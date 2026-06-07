/**
 * Alert System Module
 *
 * Event-driven alert system with multi-channel delivery (email, webhook, in-app),
 * alert rules with resource thresholds and consecutive check logic,
 * exponential backoff retry for webhooks, and alert history.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export type AlertChannelType = 'email' | 'webhook' | 'in-app';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertResourceType = 'cpu' | 'memory' | 'disk' | 'container-health';
export type DeliveryStatus = 'delivered' | 'failed' | 'pending' | 'retrying';

export interface AlertChannel {
  id?: string;
  type: AlertChannelType;
  config: Record<string, string>;
  enabled?: boolean;
}

export interface AlertRule {
  id?: string;
  resourceType: AlertResourceType;
  threshold?: number;
  consecutiveChecks?: number;
  enabled?: boolean;
}

export interface AlertEvent {
  eventType: string;
  affectedResource: string;
  severity: AlertSeverity;
  message: string;
}

export interface AlertRecord {
  id: string;
  timestamp: string;
  eventType: string;
  affectedResource: string;
  severity: AlertSeverity;
  deliveryStatus: Record<string, DeliveryStatus>;
  message: string;
}

export interface AlertSystem {
  /** Configure a notification channel (email/webhook/in-app) */
  configureChannel(channel: AlertChannel): Promise<string>;
  /** Configure an alert rule with resource thresholds */
  configureRule(rule: AlertRule): Promise<string>;
  /** Emit an alert event and deliver to all configured channels */
  emitAlert(event: AlertEvent): Promise<string>;
  /** Get the last 500 alert events */
  getAlertHistory(): Promise<AlertRecord[]>;
  /** Record a metric value for threshold-based alert checking */
  recordMetric(resourceType: AlertResourceType, resource: string, value: number): Promise<void>;
  /** Get configured channels */
  getChannels(): AlertChannel[];
  /** Get configured rules */
  getRules(): AlertRule[];
  /** Remove a channel by ID */
  removeChannel(id: string): void;
  /** Remove a rule by ID */
  removeRule(id: string): void;
}

