import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { createAuthModule, getSessionToken } from '../../src/modules/auth.js';
import { createAuthMiddleware, createSocketAuthMiddleware } from '../../src/middleware/auth.js';
import type { AuthModule } from '../../src/modules/auth.js';

describe('Auth Middleware - Express', () => {
  let db: Database.Database;
  let authModule: AuthModule;
  let app: express.Express;
  const TEST_SECRET = 'test-middleware-secret';
  const TEST_PASSWORD = 'password123';
  let TEST_PASSWORD_HASH: string;

  beforeEach(() => {
    TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
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

    process.env.PANEL_USERNAME = 'admin';
    process.env.PANEL_PASSWORD_HASH = TEST_PASSWORD_HASH;

    authModule = createAuthModule(db, { jwtSecret: TEST_SECRET });

    app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(authModule));

    // Protected route
    app.get('/dashboard', (req, res) => {
      res.json({ message: 'Welcome', user: req.session?.username });
    });

    // Protected API route
    app.get('/api/data', (req, res) => {
      res.json({ data: 'secret' });
    });

    // Public routes are handled by middleware config
    app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/login', (req, res) => {
      res.send('<html><body>Login Page</body></html>');
    });
  });

  afterEach(() => {
    db.close();
    delete process.env.PANEL_USERNAME;
    delete process.env.PANEL_PASSWORD_HASH;
  });

  describe('Public paths', () => {
    it('should allow /health without authentication', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('should allow /login without authentication', async () => {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
    });
  });

  describe('Unauthenticated requests', () => {
    it('should redirect browser requests to login page', async () => {
      const res = await request(app)
        .get('/dashboard')
        .set('Accept', 'text/html');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('should return 401 for API requests without token', async () => {
      const res = await request(app)
        .get('/api/data')
        .set('Accept', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });
  });

  describe('Authenticated requests', () => {
    it('should allow requests with valid Bearer token', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      const res = await request(app)
        .get('/dashboard')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Welcome');
      expect(res.body.user).toBe('admin');
    });

    it('should allow requests with valid session cookie', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      const res = await request(app)
        .get('/dashboard')
        .set('Cookie', `session_token=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Welcome');
    });

    it('should reject requests with invalid token', async () => {
      const res = await request(app)
        .get('/api/data')
        .set('Authorization', 'Bearer invalid-token')
        .set('Accept', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid or expired session');
    });

    it('should reject requests with expired session', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      // Simulate expired session
      const pastTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(pastTime, session.id);

      const res = await request(app)
        .get('/api/data')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(401);
    });
  });

  describe('Session attached to request', () => {
    it('should attach session object to req.session', async () => {
      const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
      const token = getSessionToken(db, session.id)!;

      const res = await request(app)
        .get('/dashboard')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.user).toBe('admin');
    });
  });
});

describe('Auth Middleware - Socket.IO', () => {
  let db: Database.Database;
  let authModule: AuthModule;
  const TEST_SECRET = 'test-socket-secret';
  const TEST_PASSWORD = 'password123';
  let TEST_PASSWORD_HASH: string;

  beforeEach(() => {
    TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
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

    process.env.PANEL_USERNAME = 'admin';
    process.env.PANEL_PASSWORD_HASH = TEST_PASSWORD_HASH;

    authModule = createAuthModule(db, { jwtSecret: TEST_SECRET });
  });

  afterEach(() => {
    db.close();
    delete process.env.PANEL_USERNAME;
    delete process.env.PANEL_PASSWORD_HASH;
  });

  it('should create socket auth middleware function', () => {
    const middleware = createSocketAuthMiddleware(authModule);
    expect(typeof middleware).toBe('function');
  });

  it('should reject socket without token', () => {
    const middleware = createSocketAuthMiddleware(authModule);

    const mockSocket = {
      handshake: {
        auth: {},
        headers: {},
      },
    } as any;

    let error: Error | undefined;
    middleware(mockSocket, (err?: Error) => {
      error = err;
    });

    expect(error).toBeDefined();
    expect(error!.message).toBe('Authentication required');
  });

  it('should reject socket with invalid token', () => {
    const middleware = createSocketAuthMiddleware(authModule);

    const mockSocket = {
      handshake: {
        auth: { token: 'invalid-token' },
        headers: {},
      },
    } as any;

    let error: Error | undefined;
    middleware(mockSocket, (err?: Error) => {
      error = err;
    });

    expect(error).toBeDefined();
    expect(error!.message).toBe('Invalid or expired session');
  });

  it('should accept socket with valid token in auth object', async () => {
    const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
    const token = getSessionToken(db, session.id)!;

    const middleware = createSocketAuthMiddleware(authModule);

    const mockSocket = {
      handshake: {
        auth: { token },
        headers: {},
      },
    } as any;

    let error: Error | undefined;
    middleware(mockSocket, (err?: Error) => {
      error = err;
    });

    expect(error).toBeUndefined();
    expect(mockSocket.session).toBeDefined();
    expect(mockSocket.session.username).toBe('admin');
  });

  it('should accept socket with valid token in Authorization header', async () => {
    const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
    const token = getSessionToken(db, session.id)!;

    const middleware = createSocketAuthMiddleware(authModule);

    const mockSocket = {
      handshake: {
        auth: {},
        headers: { authorization: `Bearer ${token}` },
      },
    } as any;

    let error: Error | undefined;
    middleware(mockSocket, (err?: Error) => {
      error = err;
    });

    expect(error).toBeUndefined();
    expect(mockSocket.session).toBeDefined();
  });

  it('should accept socket with valid token in cookie header', async () => {
    const session = await authModule.login('admin', TEST_PASSWORD, '127.0.0.1');
    const token = getSessionToken(db, session.id)!;

    const middleware = createSocketAuthMiddleware(authModule);

    const mockSocket = {
      handshake: {
        auth: {},
        headers: { cookie: `session_token=${token}; other=value` },
      },
    } as any;

    let error: Error | undefined;
    middleware(mockSocket, (err?: Error) => {
      error = err;
    });

    expect(error).toBeUndefined();
    expect(mockSocket.session).toBeDefined();
  });
});
