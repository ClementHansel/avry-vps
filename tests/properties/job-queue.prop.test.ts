/**
 * Property-based tests for Job Queue Concurrency and Ordering.
 *
 * Feature: vps-panel, Property 14: Job queue concurrency and ordering
 * Tests that never more than N jobs of same type run simultaneously and FIFO
 * ordering is maintained for queued jobs of the same type.
 *
 * Key behaviours:
 * - For any concurrency limit N and any number of submitted jobs, never more
 *   than N jobs of the same type run simultaneously.
 * - FIFO ordering is maintained: jobs submitted first execute before later ones
 *   of the same type.
 * - Different operation types are tracked independently.
 * - Concurrency limits can be changed dynamically.
 *
 * **Validates: Requirements 20.4, 22.4**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { createJobQueue, type OperationType, type JobQueue } from '../../src/modules/job-queue.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT,
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
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('pull', 2);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-import', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-export', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('backup', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('restore', 1);
    INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('tunnel-transfer', 2);
  `);

  return db;
}

/**
 * Creates an async generator that resolves after being signalled.
 * Returns a controller to signal completion and track execution order.
 */
function createControllableJob() {
  let resolveStart: () => void;
  let resolveFinish: () => void;

  const started = new Promise<void>((res) => { resolveStart = res; });
  const finishSignal = new Promise<void>((res) => { resolveFinish = res; });

  const execute = async function* () {
    resolveStart!();
    yield 'started';
    await finishSignal;
    yield 'done';
  };

  return {
    execute,
    started,
    finish: () => resolveFinish!(),
  };
}

/** Small delay to allow scheduler to tick */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  'tunnel-transfer'
);

/** Concurrency limit between 1 and 5 */
const concurrencyLimitArb = fc.integer({ min: 1, max: 5 });

