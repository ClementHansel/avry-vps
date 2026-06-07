/**
 * Job Queue Unit Tests
 *
 * Tests for job submission, cancellation, concurrency limits,
 * FIFO ordering, retention purge, and utilization display.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createJobQueue } from '../../src/modules/job-queue.js';
import type {
  JobQueue,
  JobDefinition,
  OperationType,
} from '../../src/modules/job-queue.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTempDb(): { db: Database.Database; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-jq-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create required tables
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

  return { db, dbPath };
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Creates a job that yields lines then completes */
function createSimpleJob(type: OperationType, lines: string[] = ['done']): JobDefinition {
  return {
    type,
    execute: async function* () {
      for (const line of lines) {
        yield line;
      }
    },
  };
}

/** Creates a job that blocks until resolved externally */
function createBlockingJob(type: OperationType): {
  definition: JobDefinition;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolveRef: () => void;
  let rejectRef: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });

  const definition: JobDefinition = {
    type,
    execute: async function* () {
      yield 'started';
      await promise;
      yield 'done';
    },
  };

  return { definition, resolve: resolveRef!, reject: rejectRef! };
}

/** Wait for a condition to be true, with timeout */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Job Queue Module', () => {
  let db: Database.Database;
  let dbPath: string;
  let queue: JobQueue;

  beforeEach(() => {
    const temp = createTempDb();
    db = temp.db;
    dbPath = temp.dbPath;
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
    }
    db.close();
    cleanupDb(dbPath);
  });

  describe('submit', () => {
    it('should return a unique job ID', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 }); // Long interval so no auto-processing

      const id = await queue.submit(createSimpleJob('build'));
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should assign unique IDs to each submitted job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const id1 = await queue.submit(createSimpleJob('build'));
      const id2 = await queue.submit(createSimpleJob('build'));
      expect(id1).not.toBe(id2);
    });

    it('should set initial status to queued', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const id = await queue.submit(createSimpleJob('deploy'));
      const status = await queue.getStatus(id);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('queued');
      expect(status!.type).toBe('deploy');
    });

    it('should record the submitted timestamp', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const before = new Date();
      const id = await queue.submit(createSimpleJob('build'));
      const after = new Date();

      const status = await queue.getStatus(id);
      expect(status!.submittedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(status!.submittedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });
  });

  describe('getStatus', () => {
    it('should return null for non-existent job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });
      const status = await queue.getStatus('non-existent-id');
      expect(status).toBeNull();
    });

    it('should return job record with all fields', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const id = await queue.submit({
        ...createSimpleJob('backup'),
        projectId: undefined,
        metadata: { target: 'volume1' },
      });

      const status = await queue.getStatus(id);
      expect(status).not.toBeNull();
      expect(status!.id).toBe(id);
      expect(status!.type).toBe('backup');
      expect(status!.status).toBe('queued');
      expect(status!.metadata).toEqual({ target: 'volume1' });
    });
  });

  describe('listJobs', () => {
    it('should list all jobs', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      await queue.submit(createSimpleJob('build'));
      await queue.submit(createSimpleJob('deploy'));
      await queue.submit(createSimpleJob('backup'));

      const jobs = await queue.listJobs();
      expect(jobs.length).toBe(3);
    });

    it('should filter by type', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      await queue.submit(createSimpleJob('build'));
      await queue.submit(createSimpleJob('deploy'));
      await queue.submit(createSimpleJob('build'));

      const builds = await queue.listJobs({ type: 'build' });
      expect(builds.length).toBe(2);
      expect(builds.every((j) => j.type === 'build')).toBe(true);
    });

    it('should filter by status', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      await queue.submit(createSimpleJob('build'));
      await queue.submit(createSimpleJob('deploy'));

      const queued = await queue.listJobs({ status: 'queued' });
      expect(queued.length).toBe(2);
    });

    it('should support limit and offset', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      for (let i = 0; i < 5; i++) {
        await queue.submit(createSimpleJob('build'));
      }

      const page1 = await queue.listJobs({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await queue.listJobs({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);
    });
  });

  describe('cancel', () => {
    it('should cancel a queued job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const id = await queue.submit(createSimpleJob('build'));
      await queue.cancel(id);

      const status = await queue.getStatus(id);
      expect(status!.status).toBe('cancelled');
    });

    it('should throw for non-existent job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });
      await expect(queue.cancel('non-existent')).rejects.toThrow('not found');
    });

    it('should throw for already completed job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      const id = await queue.submit(createSimpleJob('build', ['line1']));

      // Wait for job to complete
      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'completed';
      });

      await expect(queue.cancel(id)).rejects.toThrow('terminal state');
    });

    it('should cancel a running job', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      const { definition, resolve } = createBlockingJob('build');
      const id = await queue.submit(definition);

      // Wait for job to start running
      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'running';
      });

      await queue.cancel(id);

      // Resolve the blocking promise to let the generator finish
      resolve();

      // Wait for cancellation to be recorded
      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'cancelled';
      });

      const status = await queue.getStatus(id);
      expect(status!.status).toBe('cancelled');
    });
  });

  describe('concurrency limits', () => {
    it('should return default concurrency limits', () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      expect(queue.getConcurrencyLimit('build')).toBe(2);
      expect(queue.getConcurrencyLimit('deploy')).toBe(3);
      expect(queue.getConcurrencyLimit('db-import')).toBe(1);
    });

    it('should update concurrency limits', () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      queue.setConcurrencyLimit('build', 5);
      expect(queue.getConcurrencyLimit('build')).toBe(5);
    });

    it('should reject limits less than 1', () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });
      expect(() => queue.setConcurrencyLimit('build', 0)).toThrow('at least 1');
    });

    it('should not exceed concurrency limit for a type', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });

      // db-import has limit of 1
      const blocking1 = createBlockingJob('db-import');
      const blocking2 = createBlockingJob('db-import');

      queue.start();

      const id1 = await queue.submit(blocking1.definition);
      const id2 = await queue.submit(blocking2.definition);

      // Wait for first to start
      await waitFor(async () => {
        const s = await queue.getStatus(id1);
        return s?.status === 'running';
      });

      // Give scheduler time to potentially start the second
      await new Promise((r) => setTimeout(r, 200));

      // Second should still be queued
      const status2 = await queue.getStatus(id2);
      expect(status2!.status).toBe('queued');

      // Only 1 running for db-import
      expect(queue.getRunningCount('db-import')).toBe(1);

      // Clean up
      blocking1.resolve();
      blocking2.resolve();
    });

    it('should start queued jobs when a slot opens', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });

      // db-import limit is 1
      const blocking1 = createBlockingJob('db-import');
      const blocking2 = createBlockingJob('db-import');

      queue.start();

      const id1 = await queue.submit(blocking1.definition);
      const id2 = await queue.submit(blocking2.definition);

      // Wait for first to start
      await waitFor(async () => {
        const s = await queue.getStatus(id1);
        return s?.status === 'running';
      });

      // Complete the first job
      blocking1.resolve();

      // Wait for first to complete
      await waitFor(async () => {
        const s = await queue.getStatus(id1);
        return s?.status === 'completed';
      });

      // Wait for second to start
      await waitFor(async () => {
        const s = await queue.getStatus(id2);
        return s?.status === 'running';
      });

      const status2 = await queue.getStatus(id2);
      expect(status2!.status).toBe('running');

      blocking2.resolve();
    });
  });

  describe('FIFO ordering', () => {
    it('should process queued jobs in submission order', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });

      // Set db-import limit to 1 so only one runs at a time
      const executionOrder: string[] = [];

      const createTrackedJob = (label: string): JobDefinition => ({
        type: 'db-import',
        execute: async function* () {
          executionOrder.push(label);
          yield `${label} done`;
        },
      });

      // Submit 3 jobs in order
      const id1 = await queue.submit(createTrackedJob('first'));
      const id2 = await queue.submit(createTrackedJob('second'));
      const id3 = await queue.submit(createTrackedJob('third'));

      queue.start();

      // Wait for all to complete
      await waitFor(async () => {
        const s1 = await queue.getStatus(id1);
        const s2 = await queue.getStatus(id2);
        const s3 = await queue.getStatus(id3);
        return (
          s1?.status === 'completed' &&
          s2?.status === 'completed' &&
          s3?.status === 'completed'
        );
      });

      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });
  });

  describe('getConcurrencyUtilization', () => {
    it('should return utilization for all configured types', () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });

      const utilization = queue.getConcurrencyUtilization();
      expect(utilization.length).toBeGreaterThan(0);

      // Check that build type is included
      const buildUtil = utilization.find((u) => u.type === 'build');
      expect(buildUtil).toBeDefined();
      expect(buildUtil!.running).toBe(0);
      expect(buildUtil!.limit).toBe(2);
      expect(buildUtil!.display).toBe('Builds: 0/2');
    });

    it('should reflect running jobs in utilization', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });

      const blocking = createBlockingJob('build');
      queue.start();

      await queue.submit(blocking.definition);

      // Wait for the job to start
      await waitFor(() => queue.getRunningCount('build') === 1);

      const utilization = queue.getConcurrencyUtilization();
      const buildUtil = utilization.find((u) => u.type === 'build');
      expect(buildUtil!.running).toBe(1);
      expect(buildUtil!.display).toBe('Builds: 1/2');

      blocking.resolve();
    });
  });

  describe('getRunningCount', () => {
    it('should return 0 when no jobs are running', () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000 });
      expect(queue.getRunningCount()).toBe(0);
      expect(queue.getRunningCount('build')).toBe(0);
    });
  });

  describe('job execution lifecycle', () => {
    it('should record start time and completion time', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      const id = await queue.submit(createSimpleJob('build', ['log1', 'log2']));

      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'completed';
      });

      const status = await queue.getStatus(id);
      expect(status!.startedAt).toBeDefined();
      expect(status!.completedAt).toBeDefined();
      expect(status!.exitCode).toBe(0);
      expect(status!.duration).toBeDefined();
      expect(status!.duration!).toBeGreaterThanOrEqual(0);
    });

    it('should record exit code 1 for failed jobs', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      const definition: JobDefinition = {
        type: 'deploy',
        execute: async function* () {
          yield 'starting';
          throw new Error('deployment failed');
        },
      };

      const id = await queue.submit(definition);

      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'failed';
      });

      const status = await queue.getStatus(id);
      expect(status!.status).toBe('failed');
      expect(status!.exitCode).toBe(1);
    });

    it('should invoke onComplete callback', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      let callbackResult: any = null;
      const id = await queue.submit({
        type: 'build',
        execute: async function* () {
          yield 'done';
        },
        onComplete: (result) => {
          callbackResult = result;
        },
      });

      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'completed';
      });

      expect(callbackResult).not.toBeNull();
      expect(callbackResult.jobId).toBe(id);
      expect(callbackResult.status).toBe('completed');
      expect(callbackResult.exitCode).toBe(0);
    });
  });

  describe('retention purge', () => {
    it('should purge jobs older than retention period', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000, retentionDays: 30 });

      // Insert an old completed job directly into the DB
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31);

      db.prepare(`
        INSERT INTO jobs (id, type, status, submitted_at, completed_at, exit_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('old-job-1', 'build', 'completed', oldDate.toISOString(), oldDate.toISOString(), 0);

      // Insert a recent completed job
      const recentDate = new Date();
      db.prepare(`
        INSERT INTO jobs (id, type, status, submitted_at, completed_at, exit_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('recent-job-1', 'build', 'completed', recentDate.toISOString(), recentDate.toISOString(), 0);

      const purged = queue.purgeExpiredJobs();
      expect(purged).toBe(1);

      // Old job should be gone
      const oldStatus = await queue.getStatus('old-job-1');
      expect(oldStatus).toBeNull();

      // Recent job should still exist
      const recentStatus = await queue.getStatus('recent-job-1');
      expect(recentStatus).not.toBeNull();
    });

    it('should not purge queued or running jobs', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 100000, retentionDays: 0 });

      // Insert a queued job with old date
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 5);

      db.prepare(`
        INSERT INTO jobs (id, type, status, submitted_at)
        VALUES (?, ?, ?, ?)
      `).run('queued-job', 'build', 'queued', oldDate.toISOString());

      const purged = queue.purgeExpiredJobs();
      expect(purged).toBe(0);

      const status = await queue.getStatus('queued-job');
      expect(status).not.toBeNull();
      expect(status!.status).toBe('queued');
    });
  });

  describe('stop', () => {
    it('should stop the scheduler and cancel running jobs', async () => {
      queue = createJobQueue(db, { pollIntervalMs: 50 });
      queue.start();

      const blocking = createBlockingJob('build');
      const id = await queue.submit(blocking.definition);

      // Wait for the job to start running
      await waitFor(async () => {
        const s = await queue.getStatus(id);
        return s?.status === 'running';
      });

      queue.stop();

      // Job should be cancelled after stop
      const status = await queue.getStatus(id);
      expect(status!.status).toBe('cancelled');

      blocking.resolve();
    });
  });
});
