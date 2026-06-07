<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';

interface LogEntry {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

const props = defineProps<{
  containerId: string;
  containerName: string;
  containerStatus: 'running' | 'stopped' | 'exited' | 'restarting';
}>();

const authStore = useAuthStore();

const logs = ref<LogEntry[]>([]);
const searchQuery = ref('');
const timeRange = ref<'1h' | '6h' | '24h' | 'all'>('all');
const isLoading = ref(false);
const autoScroll = ref(true);
const maxLines = 500;

const logContainer = ref<HTMLElement | null>(null);
let socket: Socket | null = null;

const timeRangeOptions = [
  { value: '1h', label: 'Last 1h' },
  { value: '6h', label: 'Last 6h' },
  { value: '24h', label: 'Last 24h' },
  { value: 'all', label: 'All' },
];

const filteredLogs = computed(() => {
  let filtered = logs.value;

  // Apply time range filter
  if (timeRange.value !== 'all') {
    const now = Date.now();
    const ranges: Record<string, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    const cutoff = now - (ranges[timeRange.value] ?? 0);
    filtered = filtered.filter((entry) => new Date(entry.timestamp).getTime() >= cutoff);
  }

  // Apply search filter (case-insensitive)
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase();
    filtered = filtered.filter((entry) =>
      entry.message.toLowerCase().includes(query)
    );
  }

  return filtered;
});

const noMatchesFound = computed(() => {
  return searchQuery.value.trim() !== '' && filteredLogs.value.length === 0;
});

async function fetchLogs(): Promise<void> {
  isLoading.value = true;

  try {
    const params = new URLSearchParams({
      containerId: props.containerId,
      tail: String(maxLines),
    });

    if (timeRange.value !== 'all') {
      params.set('since', timeRange.value);
    }

    const response = await fetch(`/api/containers/${props.containerId}/logs?${params}`, {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to fetch logs');

    const data = await response.json();
    logs.value = (data.entries ?? []).slice(-maxLines);
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  } finally {
    isLoading.value = false;
  }
}

function connectStream(): void {
  if (props.containerStatus !== 'running') return;

  socket = io(window.location.origin, {
    auth: { token: authStore.token },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    socket!.emit('logs:subscribe', { containerId: props.containerId });
  });

  socket.on('logs:data', (entry: LogEntry) => {
    logs.value.push(entry);

    // Enforce max lines
    if (logs.value.length > maxLines) {
      logs.value = logs.value.slice(-maxLines);
    }

    // Auto-scroll to bottom
    if (autoScroll.value) {
      nextTick(() => scrollToBottom());
    }
  });

  socket.on('disconnect', () => {
    // Will auto-reconnect via socket.io-client
  });
}

function disconnectStream(): void {
  if (socket) {
    socket.emit('logs:unsubscribe', { containerId: props.containerId });
    socket.disconnect();
    socket = null;
  }
}

function scrollToBottom(): void {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
}

function handleScroll(): void {
  if (!logContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logContainer.value;
  // Auto-scroll if near bottom (within 50px)
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 50;
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  } catch {
    return ts;
  }
}

// Watch for time range changes to refetch
watch(timeRange, () => {
  fetchLogs();
});

// Watch container changes
watch(
  () => props.containerId,
  (newId, oldId) => {
    if (newId !== oldId) {
      disconnectStream();
      logs.value = [];
      fetchLogs();
      if (props.containerStatus === 'running') {
        connectStream();
      }
    }
  }
);

onMounted(() => {
  fetchLogs();
  if (props.containerStatus === 'running') {
    connectStream();
  }
});

onBeforeUnmount(() => {
  disconnectStream();
});
</script>

<template>
  <div class="log-viewer">
    <!-- Controls -->
    <div class="log-controls">
      <div class="search-box">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search logs..."
          maxlength="200"
          class="search-input"
        />
      </div>

      <div class="time-range">
        <button
          v-for="option in timeRangeOptions"
          :key="option.value"
          class="range-btn"
          :class="{ active: timeRange === option.value }"
          @click="timeRange = option.value as typeof timeRange"
        >
          {{ option.label }}
        </button>
      </div>

      <button class="btn-scroll" @click="scrollToBottom" title="Scroll to bottom">
        ⬇️
      </button>
    </div>

    <!-- Container stopped notice -->
    <div v-if="containerStatus !== 'running'" class="container-stopped-notice">
      ⚠️ Container "{{ containerName }}" is not currently running. Showing historical logs.
    </div>

    <!-- Log content -->
    <div
      ref="logContainer"
      class="log-content"
      @scroll="handleScroll"
    >
      <div v-if="isLoading" class="log-loading">Loading logs...</div>

      <div v-else-if="noMatchesFound" class="log-no-matches">
        No matching log entries found for "{{ searchQuery }}"
      </div>

      <div v-else-if="filteredLogs.length === 0" class="log-empty">
        No log entries available
      </div>

      <div v-else class="log-entries">
        <div
          v-for="(entry, index) in filteredLogs"
          :key="index"
          class="log-entry"
          :class="{ stderr: entry.stream === 'stderr' }"
        >
          <span class="log-timestamp">{{ formatTimestamp(entry.timestamp) }}</span>
          <span class="log-stream" :class="entry.stream">{{ entry.stream === 'stderr' ? 'ERR' : 'OUT' }}</span>
          <span class="log-message">{{ entry.message }}</span>
        </div>
      </div>
    </div>

    <!-- Status bar -->
    <div class="log-status">
      <span>{{ filteredLogs.length }} / {{ logs.length }} lines</span>
      <span v-if="autoScroll" class="auto-scroll-indicator">↓ Auto-scroll</span>
      <span v-if="containerStatus === 'running'" class="streaming-indicator">🟢 Live</span>
    </div>
  </div>
</template>

<style scoped>
.log-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  overflow: hidden;
}

.log-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.search-box {
  flex: 1;
}

.search-input {
  width: 100%;
  padding: 0.375rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  color: var(--color-text);
  font-size: 0.85rem;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.time-range {
  display: flex;
  gap: 0.25rem;
}

.range-btn {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  padding: 0.375rem 0.5rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.75rem;
}

.range-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-text);
}

