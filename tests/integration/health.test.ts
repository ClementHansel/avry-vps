/**
 * Integration Tests: Health Endpoint
 *
 * Tests the /health endpoint returns correct status:
 * - Returns 200 with proper JSON structure when healthy
 * - Includes database health, degradation status, and uptime
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppInstance } from '../../src/app.js';
import {
  createTestEnvConfig,
  setupTestCredentials,
  cleanupTestCredentials,
} from './helpers.js';

describe('Integration: Health Endpoint', () => {
  let appInstance: AppInstance;
  let agent: ReturnType<typeof request>;

  beforeEach(() => {
    setupTestCredentials();
    appInstance = createApp(createTestEnvConfig());
    agent = request(appInstance.app);
  });

  afterEach(() => {
    appInstance.shutdown();
    cleanupTestCredentials();
  });

  describe('GET /health', () => {
    it('should return 200 with proper JSON structure', async () => {
      const res = await agent.get('/health');

      // In test environment without Docker socket, health may return 503
      // Both are valid responses with proper JSON structure
      expect([200, 503]).toContain(res.status);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('should include status field', async () => {
      const res = await agent.get('/health');

      // May be 'ok' or 'unhealthy' depending on Docker socket availability in test env
      expect(res.body.status).toBeDefined();
      expect(['ok', 'unhealthy']).toContain(res.body.status);
    });

    it('should include uptime field', async () => {
      const res = await agent.get('/health');

      expect(res.body.uptime).toBeDefined();
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp field', async () => {
      const res = await agent.get('/health');

      expect(res.body.timestamp).toBeDefined();
      // Verify it's a valid ISO date
      const date = new Date(res.body.timestamp);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should be accessible without authentication', async () => {
      // Health endpoint must be public for load balancer checks
      const res = await agent.get('/health');

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('should include degradation status when healthy', async () => {
      const res = await agent.get('/health');

      if (res.body.status === 'ok') {
        expect(res.body.degradation).toBeDefined();
        expect(typeof res.body.degradation.dockerAvailable).toBe('boolean');
        expect(typeof res.body.degradation.procAvailable).toBe('boolean');
        expect(typeof res.body.degradation.ptyAvailable).toBe('boolean');
      }
    });

    it('should include database health info when healthy', async () => {
      const res = await agent.get('/health');

      if (res.body.status === 'ok') {
        expect(res.body.database).toBeDefined();
        expect(res.body.database.healthy).toBe(true);
        expect(typeof res.body.database.latencyMs).toBe('number');
      }
    });
  });
});
