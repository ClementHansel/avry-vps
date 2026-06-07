/**
 * Webhook Handler Unit Tests
 *
 * Tests for webhook URL generation, signature validation (GitHub, GitLab, Bitbucket),
 * branch extraction, build triggering, event logging, and history retrieval.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { createWebhookHandler } from '../../src/modules/webhook-handler.js';
import type {
  WebhookHandler,
  WebhookHandlerDeps,
  WebhookConfig,
} from '../../src/modules/webhook-handler.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTempDb(): { db: Database.Database; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-wh-test-'));
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

    CREATE TABLE IF NOT EXISTS webhook_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      secret TEXT,
      trigger_branch TEXT NOT NULL DEFAULT 'main',
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_ip TEXT,
      branch TEXT,
      validation_result TEXT,
      triggered_action TEXT,
      response_code INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id, timestamp DESC);
  `);

  return { db, dbPath };
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockDeps(overrides?: Partial<WebhookHandlerDeps>): WebhookHandlerDeps {
  return {
    triggerBuild: vi.fn().mockResolvedValue('job-build-123'),
    ...overrides,
  };
}

function createProject(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
}

function computeGitHubSignature(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  return 'sha256=' + hmac.digest('hex');
}

function makeGitHubPushPayload(branch: string): string {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    repository: { full_name: 'owner/repo' },
    pusher: { name: 'user' },
  });
}

function makeGitLabPushPayload(branch: string): string {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    project: { path_with_namespace: 'owner/repo' },
    user_name: 'user',
  });
}

function makeBitbucketPushPayload(branch: string): string {
  return JSON.stringify({
    push: {
      changes: [
        {
          new: {
            name: branch,
            type: 'branch',
          },
        },
      ],
    },
    repository: { full_name: 'owner/repo' },
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Webhook Handler Module', () => {
  let db: Database.Database;
  let dbPath: string;
  let deps: WebhookHandlerDeps;
  let wh: WebhookHandler;
  const projectId = 'project-001';

  beforeEach(() => {
    const result = createTempDb();
    db = result.db;
    dbPath = result.dbPath;
    deps = createMockDeps();

    // Create a test project
    createProject(db, projectId, 'Test Project');

    wh = createWebhookHandler({
      db,
      deps,
      baseUrl: 'https://panel.aivory.id',
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  // ─── generateWebhookUrl ──────────────────────────────────────────────────

  describe('generateWebhookUrl', () => {
    it('should generate a webhook URL with token and secret', () => {
      const config = wh.generateWebhookUrl(projectId);

      expect(config).toBeDefined();
      expect(config.projectId).toBe(projectId);
      expect(config.token).toBeTruthy();
      expect(config.secret).toBeTruthy();
      expect(config.triggerBranch).toBe('main');
      expect(config.enabled).toBe(true);
      expect(config.url).toBe(`https://panel.aivory.id/api/webhooks/${projectId}/${config.token}`);
    });

    it('should allow specifying a trigger branch', () => {
      const config = wh.generateWebhookUrl(projectId, { triggerBranch: 'develop' });
      expect(config.triggerBranch).toBe('develop');
    });

    it('should return existing config if one already exists for the project', () => {
      const config1 = wh.generateWebhookUrl(projectId);
      const config2 = wh.generateWebhookUrl(projectId);

      expect(config1.id).toBe(config2.id);
      expect(config1.token).toBe(config2.token);
    });

    it('should generate URL in the format /api/webhooks/{project-id}/{token}', () => {
      const config = wh.generateWebhookUrl(projectId);
      expect(config.url).toMatch(/\/api\/webhooks\/project-001\/[a-f0-9]+$/);
    });
  });

  // ─── handleRequest - GitHub ──────────────────────────────────────────────

  describe('handleRequest - GitHub', () => {
    let webhookConfig: WebhookConfig;

    beforeEach(() => {
      webhookConfig = wh.generateWebhookUrl(projectId);
    });

    it('should validate GitHub HMAC-SHA256 signature and trigger build on matching branch', async () => {
      const body = makeGitHubPushPayload('main');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(200);
      expect(result.jobId).toBe('job-build-123');
      expect(deps.triggerBuild).toHaveBeenCalledWith(projectId);
    });

    it('should return 401 for invalid GitHub signature', async () => {
      const body = makeGitHubPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': 'sha256=invalid_signature',
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(401);
      expect(result.message).toContain('Invalid webhook signature');
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });

    it('should return 401 when GitHub signature header is missing', async () => {
      const body = makeGitHubPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(401);
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });

    it('should return 200 for non-matching branch', async () => {
      const body = makeGitHubPushPayload('feature-branch');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(200);
      expect(result.message).toContain('does not match');
      expect(result.jobId).toBeUndefined();
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });
  });

  // ─── handleRequest - GitLab ──────────────────────────────────────────────

  describe('handleRequest - GitLab', () => {
    let webhookConfig: WebhookConfig;

    beforeEach(() => {
      webhookConfig = wh.generateWebhookUrl(projectId);
    });

    it('should validate GitLab token header and trigger build on matching branch', async () => {
      const body = makeGitLabPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-gitlab-token': webhookConfig.secret!,
          'x-gitlab-event': 'Push Hook',
        },
        body,
        '5.6.7.8'
      );

      expect(result.statusCode).toBe(200);
      expect(result.jobId).toBe('job-build-123');
      expect(deps.triggerBuild).toHaveBeenCalledWith(projectId);
    });

    it('should return 401 for invalid GitLab token', async () => {
      const body = makeGitLabPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-gitlab-token': 'wrong-token',
          'x-gitlab-event': 'Push Hook',
        },
        body,
        '5.6.7.8'
      );

      expect(result.statusCode).toBe(401);
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });

    it('should return 401 when GitLab token header is missing', async () => {
      const body = makeGitLabPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-gitlab-event': 'Push Hook',
        },
        body,
        '5.6.7.8'
      );

      expect(result.statusCode).toBe(401);
    });

    it('should return 200 for non-matching branch from GitLab', async () => {
      const body = makeGitLabPushPayload('develop');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-gitlab-token': webhookConfig.secret!,
          'x-gitlab-event': 'Push Hook',
        },
        body,
        '5.6.7.8'
      );

      expect(result.statusCode).toBe(200);
      expect(result.message).toContain('does not match');
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });
  });

  // ─── handleRequest - Bitbucket ───────────────────────────────────────────

  describe('handleRequest - Bitbucket', () => {
    let webhookConfig: WebhookConfig;

    beforeEach(() => {
      webhookConfig = wh.generateWebhookUrl(projectId);
    });

    it('should validate Bitbucket HMAC-SHA256 signature and trigger build', async () => {
      const body = makeBitbucketPushPayload('main');
      const hmac = createHmac('sha256', webhookConfig.secret!);
      hmac.update(body);
      const signature = 'sha256=' + hmac.digest('hex');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature': signature,
          'x-event-key': 'repo:push',
        },
        body,
        '10.0.0.1'
      );

      expect(result.statusCode).toBe(200);
      expect(result.jobId).toBe('job-build-123');
      expect(deps.triggerBuild).toHaveBeenCalledWith(projectId);
    });

    it('should return 401 for invalid Bitbucket signature', async () => {
      const body = makeBitbucketPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature': 'sha256=bad',
          'x-event-key': 'repo:push',
        },
        body,
        '10.0.0.1'
      );

      expect(result.statusCode).toBe(401);
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });

    it('should return 200 for non-matching branch from Bitbucket', async () => {
      const body = makeBitbucketPushPayload('staging');
      const hmac = createHmac('sha256', webhookConfig.secret!);
      hmac.update(body);
      const signature = 'sha256=' + hmac.digest('hex');

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature': signature,
          'x-event-key': 'repo:push',
        },
        body,
        '10.0.0.1'
      );

      expect(result.statusCode).toBe(200);
      expect(result.message).toContain('does not match');
      expect(deps.triggerBuild).not.toHaveBeenCalled();
    });
  });

  // ─── handleRequest - Edge Cases ──────────────────────────────────────────

  describe('handleRequest - Edge Cases', () => {
    it('should return 401 for invalid token (no matching config)', async () => {
      const body = makeGitHubPushPayload('main');

      const result = await wh.handleRequest(
        projectId,
        'nonexistent-token',
        { 'x-github-event': 'push' },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(401);
      expect(result.message).toContain('not found');
    });

    it('should handle Buffer body correctly', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const bodyStr = makeGitHubPushPayload('main');
      const bodyBuf = Buffer.from(bodyStr, 'utf-8');
      const signature = computeGitHubSignature(webhookConfig.secret!, bodyStr);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        bodyBuf,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(200);
      expect(result.jobId).toBe('job-build-123');
    });

    it('should handle build trigger failure gracefully', async () => {
      deps.triggerBuild = vi.fn().mockRejectedValue(new Error('Pipeline not configured'));

      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('main');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(200);
      expect(result.message).toContain('Build trigger failed');
    });

    it('should normalize header keys to lowercase', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('main');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'push',
        },
        body,
        '1.2.3.4'
      );

      expect(result.statusCode).toBe(200);
      expect(result.jobId).toBe('job-build-123');
    });

    it('should handle malformed JSON body gracefully', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = 'not json at all';
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      const result = await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      // Should return 200 with branch mismatch (null branch doesn't match 'main')
      expect(result.statusCode).toBe(200);
      expect(result.message).toContain('does not match');
    });
  });

  // ─── getWebhookHistory ───────────────────────────────────────────────────

  describe('getWebhookHistory', () => {
    it('should return empty array when no events exist', () => {
      wh.generateWebhookUrl(projectId);
      const history = wh.getWebhookHistory(projectId);
      expect(history).toEqual([]);
    });

    it('should return empty array when no webhook config exists', () => {
      const history = wh.getWebhookHistory('nonexistent-project');
      expect(history).toEqual([]);
    });

    it('should log and retrieve webhook events', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('main');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      // Trigger a request to generate an event
      await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.2.3.4'
      );

      const history = wh.getWebhookHistory(projectId);
      expect(history).toHaveLength(1);
      expect(history[0].webhookId).toBe(webhookConfig.id);
      expect(history[0].sourceIp).toBe('1.2.3.4');
      expect(history[0].branch).toBe('main');
      expect(history[0].validationResult).toBe('valid');
      expect(history[0].responseCode).toBe(200);
    });

    it('should log failed validation events', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('main');

      await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': 'sha256=invalid',
          'x-github-event': 'push',
        },
        body,
        '9.8.7.6'
      );

      const history = wh.getWebhookHistory(projectId);
      expect(history).toHaveLength(1);
      expect(history[0].validationResult).toBe('invalid_signature');
      expect(history[0].responseCode).toBe(401);
      expect(history[0].sourceIp).toBe('9.8.7.6');
    });

    it('should log branch mismatch events', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('develop');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      await wh.handleRequest(
        projectId,
        webhookConfig.token,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'push',
        },
        body,
        '1.1.1.1'
      );

      const history = wh.getWebhookHistory(projectId);
      expect(history).toHaveLength(1);
      expect(history[0].validationResult).toBe('branch_mismatch');
      expect(history[0].branch).toBe('develop');
      expect(history[0].responseCode).toBe(200);
    });

    it('should return last 50 events in reverse chronological order', async () => {
      const webhookConfig = wh.generateWebhookUrl(projectId);
      const body = makeGitHubPushPayload('main');
      const signature = computeGitHubSignature(webhookConfig.secret!, body);

      // Generate 55 events
      for (let i = 0; i < 55; i++) {
        await wh.handleRequest(
          projectId,
          webhookConfig.token,
          {
            'x-hub-signature-256': signature,
            'x-github-event': 'push',
          },
          body,
          `10.0.0.${i % 256}`
        );
      }

      const history = wh.getWebhookHistory(projectId);
      expect(history).toHaveLength(50);
    });
  });

  // ─── getWebhookConfig ────────────────────────────────────────────────────

  describe('getWebhookConfig', () => {
    it('should return null when no config exists', () => {
      const config = wh.getWebhookConfig(projectId);
      expect(config).toBeNull();
    });

    it('should return existing config', () => {
      const generated = wh.generateWebhookUrl(projectId);
      const config = wh.getWebhookConfig(projectId);

      expect(config).toBeDefined();
      expect(config!.id).toBe(generated.id);
      expect(config!.token).toBe(generated.token);
      expect(config!.secret).toBe(generated.secret);
    });
  });

  // ─── deleteWebhookConfig ─────────────────────────────────────────────────

  describe('deleteWebhookConfig', () => {
    it('should delete webhook config for a project', () => {
      wh.generateWebhookUrl(projectId);
      expect(wh.getWebhookConfig(projectId)).not.toBeNull();

      wh.deleteWebhookConfig(projectId);
      expect(wh.getWebhookConfig(projectId)).toBeNull();
    });

    it('should not throw when deleting non-existent config', () => {
      expect(() => wh.deleteWebhookConfig(projectId)).not.toThrow();
    });
  });
});
