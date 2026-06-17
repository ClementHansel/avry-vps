/**
 * Tunnel Manager Module
 *
 * Manages local-to-VPS file transfer configurations, enabling developers to
 * push/deploy local project versions to the VPS via secure tunnels.
 *
 * Features:
 * - CRUD tunnel configurations (name, remote path, protocol rsync/scp, exclude patterns, post-transfer command)
 * - Generate unique auth tokens per configuration
 * - Submit transfers to Job Queue
 * - Execute post-transfer commands on completion
 * - Track transfer history (last 50, with timestamp, file count, size, duration, status)
 * - Generate downloadable CLI client script
 * - Reject concurrent transfers for same tunnel config
 * - Handle failures preserving previous deployment state
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9
 */
import type Database from 'better-sqlite3';
export type TransferProtocol = 'rsync' | 'scp';
export type TransferStatus = 'completed' | 'failed' | 'in-progress';
export interface TunnelConfig {
    id: string;
    name: string;
    projectId?: string;
    remotePath: string;
    protocol: TransferProtocol;
    excludePatterns: string[];
    postTransferCommand?: string;
    authToken: string;
    createdAt: string;
}
export interface TunnelConfigInput {
    name: string;
    projectId?: string;
    remotePath: string;
    protocol?: TransferProtocol;
    excludePatterns?: string[];
    postTransferCommand?: string;
}
export interface TransferRecord {
    id: string;
    tunnelId: string;
    timestamp: string;
    fileCount: number;
    totalSize: number;
    duration: number;
    status: TransferStatus;
}
export interface TunnelManager {
    /** List all tunnel configurations. */
    listConfigurations(): TunnelConfig[];
    /** Create a new tunnel configuration with a unique auth token. */
    createConfiguration(input: TunnelConfigInput): TunnelConfig;
    /** Update an existing tunnel configuration. */
    updateConfiguration(id: string, input: Partial<TunnelConfigInput>): TunnelConfig;
    /** Delete a tunnel configuration. */
    deleteConfiguration(id: string): void;
    /** Trigger a file push/deploy to the VPS. Returns the job ID. Rejects if transfer already in progress. */
    triggerPush(configId: string, files: Buffer): Promise<string>;
    /** Get the last 50 transfer records for a tunnel configuration. */
    getTransferHistory(configId: string): TransferRecord[];
    /** Generate a downloadable bash CLI client script for the tunnel. */
    generateCliScript(configId: string): string;
}
/**
 * Dependencies injected into the Tunnel Manager for submitting jobs.
 */
export interface TunnelManagerDeps {
    /** Submit a job to the queue. Returns the job ID. */
    submitJob: (job: {
        type: 'tunnel-transfer';
        projectId?: string;
        execute: () => AsyncGenerator<string, void, unknown>;
        onComplete?: (result: {
            jobId: string;
            status: string;
            exitCode: number;
            duration: number;
        }) => void;
        metadata?: Record<string, unknown>;
    }) => Promise<string>;
}
export interface TunnelManagerConfig {
    /** The SQLite database instance */
    db: Database.Database;
    /** Dependencies for job queue integration */
    deps: TunnelManagerDeps;
    /** Base URL for CLI script generation (e.g., "https://panel.aivory.id") */
    baseUrl?: string;
}
export declare function createTunnelManager(config: TunnelManagerConfig): TunnelManager;
//# sourceMappingURL=tunnel-manager.d.ts.map