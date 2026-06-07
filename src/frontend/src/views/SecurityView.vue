<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

interface SecurityScore {
  overall: number;
  firewallScore: number;
  ipsScore: number;
  scanScore: number;
  lastScanDate: string | null;
}

interface FirewallRule {
  id: string;
  port: number;
  protocol: 'tcp' | 'udp';
  source: string;
  action: 'allow' | 'deny';
  description?: string;
}

interface BannedIP {
  ip: string;
  jail: string;
  banTime: string;
  expiry: string | null;
}

interface ScanResult {
  id: string;
  timestamp: string;
  score: number;
  findingCount: number;
  findings: ScanFinding[];
}

interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  affectedResource: string;
  remediation: string;
}

const authStore = useAuthStore();

// State
const score = ref<SecurityScore | null>(null);
const firewallRules = ref<FirewallRule[]>([]);
const bannedIPs = ref<BannedIP[]>([]);
const scanReport = ref<ScanResult | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

// Firewall form
const showRuleForm = ref(false);
const editingRuleId = ref<string | null>(null);
const formPort = ref<number>(0);
const formProtocol = ref<'tcp' | 'udp'>('tcp');
const formSource = ref('0.0.0.0/0');
const formAction = ref<'allow' | 'deny'>('allow');
const formDescription = ref('');
const isSavingRule = ref(false);

// Ban form
const showBanForm = ref(false);
const formBanIp = ref('');
const formBanDuration = ref(3600);

// Scan state
const isScanning = ref(false);

// Hardening
const isHardening = ref(false);

// Confirm dialog
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
let pendingAction: (() => Promise<void>) | null = null;

const scoreColor = computed(() => {
  if (!score.value) return 'var(--color-text-muted)';
  const s = score.value.overall;
  if (s >= 80) return '#16a34a';
  if (s >= 60) return '#ca8a04';
  if (s >= 40) return '#ea580c';
  return '#dc2626';
});

const scoreLabel = computed(() => {
  if (!score.value) return 'N/A';
  const s = score.value.overall;
  if (s >= 80) return 'Good';
  if (s >= 60) return 'Fair';
  if (s >= 40) return 'Needs Improvement';
  return 'Critical';
});

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function fetchScore(): Promise<void> {
  try {
    const res = await fetch('/api/security/score', { headers: headers() });
    if (res.ok) {
      score.value = await res.json();
    }
  } catch {
    // silent
  }
}

async function fetchFirewallRules(): Promise<void> {
  try {
    const res = await fetch('/api/security/firewall', { headers: headers() });
    if (res.ok) {
      firewallRules.value = await res.json();
    }
  } catch {
    // silent
  }
}

async function fetchBannedIPs(): Promise<void> {
  try {
    const res = await fetch('/api/security/bans', { headers: headers() });
    if (res.ok) {
      bannedIPs.value = await res.json();
    }
  } catch {
    // silent
  }
}

async function fetchScanReport(): Promise<void> {
  try {
    const res = await fetch('/api/security/scans/latest', { headers: headers() });
    if (res.ok) {
      scanReport.value = await res.json();
    }
  } catch {
    // silent
  }
}

// Firewall CRUD
function openAddRule(): void {
  editingRuleId.value = null;
  formPort.value = 0;
  formProtocol.value = 'tcp';
  formSource.value = '0.0.0.0/0';
  formAction.value = 'allow';
  formDescription.value = '';
  showRuleForm.value = true;
}

function openEditRule(rule: FirewallRule): void {
  editingRuleId.value = rule.id;
  formPort.value = rule.port;
  formProtocol.value = rule.protocol;
  formSource.value = rule.source;
  formAction.value = rule.action;
  formDescription.value = rule.description ?? '';
  showRuleForm.value = true;
}

function cancelRuleForm(): void {
  showRuleForm.value = false;
  editingRuleId.value = null;
}

