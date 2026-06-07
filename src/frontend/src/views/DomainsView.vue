<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const authStore = useAuthStore();

interface Domain {
  id: string;
  domain: string;
  proxyTarget: string;
  sslEnabled: boolean;
  headers: Record<string, string>;
  websocketUpgrade: boolean;
  active: boolean;
  sslStatus: 'active' | 'pending' | 'none';
}

const domains = ref<Domain[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// Form state
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formDomain = ref('');
const formProxyTarget = ref('');
const formHeaders = ref('');
const formWebsocket = ref(false);

// DNS warning
const dnsWarning = ref<string | null>(null);

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
let pendingDeleteId: string | null = null;

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchDomains(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/domains', { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch domains');
    domains.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function openAddForm(): void {
  editingId.value = null;
  formDomain.value = '';
  formProxyTarget.value = '';
  formHeaders.value = '';
  formWebsocket.value = false;
  dnsWarning.value = null;
  showForm.value = true;
}

function openEditForm(domain: Domain): void {
  editingId.value = domain.id;
  formDomain.value = domain.domain;
  formProxyTarget.value = domain.proxyTarget;
  formHeaders.value = Object.entries(domain.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  formWebsocket.value = domain.websocketUpgrade;
  dnsWarning.value = null;
  showForm.value = true;
}

function cancelForm(): void {
  showForm.value = false;
  editingId.value = null;
  dnsWarning.value = null;
}

function parseHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw.trim()) return result;
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      if (key) result[key] = value;
    }
  }
  return result;
}

async function submitForm(): Promise<void> {
  error.value = null;
  dnsWarning.value = null;

  const payload = {
    domain: formDomain.value,
    proxyTarget: formProxyTarget.value,
    headers: parseHeaders(formHeaders.value),
    websocketUpgrade: formWebsocket.value,
  };

  try {
    if (editingId.value) {
      const res = await fetch(`/api/domains/${editingId.value}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to update domain');
    } else {
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.dnsWarning) {
          dnsWarning.value = data.dnsWarning;
        }
        if (!res.ok && !data.dnsWarning) throw new Error(data.message || 'Failed to add domain');
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.dnsWarning) {
          dnsWarning.value = data.dnsWarning;
        }
      }
    }
    showForm.value = false;
    editingId.value = null;
    await fetchDomains();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

function requestDelete(id: string, domainName: string): void {
  pendingDeleteId = id;
  confirmTitle.value = 'Delete Domain';
  confirmMessage.value = `Are you sure you want to delete "${domainName}"? This will remove the Nginx configuration and SSL settings for this domain.`;
  confirmOpen.value = true;
}

async function handleConfirmDelete(): Promise<void> {
  confirmOpen.value = false;
  if (!pendingDeleteId) return;

  try {
    const res = await fetch(`/api/domains/${pendingDeleteId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to delete domain');
    await fetchDomains();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
  pendingDeleteId = null;
}

async function toggleActive(domain: Domain): Promise<void> {
  try {
    const res = await fetch(`/api/domains/${domain.id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ active: !domain.active }),
    });
    if (!res.ok) throw new Error('Failed to toggle domain status');
    await fetchDomains();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

function sslBadgeClass(status: string): string {
  if (status === 'active') return 'ssl-active';
  if (status === 'pending') return 'ssl-pending';
  return 'ssl-none';
}

onMounted(() => {
  fetchDomains();
});
</script>

<template>
  <div class="domains-view">
    <div class="view-header">
      <h2>Domains</h2>
      <button class="btn btn-primary" @click="openAddForm">+ Add Domain</button>
    </div>

    <!-- DNS Warning Banner -->
    <div v-if="dnsWarning" class="dns-warning">
      <span class="warning-icon">⚠️</span>
      <span>{{ dnsWarning }}</span>
      <button class="dismiss-btn" @click="dnsWarning = null">×</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <!-- Add/Edit Form -->
    <div v-if="showForm" class="form-card">
      <h3>{{ editingId ? 'Edit Domain' : 'Add Domain' }}</h3>
      <form @submit.prevent="submitForm">
        <div class="form-group">
          <label for="domain-name">Domain Name</label>
          <input
            id="domain-name"
            v-model="formDomain"
            type="text"
            placeholder="example.com"
            required
            :disabled="!!editingId"
          />
        </div>
        <div class="form-group">
          <label for="proxy-target">Proxy Target (host:port)</label>
          <input
            id="proxy-target"
            v-model="formProxyTarget"
            type="text"
            placeholder="localhost:3000"
            required
          />
        </div>
        <div class="form-group">
          <label for="custom-headers">Custom Headers (one per line, Key: Value)</label>
          <textarea
            id="custom-headers"
            v-model="formHeaders"
            rows="3"
            placeholder="X-Custom-Header: value&#10;X-Another: value"
          ></textarea>
        </div>
        <div class="form-group checkbox-group">
          <label>
            <input v-model="formWebsocket" type="checkbox" />
            Enable WebSocket Upgrade
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="cancelForm">Cancel</button>
          <button type="submit" class="btn btn-primary">{{ editingId ? 'Update' : 'Add' }}</button>
        </div>
      </form>
    </div>

    <!-- Loading -->
    <p v-if="loading && domains.length === 0" class="muted">Loading domains...</p>

    <!-- Empty state -->
    <div v-else-if="domains.length === 0 && !loading" class="empty-state">
      <p>No domains configured.</p>
      <p class="muted">Add a domain to configure reverse proxy routing.</p>
    </div>

    <!-- Domain table -->
    <div v-else class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Proxy Target</th>
            <th>SSL Status</th>
            <th>WebSocket</th>
            <th>Active</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in domains" :key="d.id">
            <td class="domain-name-cell">{{ d.domain }}</td>
            <td class="monospace">{{ d.proxyTarget }}</td>
            <td>
              <span :class="['ssl-badge', sslBadgeClass(d.sslStatus)]">
                {{ d.sslStatus }}
              </span>
            </td>
            <td>{{ d.websocketUpgrade ? 'Yes' : 'No' }}</td>
            <td>
              <button
                :class="['toggle-btn', { active: d.active }]"
                :aria-label="d.active ? 'Deactivate' : 'Activate'"
                @click="toggleActive(d)"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </button>
            </td>
            <td class="actions-cell">
              <button class="btn-icon" title="Edit" @click="openEditForm(d)">✏️</button>
              <button class="btn-icon" title="Delete" @click="requestDelete(d.id, d.domain)">🗑️</button>
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
.domains-view h2 {
  margin: 0;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.dns-warning {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: rgba(234, 179, 8, 0.1);
  border: 1px solid rgba(234, 179, 8, 0.4);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: #a16207;
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

.warning-icon {
  font-size: 1rem;
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

.form-group textarea {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-family: 'Courier New', Courier, monospace;
  color: var(--color-text);
  resize: vertical;
}

.form-group textarea:focus {
  outline: none;
  border-color: var(--color-primary);
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
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

.domain-name-cell {
  font-weight: 500;
}

.monospace {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.8125rem;
}

/* SSL badge */
.ssl-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: capitalize;
}

.ssl-active {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.ssl-pending {
  background: rgba(234, 179, 8, 0.15);
  color: #a16207;
}

.ssl-none {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
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

.empty-state p:first-child {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
</style>
