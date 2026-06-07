/**
 * Integration Test Helpers
 *
 * Shared utilities for setting up a fresh app instance with an in-memory database
 * for each integration test suite.
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { SCHEMA_SQL } from '../../src/database/index.js';
import type { EnvConfig } from '../../src/config/env.js';
import type { AppInstance } from '../../src/app.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Default test environment configuration.
 * Uses a temp directory for the database to avoid conflicts between tests.
 */
export function createTestEnvConfig(overrides?: Partial<EnvConfig>): EnvConfig {
  const tempDir = mkdtempSync(join(tmpdir(), 'vps-test-'));
  const dbPath = join(tempDir, 'test-panel.db');

  // Set DB_PATH env var so initializeDatabase uses it
  process.env.DB_PATH = dbPath;

  return {
    PORT: 0,
    SUPABASE_JWT_SECRET: 'integration-test-jwt-secret-key-12345',
    DOCKER_HOST: '/var/run/docker.sock',
    ENVIRONMENT: 'test',
    CORS_ORIGINS: ['*'],
    DB_PATH: dbPath,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: '',
    TLS_ENABLED: false,
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_USER: '',
    SMTP_PASS: '',
    ALERT_WEBHOOK_URL: '',
    BACKUP_S3_ENDPOINT: '',
    BACKUP_S3_BUCKET: '',
    BACKUP_S3_ACCESS_KEY: '',
    BACKUP_S3_SECRET_KEY: '',
    PANEL_DOMAIN: 'test.panel.local',
    ...overrides,
  };
}

/**
 * Default test password and its hash.
 */
export const TEST_PASSWORD = 'testpass123';
export const TEST_USERNAME = 'admin';

/**
 * Get a bcrypt hash for the test password. Cached for performance.
 */
let cachedHash: string | null = null;
export function getTestPasswordHash(): string {
  if (!cachedHash) {
    cachedHash = bcrypt.hashSync(TEST_PASSWORD, 4); // Low rounds for speed
  }
  return cachedHash;
}

/**
 * Set up test credentials in process.env before creating the app.
 */
export function setupTestCredentials(): void {
  process.env.PANEL_USERNAME = TEST_USERNAME;
  process.env.PANEL_PASSWORD_HASH = getTestPasswordHash();
}

/**
 * Clean up test credentials from process.env.
 */
export function cleanupTestCredentials(): void {
  delete process.env.PANEL_USERNAME;
  delete process.env.PANEL_PASSWORD_HASH;
  delete process.env.DB_PATH;
}

/**
 * Helper to login and get an auth token via API.
 * Returns the JWT token that can be used in Authorization header.
 */
export async function loginAndGetToken(
  request: any,
  username = TEST_USERNAME,
  password = TEST_PASSWORD
): Promise<string> {
  const res = await request
    .post('/api/auth/login')
    .send({ username, password });

  if (res.status !== 200) {
    throw new Error(`Login failed with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return res.body.token;
}
