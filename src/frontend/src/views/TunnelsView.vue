<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

interface TunnelConfig {
  id: string;
  name: string;
  remotePath: string;
  protocol: 'rsync' | 'scp';
  excludePatterns: string[];
  postTransferCommand: string | null;
  authToken: string;
}

interface TransferRecord {
  id: string;
  timestamp: string;
  fileCount: number;
  totalSize: number;
  duration: number;
  status: 'completed' | 'failed' | 'in-progress';
}

const authStore = useAuthStore();

const tunnels = ref<TunnelConfig[]>([]);
const transfers = ref<TransferRecord[]>([]);
const selectedTunnelId = ref<string | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

// Form state
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formName = ref('');
const formRemotePath = ref('');
const formProtocol = ref<'rsync' | 'scp'>('rsync');
const formExcludePatterns = ref('');
const formPostTransferCommand = ref('');
const isSaving = ref(false);

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
let pendingDeleteId: string | null = null;

// Push state
const isPushing = ref(false);

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchTunnels(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/tunnels', { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch tunnels');
    tunnels.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isLoading.value = false;
  }
}

async function fetchTransfers(tunnelId: string): Promise<void> {
  selectedTunnelId.value = tunnelId;
  try {
    const res = await fetch(`/api/tunnels/${tunnelId}/transfers`, { headers: headers() });
    if (res.ok) {
      transfers.value = await res.json();
    }
  } catch {
    // silent
  }
}

function openAddForm(): void {
  editingId.value = null;
  formName.value = '';
  formRemotePath.value = '';
  formProtocol.value = 'rsync';
  formExcludePatterns.value = '';
  formPostTransferCommand.value = '';
  showForm.value = true;
}

function openEditForm(tunnel: TunnelConfig): void {
  editingId.value = tunnel.id;
  formName.value = tunnel.name;
  formRemotePath.value = tunnel.remotePath;
  formProtocol.value = tunnel.protocol;
  formExcludePatterns.value = tunnel.excludePatterns.join('\n');
  formPostTransferCommand.value = tunnel.postTransferCommand ?? '';
  showForm.value = true;
}

function cancelForm(): void {
  showForm.value = false;
  editingId.value = null;
}

