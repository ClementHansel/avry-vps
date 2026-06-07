/**
 * Unit tests for the Rate Limiter module.
 * Tests sliding window logic, lockout behavior, and counter reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import { createRateLimiter, type RateLimiter } from '../../src/modules/rate-limiter.js';
import type Database from 'better-sqlite3';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-rate-limiter-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Rate Limiter Module', () => {
  let dbPath: string;
  let db: Database.Database;
  let limiter: RateLimiter;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    limiter = createRateLimiter(db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    vi.useRealTimers();
  });

  describe('isLocked', () => {
    it('should return false for an unknown IP', () => {
      expect(limiter.isLocked('192.168.1.1')).toBe(false);
    });

    it('should return false after fewer than 3 failures', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      expect(limiter.isLocked('192.168.1.1')).toBe(false);
    });

    it('should return true after 3 failures within 5 minutes', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      expect(limiter.isLocked('192.168.1.1')).toBe(true);
    });

    it('should return false after lock period expires', () => {
      // Use a short lock duration for testing
      const shortLimiter = createRateLimiter(db, { lockDurationMs: 100 });

      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');
      expect(shortLimiter.isLocked('10.0.0.1')).toBe(true);

      // Wait for lock to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortLimiter.isLocked('10.0.0.1')).toBe(false);
          resolve();
        }, 150);
      });
    });

    it('should not affect other IPs', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      expect(limiter.isLocked('192.168.1.1')).toBe(true);
      expect(limiter.isLocked('192.168.1.2')).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('should track failures incrementally', () => {
      limiter.recordFailure('10.0.0.1');

      const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      expect(row.failed_attempts).toBe(1);
      expect(row.first_attempt_at).not.toBeNull();
      expect(row.locked_until).toBeNull();
    });

    it('should lock after reaching max attempts', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');

      const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      expect(row.failed_attempts).toBe(3);
      expect(row.locked_until).not.toBeNull();
    });

    it('should reset window when failures are outside the window', () => {
      // Use a very short window for testing
      const shortWindowLimiter = createRateLimiter(db, { windowMs: 50 });

      shortWindowLimiter.recordFailure('10.0.0.1');
      shortWindowLimiter.recordFailure('10.0.0.1');

      // Wait for window to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          shortWindowLimiter.recordFailure('10.0.0.1');

          const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
          // Should have reset to 1 since window expired
          expect(row.failed_attempts).toBe(1);
          expect(shortWindowLimiter.isLocked('10.0.0.1')).toBe(false);
          resolve();
        }, 100);
      });
    });

    it('should not increment failures when already locked', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');

      // Additional failures while locked should be ignored
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');

      const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      expect(row.failed_attempts).toBe(3);
    });

    it('should lock with custom maxAttempts', () => {
      const customLimiter = createRateLimiter(db, { maxAttempts: 5 });

      for (let i = 0; i < 4; i++) {
        customLimiter.recordFailure('10.0.0.1');
      }
      expect(customLimiter.isLocked('10.0.0.1')).toBe(false);

      customLimiter.recordFailure('10.0.0.1');
      expect(customLimiter.isLocked('10.0.0.1')).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should reset the failure counter', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      limiter.recordSuccess('10.0.0.1');

      const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      expect(row).toBeUndefined();
    });

    it('should allow new attempts after success reset', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      limiter.recordSuccess('10.0.0.1');

      // Should be able to fail again from scratch
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      expect(limiter.isLocked('10.0.0.1')).toBe(false);
    });

    it('should be a no-op for unknown IPs', () => {
      // Should not throw
      expect(() => limiter.recordSuccess('unknown-ip')).not.toThrow();
    });
  });

  describe('getRemainingLockTime', () => {
    it('should return 0 for an unlocked IP', () => {
      expect(limiter.getRemainingLockTime('10.0.0.1')).toBe(0);
    });

    it('should return 0 for an IP with failures but not locked', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      expect(limiter.getRemainingLockTime('10.0.0.1')).toBe(0);
    });

    it('should return positive seconds for a locked IP', () => {
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');
      limiter.recordFailure('10.0.0.1');

      const remaining = limiter.getRemainingLockTime('10.0.0.1');
      // Should be close to 15 minutes (900 seconds)
      expect(remaining).toBeGreaterThan(890);
      expect(remaining).toBeLessThanOrEqual(900);
    });

    it('should return 0 after lock expires', () => {
      const shortLimiter = createRateLimiter(db, { lockDurationMs: 50 });

      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortLimiter.getRemainingLockTime('10.0.0.1')).toBe(0);
          resolve();
        }, 100);
      });
    });

    it('should decrease over time', () => {
      const shortLockLimiter = createRateLimiter(db, { lockDurationMs: 2000 });

      shortLockLimiter.recordFailure('10.0.0.2');
      shortLockLimiter.recordFailure('10.0.0.2');
      shortLockLimiter.recordFailure('10.0.0.2');

      const first = shortLockLimiter.getRemainingLockTime('10.0.0.2');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const second = shortLockLimiter.getRemainingLockTime('10.0.0.2');
          expect(second).toBeLessThan(first);
          resolve();
        }, 500);
      });
    });
  });

  describe('Sliding window behavior', () => {
    it('should count failures from the first attempt timestamp', () => {
      limiter.recordFailure('10.0.0.1');

      const row = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      const firstAttempt = new Date(row.first_attempt_at).getTime();
      const now = Date.now();

      // first_attempt_at should be approximately now
      expect(Math.abs(firstAttempt - now)).toBeLessThan(1000);
    });

    it('should preserve first_attempt_at across multiple failures in same window', () => {
      limiter.recordFailure('10.0.0.1');
      const row1 = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;
      const firstAttempt = row1.first_attempt_at;

      limiter.recordFailure('10.0.0.1');
      const row2 = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('10.0.0.1') as any;

      expect(row2.first_attempt_at).toBe(firstAttempt);
    });

    it('should handle multiple IPs independently', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      limiter.recordFailure('192.168.1.2');

      expect(limiter.isLocked('192.168.1.1')).toBe(true);
      expect(limiter.isLocked('192.168.1.2')).toBe(false);

      const row2 = db.prepare('SELECT * FROM rate_limits WHERE ip = ?').get('192.168.1.2') as any;
      expect(row2.failed_attempts).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle IPv6 addresses', () => {
      const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      limiter.recordFailure(ipv6);
      limiter.recordFailure(ipv6);
      limiter.recordFailure(ipv6);
      expect(limiter.isLocked(ipv6)).toBe(true);
    });

    it('should handle empty string IP', () => {
      limiter.recordFailure('');
      expect(limiter.isLocked('')).toBe(false);
      limiter.recordFailure('');
      limiter.recordFailure('');
      expect(limiter.isLocked('')).toBe(true);
    });

    it('should allow attempts after lock expires and counter resets', () => {
      const shortLimiter = createRateLimiter(db, { lockDurationMs: 50 });

      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');
      shortLimiter.recordFailure('10.0.0.1');
      expect(shortLimiter.isLocked('10.0.0.1')).toBe(true);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Lock expired
          expect(shortLimiter.isLocked('10.0.0.1')).toBe(false);

          // Should be able to fail again from zero
          shortLimiter.recordFailure('10.0.0.1');
          shortLimiter.recordFailure('10.0.0.1');
          expect(shortLimiter.isLocked('10.0.0.1')).toBe(false);

          shortLimiter.recordFailure('10.0.0.1');
          expect(shortLimiter.isLocked('10.0.0.1')).toBe(true);
          resolve();
        }, 100);
      });
    });
  });
});
