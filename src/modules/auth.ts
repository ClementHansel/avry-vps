/**
 * Authentication Module
 *
 * JWT-based session management with SQLite storage.
 * Validates credentials against environment variables or local config file.
 * Implements 30-minute inactivity timeout.
 *
 * Requirements: 6.1, 6.2, 6.4, 6.5, 6.6
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// --- Interfaces ---

export interface Session {
  id: string;
  username: string;
  createdAt: Date;
  lastActivity: Date;
  ip: string;
}

export interface AuthModule {
  login(username: string, password: string, ip: string): Promise<Session>;
  logout(sessionId: string): void;
  validateSession(token: string): Session | null;
  isRateLimited(ip: string): boolean;
  /** Record a failed login attempt for rate limiting */
  recordFailedAttempt(ip: string): void;
  /** Record a successful login (resets rate limit counter) */
  recordSuccessfulLogin(ip: string): void;
  /** Get the JWT token for a session by its ID */
  getToken(sessionId: string): string | null;
}

export interface AuthConfig {
  jwtSecret: string;
  sessionTimeoutMinutes?: number;
  credentialsConfigPath?: string;
}

interface CredentialsConfig {
  username: string;
  /** bcrypt-hashed password */
  passwordHash: string;
}

interface SessionRow {
  id: string;
  username: string;
  token: string;
  created_at: string;
  last_activity: string;
  ip: string | null;
}

// --- Constants ---

const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;
const DEFAULT_CREDENTIALS_PATH = '/app/data/credentials.json';

// --- Helper Functions ---

/**
 * Load credentials from environment variables or a local config file.
 *
 * Priority 1: PANEL_USERNAME + PANEL_PASSWORD_HASH env vars
 * Priority 2: Config file at credentialsConfigPath or /app/data/credentials.json
 *
 * The password is always expected to be a bcrypt hash.
 */
export function loadCredentials(configPath?: string): CredentialsConfig | null {
  // Priority 1: Environment variables
  const envUsername = process.env.PANEL_USERNAME;
  const envPasswordHash = process.env.PANEL_PASSWORD_HASH;

  if (envUsername && envPasswordHash) {
    return { username: envUsername, passwordHash: envPasswordHash };
  }

  // Priority 2: Local config file
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(DEFAULT_CREDENTIALS_PATH);

  try {
    if (fs.existsSync(resolvedPath)) {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw) as { username?: string; passwordHash?: string };
      if (parsed.username && parsed.passwordHash) {
        return { username: parsed.username, passwordHash: parsed.passwordHash };
      }
    }
  } catch {
    // Config file unreadable or invalid — fall through to null
  }

  return null;
}

/**
 * Parse a SQLite row into a Session object.
 */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    username: row.username,
    createdAt: new Date(row.created_at),
    lastActivity: new Date(row.last_activity),
    ip: row.ip ?? '',
  };
}

// --- Auth Module Factory ---

/**
 * Create an AuthModule instance backed by the given SQLite database.
 */
export function createAuthModule(db: Database.Database, config: AuthConfig): AuthModule {
  const timeoutMinutes = config.sessionTimeoutMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
  const credentials = loadCredentials(config.credentialsConfigPath);

  // Prepared statements for performance
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, username, token, created_at, last_activity, ip) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const findSessionByToken = db.prepare(
    'SELECT id, username, token, created_at, last_activity, ip FROM sessions WHERE token = ?'
  );

  const updateLastActivity = db.prepare(
    'UPDATE sessions SET last_activity = ? WHERE id = ?'
  );

  const deleteSession = db.prepare(
    'DELETE FROM sessions WHERE id = ?'
  );

  const deleteSessionByToken = db.prepare(
    'DELETE FROM sessions WHERE token = ?'
  );

  /**
   * Validate that a username/password pair matches configured credentials.
   * Uses bcrypt to compare the plaintext password against the stored hash.
   */
  async function validateCredentials(username: string, password: string): Promise<boolean> {
    if (!credentials) {
      return false;
    }

    if (username !== credentials.username) {
      return false;
    }

    return bcrypt.compare(password, credentials.passwordHash);
  }

  /**
   * Generate a signed JWT token for a session.
   */
  function generateToken(sessionId: string, username: string): string {
    return jwt.sign(
      { sessionId, username },
      config.jwtSecret,
      { expiresIn: `${timeoutMinutes}m` }
    );
  }

  /**
   * Check if a session has expired due to inactivity.
   */
  function isSessionExpired(lastActivity: Date): boolean {
    const now = Date.now();
    const lastMs = lastActivity.getTime();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    return (now - lastMs) > timeoutMs;
  }

  const authModule: AuthModule = {
    async login(username: string, password: string, ip: string): Promise<Session> {
      const valid = await validateCredentials(username, password);
      if (!valid) {
        throw new Error('Invalid credentials');
      }

      const sessionId = uuidv4();
      const now = new Date().toISOString();
      const token = generateToken(sessionId, username);

      insertSession.run(sessionId, username, token, now, now, ip);

      return {
        id: sessionId,
        username,
        createdAt: new Date(now),
        lastActivity: new Date(now),
        ip,
      };
    },

    logout(sessionId: string): void {
      deleteSession.run(sessionId);
    },

    validateSession(token: string): Session | null {
      // Verify JWT signature and expiry
      try {
        jwt.verify(token, config.jwtSecret);
      } catch {
        return null;
      }

      // Look up session in database
      const row = findSessionByToken.get(token) as SessionRow | undefined;
      if (!row) {
        return null;
      }

      const session = rowToSession(row);

      // Check inactivity timeout (30 minutes)
      if (isSessionExpired(session.lastActivity)) {
        // Invalidate expired session
        deleteSessionByToken.run(token);
        return null;
      }

      // Update last activity timestamp
      const now = new Date().toISOString();
      updateLastActivity.run(now, session.id);

      return {
        ...session,
        lastActivity: new Date(now),
      };
    },

    isRateLimited(_ip: string): boolean {
      // Rate limiting is implemented in the separate rate-limiter module (task 2.2)
      // This is a stub that always returns false — overridden in app.ts
      return false;
    },

    recordFailedAttempt(_ip: string): void {
      // Stub — overridden in app.ts to call rateLimiter.recordFailure
    },

    recordSuccessfulLogin(_ip: string): void {
      // Stub — overridden in app.ts to call rateLimiter.recordSuccess
    },

    getToken(sessionId: string): string | null {
      const row = db.prepare('SELECT token FROM sessions WHERE id = ?').get(sessionId) as { token: string } | undefined;
      return row?.token ?? null;
    },
  };

  return authModule;
}

/**
 * Retrieve the JWT token for a session (for use in tests or login response).
 */
export function getSessionToken(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT token FROM sessions WHERE id = ?').get(sessionId) as { token: string } | undefined;
  return row?.token ?? null;
}
