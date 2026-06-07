<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();

interface Certificate {
  id: string;
  domain: string;
  issuer: string;
  expiryDate: string;
  daysUntilExpiry: number;
  renewalStatus: 'auto-managed' | 'manual';
  isValid: boolean;
}

const certificates = ref<Certificate[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const actionLoading = ref(false);
const successMessage = ref<string | null>(null);

// Upload form
const showUploadForm = ref(false);
const uploadDomain = ref('');
const certFile = ref<File | null>(null);
const keyFile = ref<File | null>(null);

// Provision form
const showProvisionForm = ref(false);
const provisionDomain = ref('');

function headers() {
  return { Authorization: `Bearer ${authStore.token}` };
}

function jsonHeaders() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

const expiringCerts = computed(() =>
  certificates.value.filter((c) => c.daysUntilExpiry <= 30 && c.isValid)
);

const expiredCerts = computed(() =>
  certificates.value.filter((c) => c.daysUntilExpiry <= 0)
);

async function fetchCertificates(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/ssl', { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch certificates');
    certificates.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

async function provisionCertificate(): Promise<void> {
  if (!provisionDomain.value) return;
  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    const res = await fetch('/api/ssl/provision', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ domain: provisionDomain.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to provision certificate');
    }
    successMessage.value = `Certificate provisioning started for ${provisionDomain.value}`;
    showProvisionForm.value = false;
    provisionDomain.value = '';
    await fetchCertificates();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

async function uploadCertificate(): Promise<void> {
  if (!uploadDomain.value || !certFile.value || !keyFile.value) return;
  actionLoading.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    const formData = new FormData();
    formData.append('domain', uploadDomain.value);
    formData.append('cert', certFile.value);
    formData.append('key', keyFile.value);

    const res = await fetch('/api/ssl/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to upload certificate');
    }
    successMessage.value = `Certificate uploaded for ${uploadDomain.value}`;
    showUploadForm.value = false;
    uploadDomain.value = '';
    certFile.value = null;
    keyFile.value = null;
    await fetchCertificates();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    actionLoading.value = false;
  }
}

function handleCertFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  certFile.value = input.files?.[0] ?? null;
}

function handleKeyFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  keyFile.value = input.files?.[0] ?? null;
}

function expiryClass(days: number): string {
  if (days <= 0) return 'expiry-expired';
  if (days <= 7) return 'expiry-critical';
  if (days <= 30) return 'expiry-warning';
  return 'expiry-ok';
}

function renewalBadgeClass(status: string): string {
  return status === 'auto-managed' ? 'renewal-auto' : 'renewal-manual';
}

onMounted(() => {
  fetchCertificates();
});
</script>