async function submitRule(): Promise<void> {
  isSavingRule.value = true;
  error.value = null;

  const payload = {
    port: formPort.value,
    protocol: formProtocol.value,
    source: formSource.value,
    action: formAction.value,
    description: formDescription.value || undefined,
  };

  try {
    if (editingRuleId.value) {
      const res = await fetch(`/api/security/firewall/${editingRuleId.value}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to update rule');
      }
    } else {
      const res = await fetch('/api/security/firewall', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to add rule');
      }
    }
    showRuleForm.value = false;
    editingRuleId.value = null;
    await fetchFirewallRules();
    await fetchScore();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isSavingRule.value = false;
  }
}

function requestDeleteRule(id: string): void {
  confirmTitle.value = 'Delete Firewall Rule';
  confirmMessage.value = 'Are you sure you want to delete this firewall rule? This will take effect immediately.';
  pendingAction = async () => {
    try {
      const res = await fetch(`/api/security/firewall/${id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) throw new Error('Failed to delete rule');
      await fetchFirewallRules();
      await fetchScore();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    }
  };
  confirmOpen.value = true;
}

// Ban/Unban
async function submitBan(): Promise<void> {
  error.value = null;
  try {
    const res = await fetch('/api/security/bans', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ip: formBanIp.value, duration: formBanDuration.value }),
    });
    if (!res.ok) throw new Error('Failed to ban IP');
    showBanForm.value = false;
    formBanIp.value = '';
    await fetchBannedIPs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to ban IP';
  }
}

