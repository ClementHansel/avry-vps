/**
 * Integration Tests: Authentication Flow
 *
 * Tests the full authentication lifecycle through the HTTP API:
 * - Login with valid credentials returns token
 * - Login with invalid credentials returns error
 * - Rate limiting locks after 3 failed attempts
 * - Session validation works
 * - Logout invalidates session
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppInstance } from '../../src/app.js';
import {
  createTestEnvConfig,
  setupTestCredentials,
  cleanupTestCredentials,
  TEST_USERNAME,
  TEST_PASSWORD,
} from './helpers.js';

describe('Integration: Authentication Flow', () => {
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

  describe('Login with valid credentials', () => {
    it('should return 200 with token, username, and expiresAt', async () => {
      const res = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.token).toBeTruthy();
      expect(res.body.username).toBe(TEST_USERNAME);
      expect(res.body.expiresAt).toBeDefined();
    });

    it('should return a token that can be used for authenticated requests', async () => {
      const loginRes = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

      const token = loginRes.body.token;

      // Use token to access a protected endpoint
      const protectedRes = await agent
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(protectedRes.status).toBe(200);
    });
  });

  describe('Login with invalid credentials', () => {
    it('should return 401 for wrong password', async () => {
      const res = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should return 401 for wrong username', async () => {
      const res = await agent
        .post('/api/auth/login')
        .send({ username: 'nonexistent', password: TEST_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should return 400 for missing fields', async () => {
      const res = await agent
        .post('/api/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });
  });

  describe('Rate limiting', () => {
    it('should lock out after 3 failed login attempts', async () => {
      // Make 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await agent
          .post('/api/auth/login')
          .send({ username: TEST_USERNAME, password: 'wrong' });
      }

      // 4th attempt should be rate limited (429)
      const res = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many failed attempts');
    });
  });

  describe('Session validation', () => {
    it('should reject requests without a token', async () => {
      const res = await agent.get('/api/jobs');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authentication required');
    });

    it('should reject requests with an invalid token', async () => {
      const res = await agent
        .get('/api/jobs')
        .set('Authorization', 'Bearer invalid-token-xyz');

      expect(res.status).toBe(401);
    });

    it('should accept requests with a valid session token', async () => {
      const loginRes = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

      const token = loginRes.body.token;

      const res = await agent
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('Logout', () => {
    it('should invalidate the session after logout', async () => {
      // Login
      const loginRes = await agent
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

      const token = loginRes.body.token;

      // Verify session works
      const beforeLogout = await agent
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);
      expect(beforeLogout.status).toBe(200);

      // Logout
      const logoutRes = await agent
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toContain('Logged out');

      // Verify session is invalidated
      const afterLogout = await agent
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(afterLogout.status).toBe(401);
    });
  });
});
