<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const authStore = useAuthStore();

interface CronJob {
  id: string;
  expression: string;
  command: string;
  user: string;
  enabled: boolean;
  description: string;
  lastExecution?: CronExecution;
}

interface CronExecution {
  timestamp: string;
  exitCode: number;
  output: string;
}

const jobs = ref<CronJob[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// Form state
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formExpression = ref('');
const formCommand = ref('');
const formUser = ref('root');
const formEnabled = ref(true);
const validationError = ref<string | null>(null);
const expressionDescription = ref<string | null>(null);

// History panel
const showHistory = ref(false);
const historyJobId = ref<string | null>(null);
const historyJobName = ref('');
const executionHistory = ref<CronExecution[]>([]);
const historyLoading = ref(false);

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
let pendingDeleteId: string | null = null;

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchJobs(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/cron', { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch cron jobs');
    jobs.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function openAddForm(): void {
  editingId.value = null;
  formExpression.value = '';
  formCommand.value = '';
  formUser.value = 'root';
  formEnabled.value = true;
  validationError.value = null;
  expressionDescription.value = null;
  showForm.value = true;
}

function openEditForm(job: CronJob): void {
  editingId.value = job.id;
  formExpression.value = job.expression;
  formCommand.value = job.command;
  formUser.value = job.user;
  formEnabled.value = job.enabled;
  validationError.value = null;
  expressionDescription.value = job.description;
  showForm.value = true;
}

function cancelForm(): void {
  showForm.value = false;
  editingId.value = null;
  validationError.value = null;
  expressionDescription.value = null;
}

async function validateExpression(): Promise<void> {
  if (!formExpression.value.trim()) {
    validationError.value = null;
    expressionDescription.value = null;
    return;
  }

  try {
    const res = await fetch('/api/cron/validate', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ expression: formExpression.value }),
    });
    const data = await res.json();
    if (data.valid) {
      validationError.value = null;
      expressionDescription.value = data.description || null;
    } else {
      validationError.value = data.error || 'Invalid cron expression';
      expressionDescription.value = null;
    }
  } catch {
    validationError.value = null;
    expressionDescription.value = null;
  }
}

