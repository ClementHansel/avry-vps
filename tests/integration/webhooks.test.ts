/**
 * Integration Tests: Webhook Delivery
 *
 * Tests webhook generation and delivery through the HTTP API:
 * - Generate webhook URL for a project
 * - Valid HMAC signature triggers build
 * - Invalid signature returns 401
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp, type AppInstance } from '../../src/app.js';
import {
  createTestEnvConfig,
  setupTestCredentials,
  cleanupTestCredentials,
  loginAndGetToken,
} from './helpers.js';

describe('Integration: Webhook Delivery', () => {
  let appInstance: AppInstance;
  let agent: ReturnType<typeof request>;
  let token: string;
  const TEST_PROJECT_ID = 'test-project-webhook';

  beforeEach(async () => {
    setupTestCredentials();
    appInstance = createApp(createTestEnvConfig());
    agent = request(appInstance.app);
    token = await loginAndGetToken(agent);

    // Create a project first (webhooks require a valid project)
    appInstance.db.prepare(
      'INSERT INTO projects (id, name) VALUES (?, ?)'
    ).run(TEST_PROJECT_ID, 'Webhook Test Project');
  });

  afterEach(() => {
    appInstance.shutdown();
    cleanupTestCredentials();
  });

  describe('Generate webhook', () => {
    it('should generate a webhook URL for a project', async () => {
      const res = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.triggerBranch).toBe('main');
      expect(res.body.url).toContain(TEST_PROJECT_ID);
      expect(res.body.url).toContain(res.body.token);
    });

    it('should return same config when called again for same project', async () => {
      const res1 = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      const res2 = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      expect(res1.body.token).toBe(res2.body.token);
      expect(res1.body.id).toBe(res2.body.id);
    });
  });

  describe('Webhook delivery with valid signature', () => {
    it('should accept a valid GitHub webhook and trigger build', async () => {
      // Generate webhook config
      const genRes = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      const webhookToken = genRes.body.token;
      const secret = genRes.body.secret;

      // Set up a pipeline config so the build can be triggered
      appInstance.db.prepare(`
        INSERT INTO pipeline_configs (id, project_id, repo_url, auth_method, auth_credential_encrypted, branch, dockerfile_path, build_context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('pipe-1', TEST_PROJECT_ID, 'https://github.com/test/repo.git', 'https-token', 'enc-token', 'main', './Dockerfile', '.');

      // Create a GitHub push payload
      const payload = JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'test/repo' },
        pusher: { name: 'test-user' },
      });

      // Compute HMAC-SHA256 signature
      const signature = 'sha256=' + createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      // Send webhook request (public endpoint, no auth required)
      const res = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/${webhookToken}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'push')
        .send(payload);

      expect(res.status).toBe(200);
      // Build is triggered (may succeed or fail depending on Docker availability)
      expect(res.body.message).toMatch(/Build triggered|Build trigger/);
    });

    it('should return 200 for non-matching branch', async () => {
      // Generate webhook config for 'main' branch
      const genRes = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      const webhookToken = genRes.body.token;
      const secret = genRes.body.secret;

      // Push payload for 'develop' branch
      const payload = JSON.stringify({
        ref: 'refs/heads/develop',
        repository: { full_name: 'test/repo' },
      });

      const signature = 'sha256=' + createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      const res = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/${webhookToken}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'push')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('does not match');
    });
  });

  describe('Webhook delivery with invalid signature', () => {
    it('should return 401 for invalid HMAC signature', async () => {
      // Generate webhook config
      const genRes = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/generate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ triggerBranch: 'main' });

      const webhookToken = genRes.body.token;

      const payload = JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'test/repo' },
      });

      // Use wrong secret for signature
      const badSignature = 'sha256=' + createHmac('sha256', 'wrong-secret')
        .update(payload)
        .digest('hex');

      const res = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/${webhookToken}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', badSignature)
        .set('X-GitHub-Event', 'push')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid');
    });

    it('should return 401 for non-existent webhook token', async () => {
      const payload = JSON.stringify({ ref: 'refs/heads/main' });

      const res = await agent
        .post(`/api/webhooks/${TEST_PROJECT_ID}/fake-token-12345`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .send(payload);

      expect(res.status).toBe(401);
    });
  });
});
