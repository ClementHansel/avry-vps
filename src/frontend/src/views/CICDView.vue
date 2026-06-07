<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface CICDConfig {
  id: string;
  repoUrl: string;
  branch: string;
  authMethod: 'pat' | 'github-app';
  authCredential: string;
  syncDirection: 'vps-to-github' | 'github-to-vps' | 'bidirectional';
  localPath: string;
  commitTemplate: string;
  authorName: string;
  authorEmail: string;
  excludePatterns: string[];
  debounceInterval: number;
  preDeployCommand: string;
  postDeployCommand: string;
}

type CICDStatus = 'idle' | 'syncing-vps-to-github' | 'syncing-github-to-vps' | 'error';

interface SyncEvent {
  id: string;
  direction: string;
  commitSha: string | null;
  origin: string;
  status: 'success' | 'failed' | 'conflict';
  errorMessage: string | null;
  timestamp: string;
}

const authStore = useAuthStore();

const config = ref<CICDConfig>({
  id: '',
  repoUrl: '',
  branch: 'main',
  authMethod: 'pat',
  authCredential: '',
  syncDirection: 'vps-to-github',
  localPath: '',
  commitTemplate: 'Auto-sync from VPS: {timestamp}',
  authorName: '',
  authorEmail: '',
  excludePatterns: [],
  debounceInterval: 30,
  preDeployCommand: '',
  postDeployCommand: '',
});

const status = ref<CICDStatus>('idle');
const syncHistory = ref<SyncEvent[]>([]);
const isLoading = ref(false);
const isSaving = ref(false);
const error = ref<string | null>(null);
const isWatching = ref(false);
const excludePatternsText = ref('');

let statusInterval: ReturnType<typeof setInterval> | null = null;

const statusLabel = computed(() => {
  switch (status.value) {
    case 'idle': return 'Idle';
    case 'syncing-vps-to-github': return 'Syncing VPS → GitHub';
    case 'syncing-github-to-vps': return 'Syncing GitHub → VPS';
    case 'error': return 'Error';
    default: return 'Unknown';
  }
});

const statusClass = computed(() => {
  switch (status.value) {
    case 'idle': return 'status-idle';
    case 'syncing-vps-to-github':
    case 'syncing-github-to-vps': return 'status-syncing';
    case 'error': return 'status-error';
    default: return '';
  }
});

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchConfig(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/cicd/config', { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      if (data && data.id) {
        config.value = { ...config.value, ...data };
        excludePatternsText.value = (data.excludePatterns ?? []).join('\n');
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load config';
  } finally {
    isLoading.value = false;
  }
}

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch('/api/cicd/status', { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      status.value = data.status ?? 'idle';
      isWatching.value = data.watching ?? false;
    }
  } catch {
    // silent
  }
}

async function fetchHistory(): Promise<void> {
  try {
    const res = await fetch('/api/cicd/history', { headers: headers() });
    if (res.ok) {
      syncHistory.value = await res.json();
    }
  } catch {
    // silent
  }
}