async function submitForm(): Promise<void> {
  error.value = null;
  validationError.value = null;

  const payload = {
    expression: formExpression.value,
    command: formCommand.value,
    user: formUser.value,
    enabled: formEnabled.value,
  };

  try {
    if (editingId.value) {
      const res = await fetch(`/api/cron/${editingId.value}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.validationError) {
          validationError.value = data.validationError;
          return;
        }
        throw new Error(data.message || 'Failed to update cron job');
      }
    } else {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.validationError) {
          validationError.value = data.validationError;
          return;
        }
        throw new Error(data.message || 'Failed to create cron job');
      }
    }
    showForm.value = false;
    editingId.value = null;
    await fetchJobs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

function requestDelete(id: string, command: string): void {
  pendingDeleteId = id;
  confirmTitle.value = 'Delete Cron Job';
  confirmMessage.value = `Are you sure you want to delete the cron job "${command}"?`;
  confirmOpen.value = true;
}

async function handleConfirmDelete(): Promise<void> {
  confirmOpen.value = false;
  if (!pendingDeleteId) return;

  try {
    const res = await fetch(`/api/cron/${pendingDeleteId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to delete cron job');
    await fetchJobs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
  pendingDeleteId = null;
}

async function toggleEnabled(job: CronJob): Promise<void> {
  try {
    const res = await fetch(`/api/cron/${job.id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle cron job');
    await fetchJobs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

async function openHistory(job: CronJob): Promise<void> {
  historyJobId.value = job.id;
  historyJobName.value = job.command;
  showHistory.value = true;
  historyLoading.value = true;
  executionHistory.value = [];

  try {
    const res = await fetch(`/api/cron/${job.id}/history`, { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch execution history');
    executionHistory.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    historyLoading.value = false;
  }
}

function closeHistory(): void {
  showHistory.value = false;
  historyJobId.value = null;
  executionHistory.value = [];
}

function exitCodeClass(code: number): string {
  return code === 0 ? 'exit-success' : 'exit-failure';
}

onMounted(() => {
  fetchJobs();
});
</script>

<template>
  <div class="cron-view">
    <div class="view-header">
      <h2>Cron Jobs</h2>
      <button class="btn btn-primary" @click="openAddForm">+ Add Cron Job</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <!-- Add/Edit Form -->
    <div v-if="showForm" class="form-card">
      <h3>{{ editingId ? 'Edit Cron Job' : 'Add Cron Job' }}</h3>
      <form @submit.prevent="submitForm">
        <div class="form-group">
          <label for="cron-expression">Cron Expression</label>
          <input
            id="cron-expression"
            v-model="formExpression"
            type="text"
            placeholder="*/5 * * * *"
            required
            @blur="validateExpression"
          />
          <p v-if="expressionDescription" class="expression-desc">{{ expressionDescription }}</p>
          <p v-if="validationError" class="validation-error">{{ validationError }}</p>
        </div>
        <div class="form-group">
          <label for="cron-command">Command</label>
          <input
            id="cron-command"
            v-model="formCommand"
            type="text"
            placeholder="/usr/bin/backup.sh"
            required
          />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="cron-user">User</label>
            <input
              id="cron-user"
              v-model="formUser"
              type="text"
              placeholder="root"
            />
          </div>
          <div class="form-group checkbox-group">
            <label>
              <input v-model="formEnabled" type="checkbox" />
              Enabled
            </label>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="cancelForm">Cancel</button>
          <button type="submit" class="btn btn-primary">{{ editingId ? 'Update' : 'Create' }}</button>
        </div>
      </form>
    </div>

    <!-- Loading -->
    <p v-if="loading && jobs.length === 0" class="muted">Loading cron jobs...</p>

    <!-- Empty state -->
    <div v-else-if="jobs.length === 0 && !loading" class="empty-state">
      <p>No cron jobs configured.</p>
      <p class="muted">Add a cron job to schedule recurring tasks.</p>
    </div>

    <!-- Cron jobs table -->
    <div v-else class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Expression</th>
            <th>Description</th>
            <th>Command</th>
            <th>User</th>
            <th>Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in jobs" :key="job.id">
            <td class="monospace">{{ job.expression }}</td>
            <td class="description-cell">{{ job.description }}</td>
            <td class="monospace command-cell">{{ job.command }}</td>
            <td>{{ job.user }}</td>
            <td>
              <button
                :class="['toggle-btn', { active: job.enabled }]"
                :aria-label="job.enabled ? 'Disable' : 'Enable'"
                @click="toggleEnabled(job)"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </button>
            </td>
            <td class="actions-cell">
              <button class="btn-icon" title="History" @click="openHistory(job)">📋</button>
              <button class="btn-icon" title="Edit" @click="openEditForm(job)">✏️</button>
              <button class="btn-icon" title="Delete" @click="requestDelete(job.id, job.command)">🗑️</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Execution History Panel -->
    <div v-if="showHistory" class="history-panel">
      <div class="history-header">
        <h3>Execution History: <span class="monospace">{{ historyJobName }}</span></h3>
        <button class="btn btn-secondary" @click="closeHistory">Close</button>
      </div>

      <p v-if="historyLoading" class="muted">Loading history...</p>

      <div v-else-if="executionHistory.length === 0" class="empty-state small">
        <p>No execution history available.</p>
      </div>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Exit Code</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(exec, i) in executionHistory" :key="i">
            <td>{{ new Date(exec.timestamp).toLocaleString() }}</td>
            <td>
              <span :class="['exit-badge', exitCodeClass(exec.exitCode)]">{{ exec.exitCode }}</span>
            </td>
            <td class="output-cell">
              <pre class="output-pre">{{ exec.output || '(no output)' }}</pre>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

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
.cron-view h2 {
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

.form-group input[type="text"] {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
}

.form-group input[type="text"]:focus {
  outline: none;
  border-color: var(--color-primary);
}

.form-row {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
}

.form-row .form-group {
  flex: 1;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--color-text);
}

.expression-desc {
  font-size: 0.75rem;
  color: var(--color-primary);
  margin-top: 0.375rem;
  font-style: italic;
}

.validation-error {
  font-size: 0.75rem;
  color: var(--color-danger);
  margin-top: 0.375rem;
}

.form-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

/* Table */
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

.description-cell {
  color: var(--color-text-muted);
  font-style: italic;
  max-width: 200px;
}

.command-cell {
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Toggle */
.toggle-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.toggle-track {
  display: block;
  width: 36px;
  height: 20px;
  background: var(--color-border);
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-btn.active .toggle-track {
  background: var(--color-primary);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-btn.active .toggle-thumb {
  transform: translateX(16px);
}

/* Action buttons */
.actions-cell {
  white-space: nowrap;
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

/* History panel */
.history-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
  margin-top: 1.5rem;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.history-header h3 {
  font-size: 0.9375rem;
  font-weight: 600;
  margin: 0;
}

/* Exit code badges */
.exit-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 600;
  font-family: 'Courier New', Courier, monospace;
}

.exit-success {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.exit-failure {
  background: rgba(239, 68, 68, 0.15);
  color: #dc2626;
}

.output-cell {
  max-width: 400px;
}

.output-pre {
  margin: 0;
  font-size: 0.75rem;
  background: var(--color-bg);
  padding: 0.375rem 0.5rem;
  border-radius: 0.25rem;
  max-height: 80px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
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

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover {
  background: var(--color-primary-hover);
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-secondary:hover {
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

.empty-state.small {
  padding: 1.5rem;
}

.empty-state p:first-child {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
</style>