<template>
  <div class="ssl-view">
    <div class="view-header">
      <h2>SSL Certificates</h2>
      <div class="header-actions">
        <button class="btn btn-primary" @click="showProvisionForm = true">Provision Let's Encrypt</button>
        <button class="btn btn-secondary" @click="showUploadForm = true">Upload Certificate</button>
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

    <!-- Status Dashboard Summary -->
    <div v-if="certificates.length > 0" class="status-dashboard">
      <div class="stat-card">
        <span class="stat-number">{{ certificates.length }}</span>
        <span class="stat-label">Total Certificates</span>
      </div>
      <div class="stat-card">
        <span class="stat-number stat-auto">{{ certificates.filter(c => c.renewalStatus === 'auto-managed').length }}</span>
        <span class="stat-label">Auto-Managed</span>
      </div>
      <div class="stat-card">
        <span class="stat-number stat-manual">{{ certificates.filter(c => c.renewalStatus === 'manual').length }}</span>
        <span class="stat-label">Manual</span>
      </div>
      <div v-if="expiringCerts.length > 0" class="stat-card stat-warning-card">
        <span class="stat-number stat-warning">{{ expiringCerts.length }}</span>
        <span class="stat-label">Expiring Soon</span>
      </div>
      <div v-if="expiredCerts.length > 0" class="stat-card stat-danger-card">
        <span class="stat-number stat-danger">{{ expiredCerts.length }}</span>
        <span class="stat-label">Expired</span>
      </div>
    </div>

    <!-- Provision Form -->
    <div v-if="showProvisionForm" class="form-card">
      <h3>Provision Let's Encrypt Certificate</h3>
      <form @submit.prevent="provisionCertificate">
        <div class="form-group">
          <label for="provision-domain">Domain</label>
          <input
            id="provision-domain"
            v-model="provisionDomain"
            type="text"
            placeholder="example.com"
            required
          />
          <p class="form-hint">Domain must have DNS pointing to this server for HTTP-01 validation.</p>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="showProvisionForm = false">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="actionLoading">
            {{ actionLoading ? 'Provisioning...' : 'Provision' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Upload Form -->
    <div v-if="showUploadForm" class="form-card">
      <h3>Upload Custom Certificate</h3>
      <form @submit.prevent="uploadCertificate">
        <div class="form-group">
          <label for="upload-domain">Domain</label>
          <input
            id="upload-domain"
            v-model="uploadDomain"
            type="text"
            placeholder="example.com"
            required
          />
        </div>
        <div class="form-group">
          <label for="cert-file">Certificate File (.pem / .crt)</label>
          <input id="cert-file" type="file" accept=".pem,.crt" @change="handleCertFileChange" required />
        </div>
        <div class="form-group">
          <label for="key-file">Private Key File (.pem / .key)</label>
          <input id="key-file" type="file" accept=".pem,.key" @change="handleKeyFileChange" required />
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" @click="showUploadForm = false">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="actionLoading">
            {{ actionLoading ? 'Uploading...' : 'Upload' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Loading -->
    <p v-if="loading && certificates.length === 0" class="muted">Loading certificates...</p>

    <!-- Empty state -->
    <div v-else-if="certificates.length === 0 && !loading" class="empty-state">
      <p>No SSL certificates configured.</p>
      <p class="muted">Provision a Let's Encrypt certificate or upload a custom one.</p>
    </div>

    <!-- Certificate list -->
    <div v-else class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Issuer</th>
            <th>Expiry</th>
            <th>Days Left</th>
            <th>Type</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cert in certificates" :key="cert.id">
            <td class="domain-cell">{{ cert.domain }}</td>
            <td>{{ cert.issuer }}</td>
            <td>{{ new Date(cert.expiryDate).toLocaleDateString() }}</td>
            <td>
              <span :class="['expiry-badge', expiryClass(cert.daysUntilExpiry)]">
                {{ cert.daysUntilExpiry <= 0 ? 'Expired' : `${cert.daysUntilExpiry}d` }}
              </span>
            </td>
            <td>
              <span :class="['renewal-badge', renewalBadgeClass(cert.renewalStatus)]">
                {{ cert.renewalStatus === 'auto-managed' ? 'Auto' : 'Manual' }}
              </span>
            </td>
            <td>
              <span :class="['status-dot', cert.isValid ? 'valid' : 'invalid']"></span>
              {{ cert.isValid ? 'Valid' : 'Invalid' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ssl-view h2 {
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

/* Status dashboard */
.status-dashboard {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.stat-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  text-align: center;
  min-width: 100px;
}

.stat-warning-card {
  border-color: rgba(234, 179, 8, 0.4);
}

.stat-danger-card {
  border-color: rgba(239, 68, 68, 0.4);
}

.stat-number {
  display: block;
  font-size: 1.5rem;
  font-weight: 700;
}

.stat-auto { color: var(--color-primary); }
.stat-manual { color: var(--color-text-muted); }
.stat-warning { color: #a16207; }
.stat-danger { color: var(--color-danger); }

.stat-label {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.025em;
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

.form-group input[type="file"] {
  font-size: 0.8125rem;
  color: var(--color-text);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
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

.domain-cell {
  font-weight: 500;
}

/* Badges */
.expiry-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
}

.expiry-ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.expiry-warning { background: rgba(234, 179, 8, 0.15); color: #a16207; }
.expiry-critical { background: rgba(239, 68, 68, 0.15); color: #dc2626; }
.expiry-expired { background: rgba(239, 68, 68, 0.25); color: #dc2626; }

.renewal-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
}

.renewal-auto { background: rgba(99, 102, 241, 0.15); color: var(--color-primary); }
.renewal-manual { background: rgba(148, 163, 184, 0.15); color: var(--color-text-muted); }

/* Status dot */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 0.375rem;
}

.status-dot.valid { background: #16a34a; }
.status-dot.invalid { background: var(--color-danger); }

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
