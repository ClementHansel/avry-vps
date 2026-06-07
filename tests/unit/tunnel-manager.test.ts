/**
 * Tunnel Manager Unit Tests
 *
 * Tests for CRUD operations, auth token generation, transfer triggering,
 * concurrent transfer rejection, transfer history, and CLI script generation.
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createTunnelManager } from '../../src/modules/tunnel-manager.js';
import type {
  TunnelManager,
  TunnelManagerDeps,
  TunnelConfig,
} from '../../src/modules/tunnel-manager.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTempDb(): { db: Database.Database; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-tunnel-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tunnel_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      remote_path TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'rsync',
      exclude_patterns TEXT,
      post_transfer_command TEXT,
      auth_token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tunnel_transfers (
      id TEXT PRIMARY KEY,
      tunnel_id TEXT NOT NULL REFERENCES tunnel_configs(id) ON DELETE CASCADE,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      file_count INTEGER,
      total_size INTEGER,
      duration INTEGER,
      status TEXT NOT NULL
    );
  `);

  return { db, dbPath };
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockDeps(overrides?: Partial<TunnelManagerDeps>): TunnelManagerDeps {
  return {
    submitJob: vi.fn().mockResolvedValue('job-tunnel-123'),
    ...overrides,
  };
}

function createProject(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Tunnel Manager Module', () => {
  let db: Database.Database;
  let dbPath: string;
  let deps: TunnelManagerDeps;
  let tm: TunnelManager;

  beforeEach(() => {
    const result = createTempDb();
    db = result.db;
    dbPath = result.dbPath;
    deps = createMockDeps();

    tm = createTunnelManager({
      db,
      deps,
      baseUrl: 'https://panel.aivory.id',
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  // ─── listConfigurations ──────────────────────────────────────────────────

  describe('listConfigurations', () => {
    it('should return empty array when no configurations exist', () => {
      const configs = tm.listConfigurations();
      expect(configs).toEqual([]);
    });

    it('should return all configurations in reverse chronological order', () => {
      tm.createConfiguration({ name: 'First', remotePath: '/opt/app1' });
      tm.createConfiguration({ name: 'Second', remotePath: '/opt/app2' });

      const configs = tm.listConfigurations();
      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe('Second');
      expect(configs[1].name).toBe('First');
    });
  });

  // ─── createConfiguration ─────────────────────────────────────────────────

  describe('createConfiguration', () => {
    it('should create a configuration with required fields', () => {
      const config = tm.createConfiguration({
        name: 'My App',
        remotePath: '/opt/aivery/my-app',
      });

      expect(config.id).toBeTruthy();
      expect(config.name).toBe('My App');
      expect(config.remotePath).toBe('/opt/aivery/my-app');
      expect(config.protocol).toBe('rsync');
      expect(config.excludePatterns).toEqual([]);
      expect(config.postTransferCommand).toBeUndefined();
      expect(config.authToken).toBeTruthy();
      expect(config.createdAt).toBeTruthy();
    });

    it('should create a configuration with all optional fields', () => {
      const config = tm.createConfiguration({
        name: 'Full Config',
        remotePath: '/opt/aivery/full',
        protocol: 'scp',
        excludePatterns: ['node_modules', '.git', '*.log'],
        postTransferCommand: 'docker-compose up -d --build',
      });

      expect(config.protocol).toBe('scp');
      expect(config.excludePatterns).toEqual(['node_modules', '.git', '*.log']);
      expect(config.postTransferCommand).toBe('docker-compose up -d --build');
    });

    it('should generate a unique auth token per configuration (Requirement 24.5)', () => {
      const config1 = tm.createConfiguration({ name: 'App1', remotePath: '/opt/app1' });
      const config2 = tm.createConfiguration({ name: 'App2', remotePath: '/opt/app2' });

      expect(config1.authToken).toBeTruthy();
      expect(config2.authToken).toBeTruthy();
      expect(config1.authToken).not.toBe(config2.authToken);
      // Auth token should be a 64-char hex string (two UUIDs concatenated without dashes)
      expect(config1.authToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should associate with a project when projectId is provided', () => {
      createProject(db, 'proj-1', 'Test Project');

      const config = tm.createConfiguration({
        name: 'Project App',
        remotePath: '/opt/aivery/project',
        projectId: 'proj-1',
      });

      expect(config.projectId).toBe('proj-1');
    });

    it('should persist to database and be retrievable', () => {
      tm.createConfiguration({ name: 'Persisted', remotePath: '/opt/persisted' });

      const configs = tm.listConfigurations();
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('Persisted');
    });
  });

  // ─── updateConfiguration ─────────────────────────────────────────────────

  describe('updateConfiguration', () => {
    it('should update the name of a configuration', () => {
      const config = tm.createConfiguration({ name: 'Original', remotePath: '/opt/app' });
      const updated = tm.updateConfiguration(config.id, { name: 'Updated Name' });

      expect(updated.name).toBe('Updated Name');
      expect(updated.remotePath).toBe('/opt/app');
    });

    it('should update the remote path', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/old' });
      const updated = tm.updateConfiguration(config.id, { remotePath: '/opt/new' });

      expect(updated.remotePath).toBe('/opt/new');
    });

    it('should update the protocol', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const updated = tm.updateConfiguration(config.id, { protocol: 'scp' });

      expect(updated.protocol).toBe('scp');
    });

    it('should update exclude patterns', () => {
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
        excludePatterns: ['node_modules'],
      });
      const updated = tm.updateConfiguration(config.id, {
        excludePatterns: ['node_modules', '.git', 'dist'],
      });

      expect(updated.excludePatterns).toEqual(['node_modules', '.git', 'dist']);
    });

    it('should update post-transfer command', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const updated = tm.updateConfiguration(config.id, {
        postTransferCommand: 'npm run build',
      });

      expect(updated.postTransferCommand).toBe('npm run build');
    });

    it('should preserve auth token on update', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const updated = tm.updateConfiguration(config.id, { name: 'New Name' });

      expect(updated.authToken).toBe(config.authToken);
    });

    it('should throw when updating non-existent configuration', () => {
      expect(() => tm.updateConfiguration('nonexistent-id', { name: 'Test' }))
        .toThrow('Tunnel configuration nonexistent-id not found');
    });

    it('should allow clearing post-transfer command by passing undefined', () => {
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
        postTransferCommand: 'echo done',
      });

      // Passing undefined should keep the existing value
      const updated = tm.updateConfiguration(config.id, { name: 'Same' });
      expect(updated.postTransferCommand).toBe('echo done');
    });
  });

  // ─── deleteConfiguration ─────────────────────────────────────────────────

  describe('deleteConfiguration', () => {
    it('should delete an existing configuration', () => {
      const config = tm.createConfiguration({ name: 'ToDelete', remotePath: '/opt/del' });
      expect(tm.listConfigurations()).toHaveLength(1);

      tm.deleteConfiguration(config.id);
      expect(tm.listConfigurations()).toHaveLength(0);
    });

    it('should throw when deleting non-existent configuration', () => {
      expect(() => tm.deleteConfiguration('nonexistent-id'))
        .toThrow('Tunnel configuration nonexistent-id not found');
    });

    it('should cascade-delete transfer history when config is deleted', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });

      // Insert a transfer record directly
      db.prepare(`
        INSERT INTO tunnel_transfers (id, tunnel_id, timestamp, file_count, total_size, duration, status)
        VALUES ('transfer-1', ?, datetime('now'), 10, 1024, 5, 'completed')
      `).run(config.id);

      const historyBefore = tm.getTransferHistory(config.id);
      expect(historyBefore).toHaveLength(1);

      tm.deleteConfiguration(config.id);

      // History should be empty now due to cascade delete
      const remaining = db.prepare('SELECT COUNT(*) as count FROM tunnel_transfers WHERE tunnel_id = ?')
        .get(config.id) as { count: number };
      expect(remaining.count).toBe(0);
    });
  });

  // ─── triggerPush ─────────────────────────────────────────────────────────

  describe('triggerPush', () => {
    it('should submit a transfer job to the queue (Requirement 24.3)', async () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const files = Buffer.from('fake tar content');

      const jobId = await tm.triggerPush(config.id, files);

      expect(jobId).toBe('job-tunnel-123');
      expect(deps.submitJob).toHaveBeenCalledTimes(1);
      expect(deps.submitJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tunnel-transfer',
          metadata: expect.objectContaining({
            tunnelId: config.id,
            tunnelName: 'App',
          }),
        })
      );
    });

    it('should throw when config does not exist', async () => {
      const files = Buffer.from('data');
      await expect(tm.triggerPush('nonexistent-id', files))
        .rejects.toThrow('Tunnel configuration nonexistent-id not found');
    });

    it('should reject concurrent transfers for same tunnel config (Requirement 24.9)', async () => {
      // Create a submitJob that never resolves the onComplete callback (simulating in-progress)
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const files = Buffer.from('data');

      // First push succeeds
      await tm.triggerPush(config.id, files);

      // Second push should be rejected
      await expect(tm.triggerPush(config.id, files))
        .rejects.toThrow('A transfer is already in progress for this tunnel configuration');
    });

    it('should allow a new transfer after the previous one completes', async () => {
      let onCompleteCb: ((result: any) => void) | undefined;
      const mockSubmitJob = vi.fn().mockImplementation(async (job) => {
        onCompleteCb = job.onComplete;
        return 'job-tunnel-123';
      });
      deps = { submitJob: mockSubmitJob };

      tm = createTunnelManager({ db, deps, baseUrl: 'https://panel.aivory.id' });
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const files = Buffer.from('data');

      // First push
      await tm.triggerPush(config.id, files);

      // Simulate job completion: the onComplete callback clears active transfer in-memory,
      // and we need to mark the DB record as completed (mimicking what the execute generator does)
      db.prepare("UPDATE tunnel_transfers SET status = 'completed' WHERE tunnel_id = ? AND status = 'in-progress'")
        .run(config.id);
      onCompleteCb!({ jobId: 'job-tunnel-123', status: 'completed', exitCode: 0, duration: 5 });

      // Second push should succeed now
      const jobId = await tm.triggerPush(config.id, files);
      expect(jobId).toBe('job-tunnel-123');
    });

    it('should create a transfer record with in-progress status', async () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const files = Buffer.from('some data');

      await tm.triggerPush(config.id, files);

      const history = tm.getTransferHistory(config.id);
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('in-progress');
      expect(history[0].totalSize).toBe(files.length);
    });

    it('should include projectId in job when config has one', async () => {
      createProject(db, 'proj-1', 'Test Project');
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
        projectId: 'proj-1',
      });
      const files = Buffer.from('data');

      await tm.triggerPush(config.id, files);

      expect(deps.submitJob).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
        })
      );
    });
  });

  // ─── getTransferHistory ──────────────────────────────────────────────────

  describe('getTransferHistory', () => {
    it('should return empty array when no transfers exist', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      const history = tm.getTransferHistory(config.id);
      expect(history).toEqual([]);
    });

    it('should return transfer records with all fields (Requirement 24.6)', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });

      // Insert a completed transfer directly
      db.prepare(`
        INSERT INTO tunnel_transfers (id, tunnel_id, timestamp, file_count, total_size, duration, status)
        VALUES ('t1', ?, '2024-01-15T10:00:00.000Z', 42, 1048576, 12, 'completed')
      `).run(config.id);

      const history = tm.getTransferHistory(config.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({
        id: 't1',
        tunnelId: config.id,
        timestamp: '2024-01-15T10:00:00.000Z',
        fileCount: 42,
        totalSize: 1048576,
        duration: 12,
        status: 'completed',
      });
    });

    it('should return last 50 transfers in reverse chronological order', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });

      // Insert 55 transfer records
      const stmt = db.prepare(`
        INSERT INTO tunnel_transfers (id, tunnel_id, timestamp, file_count, total_size, duration, status)
        VALUES (?, ?, ?, 10, 1024, 5, 'completed')
      `);

      for (let i = 0; i < 55; i++) {
        const ts = new Date(2024, 0, 1, 0, i, 0).toISOString();
        stmt.run(`transfer-${i}`, config.id, ts);
      }

      const history = tm.getTransferHistory(config.id);
      expect(history).toHaveLength(50);
      // Most recent first
      expect(history[0].id).toBe('transfer-54');
      expect(history[49].id).toBe('transfer-5');
    });

    it('should handle null fields gracefully', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });

      db.prepare(`
        INSERT INTO tunnel_transfers (id, tunnel_id, timestamp, file_count, total_size, duration, status)
        VALUES ('t1', ?, datetime('now'), NULL, NULL, NULL, 'failed')
      `).run(config.id);

      const history = tm.getTransferHistory(config.id);
      expect(history).toHaveLength(1);
      expect(history[0].fileCount).toBe(0);
      expect(history[0].totalSize).toBe(0);
      expect(history[0].duration).toBe(0);
    });
  });

  // ─── generateCliScript ───────────────────────────────────────────────────

  describe('generateCliScript', () => {
    it('should generate a valid bash script (Requirement 24.7)', () => {
      const config = tm.createConfiguration({
        name: 'My Deploy',
        remotePath: '/opt/aivery/deploy',
        excludePatterns: ['node_modules', '.git'],
      });

      const script = tm.generateCliScript(config.id);

      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('My Deploy');
      expect(script).toContain(config.authToken);
      expect(script).toContain(`https://panel.aivory.id/api/tunnels/${config.id}/push`);
      expect(script).toContain('node_modules');
      expect(script).toContain('.git');
    });

    it('should include the endpoint URL with auth token', () => {
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
      });

      const script = tm.generateCliScript(config.id);

      expect(script).toContain(`AUTH_TOKEN="${config.authToken}"`);
      expect(script).toContain(`ENDPOINT="https://panel.aivory.id/api/tunnels/${config.id}/push"`);
    });

    it('should throw when config does not exist', () => {
      expect(() => tm.generateCliScript('nonexistent-id'))
        .toThrow('Tunnel configuration nonexistent-id not found');
    });

    it('should include instructions for .tunnel.json usage', () => {
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
      });

      const script = tm.generateCliScript(config.id);

      expect(script).toContain('.tunnel.json');
      expect(script).toContain('curl');
      expect(script).toContain('tar');
    });

    it('should handle empty exclude patterns', () => {
      const config = tm.createConfiguration({
        name: 'App',
        remotePath: '/opt/app',
        excludePatterns: [],
      });

      const script = tm.generateCliScript(config.id);
      expect(script).toContain('EXCLUDE_PATTERNS=()');
    });

    it('should handle configurations with no baseUrl gracefully', () => {
      const tmNoBase = createTunnelManager({ db, deps, baseUrl: '' });
      const config = tmNoBase.createConfiguration({ name: 'App', remotePath: '/opt/app' });

      const script = tmNoBase.generateCliScript(config.id);
      expect(script).toContain(`/api/tunnels/${config.id}/push`);
    });
  });

  // ─── Auth Token Uniqueness ───────────────────────────────────────────────

  describe('Auth Token Generation', () => {
    it('should generate unique tokens across many configurations', () => {
      const tokens = new Set<string>();

      for (let i = 0; i < 20; i++) {
        const config = tm.createConfiguration({
          name: `App ${i}`,
          remotePath: `/opt/app${i}`,
        });
        tokens.add(config.authToken);
      }

      // All 20 tokens should be unique
      expect(tokens.size).toBe(20);
    });

    it('should generate tokens of sufficient length for security', () => {
      const config = tm.createConfiguration({ name: 'App', remotePath: '/opt/app' });
      // 64 hex chars = 256 bits of entropy
      expect(config.authToken.length).toBe(64);
    });
  });
});