async function unbanIP(ip: string): Promise<void> {
  error.value = null;
  try {
    const res = await fetch(`/api/security/bans/${encodeURIComponent(ip)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to unban IP');
    await fetchBannedIPs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to unban';
  }
}

// Scan
async function triggerScan(): Promise<void> {
  isScanning.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/security/scans', {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) throw new Error('Failed to trigger scan');
    // Poll for result
    setTimeout(async () => {
      await fetchScanReport();
      await fetchScore();
      isScanning.value = false;
    }, 5000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Scan failed';
    isScanning.value = false;
  }
}

// Hardening
function requestHardening(): void {
  confirmTitle.value = 'Apply Security Hardening';
  confirmMessage.value =
    'This will disable SSH password auth, disable root login, enable auto security updates, apply restrictive firewall defaults, and enable IPS. This action affects the entire server. Continue?';
  pendingAction = async () => {
    isHardening.value = true;
    try {
      const res = await fetch('/api/security/hardening', {
        method: 'POST',
        headers: headers(),
      });
      if (!res.ok) throw new Error('Hardening failed');
      await fetchScore();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Hardening failed';
    } finally {
      isHardening.value = false;
    }
  };
  confirmOpen.value = true;
}

async function handleConfirm(): Promise<void> {
  confirmOpen.value = false;
  if (pendingAction) {
    await pendingAction();
    pendingAction = null;
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function severityClass(severity: string): string {
  if (severity === 'critical') return 'severity-critical';
  if (severity === 'high') return 'severity-high';
  if (severity === 'medium') return 'severity-medium';
  return 'severity-low';
}

onMounted(async () => {
  isLoading.value = true;
  await Promise.all([fetchScore(), fetchFirewallRules(), fetchBannedIPs(), fetchScanReport()]);
  isLoading.value = false;
});
</script>

<template>
  <div class="security-view">
    <h2>Security Manager</h2>

    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <p v-if="isLoading" class="muted">Loading security data...</p>

    <!-- Security Score -->
    <section v-if="score" class="score-section">
      <div class="score-card">
        <div class="score-circle" :style="{ borderColor: scoreColor }">
          <span class="score-value" :style="{ color: scoreColor }">{{ score.overall }}</span>
          <span class="score-unit">/100</span>
        </div>
        <div class="score-details">
          <span class="score-label" :style="{ color: scoreColor }">{{ scoreLabel }}</span>
          <div class="score-breakdown">
            <span>Firewall: {{ score.firewallScore }}%</span>
            <span>IPS: {{ score.ipsScore }}%</span>
            <span>Scan: {{ score.scanScore }}%</span>
          </div>
          <span v-if="score.lastScanDate" class="last-scan">Last scan: {{ formatTimestamp(score.lastScanDate) }}</span>
        </div>
      </div>
      <div class="score-actions">
        <button class="btn btn-primary" :disabled="isScanning" @click="triggerScan">
          {{ isScanning ? 'Scanning...' : 'Run Security Scan' }}
        </button>
        <button class="btn btn-warning" :disabled="isHardening" @click="requestHardening">
          {{ isHardening ? 'Applying...' : 'One-Click Hardening' }}
        </button>
      </div>
    </section>

    <!-- Firewall Rules -->
    <section class="card">
      <div class="card-header">
        <h3>Firewall Rules</h3>
        <button class="btn btn-primary btn-sm" @click="openAddRule">+ Add Rule</button>
      </div>

      <!-- Rule Form -->
      <div v-if="showRuleForm" class="inline-form-card">
        <form @submit.prevent="submitRule">
          <div class="form-row">
            <div class="form-group">
              <label for="fw-port">Port</label>
              <input id="fw-port" v-model.number="formPort" type="number" min="1" max="65535" required />
            </div>
            <div class="form-group">
              <label for="fw-protocol">Protocol</label>
              <select id="fw-protocol" v-model="formProtocol">
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </div>
            <div class="form-group">
              <label for="fw-source">Source (IP/CIDR)</label>
              <input id="fw-source" v-model="formSource" type="text" placeholder="0.0.0.0/0" required />
            </div>
            <div class="form-group">
              <label for="fw-action">Action</label>
              <select id="fw-action" v-model="formAction">
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label for="fw-desc">Description (optional)</label>
            <input id="fw-desc" v-model="formDescription" type="text" placeholder="Rule description" />
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary btn-sm" @click="cancelRuleForm">Cancel</button>
            <button type="submit" class="btn btn-primary btn-sm" :disabled="isSavingRule">
              {{ isSavingRule ? 'Saving...' : (editingRuleId ? 'Update' : 'Add') }}
            </button>
          </div>
        </form>
      </div>

      <p v-if="firewallRules.length === 0 && !showRuleForm" class="muted">No firewall rules configured.</p>
      <div v-else-if="firewallRules.length > 0" class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Port</th>
              <th>Protocol</th>
              <th>Source</th>
              <th>Action</th>
              <th>Description</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in firewallRules" :key="rule.id">
              <td class="monospace">{{ rule.port }}</td>
              <td>{{ rule.protocol.toUpperCase() }}</td>
              <td class="monospace">{{ rule.source }}</td>
              <td>
                <span :class="['action-badge', rule.action === 'allow' ? 'badge-success' : 'badge-danger']">
                  {{ rule.action }}
                </span>
              </td>
              <td class="desc-cell">{{ rule.description ?? '—' }}</td>
              <td class="actions-cell">
                <button class="btn-icon" title="Edit" @click="openEditRule(rule)">✏️</button>
                <button class="btn-icon" title="Delete" @click="requestDeleteRule(rule.id)">🗑️</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Ban List -->
    <section class="card">
      <div class="card-header">
        <h3>Banned IPs</h3>
        <button class="btn btn-primary btn-sm" @click="showBanForm = !showBanForm">+ Manual Ban</button>
      </div>

      <!-- Ban Form -->
      <div v-if="showBanForm" class="inline-form-card">
        <form @submit.prevent="submitBan">
          <div class="form-row">
            <div class="form-group">
              <label for="ban-ip">IP Address</label>
              <input id="ban-ip" v-model="formBanIp" type="text" placeholder="192.168.1.100" required />
            </div>
            <div class="form-group">
              <label for="ban-duration">Duration (seconds)</label>
              <input id="ban-duration" v-model.number="formBanDuration" type="number" min="60" required />
            </div>
            <div class="form-group form-group-btn">
              <button type="submit" class="btn btn-primary btn-sm">Ban</button>
              <button type="button" class="btn btn-secondary btn-sm" @click="showBanForm = false">Cancel</button>
            </div>
          </div>
        </form>
      </div>

      <p v-if="bannedIPs.length === 0 && !showBanForm" class="muted">No banned IPs.</p>
      <div v-else-if="bannedIPs.length > 0" class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>IP Address</th>
              <th>Jail</th>
              <th>Ban Time</th>
              <th>Expiry</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ban in bannedIPs" :key="ban.ip">
              <td class="monospace">{{ ban.ip }}</td>
              <td>{{ ban.jail }}</td>
              <td class="timestamp-cell">{{ formatTimestamp(ban.banTime) }}</td>
              <td class="timestamp-cell">{{ ban.expiry ? formatTimestamp(ban.expiry) : 'Permanent' }}</td>
              <td>
                <button class="btn btn-sm btn-secondary" @click="unbanIP(ban.ip)">Unban</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Scan Report -->
    <section v-if="scanReport" class="card">
      <h3>Latest Scan Report</h3>
      <div class="scan-meta">
        <span>Score: <strong>{{ scanReport.score }}/100</strong></span>
        <span>Findings: <strong>{{ scanReport.findingCount }}</strong></span>
        <span class="timestamp-cell">{{ formatTimestamp(scanReport.timestamp) }}</span>
      </div>
      <div v-if="scanReport.findings.length > 0" class="findings-list">
        <div v-for="(finding, idx) in scanReport.findings" :key="idx" class="finding-item">
          <span :class="['severity-badge', severityClass(finding.severity)]">{{ finding.severity }}</span>
          <div class="finding-body">
            <p class="finding-desc">{{ finding.description }}</p>
            <p class="finding-resource">Resource: <code>{{ finding.affectedResource }}</code></p>
            <p class="finding-fix">Fix: {{ finding.remediation }}</p>
          </div>
        </div>
      </div>
      <p v-else class="muted">No findings — system appears secure.</p>
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      confirm-label="Confirm"
      :danger="true"
      @confirm="handleConfirm"
      @cancel="confirmOpen = false"
    />
  </div>
</template>

<style scoped>
.security-view h2 {
  margin-bottom: 1.5rem;
}

.security-view h3 {
  margin: 0;
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

/* Score Section */
.score-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.score-card {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}

.score-circle {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 4px solid;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.score-value {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
}

.score-unit {
  font-size: 0.7rem;
  color: var(--color-text-muted);
}

.score-details {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.score-label {
  font-weight: 600;
  font-size: 1rem;
}

.score-breakdown {
  display: flex;
  gap: 1rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.last-scan {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.score-actions {
  display: flex;
  gap: 0.75rem;
}

/* Cards */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.inline-form-card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  padding: 1rem;
  margin-bottom: 1rem;
}

/* Form */
.form-group {
  flex: 1;
  margin-bottom: 0.5rem;
}

.form-group label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
  color: var(--color-text-muted);
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 0.4rem 0.6rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  color: var(--color-text);
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--color-primary);
}

.form-group-btn {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding-bottom: 0.5rem;
}

.form-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

/* Table */
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

.monospace {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.8125rem;
}

.timestamp-cell {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.desc-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions-cell {
  white-space: nowrap;
}

/* Badges */
.action-badge {
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

/* Buttons */
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

.btn-warning {
  background: #ea580c;
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

/* Scan Report */
.scan-meta {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  margin: 1rem 0;
  font-size: 0.8125rem;
}

.findings-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.finding-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
}

.severity-badge {
  padding: 0.2rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  white-space: nowrap;
  height: fit-content;
}

.severity-critical {
  background: rgba(220, 38, 38, 0.15);
  color: #dc2626;
}

.severity-high {
  background: rgba(234, 88, 12, 0.15);
  color: #ea580c;
}

.severity-medium {
  background: rgba(234, 179, 8, 0.15);
  color: #a16207;
}

.severity-low {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
}

.finding-body {
  flex: 1;
}

.finding-desc {
  font-size: 0.8125rem;
  margin-bottom: 0.25rem;
}

.finding-resource {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-bottom: 0.25rem;
}

.finding-resource code {
  background: var(--color-surface);
  padding: 0.1rem 0.3rem;
  border-radius: 0.2rem;
  font-size: 0.75rem;
}

.finding-fix {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-style: italic;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}
</style>
