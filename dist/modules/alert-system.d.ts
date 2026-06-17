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
export declare function createAlertSystem(db: Database.Database, config?: AlertSystemConfig): AlertSystem;
//# sourceMappingURL=alert-system.d.ts.map