"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCredentials = loadCredentials;
exports.createAuthModule = createAuthModule;
exports.getSessionToken = getSessionToken;
/**
 * Authentication Module
 *
 * JWT-based session management with SQLite storage.
 * Validates credentials against environment variables or local config file.
 * Implements 30-minute inactivity timeout.
 *
 * Requirements: 6.1, 6.2, 6.4, 6.5, 6.6
 */
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const uuid_1 = require("uuid");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
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
function loadCredentials(configPath) {
    // Priority 1: Environment variables
    const envUsername = process.env.PANEL_USERNAME;
    const envPasswordHash = process.env.PANEL_PASSWORD_HASH;
    if (envUsername && envPasswordHash) {
        return { username: envUsername, passwordHash: envPasswordHash };
    }
    // Priority 2: Local config file
    const resolvedPath = configPath
        ? node_path_1.default.resolve(configPath)
        : node_path_1.default.resolve(DEFAULT_CREDENTIALS_PATH);
    try {
        if (node_fs_1.default.existsSync(resolvedPath)) {
            const raw = node_fs_1.default.readFileSync(resolvedPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.username && parsed.passwordHash) {
                return { username: parsed.username, passwordHash: parsed.passwordHash };
            }
        }
    }
    catch {
        // Config file unreadable or invalid — fall through to null
    }
    return null;
}
/**
 * Parse a SQLite row into a Session object.
 */
function rowToSession(row) {
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
function createAuthModule(db, config) {
    const timeoutMinutes = config.sessionTimeoutMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
    const credentials = loadCredentials(config.credentialsConfigPath);
    // Prepared statements for performance
    const insertSession = db.prepare('INSERT INTO sessions (id, username, token, created_at, last_activity, ip) VALUES (?, ?, ?, ?, ?, ?)');
    const findSessionByToken = db.prepare('SELECT id, username, token, created_at, last_activity, ip FROM sessions WHERE token = ?');
    const updateLastActivity = db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?');
    const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
    const deleteSessionByToken = db.prepare('DELETE FROM sessions WHERE token = ?');
    /**
     * Validate that a username/password pair matches configured credentials.
     * Uses bcrypt to compare the plaintext password against the stored hash.
     */
    async function validateCredentials(username, password) {
        if (!credentials) {
            return false;
        }
        if (username !== credentials.username) {
            return false;
        }
        return bcrypt_1.default.compare(password, credentials.passwordHash);
    }
    /**
     * Generate a signed JWT token for a session.
     */
    function generateToken(sessionId, username) {
        return jsonwebtoken_1.default.sign({ sessionId, username }, config.jwtSecret, { expiresIn: `${timeoutMinutes}m` });
    }
    /**
     * Check if a session has expired due to inactivity.
     */
    function isSessionExpired(lastActivity) {
        const now = Date.now();
        const lastMs = lastActivity.getTime();
        const timeoutMs = timeoutMinutes * 60 * 1000;
        return (now - lastMs) > timeoutMs;
    }
    const authModule = {
        async login(username, password, ip) {
            const valid = await validateCredentials(username, password);
            if (!valid) {
                throw new Error('Invalid credentials');
            }
            const sessionId = (0, uuid_1.v4)();
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
        logout(sessionId) {
            deleteSession.run(sessionId);
        },
        validateSession(token) {
            // Verify JWT signature and expiry
            try {
                jsonwebtoken_1.default.verify(token, config.jwtSecret);
            }
            catch {
                return null;
            }
            // Look up session in database
            const row = findSessionByToken.get(token);
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
        isRateLimited(_ip) {
            // Rate limiting is implemented in the separate rate-limiter module (task 2.2)
            // This is a stub that always returns false — overridden in app.ts
            return false;
        },
        recordFailedAttempt(_ip) {
            // Stub — overridden in app.ts to call rateLimiter.recordFailure
        },
        recordSuccessfulLogin(_ip) {
            // Stub — overridden in app.ts to call rateLimiter.recordSuccess
        },
        getToken(sessionId) {
            const row = db.prepare('SELECT token FROM sessions WHERE id = ?').get(sessionId);
            return row?.token ?? null;
        },
    };
    return authModule;
}
/**
 * Retrieve the JWT token for a session (for use in tests or login response).
 */
function getSessionToken(db, sessionId) {
    const row = db.prepare('SELECT token FROM sessions WHERE id = ?').get(sessionId);
    return row?.token ?? null;
}
//# sourceMappingURL=auth.js.map