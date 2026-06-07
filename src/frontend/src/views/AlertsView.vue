<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAlertsStore } from '@/stores/alerts';
import type { AlertChannel, AlertRule } from '@/stores/alerts';

const alertsStore = useAlertsStore();

const activeTab = ref<'history' | 'channels' | 'rules'>('history');

// Channel form
const showChannelForm = ref(false);
const editingChannel = ref<Partial<AlertChannel>>({
  type: 'email',
  config: {},
  enabled: true,
});

// Rule form
const showRuleForm = ref(false);
const editingRule = ref<Partial<AlertRule>>({
  resourceType: 'cpu',
  threshold: 90,
  consecutiveChecks: 3,
  enabled: true,
});

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function getDeliveryStatusText(status: Record<string, string>): string {
  if (!status || Object.keys(status).length === 0) return '—';
  return Object.entries(status)
    .map(([channel, s]) => `${channel}: ${s}`)
    .join(', ');
}

// Channel management
function openAddChannel(): void {
  editingChannel.value = { type: 'email', config: {}, enabled: true };
  showChannelForm.value = true;
}

function openEditChannel(channel: AlertChannel): void {
  editingChannel.value = { ...channel, config: { ...channel.config } };
  showChannelForm.value = true;
}

async function saveChannel(): Promise<void> {
  await alertsStore.saveChannel(editingChannel.value as AlertChannel);
  showChannelForm.value = false;
}

async function removeChannel(id: string): Promise<void> {
  await alertsStore.deleteChannel(id);
}

// Rule management
function openAddRule(): void {
  editingRule.value = { resourceType: 'cpu', threshold: 90, consecutiveChecks: 3, enabled: true };
  showRuleForm.value = true;
}

function openEditRule(rule: AlertRule): void {
  editingRule.value = { ...rule };
  showRuleForm.value = true;
}

async function saveRule(): Promise<void> {
  await alertsStore.saveRule(editingRule.value as AlertRule);
  showRuleForm.value = false;
}

async function removeRule(id: string): Promise<void> {
  await alertsStore.deleteRule(id);
}

function getChannelConfigLabel(channel: AlertChannel): string {
  switch (channel.type) {
    case 'email':
      return channel.config.to ?? channel.config.smtp_host ?? 'Email';
    case 'webhook':
      return channel.config.url ?? 'Webhook';
    case 'in-app':
      return 'In-App Notifications';
    default:
      return channel.type;
  }
}

onMounted(() => {
  alertsStore.fetchAlerts();
  alertsStore.fetchRules();
  alertsStore.fetchChannels();
});
</script>

