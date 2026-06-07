/**
 * Property-based tests for the Rate Limiter state machine.
 *
 * Feature: vps-panel, Property 7: Rate limiting state machine
 * For any IP address and sequence of login attempts, the rate limiter SHALL lock
 * the IP for lockDurationMs if and only if there are maxAttempts or more consecutive
 * failed attempts within any windowMs sliding window, and SHALL allow attempts from
 * IPs whose lock period has expired.
 *
 * **Validates: Requirements 6.3**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import { createRateLimiter, type RateLimiter } from '../../src/modules/rate-limiter.js';
import type Database from 'better-sqlite3';

// Use short durations for testability
const TEST_CONFIG = {
  maxAttempts: 3,
  windowMs: 100,       // 100ms window
  lockDurationMs: 50,  // 50ms lock duration
};

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-rate-limiter-prop-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Helper to wait a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Arbitrary for generating valid IP-like strings.
 */
const ipArb = fc.oneof(
  // IPv4
  fc.tuple(
    fc.integer({ min: 1, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 255 })
  ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  // Simple unique identifiers as IP stand-ins
  fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '3', '.'), { minLength: 3, maxLength: 15 })
    .filter((s) => s.length > 0)
);

describe('Rate Limiter Property Tests', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  it('Property 7.1: N consecutive failures (N >= maxAttempts) within window causes a lock', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 3, max: 10 }), // failureCount >= maxAttempts
        (ip, failureCount) => {
          const limiter = createRateLimiter(db, TEST_CONFIG);

          // Record exactly failureCount failures (all within the 100ms window since they're synchronous)
          for (let i = 0; i < failureCount; i++) {
            limiter.recordFailure(ip);
          }

          // The IP should be locked after reaching maxAttempts
          expect(limiter.isLocked(ip)).toBe(true);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 7.2: Less than maxAttempts failures does NOT cause a lock', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 1, max: 2 }), // failureCount < maxAttempts (3)
        (ip, failureCount) => {
          const limiter = createRateLimiter(db, TEST_CONFIG);

          for (let i = 0; i < failureCount; i++) {
            limiter.recordFailure(ip);
          }

          // The IP should NOT be locked with fewer than maxAttempts failures
          expect(limiter.isLocked(ip)).toBe(false);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 7.3: After lock duration expires, the IP is no longer locked', async () => {
    await fc.assert(
      fc.asyncProperty(
        ipArb,
        async (ip) => {
          const limiter = createRateLimiter(db, TEST_CONFIG);

          // Lock the IP
          for (let i = 0; i < TEST_CONFIG.maxAttempts; i++) {
            limiter.recordFailure(ip);
          }
          expect(limiter.isLocked(ip)).toBe(true);

          // Wait for lock to expire (lockDurationMs = 50ms, wait 80ms to be safe)
          await sleep(80);

          // The IP should no longer be locked
          expect(limiter.isLocked(ip)).toBe(false);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
        }
      ),
      { numRuns: 30 } // Fewer runs due to async timing
    );
  });

  it('Property 7.4: recordSuccess resets the failure counter', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 1, max: 2 }), // failures before success (less than max to not lock)
        (ip, failuresBefore) => {
          const limiter = createRateLimiter(db, TEST_CONFIG);

          // Record some failures
          for (let i = 0; i < failuresBefore; i++) {
            limiter.recordFailure(ip);
          }

          // Reset with success
          limiter.recordSuccess(ip);

          // After success, recording up to (maxAttempts - 1) failures should NOT lock
          for (let i = 0; i < TEST_CONFIG.maxAttempts - 1; i++) {
            limiter.recordFailure(ip);
          }
          expect(limiter.isLocked(ip)).toBe(false);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 7.5: Different IPs are independent', () => {
    fc.assert(
      fc.property(
        ipArb,
        ipArb,
        fc.integer({ min: 3, max: 5 }),
        (ip1, ip2, failureCount) => {
          // Skip if both IPs are the same
          fc.pre(ip1 !== ip2);

          const limiter = createRateLimiter(db, TEST_CONFIG);

          // Lock ip1
          for (let i = 0; i < failureCount; i++) {
            limiter.recordFailure(ip1);
          }

          // ip2 should be unaffected
          expect(limiter.isLocked(ip1)).toBe(true);
          expect(limiter.isLocked(ip2)).toBe(false);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip1);
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 7.6: State machine transitions - arbitrary action sequences maintain invariants', () => {
    // Action type: 'failure', 'success', or 'check'
    const actionArb = fc.constantFrom('failure', 'success', 'check') as fc.Arbitrary<'failure' | 'success' | 'check'>;
    const actionsArb = fc.array(actionArb, { minLength: 1, maxLength: 20 });

    fc.assert(
      fc.property(
        ipArb,
        actionsArb,
        (ip, actions) => {
          const limiter = createRateLimiter(db, TEST_CONFIG);

          let consecutiveFailures = 0;
          let isCurrentlyLocked = false;

          for (const action of actions) {
            if (action === 'failure') {
              if (!isCurrentlyLocked) {
                limiter.recordFailure(ip);
                consecutiveFailures++;
                if (consecutiveFailures >= TEST_CONFIG.maxAttempts) {
                  isCurrentlyLocked = true;
                }
              } else {
                // When locked, recordFailure is a no-op
                limiter.recordFailure(ip);
              }
            } else if (action === 'success') {
              limiter.recordSuccess(ip);
              consecutiveFailures = 0;
              isCurrentlyLocked = false;
            } else {
              // 'check' — just verify current state matches expectation
              const locked = limiter.isLocked(ip);
              expect(locked).toBe(isCurrentlyLocked);
            }
          }

          // Final verification: the lock state should match our model
          expect(limiter.isLocked(ip)).toBe(isCurrentlyLocked);

          // Clean up for next iteration
          db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
        }
      ),
      { numRuns: 100 }
    );
  });
});
