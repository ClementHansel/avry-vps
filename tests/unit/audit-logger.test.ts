/**
 * Unit tests for the Audit Logger module.
 * Tests logging, querying, FTS search, export, retention purging, and storage monitoring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createAuditLogger,
  ensureFtsTriggers,
  type AuditEntry,
  type AuditLogger,
} from '../../src/modules/audit-logger.js';
import type Database from 'better-sqlite3';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-audit-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createSampleEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    actor: 'admin',
    actionType: 'container.start',
    targetResource: 'container:nginx',
    details: { containerId: 'abc123', reason: 'deploy' },
    sourceIp: '192.168.1.1',
    projectId: 'project-1',
    result: 'success',
    ...overrides,
  };
}

describe('Audit Logger Module', () => {
  let dbPath: string;
  let db: Database.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    logger = createAuditLogger(db, dbPath);
  });

  afterEach(() => {
    logger.stopPurgeScheduler();
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('log', () => {
    it('should insert an audit entry into the database', async () => {
      const entry = createSampleEntry();
      await logger.log(entry);

      const row = db.prepare('SELECT * FROM audit_log').get() as any;
      expect(row).toBeDefined();
      expect(row.actor).toBe('admin');
      expect(row.action_type).toBe('container.start');
      expect(row.target_resource).toBe('container:nginx');
      expect(row.result).toBe('success');
      expect(row.source_ip).toBe('192.168.1.1');
      expect(row.project_id).toBe('project-1');
    });

    it('should generate a UUID for the entry id', async () => {
      await logger.log(createSampleEntry());

      const row = db.prepare('SELECT id FROM audit_log').get() as { id: string };
      // UUID v4 format
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should store timestamp in ISO format with UTC', async () => {
      await logger.log(createSampleEntry());

      const row = db.prepare('SELECT timestamp FROM audit_log').get() as { timestamp: string };
      expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should serialize details as JSON', async () => {
      const entry = createSampleEntry({ details: { key: 'value', nested: { a: 1 } } });
      await logger.log(entry);

      const row = db.prepare('SELECT details FROM audit_log').get() as { details: string };
      const parsed = JSON.parse(row.details);
      expect(parsed.key).toBe('value');
      expect(parsed.nested.a).toBe(1);
    });

    it('should handle entries without projectId', async () => {
      const entry = createSampleEntry({ projectId: undefined });
      await logger.log(entry);

      const row = db.prepare('SELECT project_id FROM audit_log').get() as { project_id: string | null };
      expect(row.project_id).toBeNull();
    });

    it('should auto-populate FTS via trigger', async () => {
      await logger.log(createSampleEntry());

      const ftsRow = db.prepare('SELECT * FROM audit_log_fts').get() as any;
      expect(ftsRow).toBeDefined();
      expect(ftsRow.action_type).toBe('container.start');
      expect(ftsRow.target_resource).toBe('container:nginx');
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Insert multiple entries
      for (let i = 0; i < 60; i++) {
        await logger.log(
          createSampleEntry({
            actor: i % 2 === 0 ? 'admin' : 'system',
            actionType: i % 3 === 0 ? 'container.start' : 'file.edit',
            result: i % 5 === 0 ? 'failure' : 'success',
            projectId: i % 4 === 0 ? 'project-A' : 'project-B',
          })
        );
      }
    });

    it('should return paginated results with 50 per page', async () => {
      const result = await logger.query({});
      expect(result.pageSize).toBe(50);
      expect(result.data.length).toBe(50);
      expect(result.total).toBe(60);
      expect(result.totalPages).toBe(2);
      expect(result.page).toBe(1);
    });

    it('should return page 2 with remaining entries', async () => {
      const result = await logger.query({ page: 2 });
      expect(result.data.length).toBe(10);
      expect(result.page).toBe(2);
    });

    it('should filter by actor', async () => {
      const result = await logger.query({ actor: 'admin' });
      expect(result.total).toBe(30);
      for (const record of result.data) {
        expect(record.actor).toBe('admin');
      }
    });

    it('should filter by actionType', async () => {
      const result = await logger.query({ actionType: 'container.start' });
      expect(result.total).toBe(20); // indices 0,3,6,...,57
      for (const record of result.data) {
        expect(record.actionType).toBe('container.start');
      }
    });

    it('should filter by result status', async () => {
      const result = await logger.query({ result: 'failure' });
      expect(result.total).toBe(12); // indices 0,5,10,...,55
      for (const record of result.data) {
        expect(record.result).toBe('failure');
      }
    });

    it('should filter by projectId', async () => {
      const result = await logger.query({ projectId: 'project-A' });
      expect(result.total).toBe(15);
      for (const record of result.data) {
        expect(record.projectId).toBe('project-A');
      }
    });

    it('should filter by date range', async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 100000);
      const past = new Date(now.getTime() - 100000);

      const result = await logger.query({ startDate: past, endDate: future });
      expect(result.total).toBe(60);
    });

    it('should return results in reverse chronological order', async () => {
      const result = await logger.query({});
      for (let i = 1; i < result.data.length; i++) {
        expect(result.data[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(
          result.data[i].timestamp.getTime()
        );
      }
    });

    it('should default page to 1 if not specified', async () => {
      const result = await logger.query({});
      expect(result.page).toBe(1);
    });

    it('should handle page less than 1 by defaulting to 1', async () => {
      const result = await logger.query({ page: -1 });
      expect(result.page).toBe(1);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await logger.log(createSampleEntry({
        actionType: 'container.start',
        targetResource: 'container:nginx-proxy',
        details: { reason: 'initial deploy' },
      }));
      await logger.log(createSampleEntry({
        actionType: 'file.edit',
        targetResource: '/etc/nginx/conf.d/default.conf',
        details: { changes: 'updated proxy_pass' },
      }));
      await logger.log(createSampleEntry({
        actionType: 'domain.create',
        targetResource: 'example.com',
        details: { proxyTarget: 'localhost:3000' },
      }));
    });

    it('should find entries by action_type match', async () => {
      const result = await logger.search('container');
      expect(result.total).toBeGreaterThanOrEqual(1);
      const hasNginx = result.data.some((r) => r.targetResource.includes('nginx'));
      expect(hasNginx).toBe(true);
    });

    it('should find entries by target_resource match', async () => {
      const result = await logger.search('nginx');
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('should find entries by details content', async () => {
      const result = await logger.search('deploy');
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('should return paginated search results', async () => {
      const result = await logger.search('container');
      expect(result.pageSize).toBe(50);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBeGreaterThanOrEqual(1);
    });

    it('should combine search with additional filters', async () => {
      const result = await logger.search('nginx', { actionType: 'file.edit' });
      // Should find the file.edit entry that mentions nginx in target_resource
      expect(result.total).toBeGreaterThanOrEqual(1);
      for (const record of result.data) {
        expect(record.actionType).toBe('file.edit');
      }
    });

    it('should return empty results for non-matching term', async () => {
      const result = await logger.search('zzzznonexistentterm');
      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
    });
  });

  describe('export', () => {
    beforeEach(async () => {
      await logger.log(createSampleEntry({ actor: 'admin', actionType: 'container.start' }));
      await logger.log(createSampleEntry({ actor: 'system', actionType: 'backup.create' }));
    });

    it('should export as JSON array', async () => {
      const buffer = await logger.export({}, 'json');
      const json = JSON.parse(buffer.toString('utf-8'));
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(2);
      expect(json[0]).toHaveProperty('id');
      expect(json[0]).toHaveProperty('timestamp');
      expect(json[0]).toHaveProperty('actor');
      expect(json[0]).toHaveProperty('actionType');
    });

    it('should export as CSV with headers', async () => {
      const buffer = await logger.export({}, 'csv');
      const csv = buffer.toString('utf-8');
      const lines = csv.split('\n');

      expect(lines[0]).toBe('id,timestamp,actor,actionType,targetResource,details,sourceIp,projectId,result');
      expect(lines.length).toBe(3); // header + 2 data rows
    });

    it('should respect filters in export', async () => {
      const buffer = await logger.export({ actor: 'admin' }, 'json');
      const json = JSON.parse(buffer.toString('utf-8'));
      expect(json.length).toBe(1);
      expect(json[0].actor).toBe('admin');
    });

    it('should escape CSV fields with commas', async () => {
      await logger.log(createSampleEntry({
        targetResource: 'file:config,backup.yml',
      }));

      const buffer = await logger.export({ targetResource: 'file:config,backup.yml' }, 'csv');
      const csv = buffer.toString('utf-8');
      // The field should be quoted
      expect(csv).toContain('"file:config,backup.yml"');
    });
  });

  describe('getStorageUsage', () => {
    it('should report storage usage for the database file', async () => {
      const usage = await logger.getStorageUsage();
      expect(usage.usedBytes).toBeGreaterThan(0);
      expect(usage.maxBytes).toBe(1024 * 1024 * 1024);
      expect(usage.alertThresholdPercent).toBe(90);
      expect(typeof usage.usagePercent).toBe('number');
      expect(typeof usage.isNearCapacity).toBe('boolean');
    });

    it('should detect when storage is near capacity', async () => {
      // Create logger with very small max
      const smallLogger = createAuditLogger(db, dbPath, {
        maxStorageBytes: 1, // 1 byte max — any db will exceed this
      });

      const usage = await smallLogger.getStorageUsage();
      expect(usage.isNearCapacity).toBe(true);
      expect(usage.usagePercent).toBeGreaterThan(90);
      smallLogger.stopPurgeScheduler();
    });

    it('should use custom alert threshold', async () => {
      const customLogger = createAuditLogger(db, dbPath, {
        alertThresholdPercent: 50,
        maxStorageBytes: 100, // very small
      });

      const usage = await customLogger.getStorageUsage();
      expect(usage.alertThresholdPercent).toBe(50);
      customLogger.stopPurgeScheduler();
    });
  });

  describe('purgeExpiredEntries', () => {
    it('should delete entries older than retention period', async () => {
      // Create logger with 1 day retention
      const shortRetention = createAuditLogger(db, dbPath, { retentionDays: 1 });

      // Insert an entry with old timestamp
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 2); // 2 days ago

      db.prepare(`
        INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('old-1', oldDate.toISOString(), 'admin', 'test', 'resource', '{}', '127.0.0.1', 'success');

      // Insert a recent entry
      await shortRetention.log(createSampleEntry());

      const purged = shortRetention.purgeExpiredEntries();
      expect(purged).toBe(1);

      // Recent entry should still exist
      const remaining = db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number };
      expect(remaining.count).toBe(1);

      shortRetention.stopPurgeScheduler();
    });

    it('should return 0 when no entries to purge', () => {
      const purged = logger.purgeExpiredEntries();
      expect(purged).toBe(0);
    });

    it('should also clean up FTS entries during purge', async () => {
      const shortRetention = createAuditLogger(db, dbPath, { retentionDays: 1 });

      // Insert old entry (manually to control timestamp)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 2);

      db.prepare(`
        INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('old-fts', oldDate.toISOString(), 'admin', 'old.action', 'old-resource', '{"data":"old"}', '127.0.0.1', 'success');

      // Check FTS has the entry (from trigger)
      const ftsBefore = db.prepare("SELECT COUNT(*) as count FROM audit_log_fts WHERE audit_log_fts MATCH '\"old.action\"'").get() as { count: number };
      expect(ftsBefore.count).toBe(1);

      shortRetention.purgeExpiredEntries();

      // FTS entry should be removed
      const ftsAfter = db.prepare("SELECT COUNT(*) as count FROM audit_log_fts WHERE audit_log_fts MATCH '\"old.action\"'").get() as { count: number };
      expect(ftsAfter.count).toBe(0);

      shortRetention.stopPurgeScheduler();
    });
  });

  describe('purge scheduler', () => {
    it('should start and stop without errors', () => {
      logger.startPurgeScheduler();
      // Starting again should be idempotent
      logger.startPurgeScheduler();
      logger.stopPurgeScheduler();
    });

    it('should invoke storage alert callback when threshold exceeded', async () => {
      const alertFn = vi.fn();
      const alertLogger = createAuditLogger(db, dbPath, {
        maxStorageBytes: 1, // Intentionally tiny to trigger alert
        purgeIntervalMs: 50,
        onStorageAlert: alertFn,
      });

      alertLogger.startPurgeScheduler();

      // Wait for the interval to fire
      await new Promise((resolve) => setTimeout(resolve, 150));

      alertLogger.stopPurgeScheduler();
      expect(alertFn).toHaveBeenCalled();
      const callArg = alertFn.mock.calls[0][0];
      expect(callArg.isNearCapacity).toBe(true);
    });
  });

  describe('FTS5 triggers', () => {
    it('should automatically index new entries via trigger', async () => {
      await logger.log(createSampleEntry({
        actionType: 'domain.create',
        targetResource: 'mydomain.example.org',
        details: { ssl: true },
      }));

      const fts = db.prepare("SELECT * FROM audit_log_fts WHERE audit_log_fts MATCH '\"mydomain.example.org\"'").all();
      expect(fts.length).toBe(1);
    });

    it('should ensure triggers are idempotent', () => {
      // Calling ensureFtsTriggers multiple times should not throw
      expect(() => ensureFtsTriggers(db)).not.toThrow();
      expect(() => ensureFtsTriggers(db)).not.toThrow();
    });
  });

  describe('append-only enforcement', () => {
    it('should only expose INSERT operations (no update/delete methods)', () => {
      // The AuditLogger interface only has log() for writing
      // There's no update or delete method on the public API
      expect(typeof logger.log).toBe('function');
      expect((logger as any).update).toBeUndefined();
      expect((logger as any).delete).toBeUndefined();
      expect((logger as any).deleteEntry).toBeUndefined();
      expect((logger as any).updateEntry).toBeUndefined();
    });
  });
});