<template>
  <div class="alerts-view">
    <h2>Alerts</h2>

    <!-- Tabs -->
    <div class="tabs">
      <button
        :class="['tab', { active: activeTab === 'history' }]"
        @click="activeTab = 'history'"
      >
        History
      </button>
      <button
        :class="['tab', { active: activeTab === 'channels' }]"
        @click="activeTab = 'channels'"
      >
        Channels
      </button>
      <button
        :class="['tab', { active: activeTab === 'rules' }]"
        @click="activeTab = 'rules'"
      >
        Rules
      </button>
    </div>

    <!-- Alert History Tab -->
    <div v-if="activeTab === 'history'" class="tab-content">
      <p v-if="alertsStore.isLoading" class="muted">Loading alerts...</p>
      <p v-else-if="alertsStore.alerts.length === 0" class="empty-state">
        No alert events recorded.
      </p>
      <div v-else class="alerts-table">
        <div class="table-header">
          <span class="col-timestamp">Timestamp</span>
          <span class="col-type">Event Type</span>
          <span class="col-resource">Resource</span>
          <span class="col-severity">Severity</span>
          <span class="col-delivery">Delivery Status</span>
        </div>
        <div
          v-for="alert in alertsStore.alerts"
          :key="alert.id"
          class="table-row"
        >
          <span class="col-timestamp">{{ formatTimestamp(alert.timestamp) }}</span>
          <span class="col-type">{{ alert.eventType }}</span>
          <span class="col-resource">{{ alert.affectedResource }}</span>
          <span class="col-severity">
            <span :class="['severity-badge', alert.severity]">{{ alert.severity }}</span>
          </span>
          <span class="col-delivery">{{ getDeliveryStatusText(alert.deliveryStatus) }}</span>
        </div>
      </div>
      <p class="history-note">Showing last 500 events</p>
    </div>

    <!-- Channels Tab -->
    <div v-if="activeTab === 'channels'" class="tab-content">
      <div class="section-header">
        <h3>Notification Channels</h3>
        <button class="btn-add" @click="openAddChannel">+ Add Channel</button>
      </div>

      <p v-if="alertsStore.channels.length === 0" class="empty-state">
        No notification channels configured.
      </p>

      <div v-else class="channel-list">
        <div
          v-for="channel in alertsStore.channels"
          :key="channel.id"
          class="channel-card"
        >
          <div class="channel-info">
            <span :class="['channel-type-badge', channel.type]">{{ channel.type }}</span>
            <span class="channel-label">{{ getChannelConfigLabel(channel) }}</span>
            <span v-if="!channel.enabled" class="channel-disabled">Disabled</span>
          </div>
          <div class="channel-actions">
            <button class="btn-edit" @click="openEditChannel(channel)">Edit</button>
            <button class="btn-remove" @click="removeChannel(channel.id)">Remove</button>
          </div>
        </div>
      </div>

      <!-- Channel Form Modal -->
      <div v-if="showChannelForm" class="form-overlay">
        <div class="form-modal">
          <h4>{{ editingChannel.id ? 'Edit Channel' : 'Add Channel' }}</h4>
          <div class="form-group">
            <label for="channel-type">Type</label>
            <select id="channel-type" v-model="editingChannel.type" class="form-input">
              <option value="email">Email (SMTP)</option>
              <option value="webhook">Webhook</option>
              <option value="in-app">In-App</option>
            </select>
          </div>

          <!-- Email config fields -->
          <template v-if="editingChannel.type === 'email'">
            <div class="form-group">
              <label for="smtp-host">SMTP Host</label>
              <input id="smtp-host" v-model="editingChannel.config!.smtp_host" type="text" class="form-input" placeholder="smtp.example.com" />
            </div>
            <div class="form-group">
              <label for="smtp-port">SMTP Port</label>
              <input id="smtp-port" v-model="editingChannel.config!.smtp_port" type="text" class="form-input" placeholder="587" />
            </div>
            <div class="form-group">
              <label for="smtp-user">SMTP User</label>
              <input id="smtp-user" v-model="editingChannel.config!.smtp_user" type="text" class="form-input" placeholder="user@example.com" />
            </div>
            <div class="form-group">
              <label for="smtp-pass">SMTP Password</label>
              <input id="smtp-pass" v-model="editingChannel.config!.smtp_pass" type="password" class="form-input" />
            </div>
            <div class="form-group">
              <label for="email-to">Recipient</label>
              <input id="email-to" v-model="editingChannel.config!.to" type="email" class="form-input" placeholder="admin@example.com" />
            </div>
          </template>

          <!-- Webhook config fields -->
          <template v-if="editingChannel.type === 'webhook'">
            <div class="form-group">
              <label for="webhook-url">Webhook URL</label>
              <input id="webhook-url" v-model="editingChannel.config!.url" type="url" class="form-input" placeholder="https://hooks.slack.com/..." />
            </div>
            <div class="form-group">
              <label for="webhook-format">Format</label>
              <select id="webhook-format" v-model="editingChannel.config!.format" class="form-input">
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="generic">Generic JSON</option>
              </select>
            </div>
          </template>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="editingChannel.enabled" />
              Enabled
            </label>
          </div>

          <div class="form-actions">
            <button class="btn-save" @click="saveChannel">Save</button>
            <button class="btn-cancel-form" @click="showChannelForm = false">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Rules Tab -->
    <div v-if="activeTab === 'rules'" class="tab-content">
      <div class="section-header">
        <h3>Alert Rules</h3>
        <button class="btn-add" @click="openAddRule">+ Add Rule</button>
      </div>

      <p v-if="alertsStore.rules.length === 0" class="empty-state">
        No alert rules configured.
      </p>

      <div v-else class="rules-list">
        <div
          v-for="rule in alertsStore.rules"
          :key="rule.id"
          class="rule-card"
        >
          <div class="rule-info">
            <span class="rule-resource">{{ rule.resourceType }}</span>
            <span class="rule-threshold" v-if="rule.threshold != null">
              Threshold: {{ rule.threshold }}%
            </span>
            <span class="rule-checks" v-if="rule.consecutiveChecks">
              × {{ rule.consecutiveChecks }} checks
            </span>
            <span v-if="!rule.enabled" class="rule-disabled">Disabled</span>
          </div>
          <div class="rule-actions">
            <button class="btn-edit" @click="openEditRule(rule)">Edit</button>
            <button class="btn-remove" @click="removeRule(rule.id)">Remove</button>
          </div>
        </div>
      </div>

      <!-- Rule Form Modal -->
      <div v-if="showRuleForm" class="form-overlay">
        <div class="form-modal">
          <h4>{{ editingRule.id ? 'Edit Rule' : 'Add Rule' }}</h4>
          <div class="form-group">
            <label for="rule-resource">Resource Type</label>
            <select id="rule-resource" v-model="editingRule.resourceType" class="form-input">
              <option value="cpu">CPU</option>
              <option value="memory">Memory</option>
              <option value="disk">Disk</option>
              <option value="container-health">Container Health</option>
            </select>
          </div>
          <div class="form-group">
            <label for="rule-threshold">Threshold (%)</label>
            <input id="rule-threshold" v-model.number="editingRule.threshold" type="number" min="0" max="100" class="form-input" />
          </div>
          <div class="form-group">
            <label for="rule-checks">Consecutive Checks</label>
            <input id="rule-checks" v-model.number="editingRule.consecutiveChecks" type="number" min="1" max="10" class="form-input" />
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="editingRule.enabled" />
              Enabled
            </label>
          </div>
          <div class="form-actions">
            <button class="btn-save" @click="saveRule">Save</button>
            <button class="btn-cancel-form" @click="showRuleForm = false">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alerts-view h2 {
  margin-bottom: 1.5rem;
}

