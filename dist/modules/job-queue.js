"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJobQueue = createJobQueue;
const uuid_1 = require("uuid");
// ─── Default Concurrency Limits ────────────────────────────────────────────────
const DEFAULT_CONCURRENCY_LIMITS = {
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
function parseJobRow(row) {
    return {
        id: row.id,
        type: row.type,
        projectId: row.project_id ?? undefined,
        status: row.status,
        submittedAt: new Date(row.submitted_at),
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
        exitCode: row.exit_code ?? undefined,
        duration: computeDuration(row.started_at, row.completed_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
}
function computeDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt)
        return undefined;
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    return Math.max(0, Math.round((end - start) / 1000));
}
function formatTypeDisplay(type) {
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
function createJobQueue(db, config) {
    const io = config?.io;
    const pollIntervalMs = config?.pollIntervalMs ?? 1000;
    const retentionDays = config?.retentionDays ?? 30;
    const purgeIntervalMs = config?.purgeIntervalMs ?? 86400000; // 24 hours
    // In-memory state
    const runningJobs = new Map();
    const jobExecutors = new Map();
    let schedulerTimer = null;
    let purgeTimer = null;
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
    function getConcurrencyLimitForType(type) {
        const row = getConcurrencyLimitStmt.get(type);
        if (row)
            return row.max_concurrent;
        return DEFAULT_CONCURRENCY_LIMITS[type] ?? 2;
    }
    function getRunningCountForType(type) {
        const row = getRunningJobsByTypeStmt.get(type);
        return row.count;
    }
    // ─── submit ──────────────────────────────────────────────────────────────
    async function submit(job) {
        const id = (0, uuid_1.v4)();
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
    async function cancel(jobId) {
        const row = getJobStmt.get(jobId);
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
                    const currentRow = getJobStmt.get(jobId);
                    if (currentRow && currentRow.status === 'running') {
                        completeJob(jobId, 'cancelled', -1);
                    }
                    runningJobs.delete(jobId);
                }, 10000);
            }
            else {
                // Running in DB but not in memory (shouldn't happen, but handle gracefully)
                completeJob(jobId, 'cancelled', -1);
            }
            return;
        }
    }
    // ─── getStatus ───────────────────────────────────────────────────────────
    async function getStatus(jobId) {
        const row = getJobStmt.get(jobId);
        if (!row)
            return null;
        return parseJobRow(row);
    }
    // ─── listJobs ────────────────────────────────────────────────────────────
    async function listJobs(filter) {
        const conditions = [];
        const params = [];
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
        const rows = db.prepare(query).all(...params);
        return rows.map(parseJobRow);
    }
    // ─── getRunningCount ─────────────────────────────────────────────────────
    function getRunningCount(type) {
        if (type) {
            return getRunningCountForType(type);
        }
        const row = getAllRunningJobsStmt.get();
        return row.count;
    }
    // ─── getConcurrencyLimit ─────────────────────────────────────────────────
    function getConcurrencyLimit(type) {
        return getConcurrencyLimitForType(type);
    }
    // ─── setConcurrencyLimit ─────────────────────────────────────────────────
    function setConcurrencyLimit(type, limit) {
        if (limit < 1) {
            throw new Error(`Concurrency limit must be at least 1, got ${limit}`);
        }
        upsertConcurrencyLimitStmt.run(type, limit);
    }
    // ─── getConcurrencyUtilization ───────────────────────────────────────────
    function getConcurrencyUtilization() {
        const limits = getAllConcurrencyLimitsStmt.all();
        const result = [];
        for (const row of limits) {
            const type = row.operation_type;
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
    function completeJob(jobId, status, exitCode) {
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
            const row = getJobStmt.get(jobId);
            const duration = row ? computeDuration(row.started_at, row.completed_at) ?? 0 : 0;
            executor.onComplete({ jobId, status, exitCode, duration });
        }
        jobExecutors.delete(jobId);
    }
    async function executeJob(jobId, definition) {
        const abortController = new AbortController();
        const runningJob = { id: jobId, type: definition.type, abortController };
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
        }
        catch (error) {
            // Check if it was an abort
            if (abortController.signal.aborted) {
                completeJob(jobId, 'cancelled', -1);
                if (runningJob.killTimer) {
                    clearTimeout(runningJob.killTimer);
                    runningJob.killTimer = undefined;
                }
            }
            else {
                const exitCode = error instanceof Error && 'exitCode' in error
                    ? error.exitCode ?? 1
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
    function schedulerTick() {
        if (stopped)
            return;
        // Get all operation types that have queued jobs
        const allTypes = [
            'build', 'deploy', 'pull', 'db-import', 'db-export', 'backup', 'restore', 'tunnel-transfer'
        ];
        for (const type of allTypes) {
            const limit = getConcurrencyLimitForType(type);
            const running = getRunningCountForType(type);
            const available = limit - running;
            if (available <= 0)
                continue;
            // Get queued jobs of this type in FIFO order
            const queuedRows = getQueuedJobsByTypeStmt.all(type);
            const toStart = queuedRows.slice(0, available);
            for (const row of toStart) {
                const definition = jobExecutors.get(row.id);
                if (definition) {
                    // Fire-and-forget the execution (it manages its own completion)
                    executeJob(row.id, definition).catch(() => {
                        // Error handling is done within executeJob
                    });
                }
                else {
                    // No executor in memory (e.g., after restart). Mark as failed.
                    completeJob(row.id, 'failed', -1);
                }
            }
        }
    }
    // ─── Retention Purge ─────────────────────────────────────────────────────
    function purgeExpiredJobs() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const result = purgeOldJobsStmt.run(cutoff.toISOString());
        return result.changes;
    }
    // ─── Start / Stop ────────────────────────────────────────────────────────
    function start() {
        stopped = false;
        // Start scheduler loop
        schedulerTimer = setInterval(schedulerTick, pollIntervalMs);
        // Start auto-purge
        purgeTimer = setInterval(purgeExpiredJobs, purgeIntervalMs);
        // Run an initial tick immediately
        schedulerTick();
    }
    function stop() {
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
            const row = getJobStmt.get(jobId);
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
//# sourceMappingURL=job-queue.js.map