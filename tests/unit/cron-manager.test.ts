/**
 * Cron Manager Unit Tests
 *
 * Tests for cron job CRUD, expression validation, human-readable descriptions,
 * crontab sync, and execution history tracking.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createCronManager,
  validateExpression,
  describeExpression,
  syncCrontab,
} from '../../src/modules/cron-manager.js';
import type { CronManager } from '../../src/modules/cron-manager.js';
import { SCHEMA_SQL } from '../../src/database/index.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Cron Manager', () => {
  let db: Database.Database;
  let manager: CronManager;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    manager = createCronManager(db, { execCommand: mockExec });
  });

  afterEach(() => {
    db.close();
  });

  // ─── validateExpression ────────────────────────────────────────────────────

  describe('validateExpression', () => {
    it('should return valid for a correct cron expression', () => {
      const result = validateExpression('0 3 * * *');
      expect(result.valid).toBe(true);
      expect(result.nextRun).toBeInstanceOf(Date);
    });

    it('should return valid for every minute (* * * * *)', () => {
      const result = validateExpression('* * * * *');
      expect(result.valid).toBe(true);
    });

    it('should return valid for step expressions', () => {
      const result = validateExpression('*/5 * * * *');
      expect(result.valid).toBe(true);
    });

    it('should return valid for range expressions', () => {
      const result = validateExpression('0 9-17 * * 1-5');
      expect(result.valid).toBe(true);
    });

    it('should return valid for comma-separated values', () => {
      const result = validateExpression('0 0,12 * * *');
      expect(result.valid).toBe(true);
    });

    it('should return invalid for an empty string', () => {
      const result = validateExpression('');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return invalid for gibberish', () => {
      const result = validateExpression('not a cron expression');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return invalid for out-of-range minute (60)', () => {
      const result = validateExpression('60 * * * *');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for out-of-range hour (25)', () => {
      const result = validateExpression('0 25 * * *');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for out-of-range day of month (32)', () => {
      const result = validateExpression('0 0 32 * *');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for out-of-range month (13)', () => {
      const result = validateExpression('0 0 1 13 *');
      expect(result.valid).toBe(false);
    });

    it('should return invalid for too few fields', () => {
      const result = validateExpression('0 3 *');
      expect(result.valid).toBe(false);
    });
  });

  // ─── describeExpression ────────────────────────────────────────────────────

  describe('describeExpression', () => {
    it('should describe * * * * * as "Every minute"', () => {
      expect(describeExpression('* * * * *')).toBe('Every minute');
    });

    it('should describe */5 * * * * as "Every 5 minutes"', () => {
      expect(describeExpression('*/5 * * * *')).toBe('Every 5 minutes');
    });

    it('should describe */15 * * * * as "Every 15 minutes"', () => {
      expect(describeExpression('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('should describe 0 */2 * * * as "Every 2 hours"', () => {
      expect(describeExpression('0 */2 * * *')).toBe('Every 2 hours');
    });

    it('should describe 0 * * * * as "Every hour"', () => {
      expect(describeExpression('0 * * * *')).toBe('Every hour');
    });

    it('should describe 30 * * * * as "Every hour at minute 30"', () => {
      expect(describeExpression('30 * * * *')).toBe('Every hour at minute 30');
    });

    it('should describe 0 3 * * * as "Every day at 3:00 AM"', () => {
      expect(describeExpression('0 3 * * *')).toBe('Every day at 3:00 AM');
    });

    it('should describe 30 14 * * * as "Every day at 2:30 PM"', () => {
      expect(describeExpression('30 14 * * *')).toBe('Every day at 2:30 PM');
    });

    it('should describe 0 0 * * * as "Every day at 12:00 AM"', () => {
      expect(describeExpression('0 0 * * *')).toBe('Every day at 12:00 AM');
    });

    it('should describe 0 12 * * * as "Every day at 12:00 PM"', () => {
      expect(describeExpression('0 12 * * *')).toBe('Every day at 12:00 PM');
    });

    it('should describe 0 9 * * 1-5 as "Weekdays at 9:00 AM"', () => {
      expect(describeExpression('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM');
    });

    it('should describe 0 10 * * 0,6 as "Weekends at 10:00 AM"', () => {
      expect(describeExpression('0 10 * * 0,6')).toBe('Weekends at 10:00 AM');
    });

    it('should describe 0 0 1 * * as "Day 1 of every month at 12:00 AM"', () => {
      expect(describeExpression('0 0 1 * *')).toBe('Day 1 of every month at 12:00 AM');
    });

    it('should describe 0 6 15 6 * as "June 15 at 6:00 AM"', () => {
      expect(describeExpression('0 6 15 6 *')).toBe('June 15 at 6:00 AM');
    });

    it('should return a fallback for complex expressions', () => {
      const desc = describeExpression('0,30 9-17 * * 1-5');
      expect(desc).toContain('Custom schedule');
    });

    it('should handle malformed input gracefully', () => {
      const desc = describeExpression('bad');
      expect(desc).toBe('bad');
    });
  });

  // ─── createJob ─────────────────────────────────────────────────────────────

  describe('createJob', () => {
    it('should create a new cron job with valid expression', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/usr/bin/backup.sh',
        user: 'root',
      });

      expect(job.id).toBeDefined();
      expect(job.expression).toBe('0 3 * * *');
      expect(job.command).toBe('/usr/bin/backup.sh');
      expect(job.user).toBe('root');
      expect(job.enabled).toBe(true);
      expect(job.description).toBe('Every day at 3:00 AM');
      expect(job.createdAt).toBeInstanceOf(Date);
    });

    it('should reject an invalid cron expression', async () => {
      await expect(
        manager.createJob({
          expression: 'invalid',
          command: '/usr/bin/test.sh',
        })
      ).rejects.toThrow('Invalid cron expression');
    });

    it('should default user to root', async () => {
      const job = await manager.createJob({
        expression: '*/5 * * * *',
        command: '/usr/bin/check.sh',
      });

      expect(job.user).toBe('root');
    });

    it('should default enabled to true', async () => {
      const job = await manager.createJob({
        expression: '0 0 * * *',
        command: '/usr/bin/midnight.sh',
      });

      expect(job.enabled).toBe(true);
    });

    it('should allow creating a disabled job', async () => {
      const job = await manager.createJob({
        expression: '0 0 * * *',
        command: '/usr/bin/disabled.sh',
        enabled: false,
      });

      expect(job.enabled).toBe(false);
    });

    it('should call exec to sync the crontab after creation', async () => {
      await manager.createJob({
        expression: '0 3 * * *',
        command: '/usr/bin/backup.sh',
        user: 'root',
      });

      // Should have called exec for reading existing crontab and writing new one
      expect(mockExec).toHaveBeenCalled();
    });
  });

  // ─── listJobs ──────────────────────────────────────────────────────────────

  describe('listJobs', () => {
    it('should return an empty array when no jobs exist', async () => {
      const jobs = await manager.listJobs();
      expect(jobs).toEqual([]);
    });

    it('should return all created jobs', async () => {
      await manager.createJob({ expression: '0 3 * * *', command: '/bin/a' });
      await manager.createJob({ expression: '0 6 * * *', command: '/bin/b' });

      const jobs = await manager.listJobs();
      expect(jobs).toHaveLength(2);
    });

    it('should include last execution info when available', async () => {
      const job = await manager.createJob({ expression: '0 3 * * *', command: '/bin/a' });
      await manager.recordExecution(job.id, 0, 'success output');

      const jobs = await manager.listJobs();
      expect(jobs[0].lastExecution).toBeDefined();
      expect(jobs[0].lastExecution!.exitCode).toBe(0);
      expect(jobs[0].lastExecution!.output).toBe('success output');
    });
  });

  // ─── updateJob ─────────────────────────────────────────────────────────────

  describe('updateJob', () => {
    it('should update the expression and regenerate description', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const updated = await manager.updateJob(job.id, {
        expression: '*/5 * * * *',
      });

      expect(updated.expression).toBe('*/5 * * * *');
      expect(updated.description).toBe('Every 5 minutes');
    });

    it('should update the command', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const updated = await manager.updateJob(job.id, {
        command: '/bin/b',
      });

      expect(updated.command).toBe('/bin/b');
    });

    it('should update enabled status', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const updated = await manager.updateJob(job.id, { enabled: false });
      expect(updated.enabled).toBe(false);
    });

    it('should throw when updating a non-existent job', async () => {
      await expect(
        manager.updateJob('non-existent-id', { command: '/bin/x' })
      ).rejects.toThrow('Cron job not found');
    });

    it('should reject invalid expression on update', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      await expect(
        manager.updateJob(job.id, { expression: 'invalid' })
      ).rejects.toThrow('Invalid cron expression');
    });

    it('should sync crontab for both old and new user on user change', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
        user: 'root',
      });

      mockExec.mockClear();
      await manager.updateJob(job.id, { user: 'www-data' });

      // Should sync for new user (www-data) and old user (root)
      const calls = mockExec.mock.calls.map((c) => c[0]);
      const hasCrontabCalls = calls.some((cmd: string) => cmd.includes('crontab'));
      expect(hasCrontabCalls).toBe(true);
    });
  });

  // ─── deleteJob ─────────────────────────────────────────────────────────────

  describe('deleteJob', () => {
    it('should delete an existing job', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      await manager.deleteJob(job.id);

      const jobs = await manager.listJobs();
      expect(jobs).toHaveLength(0);
    });

    it('should throw when deleting a non-existent job', async () => {
      await expect(manager.deleteJob('non-existent-id')).rejects.toThrow(
        'Cron job not found'
      );
    });

    it('should sync the crontab after deletion', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
        user: 'root',
      });

      mockExec.mockClear();
      await manager.deleteJob(job.id);

      expect(mockExec).toHaveBeenCalled();
    });

    it('should cascade delete execution history', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      await manager.recordExecution(job.id, 0, 'output');
      await manager.deleteJob(job.id);

      // History should be gone due to CASCADE
      const history = await manager.getJobHistory(job.id);
      expect(history).toHaveLength(0);
    });
  });

  // ─── getJobHistory ─────────────────────────────────────────────────────────

  describe('getJobHistory', () => {
    it('should return empty array when no executions exist', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const history = await manager.getJobHistory(job.id);
      expect(history).toEqual([]);
    });

    it('should return executions in reverse chronological order', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      await manager.recordExecution(job.id, 0, 'first');
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await manager.recordExecution(job.id, 1, 'second');

      const history = await manager.getJobHistory(job.id);
      expect(history).toHaveLength(2);
      expect(history[0].output).toBe('second');
      expect(history[1].output).toBe('first');
    });

    it('should respect the limit parameter', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      for (let i = 0; i < 10; i++) {
        await manager.recordExecution(job.id, 0, `run ${i}`);
      }

      const history = await manager.getJobHistory(job.id, 3);
      expect(history).toHaveLength(3);
    });
  });

  // ─── recordExecution ───────────────────────────────────────────────────────

  describe('recordExecution', () => {
    it('should store execution with exit code and output', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const exec = await manager.recordExecution(job.id, 0, 'backup completed');
      expect(exec.id).toBeDefined();
      expect(exec.jobId).toBe(job.id);
      expect(exec.exitCode).toBe(0);
      expect(exec.output).toBe('backup completed');
      expect(exec.timestamp).toBeInstanceOf(Date);
    });

    it('should truncate output to 1000 characters', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const longOutput = 'x'.repeat(2000);
      const exec = await manager.recordExecution(job.id, 0, longOutput);

      expect(exec.output.length).toBe(1000);
    });

    it('should handle null exit code', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const exec = await manager.recordExecution(job.id, null, 'killed');
      expect(exec.exitCode).toBe(null);
    });

    it('should store non-zero exit codes', async () => {
      const job = await manager.createJob({
        expression: '0 3 * * *',
        command: '/bin/a',
      });

      const exec = await manager.recordExecution(job.id, 127, 'command not found');
      expect(exec.exitCode).toBe(127);
    });
  });

  // ─── syncCrontab ───────────────────────────────────────────────────────────

  describe('syncCrontab', () => {
    it('should write enabled jobs to crontab with markers', async () => {
      // Create some jobs
      db.prepare(`
        INSERT INTO cron_jobs (id, expression, command, user, enabled, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('job1', '0 3 * * *', '/bin/backup.sh', 'root', 1, 'Every day at 3:00 AM', new Date().toISOString());

      const writtenContent: string[] = [];
      const localExec = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes('crontab -l')) {
          return { stdout: '', stderr: '' };
        }
        writtenContent.push(cmd);
        return { stdout: '', stderr: '' };
      });

      await syncCrontab(db, 'root', localExec);

      expect(writtenContent.length).toBeGreaterThan(0);
      const content = writtenContent[0];
      expect(content).toContain('BEGIN VPS-PANEL MANAGED CRON JOBS');
      expect(content).toContain('END VPS-PANEL MANAGED CRON JOBS');
      expect(content).toContain('0 3 * * * /bin/backup.sh');
    });

    it('should not include disabled jobs in crontab', async () => {
      db.prepare(`
        INSERT INTO cron_jobs (id, expression, command, user, enabled, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('job1', '0 3 * * *', '/bin/backup.sh', 'root', 0, 'disabled', new Date().toISOString());

      const writtenContent: string[] = [];
      const localExec = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes('crontab -l')) {
          return { stdout: '', stderr: '' };
        }
        if (cmd.includes('crontab -r')) {
          return { stdout: '', stderr: '' };
        }
        writtenContent.push(cmd);
        return { stdout: '', stderr: '' };
      });

      await syncCrontab(db, 'root', localExec);

      // With no enabled jobs and no existing crontab content, it should try to remove
      const calls = localExec.mock.calls.map((c: any[]) => c[0]);
      const hasRemoveCall = calls.some((cmd: string) => cmd.includes('crontab -r'));
      expect(hasRemoveCall).toBe(true);
    });

    it('should preserve non-panel crontab entries', async () => {
      db.prepare(`
        INSERT INTO cron_jobs (id, expression, command, user, enabled, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('job1', '0 3 * * *', '/bin/backup.sh', 'root', 1, 'test', new Date().toISOString());

      const existingCrontab = `# Existing manual entry
0 1 * * * /usr/bin/manual-job.sh
# BEGIN VPS-PANEL MANAGED CRON JOBS
# Job ID: old-job
0 0 * * * /bin/old.sh
# END VPS-PANEL MANAGED CRON JOBS`;

      const writtenContent: string[] = [];
      const localExec = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes('crontab -l')) {
          return { stdout: existingCrontab, stderr: '' };
        }
        writtenContent.push(cmd);
        return { stdout: '', stderr: '' };
      });

      await syncCrontab(db, 'root', localExec);

      expect(writtenContent.length).toBeGreaterThan(0);
      const content = writtenContent[0];
      expect(content).toContain('/usr/bin/manual-job.sh');
      expect(content).toContain('/bin/backup.sh');
      expect(content).not.toContain('/bin/old.sh');
    });

    it('should handle crontab read failure gracefully', async () => {
      db.prepare(`
        INSERT INTO cron_jobs (id, expression, command, user, enabled, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('job1', '0 3 * * *', '/bin/backup.sh', 'root', 1, 'test', new Date().toISOString());

      const localExec = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes('crontab -l')) {
          throw new Error('no crontab for user');
        }
        return { stdout: '', stderr: '' };
      });

      // Should not throw
      await expect(syncCrontab(db, 'root', localExec)).resolves.not.toThrow();
    });
  });
});
