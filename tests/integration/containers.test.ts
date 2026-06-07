/**
 * Integration Tests: Container Lifecycle
 *
 * Tests container management operations through the HTTP API.
 * Since Docker daemon is unavailable in test environments,
 * these tests verify the API layer behavior (auth, routing, error responses).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppInstance } from '../../src/app.js';
import {
  createTestEnvConfig,
  setupTestCredentials,
  cleanupTestCredentials,
  loginAndGetToken,
} from './helpers.js';

describe('Integration: Container Lifecycle', () => {
  let appInstance: AppInstance;
  let agent: ReturnType<typeof request>;
  let token: string;

  beforeEach(async () => {
    setupTestCredentials();
    appInstance = createApp(createTestEnvConfig());
    agent = request(appInstance.app);
    token = await loginAndGetToken(agent);
  });

  afterEach(() => {
    appInstance.shutdown();
    cleanupTestCredentials();
  });

  describe('GET /api/containers', () => {
    it('should respond to list containers request', async () => {
      const res = await agent
        .get('/api/containers')
        .set('Authorization', `Bearer ${token}`);

      // Without Docker, may return 200 with empty list or 500 with circuit breaker error
      expect([200, 500]).toContain(res.status);
    });

    it('should require authentication', async () => {
      const res = await agent.get('/api/containers');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/containers/:id/start', () => {
    it('should require authentication', async () => {
      const res = await agent.post('/api/containers/some-id/start');
      expect(res.status).toBe(401);
    });

    it('should respond to start request (Docker unavailable returns 500)', async () => {
      const res = await agent
        .post('/api/containers/abc123def456/start')
        .set('Authorization', `Bearer ${token}`);

      // Without Docker daemon, container operations return 500
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.message).toContain('started');
      } else {
        expect(res.body.error).toBeDefined();
      }
    });
  });

  describe('POST /api/containers/:id/stop', () => {
    it('should require authentication', async () => {
      const res = await agent.post('/api/containers/some-id/stop');
      expect(res.status).toBe(401);
    });

    it('should respond to stop request (Docker unavailable returns 500)', async () => {
      const res = await agent
        .post('/api/containers/abc123def456/stop')
        .set('Authorization', `Bearer ${token}`);

      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.message).toContain('stopped');
      } else {
        expect(res.body.error).toBeDefined();
      }
    });
  });

  describe('POST /api/containers/:id/restart', () => {
    it('should require authentication', async () => {
      const res = await agent.post('/api/containers/some-id/restart');
      expect(res.status).toBe(401);
    });

    it('should respond to restart request (Docker unavailable returns 500)', async () => {
      const res = await agent
        .post('/api/containers/abc123def456/restart')
        .set('Authorization', `Bearer ${token}`);

      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.message).toContain('restarted');
      } else {
        expect(res.body.error).toBeDefined();
      }
    });
  });

  describe('POST /api/containers/:id/redeploy', () => {
    it('should require authentication', async () => {
      const res = await agent.post('/api/containers/some-id/redeploy');
      expect(res.status).toBe(401);
    });

    it('should respond to redeploy request', async () => {
      const res = await agent
        .post('/api/containers/abc123def456/redeploy')
        .set('Authorization', `Bearer ${token}`);

      expect([200, 500]).toContain(res.status);
    });
  });
});
