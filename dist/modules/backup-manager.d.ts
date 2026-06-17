/**
 * Backup Manager Module
 *
 * Provides scheduled and on-demand backups of Docker volumes and compose files,
 * with support for local filesystem and S3-compatible storage, configurable
 * retention policy, backup history tracking, and restore functionality.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */
import type Database from 'better-sqlite3';
export interface BackupScheduleConfig {
    /** Cron expression for frequency */
    frequency: string;
    /** Targets to back up: Docker volume names and compose file paths */
    targets: string[];
    /** Storage destination type */
    storageType: 'local' | 's3';
    /** Storage configuration (local path or S3 config) */
    storageConfig: LocalStorageConfig | S3StorageConfig;
    /** Number of backups to retain. Default: 7 */
    retentionCount?: number;
    /** Whether the schedule is active */
    enabled?: boolean;
}
export interface LocalStorageConfig {
    path: string;
}
export interface S3StorageConfig {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    prefix?: string;
}
export interface BackupEntry {
    id: string;
    scheduleId?: string;
    timestamp: Date;
    size: number;
    targets: string[];
    storage: 'local' | 's3';
    storagePath: string;
    status: 'completed' | 'failed' | 'in-progress';
}
export interface BackupManager {
    configureSchedule(config: BackupScheduleConfig): Promise<string>;
    triggerBackup(targets?: string[]): Promise<string>;
    restoreBackup(backupId: string): Promise<string>;
    listBackups(): Promise<BackupEntry[]>;
    deleteBackup(backupId: string): Promise<void>;
    /** Start the cron-based scheduler */
    startScheduler(): void;
    /** Stop the scheduler */
    stopScheduler(): void;
}
export interface AlertCallback {
    onBackupFailure(backupId: string, error: string, targets: string[]): void;
}
export interface BackupManagerConfig {
    /** Working directory for temporary archives. Default: /tmp/vps-panel-backups */
    workDir?: string;
    /** Alert callback for failure notifications */
    alertCallback?: AlertCallback;
}
export declare function createBackupManager(db: Database.Database, config?: BackupManagerConfig): BackupManager;
//# sourceMappingURL=backup-manager.d.ts.map