/**
 * Audit Logger Module
 *
 * Provides comprehensive, immutable activity logging with full-text search,
 * pagination, export, retention purging, and storage monitoring.
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10
 */
import type Database from 'better-sqlite3';
export interface AuditEntry {
    actor: string;
    actionType: string;
    targetResource: string;
    details: Record<string, any>;
    sourceIp: string;
    projectId?: string;
    result: 'success' | 'failure';
}
export interface AuditRecord extends AuditEntry {
    id: string;
    timestamp: Date;
}
export interface AuditFilter {
    startDate?: Date;
    endDate?: Date;
    actor?: string;
    actionType?: string;
    targetResource?: string;
    projectId?: string;
    result?: 'success' | 'failure';
    page?: number;
}
export interface PaginatedResult<T> {
    data: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}
export interface StorageInfo {
    usedBytes: number;
    maxBytes: number;
    usagePercent: number;
    alertThresholdPercent: number;
    isNearCapacity: boolean;
}
export interface AuditLoggerConfig {
    /** Retention period in days. Default: 365 */
    retentionDays?: number;
    /** Maximum storage in bytes. Default: 1GB */
    maxStorageBytes?: number;
    /** Alert threshold percentage. Default: 90 */
    alertThresholdPercent?: number;
    /** Purge interval in milliseconds. Default: 24 hours */
    purgeIntervalMs?: number;
    /** Callback invoked when storage exceeds threshold */
    onStorageAlert?: (info: StorageInfo) => void;
}
export interface AuditLogger {
    log(entry: AuditEntry): Promise<void>;
    query(filter: AuditFilter): Promise<PaginatedResult<AuditRecord>>;
    search(term: string, filter?: AuditFilter): Promise<PaginatedResult<AuditRecord>>;
    export(filter: AuditFilter, format: 'json' | 'csv'): Promise<Buffer>;
    getStorageUsage(): Promise<StorageInfo>;
    /** Start the background retention purge scheduler */
    startPurgeScheduler(): void;
    /** Stop the background retention purge scheduler */
    stopPurgeScheduler(): void;
    /** Run retention purge immediately (for testing/manual trigger) */
    purgeExpiredEntries(): number;
}
/**
 * SQL statements to create triggers that sync audit_log inserts to audit_log_fts.
 * These ensure FTS5 is always up-to-date without manual intervention.
 */
export declare const FTS5_TRIGGER_SQL = "\nCREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN\n  INSERT INTO audit_log_fts(rowid, action_type, target_resource, details)\n  VALUES (new.rowid, new.action_type, new.target_resource, new.details);\nEND;\n";
export declare function createAuditLogger(db: Database.Database, dbPath: string, config?: AuditLoggerConfig): AuditLogger;
/**
 * Ensure FTS5 triggers are installed on the audit_log table.
 * This is idempotent — safe to call multiple times.
 */
export declare function ensureFtsTriggers(db: Database.Database): void;
//# sourceMappingURL=audit-logger.d.ts.map