.range-btn.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

.btn-scroll {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  padding: 0.375rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.btn-scroll:hover {
  border-color: var(--color-primary);
}

.container-stopped-notice {
  padding: 0.5rem 0.75rem;
  background: rgba(245, 158, 11, 0.1);
  border-bottom: 1px solid var(--color-warning);
  color: var(--color-warning);
  font-size: 0.8rem;
  flex-shrink: 0;
}

.log-content {
  flex: 1;
  overflow-y: auto;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}

.log-loading,
.log-no-matches,
.log-empty {
  padding: 2rem;
  text-align: center;
  color: var(--color-text-muted);
}

.log-entries {
  padding: 0.25rem 0;
}

.log-entry {
  display: flex;
  gap: 0.5rem;
  padding: 0.125rem 0.75rem;
  border-left: 3px solid transparent;
}

.log-entry:hover {
  background: rgba(255, 255, 255, 0.02);
}

.log-entry.stderr {
  border-left-color: var(--color-danger);
  background: rgba(239, 68, 68, 0.05);
}

.log-timestamp {
  color: var(--color-text-muted);
  flex-shrink: 0;
  font-size: 0.75rem;
}

.log-stream {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0 0.25rem;
  border-radius: 0.125rem;
}

.log-stream.stdout {
  color: var(--color-text-muted);
}

.log-stream.stderr {
  color: var(--color-danger);
  background: rgba(239, 68, 68, 0.15);
}

.log-message {
  flex: 1;
  word-break: break-all;
  white-space: pre-wrap;
  color: var(--color-text);
}

.log-entry.stderr .log-message {
  color: #fca5a5;
}

.log-status {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.375rem 0.75rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.75rem;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.auto-scroll-indicator {
  color: var(--color-primary);
}

.streaming-indicator {
  margin-left: auto;
}
</style>