/** Number of jobs to submit (kept small for test performance) */
const jobCountArb = fc.integer({ min: 1, max: 8 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Job Queue Concurrency and Ordering Property Tests', () => {
  let db: Database.Database;
  let queue: JobQueue;

  afterEach(() => {
    if (queue) queue.stop();
    if (db) db.close();
  });

  it('Property 14.1: Never more than N jobs of the same type run simultaneously', async () => {
    await fc.assert(
      fc.asyncProperty(
        operationTypeArb,
        concurrencyLimitArb,
        jobCountArb,
        async (opType, limit, jobCount) => {
          db = createTestDb();
          queue = createJobQueue(db, { pollIntervalMs: 10 });
          queue.setConcurrencyLimit(opType, limit);
          queue.start();

          // Track maximum simultaneous running jobs using atomic counter
          let currentRunning = 0;
          let maxRunning = 0;
          const controllers: { finish: () => void; started: Promise<void> }[] = [];

          // Submit jobs with instrumented executors that track concurrency
          for (let i = 0; i < jobCount; i++) {
            let resolveStart: () => void;
            let resolveFinish: () => void;
            const started = new Promise<void>((res) => { resolveStart = res; });
            const finishSignal = new Promise<void>((res) => { resolveFinish = res; });

            const execute = async function* () {
              // Increment running counter when job actually starts
              currentRunning++;
              if (currentRunning > maxRunning) {
                maxRunning = currentRunning;
              }
              resolveStart!();
              yield 'started';
              await finishSignal;
              // Decrement when job finishes
              currentRunning--;
              yield 'done';
            };

            controllers.push({ finish: () => resolveFinish!(), started });
            await queue.submit({ type: opType, execute });
          }

          // Wait for scheduler to pick up jobs (up to limit)
          await delay(100);

          // At this point, some jobs should be running, check the limit
          const runningCount = queue.getRunningCount(opType);
          expect(runningCount).toBeLessThanOrEqual(limit);

          // Complete all jobs in batches to allow more to start
          for (const ctrl of controllers) {
            ctrl.finish();
          }

          // Wait for all to complete
          await delay(300);

          // Verify: the maximum concurrent running never exceeded the limit
          expect(maxRunning).toBeLessThanOrEqual(limit);

          // All jobs should be done
          const completedJobs = await queue.listJobs({ type: opType, status: 'completed' });
          expect(completedJobs.length).toBe(jobCount);

          queue.stop();
          db.close();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('Property 14.2: FIFO ordering maintained for same-type queued jobs', async () => {
    await fc.assert(
      fc.asyncProperty(
        operationTypeArb,
        fc.integer({ min: 2, max: 6 }),
        async (opType, jobCount) => {
          db = createTestDb();
          queue = createJobQueue(db, { pollIntervalMs: 10 });

          // Set concurrency to 1 so jobs execute sequentially (pure FIFO)
          queue.setConcurrencyLimit(opType, 1);
          queue.start();

          const executionOrder: number[] = [];
          const controllers: ReturnType<typeof createControllableJob>[] = [];

          // Submit all jobs
          for (let i = 0; i < jobCount; i++) {
            const jobIndex = i;
            const ctrl = createControllableJob();
            controllers.push(ctrl);

            // Track when this job actually starts executing
            ctrl.started.then(() => {
              executionOrder.push(jobIndex);
            });

            await queue.submit({
              type: opType,
              execute: ctrl.execute,
            });
          }

          // Process jobs one at a time
          for (let i = 0; i < jobCount; i++) {
            // Wait for the current job to start
            await controllers[i].started;
            await delay(20);

            // Verify only one running
            const running = queue.getRunningCount(opType);
            expect(running).toBe(1);

            // Complete it so next can start
            controllers[i].finish();
            await delay(50);
          }

          // Wait for all to complete
          await delay(100);

          // Verify FIFO order: execution order should match submission order
          expect(executionOrder).toEqual(
            Array.from({ length: jobCount }, (_, i) => i)
          );

          queue.stop();
          db.close();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('Property 14.3: Different operation types have independent concurrency limits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(operationTypeArb, operationTypeArb).filter(([a, b]) => a !== b),
        concurrencyLimitArb,
        concurrencyLimitArb,
        async ([typeA, typeB], limitA, limitB) => {
          db = createTestDb();
          queue = createJobQueue(db, { pollIntervalMs: 10 });
          queue.setConcurrencyLimit(typeA, limitA);
          queue.setConcurrencyLimit(typeB, limitB);
          queue.start();

          const controllersA: ReturnType<typeof createControllableJob>[] = [];
          const controllersB: ReturnType<typeof createControllableJob>[] = [];

          // Submit more jobs than each limit for both types
          const submitCountA = limitA + 2;
          const submitCountB = limitB + 2;

          for (let i = 0; i < submitCountA; i++) {
            const ctrl = createControllableJob();
            controllersA.push(ctrl);
            await queue.submit({ type: typeA, execute: ctrl.execute });
          }

          for (let i = 0; i < submitCountB; i++) {
            const ctrl = createControllableJob();
            controllersB.push(ctrl);
            await queue.submit({ type: typeB, execute: ctrl.execute });
          }

          // Let scheduler process
          await delay(100);

          // Each type should respect its own limit independently
          const runningA = queue.getRunningCount(typeA);
          const runningB = queue.getRunningCount(typeB);

          expect(runningA).toBeLessThanOrEqual(limitA);
          expect(runningB).toBeLessThanOrEqual(limitB);

          // They should be running simultaneously (types don't block each other)
          expect(runningA).toBeGreaterThan(0);
          expect(runningB).toBeGreaterThan(0);

          // Cleanup
          for (const ctrl of [...controllersA, ...controllersB]) {
            ctrl.finish();
          }
          await delay(200);

          queue.stop();
          db.close();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('Property 14.4: Queued jobs start when slots become available (no starvation)', async () => {
    await fc.assert(
      fc.asyncProperty(
        operationTypeArb,
        concurrencyLimitArb,
        fc.integer({ min: 1, max: 4 }),
        async (opType, limit, extraJobs) => {
          db = createTestDb();
          queue = createJobQueue(db, { pollIntervalMs: 10 });
          queue.setConcurrencyLimit(opType, limit);
          queue.start();

          const totalJobs = limit + extraJobs;
          const controllers: ReturnType<typeof createControllableJob>[] = [];

          // Submit more jobs than the concurrency limit
          for (let i = 0; i < totalJobs; i++) {
            const ctrl = createControllableJob();
            controllers.push(ctrl);
            await queue.submit({ type: opType, execute: ctrl.execute });
          }

          // Wait for first batch to start
          await delay(100);

          // First `limit` jobs should be running
          const runningBefore = queue.getRunningCount(opType);
          expect(runningBefore).toBe(Math.min(limit, totalJobs));

          // Complete the first batch
          for (let i = 0; i < limit; i++) {
            controllers[i].finish();
          }

          // Wait for next batch to pick up
          await delay(150);

          // Remaining jobs should now be running (up to the limit)
          const expectedNextBatch = Math.min(extraJobs, limit);
          const runningAfter = queue.getRunningCount(opType);
          expect(runningAfter).toBeLessThanOrEqual(limit);
          expect(runningAfter).toBe(expectedNextBatch);

          // Complete remaining
          for (let i = limit; i < totalJobs; i++) {
            controllers[i].finish();
          }
          await delay(200);

          // All jobs should be completed
          const completed = await queue.listJobs({ type: opType, status: 'completed' });
          expect(completed.length).toBe(totalJobs);

          queue.stop();
          db.close();
        }
      ),
      { numRuns: 20 }
    );
  });
});