export interface AlertSystemConfig {
  /** Maximum number of alert history entries to keep. Default: 500 */
  maxHistorySize?: number;
  /** Webhook timeout in milliseconds. Default: 10000 (10 seconds) */
  webhookTimeoutMs?: number;
  /** Webhook retry delays in milliseconds. Default: [5000, 15000, 45000] */
  webhookRetryDelaysMs?: number[];
  /** Callback for in-app notifications (e.g., Socket.IO emit) */
  onInAppNotification?: (alert: AlertRecord) => void;
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface AlertChannelRow {
  id: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
}

interface AlertRuleRow {
  id: string;
  resource_type: string;
  threshold: number | null;
  consecutive_checks: number;
  enabled: number;
  created_at: string;
}

interface AlertRow {
  id: string;
  timestamp: string;
  event_type: string;
  affected_resource: string;
  severity: string;
  delivery_status: string | null;
  message: string | null;
}

/** Tracks consecutive threshold breaches per resource+rule */
interface ThresholdTracker {
  count: number;
  lastValue: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY_SIZE = 500;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const DEFAULT_CONSECUTIVE_CHECKS = 3;

// ─── Implementation ────────────────────────────────────────────────────────────

export function createAlertSystem(
  db: Database.Database,
  config?: AlertSystemConfig
): AlertSystem {
  const maxHistorySize = config?.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;
  const webhookTimeoutMs = config?.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const webhookRetryDelaysMs = config?.webhookRetryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
  const onInAppNotification = config?.onInAppNotification;

  // Consecutive threshold breach tracker: key is `${ruleId}:${resource}`
  const thresholdTrackers = new Map<string, ThresholdTracker>();

  // ─── Prepared Statements ───────────────────────────────────────────────

  const insertChannel = db.prepare(
    `INSERT INTO alert_channels (id, type, config, enabled) VALUES (?, ?, ?, ?)`
  );

  const updateChannel = db.prepare(
    `UPDATE alert_channels SET type = ?, config = ?, enabled = ? WHERE id = ?`
  );

  const deleteChannel = db.prepare(`DELETE FROM alert_channels WHERE id = ?`);

  const getAllChannels = db.prepare(
    `SELECT * FROM alert_channels WHERE enabled = 1`
  );

  const getAllChannelsIncludingDisabled = db.prepare(
    `SELECT * FROM alert_channels`
  );

  const insertRule = db.prepare(
    `INSERT INTO alert_rules (id, resource_type, threshold, consecutive_checks, enabled) VALUES (?, ?, ?, ?, ?)`
  );

  const updateRule = db.prepare(
    `UPDATE alert_rules SET resource_type = ?, threshold = ?, consecutive_checks = ?, enabled = ? WHERE id = ?`
  );

  const deleteRule = db.prepare(`DELETE FROM alert_rules WHERE id = ?`);

  const getAllRules = db.prepare(`SELECT * FROM alert_rules`);

  const getEnabledRulesByResourceType = db.prepare(
    `SELECT * FROM alert_rules WHERE resource_type = ? AND enabled = 1`
  );

  const insertAlert = db.prepare(
    `INSERT INTO alerts (id, timestamp, event_type, affected_resource, severity, delivery_status, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const getAlertHistoryStmt = db.prepare(
    `SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`
  );

  const getAlertCount = db.prepare(`SELECT COUNT(*) as count FROM alerts`);

  const pruneOldAlerts = db.prepare(
    `DELETE FROM alerts WHERE id IN (
      SELECT id FROM alerts ORDER BY timestamp DESC LIMIT -1 OFFSET ?
    )`
  );

  // ─── Channel Configuration ─────────────────────────────────────────────

  async function configureChannel(channel: AlertChannel): Promise<string> {
    const id = channel.id ?? uuidv4();
    const enabled = channel.enabled !== false ? 1 : 0;
    const configJson = JSON.stringify(channel.config);

    if (channel.id) {
      // Update existing channel
      const existing = db.prepare('SELECT id FROM alert_channels WHERE id = ?').get(channel.id);
      if (existing) {
        updateChannel.run(channel.type, configJson, enabled, channel.id);
        return channel.id;
      }
    }

    insertChannel.run(id, channel.type, configJson, enabled);
    return id;
  }

  // ─── Rule Configuration ─────────────────────────────────────────────────

  async function configureRule(rule: AlertRule): Promise<string> {
    const id = rule.id ?? uuidv4();
    const consecutiveChecks = rule.consecutiveChecks ?? DEFAULT_CONSECUTIVE_CHECKS;
    const enabled = rule.enabled !== false ? 1 : 0;

    if (rule.id) {
      const existing = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(rule.id);
      if (existing) {
        updateRule.run(rule.resourceType, rule.threshold ?? null, consecutiveChecks, enabled, rule.id);
        return rule.id;
      }
    }

    insertRule.run(id, rule.resourceType, rule.threshold ?? null, consecutiveChecks, enabled);
    return id;
  }

  // ─── Alert Emission ─────────────────────────────────────────────────────

  async function emitAlert(event: AlertEvent): Promise<string> {
    const id = uuidv4();
    const timestamp = new Date().toISOString();

    // Get all enabled channels
    const channels = getAllChannels.all() as AlertChannelRow[];

    // Deliver to all channels independently
    const deliveryStatus: Record<string, DeliveryStatus> = {};

    // Launch all deliveries in parallel (independent failures)
    const deliveryPromises = channels.map(async (channel) => {
      try {
        await deliverToChannel(channel, event);
        deliveryStatus[channel.id] = 'delivered';
      } catch {
        deliveryStatus[channel.id] = 'failed';
      }
    });

    // Wait for all deliveries (with 30-second overall deadline)
    await Promise.race([
      Promise.allSettled(deliveryPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);

    // Mark any still-pending channels
    for (const channel of channels) {
      if (!deliveryStatus[channel.id]) {
        deliveryStatus[channel.id] = 'pending';
      }
    }

    // Persist the alert record
    const alertRecord: AlertRecord = {
      id,
      timestamp,
      eventType: event.eventType,
      affectedResource: event.affectedResource,
      severity: event.severity,
      deliveryStatus,
      message: event.message,
    };

    insertAlert.run(
      id,
      timestamp,
      event.eventType,
      event.affectedResource,
      event.severity,
      JSON.stringify(deliveryStatus),
      event.message
    );

    // Prune history if needed
    pruneHistory();

    // In-app notification callback
    if (onInAppNotification) {
      onInAppNotification(alertRecord);
    }

    return id;
  }

  // ─── Channel Delivery ───────────────────────────────────────────────────

  async function deliverToChannel(channel: AlertChannelRow, event: AlertEvent): Promise<void> {
    const channelConfig = JSON.parse(channel.config) as Record<string, string>;

    switch (channel.type) {
      case 'email':
        await deliverEmail(channelConfig, event);
        break;
      case 'webhook':
        await deliverWebhook(channelConfig, event);
        break;
      case 'in-app':
        // In-app notifications are handled via the callback in emitAlert
        break;
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  // ─── Email Delivery (SMTP via nodemailer) ───────────────────────────────

  async function deliverEmail(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Promise<void> {
    const transport = nodemailer.createTransport({
      host: channelConfig.host,
      port: parseInt(channelConfig.port ?? '587', 10),
      secure: channelConfig.secure === 'true',
      auth: channelConfig.user
        ? {
            user: channelConfig.user,
            pass: channelConfig.pass ?? '',
          }
        : undefined,
    });

    const severityLabel = event.severity.toUpperCase();
    const subject = `[${severityLabel}] Alert: ${event.eventType} - ${event.affectedResource}`;

    await transport.sendMail({
      from: channelConfig.from ?? channelConfig.user ?? 'alerts@vps-panel.local',
      to: channelConfig.to,
      subject,
      text: `Alert: ${event.eventType}\nResource: ${event.affectedResource}\nSeverity: ${event.severity}\n\n${event.message}`,
      html: `<h2>VPS Panel Alert</h2>
<p><strong>Event:</strong> ${event.eventType}</p>
<p><strong>Resource:</strong> ${event.affectedResource}</p>
<p><strong>Severity:</strong> ${event.severity}</p>
<p>${event.message}</p>`,
    });
  }

  // ─── Webhook Delivery (Slack/Discord compatible HTTP POST) ──────────────

  async function deliverWebhook(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Promise<void> {
    const url = channelConfig.url;
    if (!url) throw new Error('Webhook URL not configured');

    const payload = buildWebhookPayload(channelConfig, event);
    const maxRetries = webhookRetryDelaysMs.length;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), webhookTimeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          return; // Success
        }

        lastError = new Error(`Webhook returned status ${response.status}`);
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If this wasn't the last attempt, wait with exponential backoff
      if (attempt < maxRetries) {
        const delay = webhookRetryDelaysMs[attempt];
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Webhook delivery failed after retries');
  }

  function buildWebhookPayload(
    channelConfig: Record<string, string>,
    event: AlertEvent
  ): Record<string, unknown> {
    const format = channelConfig.format ?? 'slack';

    // Slack/Discord-compatible payload format
    if (format === 'discord' || format === 'slack') {
      const colorMap: Record<AlertSeverity, string> = {
        critical: '#dc3545',
        high: '#fd7e14',
        medium: '#ffc107',
        low: '#17a2b8',
      };

      return {
        text: `[${event.severity.toUpperCase()}] ${event.eventType}: ${event.affectedResource}`,
        attachments: [
          {
            color: colorMap[event.severity] ?? '#6c757d',
            title: `Alert: ${event.eventType}`,
            fields: [
              { title: 'Resource', value: event.affectedResource, short: true },
              { title: 'Severity', value: event.severity, short: true },
            ],
            text: event.message,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
        // Discord embeds format (works alongside Slack format for Discord webhooks)
        embeds: [
          {
            title: `[${event.severity.toUpperCase()}] ${event.eventType}`,
            description: event.message,
            color: parseInt(colorMap[event.severity]?.replace('#', '') ?? '6c757d', 16),
            fields: [
              { name: 'Resource', value: event.affectedResource, inline: true },
              { name: 'Severity', value: event.severity, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    // Generic JSON format
    return {
      eventType: event.eventType,
      affectedResource: event.affectedResource,
      severity: event.severity,
      message: event.message,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Metric Recording and Threshold Checking ───────────────────────────

  async function recordMetric(
    resourceType: AlertResourceType,
    resource: string,
    value: number
  ): Promise<void> {
    const rules = getEnabledRulesByResourceType.all(resourceType) as AlertRuleRow[];

    for (const rule of rules) {
      if (rule.threshold === null) continue;

      const key = `${rule.id}:${resource}`;
      const tracker = thresholdTrackers.get(key) ?? { count: 0, lastValue: 0 };

      if (value > rule.threshold) {
        tracker.count++;
        tracker.lastValue = value;
      } else {
        // Reset counter when value drops below threshold
        tracker.count = 0;
        tracker.lastValue = value;
      }

      thresholdTrackers.set(key, tracker);

      // Fire alert if consecutive threshold exceeded
      if (tracker.count >= rule.consecutive_checks) {
        await emitAlert({
          eventType: `${resourceType}_threshold_exceeded`,
          affectedResource: resource,
          severity: determineSeverity(resourceType, value, rule.threshold),
          message: `${resourceType} exceeded threshold: ${value.toFixed(1)}% (threshold: ${rule.threshold}%) for ${tracker.count} consecutive checks`,
        });

        // Reset the tracker after firing to avoid alert floods
        tracker.count = 0;
        thresholdTrackers.set(key, tracker);
      }
    }
  }

  function determineSeverity(
    resourceType: AlertResourceType,
    value: number,
    threshold: number
  ): AlertSeverity {
    const excess = value - threshold;
    if (excess >= 20 || value >= 95) return 'critical';
    if (excess >= 10 || value >= 90) return 'high';
    if (excess >= 5) return 'medium';
    return 'low';
  }

  // ─── Alert History ──────────────────────────────────────────────────────

  async function getAlertHistory(): Promise<AlertRecord[]> {
    const rows = getAlertHistoryStmt.all(maxHistorySize) as AlertRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      affectedResource: row.affected_resource,
      severity: row.severity as AlertSeverity,
      deliveryStatus: row.delivery_status ? JSON.parse(row.delivery_status) : {},
      message: row.message ?? '',
    }));
  }

  function pruneHistory(): void {
    const countRow = getAlertCount.get() as { count: number };
    if (countRow.count > maxHistorySize) {
      pruneOldAlerts.run(maxHistorySize);
    }
  }

  // ─── Channel & Rule Accessors ──────────────────────────────────────────

  function getChannels(): AlertChannel[] {
    const rows = getAllChannelsIncludingDisabled.all() as AlertChannelRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type as AlertChannelType,
      config: JSON.parse(row.config),
      enabled: row.enabled === 1,
    }));
  }

  function getRules(): AlertRule[] {
    const rows = getAllRules.all() as AlertRuleRow[];
    return rows.map((row) => ({
      id: row.id,
      resourceType: row.resource_type as AlertResourceType,
      threshold: row.threshold ?? undefined,
      consecutiveChecks: row.consecutive_checks,
      enabled: row.enabled === 1,
    }));
  }

  function removeChannel(id: string): void {
    deleteChannel.run(id);
  }

  function removeRule(id: string): void {
    deleteRule.run(id);
    // Clean up any threshold trackers associated with this rule
    for (const key of thresholdTrackers.keys()) {
      if (key.startsWith(`${id}:`)) {
        thresholdTrackers.delete(key);
      }
    }
  }

  // ─── Utility ────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Return Public API ──────────────────────────────────────────────────

  return {
    configureChannel,
    configureRule,
    emitAlert,
    getAlertHistory,
    recordMetric,
    getChannels,
    getRules,
    removeChannel,
    removeRule,
  };
}