.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--color-border);
}

.tab {
  padding: 0.625rem 1.25rem;
  font-size: 0.875rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.tab:hover {
  color: var(--color-text);
}

.tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.tab-content {
  min-height: 200px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-header h3 {
  font-size: 1rem;
  font-weight: 600;
}

.btn-add {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-add:hover {
  background: var(--color-primary-hover);
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  background: var(--color-surface);
  padding: 2rem;
  border-radius: 0.5rem;
  border: 1px dashed var(--color-border);
  text-align: center;
}

/* Alert history table */
.alerts-table {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow-x: auto;
}

.table-header,
.table-row {
  display: grid;
  grid-template-columns: 170px 140px 1fr 100px 200px;
  padding: 0.75rem 1rem;
  align-items: center;
  min-width: max-content;
}

.table-header {
  background: var(--color-surface-hover);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}

.table-row {
  border-top: 1px solid var(--color-border);
  font-size: 0.8125rem;
}

.table-row:hover {
  background: var(--color-surface-hover);
}

.col-timestamp {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-family: monospace;
}

.col-delivery {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.severity-badge {
  display: inline-block;
  font-size: 0.6875rem;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-weight: 600;
}

.severity-badge.critical {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.severity-badge.high {
  background: rgba(245, 158, 11, 0.15);
  color: var(--color-warning);
}

.severity-badge.medium {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.severity-badge.low {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
}

.history-note {
  text-align: center;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-top: 0.75rem;
}

/* Channel list */
.channel-list,
.rules-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.channel-card,
.rule-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
}

.channel-info,
.rule-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.channel-type-badge {
  font-size: 0.6875rem;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-weight: 600;
}

.channel-type-badge.email {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.channel-type-badge.webhook {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.channel-type-badge.in-app {
  background: rgba(245, 158, 11, 0.15);
  color: var(--color-warning);
}

.channel-label {
  font-size: 0.875rem;
}

.channel-disabled,
.rule-disabled {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  background: rgba(148, 163, 184, 0.1);
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
}

.rule-resource {
  font-weight: 500;
  font-size: 0.875rem;
  text-transform: capitalize;
}

.rule-threshold,
.rule-checks {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.channel-actions,
.rule-actions {
  display: flex;
  gap: 0.375rem;
}

.btn-edit {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: 0.25rem;
  cursor: pointer;
}

.btn-edit:hover {
  background: var(--color-surface-hover);
}

.btn-remove {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  background: transparent;
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
  border-radius: 0.25rem;
  cursor: pointer;
}

.btn-remove:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Form modal */
.form-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.form-modal {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.5rem;
  width: 100%;
  max-width: 420px;
}

.form-modal h4 {
  margin-bottom: 1rem;
  font-size: 1rem;
}

.form-group {
  margin-bottom: 0.75rem;
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  margin-bottom: 0.25rem;
}

.form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text);
  font-size: 0.875rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--color-text);
  cursor: pointer;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.btn-save {
  padding: 0.5rem 1rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-save:hover {
  background: var(--color-primary-hover);
}

.btn-cancel-form {
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-cancel-form:hover {
  background: var(--color-surface-hover);
}
</style>