async function submitForm(): Promise<void> {
  isSaving.value = true;
  error.value = null;

  const payload = {
    name: formName.value,
    remotePath: formRemotePath.value,
    protocol: formProtocol.value,
    excludePatterns: formExcludePatterns.value.split('\n').map(p => p.trim()).filter(Boolean),
    postTransferCommand: formPostTransferCommand.value || null,
  };

  try {
    if (editingId.value) {
      const res = await fetch(`/api/tunnels/${editingId.value}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to update tunnel');
    } else {
      const res = await fetch('/api/tunnels', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to create tunnel');
    }
    showForm.value = false;
    editingId.value = null;
    await fetchTunnels();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isSaving.value = false;
  }
}

function requestDelete(id: string, name: string): void {
  pendingDeleteId = id;
  confirmTitle.value = 'Delete Tunnel';
  confirmMessage.value = `Are you sure you want to delete tunnel "${name}"? This will also remove its transfer history.`;
  confirmOpen.value = true;
}

async function handleConfirmDelete(): Promise<void> {
  confirmOpen.value = false;
  if (!pendingDeleteId) return;
  try {
    const res = await fetch(`/api/tunnels/${pendingDeleteId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to delete tunnel');
    if (selectedTunnelId.value === pendingDeleteId) {
      selectedTunnelId.value = null;
      transfers.value = [];
    }
    await fetchTunnels();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
  pendingDeleteId = null;
}

async function triggerPush(tunnelId: string): Promise<void> {
  isPushing.value = true;
  error.value = null;
  try {
    const res = await fetch(`/api/tunnels/${tunnelId}/push`, {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to trigger push');
    await fetchTransfers(tunnelId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Push failed';
  } finally {
    isPushing.value = false;
  }
}

function downloadCliScript(tunnelId: string): void {
  const url = `/api/tunnels/${tunnelId}/cli-script`;
  const link = document.createElement('a');
  link.href = url;
  link.download = `tunnel-cli-${tunnelId}.sh`;
  link.click();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function statusBadgeClass(status: string): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-danger';
  return 'badge-info';
}

onMounted(() => {
  fetchTunnels();
});
</script>

<template>
  <div class="tunnels-view">
    <div class="view-header">
      <h2>Tunnel Manager</h2>
      <button class="btn btn-primary" @click="openAddForm">+ New Tunnel</button>
    </div>

    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <!-- Add/Edit Form -->
    <div v-if="showForm" class="form-card">
      <h3>{{ editingId ? 'Edit Tunnel' : 'New Tunnel' }}</h3>
      <form @submit.prevent="submitForm">
        <div class="form-group">
          <label for="tunnel-name">Name</label>
          <input id="tunnel-name" v-model="formName" type="text" placeholder="My Tunnel" required />
        </div>
        <div class="form-group">
          <label for="remote-path">Remote Path</label>
          <input id="remote-path" v-model="formRemotePath" type="text" placeholder="/opt/app/deploy" required />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="protocol">Protocol</label>
            <select id="protocol" v-model="formProtocol">
              <option value="rsync">rsync</option>
              <option value="scp">scp</option>
            </select>
          </div>
          <div class="form-group">
            <label for="post-command">Post-Transfer Command</label>
            <input id="post-command" v-model="formPostTransferCommand" type="text" placeholder="docker compose restart" />
          </div>
        </div>
        <div class="form-group">
          <label for="exclude-patterns">Exclude Patterns (one per line)</label>
          <textarea id="exclude-patterns" v-model="formExcludePatterns" rows="3" placeholder="node_modules&#10;.git&#10;*.log"></textarea>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="cancelForm">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="isSaving">
            {{ isSaving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
          </button>
        </div>
      </form>
    </div>

    <!-- Loading -->
    <p v-if="isLoading && tunnels.length === 0" class="muted">Loading tunnels...</p>

    <!-- Empty -->
    <div v-else-if="tunnels.length === 0 && !isLoading && !showForm" class="empty-state">
      <p>No tunnel configurations.</p>
      <p class="muted">Create a tunnel to enable local-to-VPS file deployments.</p>
    </div>

    <!-- Tunnel List -->
    <div v-else-if="tunnels.length > 0" class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Remote Path</th>
            <th>Protocol</th>
            <th>Post-Transfer</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tunnels" :key="t.id">
            <td class="name-cell">{{ t.name }}</td>
            <td class="monospace">{{ t.remotePath }}</td>
            <td>{{ t.protocol }}</td>
            <td class="monospace truncate">{{ t.postTransferCommand ?? '—' }}</td>
            <td class="actions-cell">
              <button class="btn btn-sm btn-success" :disabled="isPushing" @click="triggerPush(t.id)" title="Push/Deploy">
                ▶ Push
              </button>
              <button class="btn-icon" title="History" @click="fetchTransfers(t.id)">📋</button>
              <button class="btn-icon" title="Download CLI Script" @click="downloadCliScript(t.id)">⬇️</button>
              <button class="btn-icon" title="Edit" @click="openEditForm(t)">✏️</button>
              <button class="btn-icon" title="Delete" @click="requestDelete(t.id, t.name)">🗑️</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Transfer History -->
    <section v-if="selectedTunnelId && transfers.length > 0" class="card">
      <h3>Transfer History</h3>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Files</th>
              <th>Size</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tr in transfers" :key="tr.id">
              <td class="timestamp-cell">{{ formatTimestamp(tr.timestamp) }}</td>
              <td>{{ tr.fileCount }}</td>
              <td>{{ formatSize(tr.totalSize) }}</td>
              <td>{{ formatDuration(tr.duration) }}</td>
              <td>
                <span :class="['status-badge', statusBadgeClass(tr.status)]">{{ tr.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else-if="selectedTunnelId && transfers.length === 0" class="card">
      <h3>Transfer History</h3>
      <p class="muted">No transfers recorded for this tunnel.</p>
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      confirm-label="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="confirmOpen = false"
    />
  </div>
</template>

<style scoped>
.tunnels-view h2 {
  margin: 0;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
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

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1.5rem;
  margin-top: 1.5rem;
}

.card h3 {
  margin-bottom: 1rem;
  font-size: 1rem;
  font-weight: 600;
}

.form-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
  margin-bottom: 1.5rem;
}

.form-card h3 {
  font-size: 0.9375rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.form-group {
  margin-bottom: 0.875rem;
  flex: 1;
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
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
  justify-content: flex-end;
  margin-top: 1rem;
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

.name-cell {
  font-weight: 500;
}

.monospace {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.8125rem;
}

.truncate {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timestamp-cell {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.actions-cell {
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.btn {
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-success {
  background: var(--color-success);
  color: white;
}

.btn-sm {
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
}

.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  font-size: 0.875rem;
  opacity: 0.7;
  transition: opacity 0.2s;
}

.btn-icon:hover {
  opacity: 1;
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

.badge-info {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  background: var(--color-surface);
  border: 1px dashed var(--color-border);
  border-radius: 0.5rem;
  padding: 3rem;
  text-align: center;
}

.empty-state p:first-child {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
</style>
