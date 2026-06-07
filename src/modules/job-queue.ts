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
import { v4 as uuidv4 } from 'uuid';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type OperationType =
  | 'build'
  | 'deploy'
  | 'pull'
  | 'db-import'
  | 'db-export'
  | 'backup'
  | 'restore'
  | 'tunnel-transfer';

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

// ─── Internal Types ────────────────────────────────────────────────────────────

interface RawJobRow {
  id: string;
  type: string;
  project_id: string | null;
  status: string;
  priority: number;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  log_path: string | null;
  metadata: string | null;
}

interface RawConcurrencyRow {
  operation_type: string;
  max_concurrent: number;
}

/** In-memory tracking of a running job with its abort handle. */
interface RunningJob {
  id: string;
  type: OperationType;
  abortController: AbortController;
  /** Timer for SIGKILL escalation after SIGTERM */
  killTimer?: ReturnType<typeof setTimeout>;
}

// ─── Default Concurrency Limits ────────────────────────────────────────────────

const DEFAULT_CONCURRENCY_LIMITS: Record<string, number> = {
  build: 2,
  deploy: 3,
  pull: 2,
  'db-import': 1,
  'db-export': 1,
  backup: 1,
  restore: 1,
  'tunnel-transfer': 2,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseJobRow(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    type: row.type as OperationType,
    projectId: row.project_id ?? undefined,
    status: row.status as JobStatus,
    submittedAt: new Date(row.submitted_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    exitCode: row.exit_code ?? undefined,
    duration: computeDuration(row.started_at, row.completed_at),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

function computeDuration(startedAt: string | null, completedAt: string | null): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  return Math.max(0, Math.round((end - start) / 1000));
}

function formatTypeDisplay(type: OperationType): string {
  switch (type) {
    case 'build': return 'Builds';
    case 'deploy': return 'Deploys';
    case 'pull': return 'Pulls';
    case 'db-import': return 'DB Imports';
    case 'db-export': return 'DB Exports';
    case 'backup': return 'Backups';
    case 'restore': return 'Restores';
    case 'tunnel-transfer': return 'Transfers';
  }
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createJobQueue(
  db: Database.Database,
  config?: JobQueueConfig
): JobQueue {
  const io = config?.io;
  const pollIntervalMs = config?.pollIntervalMs ?? 1000;
  const retentionDays = config?.retentionDays ?? 30;
  const purgeIntervalMs = config?.purgeIntervalMs ?? 86400000; // 24 hours

  // In-memory state
  const runningJobs = new Map<string, RunningJob>();
  const jobExecutors = new Map<string, JobDefinition>();
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  let purgeTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // ─── Prepared Statements ─────────────────────────────────────────────────

  const insertJobStmt = db.prepare(`
    INSERT INTO jobs (id, type, project_id, status, submitted_at, metadata)
    VALUES (?, ?, ?, 'queued', ?, ?)
  `);

  const getJobStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);

  const updateJobStatusStmt = db.prepare(`
    UPDATE jobs SET status = ? WHERE id = ?
  `);

  const updateJobStartStmt = db.prepare(`
    UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?
  `);

  const updateJobCompleteStmt = db.prepare(`
    UPDATE jobs SET status = ?, completed_at = ?, exit_code = ? WHERE id = ?
  `);

  const getQueuedJobsByTypeStmt = db.prepare(`
    SELECT * FROM jobs WHERE type = ? AND status = 'queued'
    ORDER BY submitted_at ASC
  `);

  const getRunningJobsByTypeStmt = db.prepare(`
    SELECT COUNT(*) as count FROM jobs WHERE type = ? AND status = 'running'
  `);

  const getAllRunningJobsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM jobs WHERE status = 'running'
  `);

  const getConcurrencyLimitStmt = db.prepare(`
    SELECT max_concurrent FROM concurrency_limits WHERE operation_type = ?
  `);

  const upsertConcurrencyLimitStmt = db.prepare(`
    INSERT INTO concurrency_limits (operation_type, max_concurrent)
    VALUES (?, ?)
    ON CONFLICT(operation_type) DO UPDATE SET max_concurrent = excluded.max_concurrent
  `);

  const getAllConcurrencyLimitsStmt = db.prepare(`
    SELECT * FROM concurrency_limits
  `);

  const purgeOldJobsStmt = db.prepare(`
    DELETE FROM jobs
    WHERE status IN ('completed', 'failed', 'cancelled')
    AND completed_at < ?
  `);

  const listJobsBaseQuery = `SELECT * FROM jobs`;

  // ─── Concurrency Limit Lookup ────────────────────────────────────────────

  function getConcurrencyLimitForType(type: OperationType): number {
    const row = getConcurrencyLimitStmt.get(type) as { max_concurrent: number } | undefined;
    if (row) return row.max_concurrent;
    return DEFAULT_CONCURRENCY_LIMITS[type] ?? 2;
  }

  function getRunningCountForType(type: OperationType): number {
    const row = getRunningJobsByTypeStmt.get(type) as { count: number };
    return row.count;
  }

  // ─── submit ──────────────────────────────────────────────────────────────

  async function submit(job: JobDefinition): Promise<string> {
    const id = uuidv4();
    const submittedAt = new Date().toISOString();
    const metadata = job.metadata ? JSON.stringify(job.metadata) : null;

    insertJobStmt.run(id, job.type, job.projectId ?? null, submittedAt, metadata);

    // Store the executor in memory for later use by the scheduler
    jobExecutors.set(id, job);

    // Emit to Socket.IO that a new job was queued
    if (io) {
      io.to(`job:${id}`).emit('job:queued', { jobId: id, type: job.type });
    }

    return id;
  }

  // ─── cancel ──────────────────────────────────────────────────────────────

  async function cancel(jobId: string): Promise<void> {
    const row = getJobStmt.get(jobId) as RawJobRow | undefined;
    if (!row) {
      throw new Error(`Job ${jobId} not found`);
    }

    // Already in a terminal state — reject
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      throw new Error(`Job ${jobId} is already in terminal state: ${row.status}`);
    }

    if (row.status === 'queued') {
      // Simply mark as cancelled and remove executor
      updateJobCompleteStmt.run('cancelled', new Date().toISOString(), null, jobId);
      jobExecutors.delete(jobId);

      if (io) {
        io.to(`job:${jobId}`).emit('job:cancelled', { jobId });
      }
      return;
    }

    if (row.status === 'running') {
      const running = runningJobs.get(jobId);
      if (running) {
        // Send abort signal (equivalent to SIGTERM)
        running.abortController.abort();

        // Set a kill timer — force after 10 seconds
        running.killTimer = setTimeout(() => {
          // Force-complete the job if it hasn't finished
          const currentRow = getJobStmt.get(jobId) as RawJobRow | undefined;
          if (currentRow && currentRow.status === 'running') {
            completeJob(jobId, 'cancelled', -1);
          }
          runningJobs.delete(jobId);
        }, 10000);
      } else {
        // Running in DB but not in memory (shouldn't happen, but handle gracefully)
        completeJob(jobId, 'cancelled', -1);
      }
      return;
    }
  }

  // ─── getStatus ───────────────────────────────────────────────────────────

  async function getStatus(jobId: string): Promise<JobRecord | null> {
    const row = getJobStmt.get(jobId) as RawJobRow | undefined;
    if (!row) return null;
    return parseJobRow(row);
  }

  // ─── listJobs ────────────────────────────────────────────────────────────

  async function listJobs(filter?: JobFilter): Promise<JobRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }
    if (filter?.projectId) {
      conditions.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    let query = listJobsBaseQuery;
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY submitted_at DESC';

    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter?.offset) {
      query += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = db.prepare(query).all(...params) as RawJobRow[];
    return rows.map(parseJobRow);
  }

  // ─── getRunningCount ─────────────────────────────────────────────────────

  function getRunningCount(type?: OperationType): number {
    if (type) {
      return getRunningCountForType(type);
    }
    const row = getAllRunningJobsStmt.get() as { count: number };
    return row.count;
  }

  // ─── getConcurrencyLimit ─────────────────────────────────────────────────

  function getConcurrencyLimit(type: OperationType): number {
    return getConcurrencyLimitForType(type);
  }

  // ─── setConcurrencyLimit ─────────────────────────────────────────────────

  function setConcurrencyLimit(type: OperationType, limit: number): void {
    if (limit < 1) {
      throw new Error(`Concurrency limit must be at least 1, got ${limit}`);
    }
    upsertConcurrencyLimitStmt.run(type, limit);
  }

  // ─── getConcurrencyUtilization ───────────────────────────────────────────

  function getConcurrencyUtilization(): ConcurrencyUtilization[] {
    const limits = getAllConcurrencyLimitsStmt.all() as RawConcurrencyRow[];
    const result: ConcurrencyUtilization[] = [];

    for (const row of limits) {
      const type = row.operation_type as OperationType;
      const running = getRunningCountForType(type);
      const limit = row.max_concurrent;
      result.push({
        type,
        running,
        limit,
        display: `${formatTypeDisplay(type)}: ${running}/${limit}`,
      });
    }

    return result;
  }

  // ─── Job Execution ───────────────────────────────────────────────────────

  function completeJob(jobId: string, status: 'completed' | 'failed' | 'cancelled', exitCode: number): void {
    const completedAt = new Date().toISOString();
    updateJobCompleteStmt.run(status, completedAt, exitCode, jobId);
    runningJobs.delete(jobId);

    // Notify Socket.IO subscribers
    if (io) {
      io.to(`job:${jobId}`).emit('job:completed', {
        jobId,
        status,
        exitCode,
      });
    }

    // Invoke onComplete callback if registered
    const executor = jobExecutors.get(jobId);
    if (executor?.onComplete) {
      const row = getJobStmt.get(jobId) as RawJobRow | undefined;
      const duration = row ? computeDuration(row.started_at, row.completed_at) ?? 0 : 0;
      executor.onComplete({ jobId, status, exitCode, duration });
    }
    jobExecutors.delete(jobId);
  }

  async function executeJob(jobId: string, definition: JobDefinition): Promise<void> {
    const abortController = new AbortController();
    const runningJob: RunningJob = { id: jobId, type: definition.type, abortController };
    runningJobs.set(jobId, runningJob);

    // Mark as running in DB
    const startedAt = new Date().toISOString();
    updateJobStartStmt.run(startedAt, jobId);

    // Notify via Socket.IO
    if (io) {
      io.to(`job:${jobId}`).emit('job:started', { jobId, type: definition.type });
    }

    try {
      const generator = definition.execute();
      let exitCode = 0;

      for await (const logLine of generator) {
        // Check if job was cancelled
        if (abortController.signal.aborted) {
          exitCode = -1;
          completeJob(jobId, 'cancelled', exitCode);
          // Clear kill timer since we handled it
          if (runningJob.killTimer) {
            clearTimeout(runningJob.killTimer);
            runningJob.killTimer = undefined;
          }
          return;
        }

        // Stream log line to Socket.IO room
        if (io) {
          io.to(`job:${jobId}`).emit('job:log', { jobId, line: logLine });
        }
      }

      // Completed successfully
      completeJob(jobId, 'completed', exitCode);
    } catch (error: unknown) {
      // Check if it was an abort
      if (abortController.signal.aborted) {
        completeJob(jobId, 'cancelled', -1);
        if (runningJob.killTimer) {
          clearTimeout(runningJob.killTimer);
          runningJob.killTimer = undefined;
        }
      } else {
        const exitCode = error instanceof Error && 'exitCode' in error
          ? (error as any).exitCode ?? 1
          : 1;
        completeJob(jobId, 'failed', exitCode);

        // Stream error to Socket.IO room
        if (io) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          io.to(`job:${jobId}`).emit('job:error', { jobId, error: errorMsg });
        }
      }
    }
  }

  // ─── Scheduler Loop ──────────────────────────────────────────────────────

  function schedulerTick(): void {
    if (stopped) return;

    // Get all operation types that have queued jobs
    const allTypes: OperationType[] = [
      'build', 'deploy', 'pull', 'db-import', 'db-export', 'backup', 'restore', 'tunnel-transfer'
    ];

    for (const type of allTypes) {
      const limit = getConcurrencyLimitForType(type);
      const running = getRunningCountForType(type);
      const available = limit - running;

      if (available <= 0) continue;

      // Get queued jobs of this type in FIFO order
      const queuedRows = getQueuedJobsByTypeStmt.all(type) as RawJobRow[];
      const toStart = queuedRows.slice(0, available);

      for (const row of toStart) {
        const definition = jobExecutors.get(row.id);
        if (definition) {
          // Fire-and-forget the execution (it manages its own completion)
          executeJob(row.id, definition).catch(() => {
            // Error handling is done within executeJob
          });
        } else {
          // No executor in memory (e.g., after restart). Mark as failed.
          completeJob(row.id, 'failed', -1);
        }
      }
    }
  }

  // ─── Retention Purge ─────────────────────────────────────────────────────

  function purgeExpiredJobs(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const result = purgeOldJobsStmt.run(cutoff.toISOString());
    return result.changes;
  }

  // ─── Start / Stop ────────────────────────────────────────────────────────

  function start(): void {
    stopped = false;

    // Start scheduler loop
    schedulerTimer = setInterval(schedulerTick, pollIntervalMs);

    // Start auto-purge
    purgeTimer = setInterval(purgeExpiredJobs, purgeIntervalMs);

    // Run an initial tick immediately
    schedulerTick();
  }

  function stop(): void {
    stopped = true;

    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }

    if (purgeTimer) {
      clearInterval(purgeTimer);
      purgeTimer = null;
    }

    // Cancel all running jobs
    for (const [jobId, running] of runningJobs) {
      running.abortController.abort();
      if (running.killTimer) {
        clearTimeout(running.killTimer);
      }
      // Mark in DB
      const row = getJobStmt.get(jobId) as RawJobRow | undefined;
      if (row && row.status === 'running') {
        completeJob(jobId, 'cancelled', -1);
      }
    }
    runningJobs.clear();
    jobExecutors.clear();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    submit,
    cancel,
    getStatus,
    listJobs,
    getRunningCount,
    getConcurrencyLimit,
    setConcurrencyLimit,
    getConcurrencyUtilization,
    start,
    stop,
    purgeExpiredJobs,
  };
}
