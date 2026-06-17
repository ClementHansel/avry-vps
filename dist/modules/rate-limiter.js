"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimiter = createRateLimiter;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
/**
 * Create a rate limiter instance backed by a SQLite database.
 */
function createRateLimiter(db, config) {
    const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    const lockDurationMs = config?.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
    // Prepared statements for performance
    const getRecord = db.prepare('SELECT * FROM rate_limits WHERE ip = ?');
    const upsertRecord = db.prepare(`INSERT INTO rate_limits (ip, failed_attempts, first_attempt_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       failed_attempts = excluded.failed_attempts,
       first_attempt_at = excluded.first_attempt_at,
       locked_until = excluded.locked_until`);
    const deleteRecord = db.prepare('DELETE FROM rate_limits WHERE ip = ?');
    function getRow(ip) {
        return getRecord.get(ip);
    }
    function isLocked(ip) {
        const row = getRow(ip);
        if (!row || !row.locked_until)
            return false;
        const lockedUntil = new Date(row.locked_until).getTime();
        const now = Date.now();
        if (now >= lockedUntil) {
            // Lock has expired — reset the record
            deleteRecord.run(ip);
            return false;
        }
        return true;
    }
    function recordFailure(ip) {
        const row = getRow(ip);
        const now = new Date();
        if (row && row.locked_until) {
            const lockedUntil = new Date(row.locked_until).getTime();
            if (now.getTime() < lockedUntil) {
                // Already locked, ignore further failures
                return;
            }
            // Lock expired, treat as fresh start
            deleteRecord.run(ip);
        }
        if (row && row.first_attempt_at && !row.locked_until) {
            const firstAttempt = new Date(row.first_attempt_at).getTime();
            const elapsed = now.getTime() - firstAttempt;
            if (elapsed > windowMs) {
                // Window expired — start a new window with this failure
                upsertRecord.run(ip, 1, now.toISOString(), null);
                return;
            }
            // Within the window — increment
            const newCount = row.failed_attempts + 1;
            if (newCount >= maxAttempts) {
                // Lock the IP
                const lockUntil = new Date(now.getTime() + lockDurationMs).toISOString();
                upsertRecord.run(ip, newCount, row.first_attempt_at, lockUntil);
            }
            else {
                upsertRecord.run(ip, newCount, row.first_attempt_at, null);
            }
        }
        else {
            // No existing record or record was cleaned — start fresh
            upsertRecord.run(ip, 1, now.toISOString(), null);
        }
    }
    function recordSuccess(ip) {
        // Reset the failure counter on successful login
        deleteRecord.run(ip);
    }
    function getRemainingLockTime(ip) {
        const row = getRow(ip);
        if (!row || !row.locked_until)
            return 0;
        const lockedUntil = new Date(row.locked_until).getTime();
        const now = Date.now();
        const remaining = lockedUntil - now;
        if (remaining <= 0) {
            // Lock has expired — clean up
            deleteRecord.run(ip);
            return 0;
        }
        return Math.ceil(remaining / 1000); // Convert to seconds
    }
    /**
     * Remove expired entries from the rate_limits table.
     * Deletes rows where the lock has expired or the sliding window has elapsed
     * without reaching the threshold. Returns the number of rows removed.
     */
    function cleanup() {
        const now = new Date().toISOString();
        const windowCutoff = new Date(Date.now() - windowMs).toISOString();
        const result = db.prepare(`DELETE FROM rate_limits
       WHERE (locked_until IS NOT NULL AND locked_until <= ?)
          OR (locked_until IS NULL AND first_attempt_at <= ?)`).run(now, windowCutoff);
        return result.changes;
    }
    return {
        isLocked,
        recordFailure,
        recordSuccess,
        getRemainingLockTime,
        cleanup,
    };
}
//# sourceMappingURL=rate-limiter.js.map