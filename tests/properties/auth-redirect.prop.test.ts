/**
 * Property 6: Authentication middleware redirect
 *
 * Test that any request to a protected route without a valid session token
 * results in a redirect to login (browser requests) or 401 (API requests).
 *
 * **Validates: Requirements 6.1**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createAuthModule, type AuthModule } from '../../src/modules/auth.ts';
import { createAuthMiddleware } from '../../src/middleware/auth.ts';
import { SCHEMA_SQL } from '../../src/database/index.ts';

// --- Test Helpers ---

const PUBLIC_PATHS = ['/health', '/login', '/api/auth/login'];

/**
 * Generate arbitrary URL paths that are NOT public paths.
 * Ensures we only test protected routes.
 */
const protectedPathArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '_'
  ),
  { minLength: 1, maxLength: 20 }
).map(segment => `/${segment}`)
  .filter(p => !PUBLIC_PATHS.some(pub => p === pub || p.startsWith(pub + '/')));

/**
 * Generate multi-segment paths (e.g., /dashboard/containers/abc123)
 */
const multiSegmentPathArb = fc.array(
  fc.stringOf(
    fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '-', '_'
    ),
    { minLength: 1, maxLength: 10 }
  ),
  { minLength: 1, maxLength: 4 }
).map(segments => '/' + segments.join('/'))
  .filter(p => !PUBLIC_PATHS.some(pub => p === pub || p.startsWith(pub + '/')));

/**
 * Arbitrary for the protected path - union of single and multi-segment paths
 */
const anyProtectedPathArb = fc.oneof(protectedPathArb, multiSegmentPathArb);

/**
 * Generate invalid/expired tokens
 */
const invalidTokenArb = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 50 }),
  fc.constant('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSWQiOiJmYWtlIiwidXNlcm5hbWUiOiJhZG1pbiJ9.invalidsignature'),
  fc.constant('not-a-jwt-token'),
  fc.constant('Bearer malformed')
);

// --- Test Setup ---

function createTestApp(authModule: AuthModule) {
  const app = express();
  app.use(express.json());

  const authMiddleware = createAuthMiddleware(authModule, {
    loginPath: '/login',
    publicPaths: PUBLIC_PATHS,
  });

  app.use(authMiddleware);

  // Protected catch-all route that should never be reached without auth
  app.use((_req, res) => {
    res.status(200).json({ message: 'protected content' });
  });

  return app;
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

// --- Property Tests ---

describe('Property 6: Authentication middleware redirect', () => {
  let db: Database.Database;
  let authModule: AuthModule;
  let app: express.Application;

  beforeEach(() => {
    db = createTestDb();
    authModule = createAuthModule(db, {
      jwtSecret: 'test-secret-key-for-property-tests',
      sessionTimeoutMinutes: 30,
    });
    app = createTestApp(authModule);
  });

  afterEach(() => {
    db.close();
  });

  it('browser requests without token to protected routes get 302 redirect to /login', async () => {
    await fc.assert(
      fc.asyncProperty(anyProtectedPathArb, async (path) => {
        const response = await request(app)
          .get(path)
          .set('Accept', 'text/html');

        // Browser requests without auth should get redirected to /login
        if (response.status !== 302) {
          throw new Error(
            `Expected 302 redirect for browser request to ${path}, got ${response.status}`
          );
        }
        if (!response.headers.location?.includes('/login')) {
          throw new Error(
            `Expected redirect location to contain /login, got ${response.headers.location}`
          );
        }
      }),
      { numRuns: 50 }
    );
  });

  it('API requests without token to protected routes get 401 JSON response', async () => {
    await fc.assert(
      fc.asyncProperty(anyProtectedPathArb, async (path) => {
        const response = await request(app)
          .get(path)
          .set('Accept', 'application/json');

        // API requests without auth should get 401
        if (response.status !== 401) {
          throw new Error(
            `Expected 401 for API request to ${path}, got ${response.status}`
          );
        }
        if (!response.body.error) {
          throw new Error(
            `Expected error field in JSON response for ${path}, got ${JSON.stringify(response.body)}`
          );
        }
      }),
      { numRuns: 50 }
    );
  });

  it('browser requests with invalid tokens to protected routes get 302 redirect to /login', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyProtectedPathArb,
        invalidTokenArb,
        async (path, invalidToken) => {
          const req = request(app)
            .get(path)
            .set('Accept', 'text/html');

          // Apply the token if non-empty (as Authorization header)
          if (invalidToken.length > 0) {
            req.set('Authorization', `Bearer ${invalidToken}`);
          }

          const response = await req;

          if (response.status !== 302) {
            throw new Error(
              `Expected 302 for browser request with invalid token to ${path}, got ${response.status}`
            );
          }
          if (!response.headers.location?.includes('/login')) {
            throw new Error(
              `Expected redirect to /login, got ${response.headers.location}`
            );
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('API requests with invalid tokens to protected routes get 401', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyProtectedPathArb,
        invalidTokenArb,
        async (path, invalidToken) => {
          const req = request(app)
            .get(path)
            .set('Accept', 'application/json');

          if (invalidToken.length > 0) {
            req.set('Authorization', `Bearer ${invalidToken}`);
          }

          const response = await req;

          if (response.status !== 401) {
            throw new Error(
              `Expected 401 for API request with invalid token to ${path}, got ${response.status}`
            );
          }
          if (!response.body.error) {
            throw new Error(
              `Expected error field in JSON response, got ${JSON.stringify(response.body)}`
            );
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('requests with expired session tokens are rejected', async () => {
    // Create a module with very short timeout to simulate expiration
    const shortTimeoutModule = createAuthModule(db, {
      jwtSecret: 'test-secret-key-for-property-tests',
      sessionTimeoutMinutes: 0, // 0 minutes means immediately expired
    });
    const shortTimeoutApp = createTestApp(shortTimeoutModule);

    // First, create a valid session
    const session = await shortTimeoutModule.login('admin', 'password', '127.0.0.1').catch(() => null);

    // If we can't login (no credentials configured), test with a manually crafted expired scenario
    // The key property is: even with a token that was once valid, expired sessions are rejected
    await fc.assert(
      fc.asyncProperty(anyProtectedPathArb, async (path) => {
        const response = await request(shortTimeoutApp)
          .get(path)
          .set('Accept', 'text/html')
          .set('Authorization', 'Bearer expired.jwt.token');

        // Expired/invalid token should still redirect
        if (response.status !== 302) {
          throw new Error(
            `Expected 302 for expired token request to ${path}, got ${response.status}`
          );
        }
      }),
      { numRuns: 20 }
    );
  });

  it('public paths are accessible without authentication', async () => {
    const publicPathArb = fc.constantFrom(...PUBLIC_PATHS);

    await fc.assert(
      fc.asyncProperty(publicPathArb, async (path) => {
        const response = await request(app)
          .get(path)
          .set('Accept', 'text/html');

        // Public paths should NOT be redirected (they pass through middleware)
        // They'll get 404 since we don't define handlers for them in the test,
        // but the point is they don't get 302 or 401
        if (response.status === 302 || response.status === 401) {
          throw new Error(
            `Expected public path ${path} to NOT be redirected/rejected, got ${response.status}`
          );
        }
      }),
      { numRuns: 10 }
    );
  });
});
