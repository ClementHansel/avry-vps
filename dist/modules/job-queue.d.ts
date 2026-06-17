/**
 * Job Queue Module
 *
 * SQLite-backed background task execution system with:
 * - Per-type concurrency limits (build: 2, deploy: 3, db-import: 1, etc.)
 * - FIFO ordering for same-type queued jobs
 * - Real-time log streaming via Socket.IO rooms
 * - Cancel support (SIGTERM → SIGKILL after 10s)
 * - Timestamps, exit codes, duration recording
 * - Configurable retention period with auto-purge (default 30 days)
 * - Concurrency utilization display
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */
import type Database from 'better-sqlite3';
import type { Server as SocketIOServer } from 'socket.io';
export type OperationType = 'build' | 'deploy' | 'pull' | 'db-import' | 'db-export' | 'backup' | 'restore' | 'tunnel-transfer';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface JobDefinition {
    type: OperationType;
    projectId?: string;
    /** Async generator that yields log lines during execution */
    execute: () => AsyncGenerator<string, void, unknown>;
    /** Optional callback invoked when the job completes or fails */
    onComplete?: (result: JobResult) => void;
    /** Optional metadata (JSON-serializable) stored with the job */
    metadata?: Record<string, unknown>;
}
export interface JobResult {
    jobId: string;
    status: 'completed' | 'failed' | 'cancelled';
    exitCode: number;
    duration: number;
}
export interface JobRecord {
    id: string;
    type: OperationType;
    projectId?: string;
    status: JobStatus;
    submittedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    exitCode?: number;
    duration?: number;
    metadata?: Record<string, unknown>;
}
export interface JobFilter {
    type?: OperationType;
    projectId?: string;
    status?: JobStatus;
    limit?: number;
    offset?: number;
}
export interface ConcurrencyUtilization {
    type: OperationType;
    running: number;
    limit: number;
    display: string;
}
export interface JobQueue {
    /** Submit a job definition. Returns the assigned unique job ID. */
    submit(job: JobDefinition): Promise<string>;
    /** Cancel a running or queued job. Running jobs get SIGTERM → SIGKILL after 10s. */
    cancel(jobId: string): Promise<void>;
    /** Get the current status of a job. */
    getStatus(jobId: string): Promise<JobRecord | null>;
    /** List jobs with optional filtering by type, project, or status. */
    listJobs(filter?: JobFilter): Promise<JobRecord[]>;
    /** Get the number of currently running jobs, optionally filtered by type. */
    getRunningCount(type?: OperationType): number;
    /** Get the concurrency limit for a given operation type. */
    getConcurrencyLimit(type: OperationType): number;
    /** Update the concurrency limit for a given operation type. */
    setConcurrencyLimit(type: OperationType, limit: number): void;
    /** Get concurrency utilization across all types. */
    getConcurrencyUtilization(): ConcurrencyUtilization[];
    /** Start the scheduler loop. Must be called after creation to begin processing. */
    start(): void;
    /** Stop the scheduler loop and cancel all running jobs. */
    stop(): void;
    /** Run retention purge manually (also runs automatically on schedule). */
    purgeExpiredJobs(): number;
}
export interface JobQueueConfig {
    /** Socket.IO server instance for streaming job output. */
    io?: SocketIOServer;
    /** Scheduler poll interval in milliseconds. Default: 1000 (1 second). */
    pollIntervalMs?: number;
    /** Retention period in days for completed/failed/cancelled jobs. Default: 30. */
    retentionDays?: number;
    /** How often to run auto-purge in milliseconds. Default: 86400000 (24 hours). */
    purgeIntervalMs?: number;
}
export declare function createJobQueue(db: Database.Database, config?: JobQueueConfig): JobQueue;
//# sourceMappingURL=job-queue.d.ts.map