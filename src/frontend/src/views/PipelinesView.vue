<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface PipelineConfig {
  repoUrl: string;
  authMethod: 'ssh-key' | 'https-token';
  authCredential: string;
  branch: string;
  dockerfilePath: string;
  buildContext: string;
  buildArgs: string;
  tagFormat: string;
  targetContainer: string;
}

interface BuildRecord {
  id: string;
  timestamp: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  duration?: number;
  imageTag?: string;
  branch?: string;
  commitSha?: string;
}

const authStore = useAuthStore();

const config = ref<PipelineConfig>({
  repoUrl: '',
  authMethod: 'https-token',
  authCredential: '',
  branch: 'main',
  dockerfilePath: './Dockerfile',
  buildContext: '.',
  buildArgs: '',
  tagFormat: '{project}:latest',
  targetContainer: '',
});

const buildHistory = ref<BuildRecord[]>([]);
const buildOutput = ref<string[]>([]);
const isLoading = ref(false);
const isSaving = ref(false);
const isBuilding = ref(false);
const error = ref<string | null>(null);
const activeJobId = ref<string | null>(null);

let outputInterval: ReturnType<typeof setInterval> | null = null;

async function fetchConfig(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const response = await fetch('/api/pipelines/config', {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    if (response.ok) {
      const data = await response.json();
      if (data) {
        config.value = { ...config.value, ...data };
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load config';
  } finally {
    isLoading.value = false;
  }
}

async function fetchHistory(): Promise<void> {
  try {
    const response = await fetch('/api/pipelines/history', {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    if (response.ok) {
      buildHistory.value = await response.json();
    }
  } catch {
    // silent
  }
}

async function saveConfig(): Promise<void> {
  isSaving.value = true;
  error.value = null;
  try {
    const response = await fetch('/api/pipelines/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.token}`,
      },
      body: JSON.stringify(config.value),
    });
    if (!response.ok) throw new Error('Failed to save pipeline configuration');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save';
  } finally {
    isSaving.value = false;
  }
}

async function triggerBuild(): Promise<void> {
  isBuilding.value = true;
  buildOutput.value = [];
  error.value = null;
  try {
    const response = await fetch('/api/pipelines/trigger', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    if (!response.ok) throw new Error('Failed to trigger build');
    const data = await response.json();
    activeJobId.value = data.jobId;
    subscribeToBuildOutput(data.jobId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to trigger build';
    isBuilding.value = false;
  }
}

function subscribeToBuildOutput(jobId: string): void {
  // Poll for build output (Socket.IO integration can be added when available)
  outputInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/output`, {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });
      if (response.ok) {
        const data = await response.json();
        buildOutput.value = data.lines ?? [];
        if (data.status === 'completed' || data.status === 'failed') {
          isBuilding.value = false;
          if (outputInterval) clearInterval(outputInterval);
          outputInterval = null;
          fetchHistory();
        }
      }
    } catch {
      // retry on next interval
    }
  }, 2000);
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  fetchConfig();
  fetchHistory();
});

onUnmounted(() => {
  if (outputInterval) clearInterval(outputInterval);
});
</script>

<template>
  <div class="pipelines-view">
    <h2>Build Pipeline</h2>

    <p v-if="error" class="error-message">{{ error }}</p>

    <!-- Pipeline Configuration -->
    <section class="config-section">
      <h3>Configuration</h3>
      <form class="config-form" @submit.prevent="saveConfig">
        <div class="form-group">
          <label for="repo-url">Repository URL</label>
          <input id="repo-url" v-model="config.repoUrl" type="text" placeholder="https://github.com/user/repo.git" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="auth-method">Auth Method</label>
            <select id="auth-method" v-model="config.authMethod">
              <option value="ssh-key">SSH Key</option>
              <option value="https-token">HTTPS Token</option>
            </select>
          </div>
          <div class="form-group">
            <label for="auth-credential">Credential</label>
            <input id="auth-credential" v-model="config.authCredential" type="password" placeholder="Token or key path" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="branch">Branch</label>
            <input id="branch" v-model="config.branch" type="text" placeholder="main" />
          </div>
          <div class="form-group">
            <label for="dockerfile-path">Dockerfile Path</label>
            <input id="dockerfile-path" v-model="config.dockerfilePath" type="text" placeholder="./Dockerfile" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="build-context">Build Context</label>
            <input id="build-context" v-model="config.buildContext" type="text" placeholder="." />
          </div>
          <div class="form-group">
            <label for="tag-format">Tag Format</label>
            <input id="tag-format" v-model="config.tagFormat" type="text" placeholder="{project}:latest" />
          </div>
        </div>

        <div class="form-group">
          <label for="build-args">Build Args (KEY=VALUE, one per line)</label>
          <textarea id="build-args" v-model="config.buildArgs" rows="3" placeholder="NODE_ENV=production"></textarea>
        </div>

        <div class="form-group">
          <label for="target-container">Target Container</label>
          <input id="target-container" v-model="config.targetContainer" type="text" placeholder="Container name to deploy to" />
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" :disabled="isSaving">
            {{ isSaving ? 'Saving...' : 'Save Configuration' }}
          </button>
          <button type="button" class="btn btn-success" :disabled="isBuilding" @click="triggerBuild">
            {{ isBuilding ? 'Building...' : 'Trigger Build' }}
          </button>
        </div>
      </form>
    </section>

    <!-- Real-time Build Output -->
    <section v-if="buildOutput.length > 0 || isBuilding" class="output-section">
      <h3>Build Output</h3>
      <div class="build-output">
        <pre><code>{{ buildOutput.join('\n') }}</code></pre>
        <p v-if="isBuilding" class="building-indicator">● Building...</p>
      </div>
    </section>

    <!-- Build History -->
    <section class="history-section">
      <h3>Build History</h3>
      <p v-if="isLoading">Loading...</p>
      <p v-else-if="buildHistory.length === 0" class="empty">No builds yet.</p>
      <div v-else class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Status</th>
              <th>Image Tag</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="build in buildHistory" :key="build.id">
              <td class="timestamp">{{ formatTimestamp(build.timestamp) }}</td>
              <td><span :class="['status-badge', build.status]">{{ build.status }}</span></td>
              <td class="monospace">{{ build.imageTag ?? '—' }}</td>
              <td>{{ build.branch ?? '—' }}</td>
              <td class="monospace">{{ build.commitSha ? build.commitSha.slice(0, 7) : '—' }}</td>
              <td>{{ formatDuration(build.duration) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pipelines-view h2 {
  margin-bottom: 1.5rem;
}

.pipelines-view h3 {
  margin-bottom: 1rem;
  font-size: 1rem;
  font-weight: 600;
}

.error-message {
  color: var(--color-danger);
  margin-bottom: 1rem;
}

.config-section,
.output-section,
.history-section {
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

.btn-success {
  background: var(--color-success);
  color: #fff;
}

.build-output {
  background: #1a1a2e;
  border-radius: 0.25rem;
  padding: 1rem;
  max-height: 400px;
  overflow-y: auto;
}

.build-output pre {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: #e0e0e0;
  white-space: pre-wrap;
  word-break: break-all;
}

.building-indicator {
  color: var(--color-primary);
  font-size: 0.8rem;
  margin-top: 0.5rem;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface);
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

.monospace {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.8125rem;
}

.timestamp {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.status-badge {
  display: inline-block;
  font-size: 0.75rem;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: 0.25rem;
  font-weight: 600;
}

.status-badge.completed {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.status-badge.failed {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.status-badge.running {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.status-badge.queued {
  background: rgba(156, 163, 175, 0.15);
  color: var(--color-text-muted);
}

.empty {
  color: var(--color-text-muted);
}
</style>
