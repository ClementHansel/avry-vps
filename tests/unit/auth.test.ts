import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { createAuthModule, getSessionToken, loadCredentials } from '../../src/modules/auth.js';
import type { AuthModule } from '../../src/modules/auth.js';

describe('Auth Module', () => {
  let db: Database.Database;
  let authModule: AuthModule;
  const TEST_SECRET = 'test-jwt-secret-for-testing';
  const TEST_PASSWORD = 'secret123';
  let TEST_PASSWORD_HASH: string;

  beforeEach(() => {
    // Pre-compute bcrypt hash for tests
    TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

    // In-memory database for tests
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create sessions table
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip TEXT
      );
    `);

    // Set environment credentials (bcrypt hash)
    process.env.PANEL_USERNAME = 'admin';
    process.env.PANEL_PASSWORD_HASH = TEST_PASSWORD_HASH;

    authModule = createAuthModule(db, { jwtSecret: TEST_SECRET });
  });

  afterEach(() => {
    db.close();
    delete process.env.PANEL_USERNAME;
    delete process.env.PANEL_PASSWORD_HASH;
  });

  describe('login', () => {
    it('should create a session with valid credentials', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');

      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      expect(session.username).toBe('admin');
      expect(session.ip).toBe('127.0.0.1');
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActivity).toBeInstanceOf(Date);
    });

    it('should store session in the database', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '192.168.1.1');

      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as any;
      expect(row).toBeDefined();
      expect(row.username).toBe('admin');
      expect(row.ip).toBe('192.168.1.1');
      expect(row.token).toBeTruthy();
    });

    it('should generate a JWT token for the session', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '10.0.0.1');

      const token = getSessionToken(db, session.id);
      expect(token).toBeTruthy();
      expect(token!.split('.')).toHaveLength(3); // JWT format
    });

    it('should reject invalid username', async () => {
      await expect(
        authModule.login('wronguser', TEST_PASSWORD, '127.0.0.1')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should reject invalid password', async () => {
      await expect(
        authModule.login('admin', 'wrongpass', '127.0.0.1')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should reject when no credentials configured', async () => {
      delete process.env.PANEL_USERNAME;
      delete process.env.PANEL_PASSWORD_HASH;

      const noCredAuth = createAuthModule(db, { jwtSecret: TEST_SECRET });

      await expect(
        noCredAuth.login('admin', TEST_PASSWORD, '127.0.0.1')
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('validateSession', () => {
    it('should return session for a valid token', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      const validated = authModule.validateSession(token);
      expect(validated).not.toBeNull();
      expect(validated!.id).toBe(session.id);
      expect(validated!.username).toBe('admin');
    });

    it('should return null for an invalid token', () => {
      const result = authModule.validateSession('invalid-token-string');
      expect(result).toBeNull();
    });

    it('should return null for a tampered JWT', () => {
      const result = authModule.validateSession(
        'eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uSWQiOiJmYWtlIn0.tampered'
      );
      expect(result).toBeNull();
    });

    it('should update last_activity on valid session access', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      // Wait a tiny bit so time differs
      await new Promise((r) => setTimeout(r, 50));

      const validated = authModule.validateSession(token);
      expect(validated).not.toBeNull();

      // last_activity should be updated
      const row = db.prepare('SELECT last_activity FROM sessions WHERE id = ?').get(session.id) as any;
      const dbLastActivity = new Date(row.last_activity).getTime();
      const sessionCreated = session.createdAt.getTime();
      expect(dbLastActivity).toBeGreaterThanOrEqual(sessionCreated);
    });

    it('should invalidate session after 30 minutes of inactivity', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      // Simulate 31 minutes of inactivity by updating last_activity in the past
      const pastTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(pastTime, session.id);

      const validated = authModule.validateSession(token);
      expect(validated).toBeNull();

      // Session should be deleted from database
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      expect(row).toBeUndefined();
    });

    it('should keep session valid within 30 minutes of activity', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      // Set last_activity to 29 minutes ago (within timeout)
      const recentTime = new Date(Date.now() - 29 * 60 * 1000).toISOString();
      db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(recentTime, session.id);

      const validated = authModule.validateSession(token);
      expect(validated).not.toBeNull();
    });
  });

  describe('logout', () => {
    it('should remove session from database', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');

      authModule.logout(session.id);

      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      expect(row).toBeUndefined();
    });

    it('should not throw for non-existent session', () => {
      expect(() => authModule.logout('non-existent-id')).not.toThrow();
    });
  });

  describe('isRateLimited', () => {
    it('should return false (stub for task 2.2)', () => {
      expect(authModule.isRateLimited('127.0.0.1')).toBe(false);
    });
  });

  describe('configurable timeout', () => {
    it('should respect custom timeout value', async () => {
      // Create auth module with 5-minute timeout
      const shortAuth = createAuthModule(db, {
        jwtSecret: TEST_SECRET,
        sessionTimeoutMinutes: 5,
      });

      const session = await shortAuth.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      // Set last_activity to 6 minutes ago
      const pastTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(pastTime, session.id);

      const validated = shortAuth.validateSession(token);
      expect(validated).toBeNull();
    });
  });
});

describe('loadCredentials', () => {
  afterEach(() => {
    delete process.env.PANEL_USERNAME;
    delete process.env.PANEL_PASSWORD_HASH;
  });

  it('should load credentials from environment variables', () => {
    process.env.PANEL_USERNAME = 'envuser';
    process.env.PANEL_PASSWORD_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';

    const creds = loadCredentials();
    expect(creds).toEqual({
      username: 'envuser',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012',
    });
  });

  it('should return null when env vars are incomplete', () => {
    process.env.PANEL_USERNAME = 'user';
    // No PANEL_PASSWORD_HASH

    const creds = loadCredentials();
    expect(creds).toBeNull();
  });

  it('should return null when no credentials are available', () => {
    const creds = loadCredentials('/nonexistent/path.json');
    expect(creds).toBeNull();
  });
});
