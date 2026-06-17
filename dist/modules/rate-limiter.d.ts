/**
 * Rate Limiter Module
 *
 * Implements sliding window rate limiting for login attempts.
 * Tracks failed attempts per IP in SQLite rate_limits table.
 * Locks IP for 15 minutes after 3 consecutive failed attempts within 5 minutes.
 */
import type Database from 'better-sqlite3';
export interface RateLimiter {
    /** Check if an IP is currently locked out */
    isLocked(ip: string): boolean;
    /** Record a failed login attempt for an IP */
    recordFailure(ip: string): void;
    /** Record a successful login (resets the failure counter) */
    recordSuccess(ip: string): void;
    /** Get remaining lock time in seconds (0 if not locked) */
    getRemainingLockTime(ip: string): number;
    /** Remove expired entries from the rate_limits table */
    cleanup(): number;
}
export interface RateLimiterConfig {
    /** Maximum failed attempts before lockout. Default: 3 */
    maxAttempts?: number;
    /** Window in milliseconds for counting failures. Default: 5 minutes (300000ms) */
    windowMs?: number;
    /** Lock duration in milliseconds. Default: 15 minutes (900000ms) */
    lockDurationMs?: number;
}
/**
 * Create a rate limiter instance backed by a SQLite database.
 */
export declare function createRateLimiter(db: Database.Database, config?: RateLimiterConfig): RateLimiter;
//# sourceMappingURL=rate-limiter.d.ts.map