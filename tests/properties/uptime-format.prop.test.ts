/**
 * Property-based tests for uptime duration formatting.
 *
 * Feature: vps-panel, Property 2: Uptime duration formatting
 * For any non-negative integer representing seconds of uptime, the formatUptime()
 * function SHALL produce a string in the format "Xd Xh Xm" where converting back
 * to seconds yields the original value (rounded to the nearest minute).
 *
 * **Validates: Requirements 1.4**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatUptime, parseUptime } from '../../src/utils/format-uptime.js';

/**
 * Arbitrary for non-negative integers representing seconds (0 to 10,000,000).
 */
const secondsArb = fc.integer({ min: 0, max: 10_000_000 });

describe('Uptime Duration Formatting Property Tests', () => {
  it('Property 2.1: Round-trip — parseUptime(formatUptime(x)) === Math.round(x / 60) * 60', () => {
    fc.assert(
      fc.property(secondsArb, (seconds) => {
        const formatted = formatUptime(seconds);
        const parsed = parseUptime(formatted);
        const expectedSeconds = Math.round(seconds / 60) * 60;

        expect(parsed).toBe(expectedSeconds);
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 2.2: Format validity — output always matches pattern with at least one component', () => {
    // The output is space-separated components: "Xd", "Xh", "Xm" (any combination with at least one).
    // Valid examples: "0m", "5h", "2d", "1d 3h", "2h 45m", "1d 2h 30m", "1d 30m"
    const validPattern = /^(\d+d)?( \d+h)?( \d+m)?$/;

    fc.assert(
      fc.property(secondsArb, (seconds) => {
        const formatted = formatUptime(seconds);

        // Must have at least one component (d, h, or m)
        expect(formatted.length).toBeGreaterThan(0);
        expect(/\d+[dhm]/.test(formatted)).toBe(true);

        // Must match the overall pattern (components separated by spaces)
        // The pattern allows: Xd, Xh, Xm, Xd Xh, Xd Xm, Xh Xm, Xd Xh Xm
        const parts = formatted.split(' ');
        expect(parts.length).toBeGreaterThanOrEqual(1);
        expect(parts.length).toBeLessThanOrEqual(3);

        for (const part of parts) {
          // Each part must be digits followed by exactly one of d, h, m
          expect(part).toMatch(/^\d+[dhm]$/);
        }

        // Components must appear in order: d before h before m
        const order = parts.map((p) => p[p.length - 1]);
        const validOrder = ['d', 'h', 'm'];
        let lastIdx = -1;
        for (const unit of order) {
          const idx = validOrder.indexOf(unit);
          expect(idx).toBeGreaterThan(lastIdx);
          lastIdx = idx;
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 2.3: Components are non-negative integers', () => {
    fc.assert(
      fc.property(secondsArb, (seconds) => {
        const formatted = formatUptime(seconds);

        // Extract all numeric components
        const dayMatch = formatted.match(/(\d+)d/);
        const hourMatch = formatted.match(/(\d+)h/);
        const minuteMatch = formatted.match(/(\d+)m/);

        if (dayMatch) {
          const days = parseInt(dayMatch[1], 10);
          expect(days).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(days)).toBe(true);
        }

        if (hourMatch) {
          const hours = parseInt(hourMatch[1], 10);
          expect(hours).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(hours)).toBe(true);
        }

        if (minuteMatch) {
          const minutes = parseInt(minuteMatch[1], 10);
          expect(minutes).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(minutes)).toBe(true);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 2.4: No leading zeros in components', () => {
    fc.assert(
      fc.property(secondsArb, (seconds) => {
        const formatted = formatUptime(seconds);

        // Extract all numeric parts and check for leading zeros
        const dayMatch = formatted.match(/(\d+)d/);
        const hourMatch = formatted.match(/(\d+)h/);
        const minuteMatch = formatted.match(/(\d+)m/);

        if (dayMatch) {
          const daysStr = dayMatch[1];
          // No leading zeros unless the value is "0" itself
          if (daysStr.length > 1) {
            expect(daysStr[0]).not.toBe('0');
          }
        }

        if (hourMatch) {
          const hoursStr = hourMatch[1];
          if (hoursStr.length > 1) {
            expect(hoursStr[0]).not.toBe('0');
          }
        }

        if (minuteMatch) {
          const minutesStr = minuteMatch[1];
          if (minutesStr.length > 1) {
            expect(minutesStr[0]).not.toBe('0');
          }
        }
      }),
      { numRuns: 1000 }
    );
  });
});