async function saveConfig(): Promise<void> {
  isSaving.value = true;
  error.value = null;

  const payload = {
    ...config.value,
    excludePatterns: excludePatternsText.value.split('\n').map(p => p.trim()).filter(Boolean),
  };

  try {
    const res = await fetch('/api/cicd/config', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to save CI/CD configuration');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save';
  } finally {
    isSaving.value = false;
  }
}

async function startWatching(): Promise<void> {
  error.value = null;
  try {
    const res = await fetch('/api/cicd/start', {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to start watching');
    isWatching.value = true;
    await fetchStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to start';
  }
}

async function stopWatching(): Promise<void> {
  error.value = null;
  try {
    const res = await fetch('/api/cicd/stop', {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to stop watching');
    isWatching.value = false;
    status.value = 'idle';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to stop';
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function eventStatusClass(s: string): string {
  if (s === 'success') return 'badge-success';
  if (s === 'failed') return 'badge-danger';
  return 'badge-warning';
}

onMounted(() => {
  fetchConfig();
  fetchStatus();
  fetchHistory();
  statusInterval = setInterval(fetchStatus, 5000);
});

onUnmounted(() => {
  if (statusInterval) clearInterval(statusInterval);
});
</script>

<template>
  <div class="cicd-view">
    <h2>CI/CD Bridge</h2>

    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <!-- Status Indicator -->
    <section class="status-section">
      <div class="status-row">
        <div class="status-indicator">
          <span :class="['status-dot', statusClass]"></span>
          <span class="status-text">{{ statusLabel }}</span>
        </div>
        <div class="watch-controls">
          <button v-if="!isWatching" class="btn btn-primary" @click="startWatching">Start Watching</button>
          <button v-else class="btn btn-danger" @click="stopWatching">Stop Watching</button>
        </div>
      </div>
    </section>

    <!-- Configuration -->
    <section class="card">
      <h3>Configuration</h3>
      <form class="config-form" @submit.prevent="saveConfig">
        <div class="form-row">
          <div class="form-group">
            <label for="cicd-repo">Repository URL</label>
            <input id="cicd-repo" v-model="config.repoUrl" type="text" placeholder="https://github.com/user/repo.git" />
          </div>
          <div class="form-group">
            <label for="cicd-branch">Branch</label>
            <input id="cicd-branch" v-model="config.branch" type="text" placeholder="main" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="cicd-auth">Auth Method</label>
            <select id="cicd-auth" v-model="config.authMethod">
              <option value="pat">Personal Access Token</option>
              <option value="github-app">GitHub App</option>
            </select>
          </div>
          <div class="form-group">
            <label for="cicd-credential">Auth Credential</label>
            <input id="cicd-credential" v-model="config.authCredential" type="password" placeholder="Token or App ID" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="cicd-direction">Sync Direction</label>
            <select id="cicd-direction" v-model="config.syncDirection">
              <option value="vps-to-github">VPS → GitHub</option>
              <option value="github-to-vps">GitHub → VPS</option>
              <option value="bidirectional">Bidirectional</option>
            </select>
          </div>
          <div class="form-group">
            <label for="cicd-local-path">Local Path</label>
            <input id="cicd-local-path" v-model="config.localPath" type="text" placeholder="/opt/app/src" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="cicd-commit-template">Commit Template</label>
            <input id="cicd-commit-template" v-model="config.commitTemplate" type="text" placeholder="Auto-sync: {timestamp}" />
          </div>
          <div class="form-group">
            <label for="cicd-debounce">Debounce (seconds)</label>
            <input id="cicd-debounce" v-model.number="config.debounceInterval" type="number" min="5" max="300" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="cicd-author-name">Author Name</label>
            <input id="cicd-author-name" v-model="config.authorName" type="text" placeholder="Deploy Bot" />
          </div>
          <div class="form-group">
            <label for="cicd-author-email">Author Email</label>
            <input id="cicd-author-email" v-model="config.authorEmail" type="email" placeholder="deploy@example.com" />
          </div>
        </div>

        <div class="form-group">
          <label for="cicd-exclude">Exclude Patterns (one per line)</label>
          <textarea id="cicd-exclude" v-model="excludePatternsText" rows="3" placeholder="node_modules&#10;.git&#10;*.log"></textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="cicd-pre-deploy">Pre-Deploy Command</label>
            <input id="cicd-pre-deploy" v-model="config.preDeployCommand" type="text" placeholder="npm run build" />
          </div>
          <div class="form-group">
            <label for="cicd-post-deploy">Post-Deploy Command</label>
            <input id="cicd-post-deploy" v-model="config.postDeployCommand" type="text" placeholder="docker compose restart" />
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" :disabled="isSaving">
            {{ isSaving ? 'Saving...' : 'Save Configuration' }}
          </button>
        </div>
      </form>
    </section>

    <!-- Sync History -->
    <section class="card">
      <h3>Sync Event History</h3>
      <p v-if="syncHistory.length === 0" class="muted">No sync events recorded.</p>
      <div v-else class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Direction</th>
              <th>Origin</th>
              <th>Commit</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in syncHistory" :key="event.id">
              <td class="timestamp-cell">{{ formatTimestamp(event.timestamp) }}</td>
              <td>{{ event.direction.replace(/-/g, ' → ').replace('to', '') }}</td>
              <td>{{ event.origin }}</td>
              <td class="monospace">{{ event.commitSha ? event.commitSha.slice(0, 7) : '—' }}</td>
              <td>
                <span :class="['status-badge', eventStatusClass(event.status)]">{{ event.status }}</span>
              </td>
              <td class="error-cell">{{ event.errorMessage ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cicd-view h2 {
  margin-bottom: 1.5rem;
}

.cicd-view h3 {
  margin-bottom: 1rem;
  font-size: 1rem;
  font-weight: 600;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: var(--color-danger);
}

.dismiss-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: inherit;
  padding: 0 0.25rem;
}

.status-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1rem 1.5rem;
  margin-bottom: 1.5rem;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.status-idle {
  background: var(--color-text-muted);
}

.status-syncing {
  background: var(--color-primary);
  animation: pulse-dot 1.5s infinite;
}

.status-error {
  background: var(--color-danger);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 0.875rem;
  font-weight: 500;
}

.watch-controls {
  display: flex;
  gap: 0.5rem;
}

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
}

.form-group label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-text-muted);
}

.form-group input,
.form-group select,
.form-group textarea {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.875rem;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--color-primary);
}

.form-row {
  display: flex;
  gap: 1rem;
}

.form-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--color-primary);
  color: #fff;
}

.btn-danger {
  background: var(--color-danger);
  color: #fff;
}

.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

.data-table th,
.data-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  font-size: 0.8125rem;
  border-bottom: 1px solid var(--color-border);
}

.data-table th {
  background: var(--color-bg);
  font-weight: 600;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.timestamp-cell {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.monospace {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.8125rem;
}

.error-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.status-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: capitalize;
}

.badge-success {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.badge-warning {
  background: rgba(234, 179, 8, 0.15);
  color: #a16207;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}
</style>
