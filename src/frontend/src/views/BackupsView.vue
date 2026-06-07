<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const authStore = useAuthStore();

interface BackupEntry {
  id: string;
  timestamp: string;
  size: number;
  targets: string[];
  storage: 'local' | 's3';
  status: 'completed' | 'failed' | 'in-progress';
}

interface BackupSchedule {
  id: string;
  frequency: string;
  targets: string[];
  storageType: 'local' | 's3';
  storageConfig: Record<string, string>;
  retentionCount: number;
  enabled: boolean;
}

const backups = ref<BackupEntry[]>([]);
const schedule = ref<BackupSchedule | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);
const actionLoading = ref(false);

// Schedule form
const showScheduleForm = ref(false);
const formFrequency = ref('0 2 * * *');
const formTargets = ref<string[]>(['volumes', 'compose-files']);
const formStorageType = ref<'local' | 's3'>('local');
const formRetention = ref(7);
const formS3Bucket = ref('');
const formS3Region = ref('');
const formS3Endpoint = ref('');
const formLocalPath = ref('/backups');

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmLabel = ref('');
const confirmDanger = ref(false);
let pendingAction: (() => Promise<void>) | null = null;

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

async function fetchBackups(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/backups', { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch backups');
    backups.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

async function fetchSchedule(): Promise<void> {
  try {
    const res = await fetch('/api/backups/schedule', { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.id) {
      schedule.value = data;
    }
  } catch {
    // Schedule may not exist yet
  }
}

function openScheduleForm(): void {
  if (schedule.value) {
    formFrequency.value = schedule.value.frequency;
    formTargets.value = [...schedule.value.targets];
    formStorageType.value = schedule.value.storageType;
    formRetention.value = schedule.value.retentionCount;
    if (schedule.value.storageConfig) {
      formS3Bucket.value = schedule.value.storageConfig.bucket || '';
      formS3Region.value = schedule.value.storageConfig.region || '';
      formS3Endpoint.value = schedule.value.storageConfig.endpoint || '';
      formLocalPath.value = schedule.value.storageConfig.path || '/backups';
    }
  }
  showScheduleForm.value = true;
}

async function saveSchedule(): Promise<void> {
  error.value = null;
  actionLoading.value = true;

  const storageConfig: Record<string, string> = {};
  if (formStorageType.value === 's3') {
    storageConfig.bucket = formS3Bucket.value;
    storageConfig.region = formS3Region.value;
    if (formS3Endpoint.value) storageConfig.endpoint = formS3Endpoint.value;
  } else {
    storageConfig.path = formLocalPath.value;
  }

  const payload = {
    frequency: formFrequency.value,
    targets: formTargets.value,
    storageType: formStorageType.value,
    storageConfig,
    retentionCount: formRetention.value,
    enabled: true,
  };

  try {
    const res = await fetch('/api/backups/schedule', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to save backup schedule');
    successMessage.value = 'Backup schedule saved successfully.';
    showScheduleForm.value = false;
    await fetchSchedule();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

async function triggerManualBackup(): Promise<void> {
  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    const res = await fetch('/api/backups/trigger', {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to trigger backup');
    const data = await res.json();
    successMessage.value = `Manual backup started. Job ID: ${data.jobId}`;
    // Refresh backup list after a short delay
    setTimeout(() => fetchBackups(), 2000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

function requestRestore(backup: BackupEntry): void {
  confirmTitle.value = 'Restore Backup';
  confirmMessage.value = `Are you sure you want to restore from the backup created on ${new Date(backup.timestamp).toLocaleString()}? This will overwrite current data for targets: ${backup.targets.join(', ')}.`;
  confirmLabel.value = 'Restore';
  confirmDanger.value = true;
  pendingAction = async () => {
    const res = await fetch(`/api/backups/${backup.id}/restore`, {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to start restore');
    const data = await res.json();
    successMessage.value = `Restore started. Job ID: ${data.jobId}`;
  };
  confirmOpen.value = true;
}

async function handleConfirm(): Promise<void> {
  confirmOpen.value = false;
  if (!pendingAction) return;

  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    await pendingAction();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
    pendingAction = null;
  }
}

function toggleTarget(target: string): void {
  const idx = formTargets.value.indexOf(target);
  if (idx >= 0) {
    formTargets.value.splice(idx, 1);
  } else {
    formTargets.value.push(target);
  }
}

function statusClass(status: string): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'failed') return 'status-failed';
  return 'status-progress';
}

onMounted(() => {
  fetchBackups();
  fetchSchedule();
});
</script>

<template>
  <div class="backups-view">
    <div class="view-header">
      <h2>Backups</h2>
      <div class="header-actions">
        <button class="btn btn-secondary" @click="openScheduleForm">Configure Schedule</button>
        <button class="btn btn-primary" :disabled="actionLoading" @click="triggerManualBackup">
          {{ actionLoading ? 'Starting...' : 'Backup Now' }}
        </button>
      </div>
    </div>

    <!-- Success message -->
    <div v-if="successMessage" class="success-banner">
      <span>{{ successMessage }}</span>
      <button class="dismiss-btn" @click="successMessage = null">×</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <!-- Current schedule summary -->
    <div v-if="schedule" class="schedule-summary">
      <h3>Active Schedule</h3>
      <div class="summary-grid">
        <div class="summary-item">
          <span class="summary-label">Frequency</span>
          <span class="summary-value monospace">{{ schedule.frequency }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Targets</span>
          <span class="summary-value">{{ schedule.targets.join(', ') }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Storage</span>
          <span class="summary-value">{{ schedule.storageType === 's3' ? 'S3' : 'Local' }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Retention</span>
          <span class="summary-value">{{ schedule.retentionCount }} backups</span>
        </div>
      </div>
    </div>

    <!-- Schedule Form -->
    <div v-if="showScheduleForm" class="form-card">
      <h3>Backup Schedule Configuration</h3>
      <form @submit.prevent="saveSchedule">
        <div class="form-group">
          <label for="backup-frequency">Frequency (cron expression)</label>
          <input
            id="backup-frequency"
            v-model="formFrequency"
            type="text"
            placeholder="0 2 * * *"
            required
          />
          <p class="form-hint">e.g. "0 2 * * *" = daily at 2:00 AM</p>
        </div>

        <div class="form-group">
          <label>Backup Targets</label>
          <div class="checkbox-list">
            <label class="checkbox-item">
              <input type="checkbox" :checked="formTargets.includes('volumes')" @change="toggleTarget('volumes')" />
              Docker Volumes
            </label>
            <label class="checkbox-item">
              <input type="checkbox" :checked="formTargets.includes('compose-files')" @change="toggleTarget('compose-files')" />
              Compose Files
            </label>
            <label class="checkbox-item">
              <input type="checkbox" :checked="formTargets.includes('databases')" @change="toggleTarget('databases')" />
              Databases
            </label>
            <label class="checkbox-item">
              <input type="checkbox" :checked="formTargets.includes('configs')" @change="toggleTarget('configs')" />
              Configuration Files
            </label>
          </div>
        </div>

        <div class="form-group">
          <label for="storage-type">Storage Type</label>
          <select id="storage-type" v-model="formStorageType">
            <option value="local">Local Filesystem</option>
            <option value="s3">S3-Compatible Storage</option>
          </select>
        </div>

        <template v-if="formStorageType === 'local'">
          <div class="form-group">
            <label for="local-path">Local Path</label>
            <input id="local-path" v-model="formLocalPath" type="text" placeholder="/backups" required />
          </div>
        </template>

        <template v-if="formStorageType === 's3'">
          <div class="form-row">
            <div class="form-group">
              <label for="s3-bucket">Bucket</label>
              <input id="s3-bucket" v-model="formS3Bucket" type="text" placeholder="my-backups" required />
            </div>
            <div class="form-group">
              <label for="s3-region">Region</label>
              <input id="s3-region" v-model="formS3Region" type="text" placeholder="us-east-1" required />
            </div>
          </div>
          <div class="form-group">
            <label for="s3-endpoint">Endpoint (optional, for MinIO etc.)</label>
            <input id="s3-endpoint" v-model="formS3Endpoint" type="text" placeholder="https://s3.example.com" />
          </div>
        </template>

        <div class="form-group">
          <label for="retention-count">Retention (number of backups to keep)</label>
          <input id="retention-count" v-model.number="formRetention" type="number" min="1" max="100" required />
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="showScheduleForm = false">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="actionLoading">
            {{ actionLoading ? 'Saving...' : 'Save Schedule' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Loading -->
    <p v-if="loading && backups.length === 0" class="muted">Loading backups...</p>

    <!-- Empty state -->
    <div v-else-if="backups.length === 0 && !loading" class="empty-state">
      <p>No backups found.</p>
      <p class="muted">Configure a schedule or trigger a manual backup to get started.</p>
    </div>

    <!-- Backup history table -->
    <div v-else class="table-wrapper">
      <h3 class="section-title">Backup History</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Size</th>
            <th>Targets</th>
            <th>Storage</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="backup in backups" :key="backup.id">
            <td>{{ new Date(backup.timestamp).toLocaleString() }}</td>
            <td>{{ formatSize(backup.size) }}</td>
            <td>{{ backup.targets.join(', ') }}</td>
            <td>
              <span class="storage-badge">{{ backup.storage === 's3' ? 'S3' : 'Local' }}</span>
            </td>
            <td>
              <span :class="['status-badge', statusClass(backup.status)]">
                {{ backup.status }}
              </span>
            </td>
            <td>
              <button
                v-if="backup.status === 'completed'"
                class="btn btn-sm btn-secondary"
                @click="requestRestore(backup)"
              >
                Restore
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmLabel"
      :danger="confirmDanger"
      @confirm="handleConfirm"
      @cancel="confirmOpen = false"
    />
  </div>
</template>

<style scoped>
.backups-view h2 {
  margin: 0;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

/* Banners */
.success-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: #16a34a;
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

/* Schedule summary */
.schedule-summary {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
  margin-bottom: 1.5rem;
}

.schedule-summary h3 {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.summary-label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: var(--color-text-muted);
}

.summary-value {
  font-size: 0.8125rem;
  font-weight: 500;
}

.monospace {
  font-family: 'Courier New', Courier, monospace;
}

/* Form */
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
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--color-primary);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-top: 0.375rem;
}

.form-row {
  display: flex;
  gap: 1rem;
}

.form-row .form-group {
  flex: 1;
}

.checkbox-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  cursor: pointer;
  color: var(--color-text);
}

.form-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

/* Table */
.section-title {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
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

/* Badges */
.storage-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.status-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: capitalize;
}

.status-completed {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.status-failed {
  background: rgba(239, 68, 68, 0.15);
  color: #dc2626;
}

.status-progress {
  background: rgba(234, 179, 8, 0.15);
  color: #a16207;
}

/* Buttons */
.btn {
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-border);
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
