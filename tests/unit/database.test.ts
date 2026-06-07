/**
 * Unit tests for the database module.
 * Tests SQLite initialization, schema creation, migration runner, and health check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  initializeDatabase,
  checkHealth,
  closeDatabase,
  listTables,
  getDbPath,
  getCurrentSchemaVersion,
  applyMigrations,
} from '../../src/database/index.js';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Database Module', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  describe('getDbPath', () => {
    it('should use provided config path', () => {
      const result = getDbPath({ dbPath: '/custom/path/db.sqlite' });
      expect(result).toBe(path.resolve('/custom/path/db.sqlite'));
    });

    it('should use DB_PATH env var when no config provided', () => {
      const original = process.env.DB_PATH;
      process.env.DB_PATH = '/env/path/panel.db';
      try {
        const result = getDbPath();
        expect(result).toBe(path.resolve('/env/path/panel.db'));
      } finally {
        if (original !== undefined) {
          process.env.DB_PATH = original;
        } else {
          delete process.env.DB_PATH;
        }
      }
    });

    it('should default to ./data/panel.db', () => {
      const original = process.env.DB_PATH;
      delete process.env.DB_PATH;
      try {
        const result = getDbPath();
        expect(result).toBe(path.resolve('./data/panel.db'));
      } finally {
        if (original !== undefined) {
          process.env.DB_PATH = original;
        }
      }
    });
  });

  describe('initializeDatabase', () => {
    it('should create the database file and directory', () => {
      const db = initializeDatabase({ dbPath });
      expect(fs.existsSync(dbPath)).toBe(true);
      closeDatabase(db);
    });

    it('should enable WAL mode by default', () => {
      const db = initializeDatabase({ dbPath });
      const mode = db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
      closeDatabase(db);
    });

    it('should skip WAL mode when walMode is false', () => {
      const db = initializeDatabase({ dbPath, walMode: false });
      const mode = db.pragma('journal_mode', { simple: true });
      // Without explicit WAL, SQLite defaults to 'delete' journal mode
      expect(mode).not.toBe('wal');
      closeDatabase(db);
    });

    it('should enable foreign keys', () => {
      const db = initializeDatabase({ dbPath });
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
      closeDatabase(db);
    });

    it('should create all expected tables', () => {
      const db = initializeDatabase({ dbPath });
      const tables = listTables(db);

      const expectedTables = [
        'projects',
        'project_resources',
        'jobs',
        'pipeline_configs',
        'webhook_configs',
        'webhook_events',
        'tunnel_configs',
        'tunnel_transfers',
        'cicd_configs',
        'cicd_sync_events',
        'domains',
        'certificates',
        'backup_schedules',
        'backups',
        'alert_rules',
        'alert_channels',
        'alerts',
        'firewall_rules',
        'security_scans',
        'audit_log',
        'sessions',
        'rate_limits',
        'concurrency_limits',
        'cron_jobs',
        'cron_executions',
        'schema_migrations',
      ];

      for (const table of expectedTables) {
        expect(tables).toContain(table);
      }

      closeDatabase(db);
    });

    it('should create default concurrency limits', () => {
      const db = initializeDatabase({ dbPath });
      const rows = db.prepare('SELECT * FROM concurrency_limits ORDER BY operation_type').all() as {
        operation_type: string;
        max_concurrent: number;
      }[];

      expect(rows.length).toBeGreaterThanOrEqual(3);

      const buildLimit = rows.find((r) => r.operation_type === 'build');
      expect(buildLimit?.max_concurrent).toBe(2);

      const deployLimit = rows.find((r) => r.operation_type === 'deploy');
      expect(deployLimit?.max_concurrent).toBe(3);

      const dbImportLimit = rows.find((r) => r.operation_type === 'db-import');
      expect(dbImportLimit?.max_concurrent).toBe(1);

      closeDatabase(db);
    });

    it('should be idempotent (safe to call multiple times)', () => {
      const db1 = initializeDatabase({ dbPath });
      closeDatabase(db1);

      // Second initialization should not throw
      const db2 = initializeDatabase({ dbPath });
      const tables = listTables(db2);
      expect(tables).toContain('projects');
      closeDatabase(db2);
    });
  });

  describe('applyMigrations', () => {
    it('should set schema version to 1 after initial migration', () => {
      const db = initializeDatabase({ dbPath });
      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(1);
      closeDatabase(db);
    });

    it('should not re-apply migrations on subsequent calls', () => {
      const db = initializeDatabase({ dbPath });

      // Insert a test row
      db.prepare("INSERT INTO projects (id, name) VALUES ('test-1', 'Test Project')").run();

      // Re-apply migrations (should be a no-op)
      applyMigrations(db);

      // The test row should still exist
      const row = db.prepare("SELECT * FROM projects WHERE id = 'test-1'").get() as { name: string } | undefined;
      expect(row?.name).toBe('Test Project');

      closeDatabase(db);
    });
  });

  describe('checkHealth', () => {
    it('should report healthy for a valid database', () => {
      const db = initializeDatabase({ dbPath });
      const health = checkHealth(db);

      expect(health.healthy).toBe(true);
      expect(health.walMode).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();

      closeDatabase(db);
    });

    it('should report unhealthy after database is closed', () => {
      const db = initializeDatabase({ dbPath });
      closeDatabase(db);

      const health = checkHealth(db);
      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('should report walMode false when WAL is not enabled', () => {
      const db = initializeDatabase({ dbPath, walMode: false });
      const health = checkHealth(db);

      expect(health.healthy).toBe(true);
      expect(health.walMode).toBe(false);

      closeDatabase(db);
    });
  });

  describe('Schema integrity', () => {
    it('should enforce foreign key constraints', () => {
      const db = initializeDatabase({ dbPath });

      // Inserting a project_resource without a valid project_id should fail
      expect(() => {
        db.prepare(
          "INSERT INTO project_resources (id, project_id, resource_type, resource_id) VALUES ('r1', 'nonexistent', 'container', 'c1')"
        ).run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should enforce unique constraints on projects.name', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'My Project')").run();

      expect(() => {
        db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'My Project')").run();
      }).toThrow();

      closeDatabase(db);
    });

    it('should cascade delete project resources when project is deleted', () => {
      const db = initializeDatabase({ dbPath });

      db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project 1')").run();
      db.prepare(
        "INSERT INTO project_resources (id, project_id, resource_type, resource_id) VALUES ('r1', 'p1', 'container', 'c1')"
      ).run();

      db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

      const resources = db.prepare("SELECT * FROM project_resources WHERE project_id = 'p1'").all();
      expect(resources).toHaveLength(0);

      closeDatabase(db);
    });

    it('should have indexes on jobs table', () => {
      const db = initializeDatabase({ dbPath });

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_jobs_status');
      expect(indexNames).toContain('idx_jobs_type_status');
      expect(indexNames).toContain('idx_jobs_project');

      closeDatabase(db);
    });

    it('should support FTS5 on audit_log_fts', () => {
      const db = initializeDatabase({ dbPath });

      // Insert an audit log entry
      db.prepare(
        "INSERT INTO audit_log (id, actor, action_type, target_resource, details, result) VALUES ('a1', 'admin', 'container.start', 'container:nginx', '{\"reason\":\"deploy\"}', 'success')"
      ).run();

      // Manually insert into FTS table (in production, triggers would do this)
      db.prepare(
        "INSERT INTO audit_log_fts (rowid, action_type, target_resource, details) VALUES (last_insert_rowid(), 'container.start', 'container:nginx', '{\"reason\":\"deploy\"}')"
      ).run();

      // Search via FTS
      const results = db
        .prepare("SELECT * FROM audit_log_fts WHERE audit_log_fts MATCH 'container'")
        .all();
      expect(results.length).toBeGreaterThanOrEqual(1);

      closeDatabase(db);
    });
  });
});
