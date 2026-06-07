<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface WebhookConfig {
  id: string;
  url: string;
  token: string;
  secret: string;
  triggerBranch: string;
  enabled: boolean;
}

interface WebhookEvent {
  id: string;
  timestamp: string;
  sourceIp: string;
  branch: string;
  validationResult: 'valid' | 'invalid_signature' | 'branch_mismatch';
  triggeredAction: string | null;
  responseCode: number;
}

const authStore = useAuthStore();

const config = ref<WebhookConfig | null>(null);
const events = ref<WebhookEvent[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);
const secretVisible = ref(false);
const copiedUrl = ref(false);

// Form
const formBranch = ref('main');
const isSaving = ref(false);

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchWebhook(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/webhooks/config', { headers: headers() });
    if (res.ok) {
      config.value = await res.json();
      if (config.value) {
        formBranch.value = config.value.triggerBranch;
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load webhook config';
  } finally {
    isLoading.value = false;
  }
}

async function fetchEvents(): Promise<void> {
  try {
    const res = await fetch('/api/webhooks/events?limit=50', { headers: headers() });
    if (res.ok) {
      events.value = await res.json();
    }
  } catch {
    // silent
  }
}

async function generateWebhook(): Promise<void> {
  error.value = null;
  try {
    const res = await fetch('/api/webhooks/generate', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ triggerBranch: formBranch.value }),
    });
    if (!res.ok) throw new Error('Failed to generate webhook');
    config.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to generate webhook';
  }
}

async function saveBranch(): Promise<void> {
  if (!config.value) return;
  isSaving.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/webhooks/config', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ triggerBranch: formBranch.value }),
    });
    if (!res.ok) throw new Error('Failed to save trigger branch');
    if (config.value) config.value.triggerBranch = formBranch.value;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save';
  } finally {
    isSaving.value = false;
  }
}

function copyUrl(): void {
  if (!config.value) return;
  navigator.clipboard.writeText(config.value.url);
  copiedUrl.value = true;
  setTimeout(() => { copiedUrl.value = false; }, 2000);
}

function maskedSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return secret.slice(0, 4) + '••••••••' + secret.slice(-4);
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function validationBadgeClass(result: string): string {
  if (result === 'valid') return 'badge-success';
  if (result === 'invalid_signature') return 'badge-danger';
  return 'badge-warning';
}

onMounted(() => {
  fetchWebhook();
  fetchEvents();
});
</script>

<template>
  <div class="webhooks-view">
    <h2>Webhook Settings</h2>

    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <p v-if="isLoading" class="muted">Loading...</p>

    <!-- No Webhook Configured -->
    <section v-if="!isLoading && !config" class="card">
      <h3>Generate Webhook</h3>
      <p class="muted">No webhook is configured for this project. Generate one to enable automatic deployments from Git pushes.</p>
      <div class="form-group">
        <label for="gen-branch">Trigger Branch</label>
        <input id="gen-branch" v-model="formBranch" type="text" placeholder="main" />
      </div>
      <button class="btn btn-primary" @click="generateWebhook">Generate Webhook URL</button>
    </section>

    <!-- Webhook Config -->
    <section v-if="config" class="card">
      <h3>Webhook URL</h3>
      <div class="url-display">
        <code class="url-text">{{ config.url }}</code>
        <button class="btn btn-sm" @click="copyUrl">{{ copiedUrl ? 'Copied!' : 'Copy' }}</button>
      </div>

      <div class="secret-row">
        <label>Secret</label>
        <div class="secret-display">
          <code>{{ secretVisible ? config.secret : maskedSecret(config.secret) }}</code>
          <button class="btn btn-sm btn-ghost" @click="secretVisible = !secretVisible">
            {{ secretVisible ? 'Hide' : 'Reveal' }}
          </button>
        </div>
      </div>

      <div class="branch-row">
        <div class="form-group">
          <label for="trigger-branch">Trigger Branch</label>
          <div class="inline-form">
            <input id="trigger-branch" v-model="formBranch" type="text" placeholder="main" />
            <button class="btn btn-primary btn-sm" :disabled="isSaving" @click="saveBranch">
              {{ isSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Event Log -->
    <section class="card">
      <h3>Event Log (Last 50)</h3>
      <p v-if="events.length === 0" class="muted">No webhook events recorded.</p>
      <div v-else class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Source IP</th>
              <th>Branch</th>
              <th>Validation</th>
              <th>Action</th>
              <th>Response</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td class="timestamp-cell">{{ formatTimestamp(event.timestamp) }}</td>
              <td class="monospace">{{ event.sourceIp }}</td>
              <td>{{ event.branch || '—' }}</td>
              <td>
                <span :class="['validation-badge', validationBadgeClass(event.validationResult)]">
                  {{ event.validationResult.replace('_', ' ') }}
                </span>
              </td>
              <td>{{ event.triggeredAction ?? '—' }}</td>
              <td>{{ event.responseCode }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.webhooks-view h2 {
  margin-bottom: 1.5rem;
}

.webhooks-view h3 {
  margin-bottom: 1rem;
  font-size: 1rem;
  font-weight: 600;
}

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1.5rem;
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

.url-display {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.url-text {
  flex: 1;
  font-size: 0.8125rem;
  word-break: break-all;
}

.secret-row {
  margin-bottom: 1rem;
}

.secret-row label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.secret-display {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.secret-display code {
  font-size: 0.8125rem;
  background: var(--color-bg);
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  border: 1px solid var(--color-border);
}

.branch-row {
  margin-top: 1rem;
}

.inline-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.inline-form input {
  flex: 1;
  max-width: 200px;
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

.form-group input {
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
}

.form-group input:focus {
  outline: none;
  border-color: var(--color-primary);
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

.btn-sm {
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
}

.btn-ghost {
  background: transparent;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
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

.validation-badge {
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
