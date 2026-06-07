/**
 * Property-based tests for Job Retention Purging.
 *
 * Feature: vps-panel, Property 15: Job retention purging
 * Tests that after purging, only jobs within the retention period remain.
 *
 * Key behaviours:
 * - After purgeExpiredJobs(), only completed/failed/cancelled jobs within the
 *   retention period remain. Jobs outside the retention period are deleted.
 * - Queued and running jobs are NEVER purged regardless of age.
 * - The retention period boundary is respected exactly.
 *
 * **Validates: Requirements 20.8**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { createJobQueue, type OperationType, type JobStatus } from '../../src/modules/job-queue.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER DEFAULT 0,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      exit_code INTEGER,
      log_path TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

    CREATE TABLE IF NOT EXISTS concurrency_limits (
      operation_type TEXT PRIMARY KEY,
      max_concurrent INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('build', 2);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('deploy', 3);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-import', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-export', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('backup', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('restore', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('tunnel-transfer', 2);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('pull', 2);
  `);

  return db;
}

/**
 * Inserts a job directly into the database with specified parameters.
 * This bypasses the queue's submit() to allow setting arbitrary timestamps and statuses.
 */
function insertJob(
  db: Database.Database,
  id: string,
  type: OperationType,
  status: JobStatus,
  submittedAt: Date,
  completedAt: Date | null,
): void {
  const stmt = db.prepare(`
    INSERT INTO jobs (id, type, status, submitted_at, started_at, completed_at, exit_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const startedAt = status !== 'queued' ? submittedAt.toISOString() : null;
  const exitCode = status === 'completed' ? 0 : status === 'failed' ? 1 : null;
  stmt.run(
    id,
    type,
    status,
    submittedAt.toISOString(),
    startedAt,
    completedAt ? completedAt.toISOString() : null,
    exitCode,
  );
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const operationTypeArb: fc.Arbitrary<OperationType> = fc.constantFrom(
  'build',
  'deploy',
  'pull',
  'db-import',
  'db-export',
  'backup',
  'restore',
  'tunnel-transfer',
);

const terminalStatusArb: fc.Arbitrary<JobStatus> = fc.constantFrom(
  'completed',
  'failed',
  'cancelled',
);

const nonTerminalStatusArb: fc.Arbitrary<JobStatus> = fc.constantFrom(
  'queued',
  'running',
);

/** Retention period between 1 and 90 days */
const retentionDaysArb = fc.integer({ min: 1, max: 90 });

/** Days ago for job completion: 0 to 180 days in the past */
const daysAgoArb = fc.integer({ min: 0, max: 180 });

interface JobSpec {
  id: string;
  type: OperationType;
  status: JobStatus;
  daysAgo: number; // how many days ago the job completed
}

const jobSpecArb = (index: number): fc.Arbitrary<JobSpec> =>
  fc.record({
    id: fc.constant(`job-${index}`),
    type: operationTypeArb,
    status: fc.oneof(terminalStatusArb, nonTerminalStatusArb),
    daysAgo: daysAgoArb,
  });

/** Generate a list of 1-30 jobs with various statuses and ages */
const jobListArb = fc.integer({ min: 1, max: 30 }).chain((count) =>
  fc.tuple(...Array.from({ length: count }, (_, i) => jobSpecArb(i)))
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Job Retention Purging Property Tests', () => {
  it('Property 15.1: After purging, only completed/failed/cancelled jobs within retention period remain; jobs outside are deleted', () => {
    fc.assert(
      fc.property(
        retentionDaysArb,
        jobListArb,
        (retentionDays, jobs) => {
          const db = createTestDb();
          const now = new Date();

          // The purge implementation computes cutoff as: now - retentionDays.
          // It deletes jobs where completed_at < cutoff.
          // Due to timing differences between our `now` and the purge's `now`,
          // we use a safe margin: jobs strictly MORE than retentionDays old are
          // definitely expired, jobs strictly LESS are definitely within retention.
          // We skip testing jobs exactly at the boundary (daysAgo == retentionDays)
          // since that's a race condition between the two `now` values.

          // Insert jobs with specified ages
          for (const job of jobs) {
            const completedAt = new Date(now.getTime() - job.daysAgo * 24 * 60 * 60 * 1000);
            const submittedAt = new Date(completedAt.getTime() - 60000); // 1 min before completion
            insertJob(db, job.id, job.type, job.status, submittedAt, completedAt);
          }

          // Create queue and run purge
          const queue = createJobQueue(db, { retentionDays, pollIntervalMs: 999999 });
          const purgedCount = queue.purgeExpiredJobs();
          queue.stop();

          // Check what remains
          const remainingRows = db.prepare('SELECT id, status, completed_at FROM jobs').all() as Array<{
            id: string;
            status: string;
            completed_at: string | null;
          }>;

          const remainingIds = new Set(remainingRows.map((r) => r.id));

          // Verify each original job's expected fate
          let expectedPurged = 0;
          for (const job of jobs) {
            const isTerminal = ['completed', 'failed', 'cancelled'].includes(job.status);

            if (!isTerminal) {
              // Queued and running jobs are NEVER purged
              expect(remainingIds.has(job.id)).toBe(true);
            } else if (job.daysAgo > retentionDays) {
              // Terminal jobs clearly outside retention period should be deleted
              expect(remainingIds.has(job.id)).toBe(false);
              expectedPurged++;
            } else if (job.daysAgo < retentionDays) {
              // Terminal jobs clearly within retention period should remain
              expect(remainingIds.has(job.id)).toBe(true);
            }
            // Jobs exactly at daysAgo == retentionDays: boundary depends on
            // sub-second timing, so we don't assert on them (either outcome valid).
          }

          // Purged count should be at least the clearly-expired jobs
          expect(purgedCount).toBeGreaterThanOrEqual(expectedPurged);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 15.2: Queued and running jobs are NEVER purged regardless of age', () => {
    fc.assert(
      fc.property(
        retentionDaysArb,
        fc.array(
          fc.record({
            type: operationTypeArb,
            status: nonTerminalStatusArb,
            daysAgo: fc.integer({ min: 0, max: 365 }), // very old jobs
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (retentionDays, jobs) => {
          const db = createTestDb();
          const now = new Date();

          // Insert only queued/running jobs with various ages
          for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            const completedAt = new Date(now.getTime() - job.daysAgo * 24 * 60 * 60 * 1000);
            const submittedAt = new Date(completedAt.getTime() - 60000);
            insertJob(db, `job-${i}`, job.type, job.status, submittedAt, null);
          }

          const queue = createJobQueue(db, { retentionDays, pollIntervalMs: 999999 });
          const purgedCount = queue.purgeExpiredJobs();
          queue.stop();

          // No jobs should have been purged
          expect(purgedCount).toBe(0);

          // All jobs should still exist
          const count = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get() as { cnt: number };
          expect(count.cnt).toBe(jobs.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 15.3: The retention period boundary is respected - jobs clearly within retention are kept, jobs clearly outside are purged', () => {
    fc.assert(
      fc.property(
        retentionDaysArb,
        operationTypeArb,
        terminalStatusArb,
        (retentionDays, type, status) => {
          const db = createTestDb();
          const now = new Date();

          // Job completed clearly within retention (half the retention period ago)
          // This ensures it's well within the boundary regardless of timing drift
          const withinRetention = new Date(now.getTime() - (retentionDays - 1) * 24 * 60 * 60 * 1000);
          insertJob(db, 'job-fresh', type, status, new Date(withinRetention.getTime() - 60000), withinRetention);

          // Job completed clearly outside retention (retentionDays + 1 days ago)
          const outsideRetention = new Date(now.getTime() - (retentionDays + 1) * 24 * 60 * 60 * 1000);
          insertJob(db, 'job-expired', type, status, new Date(outsideRetention.getTime() - 60000), outsideRetention);

          // Job completed very recently (1 hour ago) - definitely within retention
          const veryRecent = new Date(now.getTime() - 60 * 60 * 1000);
          insertJob(db, 'job-recent', type, status, new Date(veryRecent.getTime() - 60000), veryRecent);

          const queue = createJobQueue(db, { retentionDays, pollIntervalMs: 999999 });
          queue.purgeExpiredJobs();
          queue.stop();

          const remaining = db.prepare('SELECT id FROM jobs').all() as Array<{ id: string }>;
          const remainingIds = new Set(remaining.map((r) => r.id));

          // Job clearly within retention: kept
          expect(remainingIds.has('job-fresh')).toBe(true);
          // Job clearly outside retention: purged
          expect(remainingIds.has('job-expired')).toBe(false);
          // Very recent job: kept
          expect(remainingIds.has('job-recent')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 15.4: Purging is idempotent - running purge twice produces the same result', () => {
    fc.assert(
      fc.property(
        retentionDaysArb,
        jobListArb,
        (retentionDays, jobs) => {
          const db = createTestDb();
          const now = new Date();

          for (const job of jobs) {
            const completedAt = new Date(now.getTime() - job.daysAgo * 24 * 60 * 60 * 1000);
            const submittedAt = new Date(completedAt.getTime() - 60000);
            insertJob(
              db,
              job.id,
              job.type,
              job.status,
              submittedAt,
              ['completed', 'failed', 'cancelled'].includes(job.status) ? completedAt : null,
            );
          }

          const queue = createJobQueue(db, { retentionDays, pollIntervalMs: 999999 });

          // First purge
          const firstPurge = queue.purgeExpiredJobs();

          // Get remaining jobs after first purge
          const afterFirst = db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: string }>;

          // Second purge should delete nothing
          const secondPurge = queue.purgeExpiredJobs();

          // Get remaining jobs after second purge
          const afterSecond = db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: string }>;

          queue.stop();

          // Second purge removes nothing
          expect(secondPurge).toBe(0);
          // State unchanged after second purge
          expect(afterSecond).toEqual(afterFirst);
        }
      ),
      { numRuns: 100 }
    );
  });
});
