import type Database from 'better-sqlite3';
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
/**
 * Load credentials from environment variables or a local config file.
 *
 * Priority 1: PANEL_USERNAME + PANEL_PASSWORD_HASH env vars
 * Priority 2: Config file at credentialsConfigPath or /app/data/credentials.json
 *
 * The password is always expected to be a bcrypt hash.
 */
export declare function loadCredentials(configPath?: string): CredentialsConfig | null;
/**
 * Create an AuthModule instance backed by the given SQLite database.
 */
export declare function createAuthModule(db: Database.Database, config: AuthConfig): AuthModule;
/**
 * Retrieve the JWT token for a session (for use in tests or login response).
 */
export declare function getSessionToken(db: Database.Database, sessionId: string): string | null;
export {};
//# sourceMappingURL=auth.d.ts.map