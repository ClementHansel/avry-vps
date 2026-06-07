<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';

interface TerminalTab {
  id: string;
  title: string;
  terminal: any; // xterm.js Terminal instance
  fitAddon: any; // FitAddon instance
  connected: boolean;
}

const authStore = useAuthStore();

const tabs = ref<TerminalTab[]>([]);
const activeTabId = ref<string | null>(null);
const terminalRefs = ref<Record<string, HTMLElement>>({});
const isConnecting = ref(false);
const disconnected = ref(false);
const reconnectAttempts = ref(0);
const maxReconnectAttempts = 3;
const reconnectInterval = 2000;

let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

function getActiveTab(): TerminalTab | undefined {
  return tabs.value.find((t) => t.id === activeTabId.value);
}

function initSocket(): void {
  if (socket?.connected) return;

  socket = io(window.location.origin, {
    auth: { token: authStore.token },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    disconnected.value = false;
    reconnectAttempts.value = 0;
    // Re-attach all tabs if reconnecting
    tabs.value.forEach((tab) => {
      tab.connected = true;
    });
  });

  socket.on('disconnect', () => {
    disconnected.value = true;
    tabs.value.forEach((tab) => {
      tab.connected = false;
    });
    attemptReconnect();
  });

  socket.on('terminal:data', (data: { sessionId: string; data: string }) => {
    const tab = tabs.value.find((t) => t.id === data.sessionId);
    if (tab?.terminal) {
      tab.terminal.write(data.data);
    }
  });

  socket.on('terminal:closed', (data: { sessionId: string }) => {
    const tab = tabs.value.find((t) => t.id === data.sessionId);
    if (tab) {
      tab.connected = false;
      tab.terminal?.write('\r\n\x1b[31m[Session closed]\x1b[0m\r\n');
    }
  });
}

function attemptReconnect(): void {
  if (reconnectAttempts.value >= maxReconnectAttempts) return;

  reconnectTimer = setTimeout(() => {
    reconnectAttempts.value++;
    socket?.connect();
  }, reconnectInterval);
}

function manualReconnect(): void {
  reconnectAttempts.value = 0;
  disconnected.value = false;
  socket?.connect();
}

async function createTab(): Promise<void> {
  if (!socket?.connected) {
    initSocket();
    // Wait for connection
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (socket?.connected) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(checkInterval); resolve(); }, 3000);
    });
  }

  isConnecting.value = true;

  socket!.emit('terminal:create', {}, async (response: { sessionId: string; error?: string }) => {
    isConnecting.value = false;

    if (response.error) {
      console.error('Failed to create terminal session:', response.error);
      return;
    }

    const sessionId = response.sessionId;

    // Dynamically import xterm.js
    const { Terminal } = await import('xterm');
    const { FitAddon } = await import('xterm-addon-fit');

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0f172a',
        foreground: '#f8fafc',
        cursor: '#6366f1',
        selectionBackground: 'rgba(99, 102, 241, 0.3)',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const tab: TerminalTab = {
      id: sessionId,
      title: `Terminal ${tabs.value.length + 1}`,
      terminal,
      fitAddon,
      connected: true,
    };

    tabs.value.push(tab);
    activeTabId.value = sessionId;

    // Wait for DOM to update, then open terminal
    await nextTick();

    const container = document.getElementById(`terminal-${sessionId}`);
    if (container) {
      terminal.open(container);
      fitAddon.fit();

      // Handle user input
      terminal.onData((data: string) => {
        if (socket?.connected) {
          socket.emit('terminal:data', { sessionId, data });
        }
      });

      // Handle clipboard - Ctrl+Shift+C for copy, Ctrl+Shift+V for paste
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.ctrlKey && event.shiftKey && event.key === 'C') {
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection);
          }
          return false;
        }
        if (event.ctrlKey && event.shiftKey && event.key === 'V') {
          navigator.clipboard.readText().then((text) => {
            if (socket?.connected) {
              socket.emit('terminal:data', { sessionId, data: text });
            }
          });
          return false;
        }
        return true;
      });

      // Emit initial resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        socket!.emit('terminal:resize', { sessionId, cols: dims.cols, rows: dims.rows });
      }
    }
  });
}

function closeTab(tabId: string): void {
  const tabIndex = tabs.value.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabs.value[tabIndex];
  tab.terminal?.dispose();
  socket?.emit('terminal:close', { sessionId: tabId });

  tabs.value.splice(tabIndex, 1);

  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value.length > 0
      ? tabs.value[Math.min(tabIndex, tabs.value.length - 1)].id
      : null;
  }
}

function switchTab(tabId: string): void {
  activeTabId.value = tabId;
  nextTick(() => {
    const tab = tabs.value.find((t) => t.id === tabId);
    tab?.fitAddon?.fit();
    tab?.terminal?.focus();
  });
}

