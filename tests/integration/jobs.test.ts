/**
 * Integration Tests: Job Queue
 *
 * Tests job queue operations through the HTTP API:
 * - Submit a job and check its status
 * - Job completes successfully
 * - Cancel a queued/running job
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

describe('Integration: Job Queue', () => {
  let appInstance: AppInstance;
  let agent: ReturnType<typeof request>;
  let token: string;

  beforeEach(async () => {
    setupTestCredentials();
    appInstance = createApp(createTestEnvConfig());
    agent = request(appInstance.app);
    token = await loginAndGetToken(agent);

    // Start the job queue scheduler for tests
    appInstance.modules.jobQueue.start();
  });

  afterEach(() => {
    appInstance.modules.jobQueue.stop();
    appInstance.shutdown();
    cleanupTestCredentials();
  });

  describe('Submit and check job status', () => {
    it('should submit a job and return a job ID', async () => {
      // Submit a job directly through the module (since there's no generic submit endpoint)
      const jobId = await appInstance.modules.jobQueue.submit({
        type: 'build',
        execute: async function* () {
          yield 'Starting build...';
          yield 'Build complete.';
        },
      });

      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');

      // Check status via API
      const res = await agent
        .get(`/api/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(jobId);
      expect(res.body.type).toBe('build');
      // Status could be queued or running depending on timing
      expect(['queued', 'running', 'completed']).toContain(res.body.status);
    });

    it('should list jobs with filtering', async () => {
      // Submit a couple of jobs
      await appInstance.modules.jobQueue.submit({
        type: 'build',
        execute: async function* () { yield 'done'; },
      });
      await appInstance.modules.jobQueue.submit({
        type: 'deploy',
        execute: async function* () { yield 'done'; },
      });

      // List all jobs
      const res = await agent
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);

      // Filter by type
      const buildRes = await agent
        .get('/api/jobs')
        .query({ type: 'build' })
        .set('Authorization', `Bearer ${token}`);

      expect(buildRes.status).toBe(200);
      for (const job of buildRes.body) {
        expect(job.type).toBe('build');
      }
    });

    it('should return 404 for non-existent job', async () => {
      const res = await agent
        .get('/api/jobs/nonexistent-job-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Job completion', () => {
    it('should mark job as completed after execution', async () => {
      const jobId = await appInstance.modules.jobQueue.submit({
        type: 'deploy',
        execute: async function* () {
          yield 'Deploying...';
          yield 'Done.';
        },
      });

      // Wait for the scheduler to pick up and execute the job
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const res = await agent
        .get(`/api/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.exitCode).toBe(0);
    });

    it('should mark job as failed when execution throws', async () => {
      const jobId = await appInstance.modules.jobQueue.submit({
        type: 'backup',
        execute: async function* () {
          yield 'Starting backup...';
          throw new Error('Backup failed: disk full');
        },
      });

      // Wait for execution
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const res = await agent
        .get(`/api/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.exitCode).toBe(1);
    });
  });

  describe('Cancel a job', () => {
    it('should cancel a queued job', async () => {
      // Set concurrency to 0 so the job stays queued
      appInstance.modules.jobQueue.setConcurrencyLimit('build', 1);

      // Submit a blocking job first to fill the slot
      await appInstance.modules.jobQueue.submit({
        type: 'build',
        execute: async function* () {
          // Long-running job to block the slot
          await new Promise((r) => setTimeout(r, 60000));
          yield 'never reached';
        },
      });

      // Wait for first job to start
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Submit a second job that will be queued
      const queuedJobId = await appInstance.modules.jobQueue.submit({
        type: 'build',
        execute: async function* () { yield 'should not run'; },
      });

      // Cancel the queued job via API
      const cancelRes = await agent
        .post(`/api/jobs/${queuedJobId}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.message).toContain('cancelled');

      // Verify the job is cancelled
      const statusRes = await agent
        .get(`/api/jobs/${queuedJobId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(statusRes.body.status).toBe('cancelled');
    });

    it('should return 400 when cancelling a completed job', async () => {
      const jobId = await appInstance.modules.jobQueue.submit({
        type: 'deploy',
        execute: async function* () { yield 'done'; },
      });

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const res = await agent
        .post(`/api/jobs/${jobId}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('terminal state');
    });
  });
});