function handleResize(): void {
  const tab = getActiveTab();
  if (!tab?.fitAddon || !tab.connected) return;

  tab.fitAddon.fit();
  const dims = tab.fitAddon.proposeDimensions();
  if (dims && socket?.connected) {
    socket.emit('terminal:resize', { sessionId: tab.id, cols: dims.cols, rows: dims.rows });
  }
}

onMounted(() => {
  initSocket();

  // Observe terminal container resize
  resizeObserver = new ResizeObserver(() => {
    handleResize();
  });

  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  // Clean up all terminals
  tabs.value.forEach((tab) => {
    tab.terminal?.dispose();
    if (socket?.connected) {
      socket.emit('terminal:close', { sessionId: tab.id });
    }
  });

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (resizeObserver) resizeObserver.disconnect();
  window.removeEventListener('resize', handleResize);
  socket?.disconnect();
  socket = null;
});

// Watch active tab to fit terminal
watch(activeTabId, () => {
  nextTick(() => handleResize());
});
</script>

<template>
  <div class="terminal-view">
    <h2>Web Terminal</h2>

    <!-- Reconnection UI -->
    <div v-if="disconnected" class="reconnect-bar">
      <span v-if="reconnectAttempts < maxReconnectAttempts" class="reconnect-status">
        🔄 Reconnecting... (attempt {{ reconnectAttempts }}/{{ maxReconnectAttempts }})
      </span>
      <span v-else class="reconnect-status">
        ❌ Connection lost
      </span>
      <button
        v-if="reconnectAttempts >= maxReconnectAttempts"
        class="btn-reconnect"
        @click="manualReconnect"
      >
        🔌 Reconnect
      </button>
    </div>

    <!-- Tab bar -->
    <div class="terminal-tabs">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="terminal-tab"
        :class="{ active: activeTabId === tab.id }"
        @click="switchTab(tab.id)"
      >
        <span class="tab-indicator" :class="{ connected: tab.connected, disconnected: !tab.connected }"></span>
        <span class="tab-title">{{ tab.title }}</span>
        <button class="tab-close" @click.stop="closeTab(tab.id)">✕</button>
      </div>
      <button class="btn-new-tab" @click="createTab" :disabled="isConnecting">
        {{ isConnecting ? '...' : '+ New' }}
      </button>
    </div>

    <!-- Terminal panels -->
    <div class="terminal-container">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        :id="`terminal-${tab.id}`"
        class="terminal-panel"
        :class="{ active: activeTabId === tab.id }"
      ></div>

      <div v-if="tabs.length === 0" class="terminal-empty">
        <p>No terminal sessions open</p>
        <button class="btn-create" @click="createTab" :disabled="isConnecting">
          {{ isConnecting ? 'Connecting...' : '🖥️ Open Terminal' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 130px);
}

.terminal-view h2 {
  margin-bottom: 1rem;
  flex-shrink: 0;
}

.reconnect-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid var(--color-warning);
  border-radius: 0.375rem;
  margin-bottom: 0.5rem;
  flex-shrink: 0;
}

.reconnect-status {
  font-size: 0.85rem;
  color: var(--color-warning);
}

.btn-reconnect {
  background: var(--color-warning);
  border: none;
  color: #000;
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
}

.terminal-tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-bottom: none;
  border-radius: 0.375rem 0.375rem 0 0;
  flex-shrink: 0;
  overflow-x: auto;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
  white-space: nowrap;
}

.terminal-tab.active {
  background: var(--color-surface-hover);
  border-color: var(--color-primary);
}

.tab-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.tab-indicator.connected {
  background: var(--color-success);
}

.tab-indicator.disconnected {
  background: var(--color-danger);
}

.tab-title {
  color: var(--color-text);
}

.tab-close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.125rem 0.25rem;
  border-radius: 0.125rem;
}

.tab-close:hover {
  background: var(--color-danger);
  color: #fff;
}

.btn-new-tab {
  background: var(--color-surface-hover);
  border: 1px dashed var(--color-border);
  color: var(--color-text-muted);
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-new-tab:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.btn-new-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.terminal-container {
  flex: 1;
  background: #0f172a;
  border: 1px solid var(--color-border);
  border-radius: 0 0 0.375rem 0.375rem;
  position: relative;
  overflow: hidden;
}

.terminal-panel {
  position: absolute;
  inset: 0;
  padding: 0.5rem;
  display: none;
}

.terminal-panel.active {
  display: block;
}

.terminal-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--color-text-muted);
}

.btn-create {
  background: var(--color-primary);
  border: none;
  color: #fff;
  padding: 0.5rem 1.25rem;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.btn-create:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.btn-create:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<style>
/* xterm.js global styles */
.xterm {
  height: 100%;
}

.xterm-viewport {
  overflow-y: auto !important;
}
</style>
