/**
 * Property-based tests for cron expression human-readable description.
 *
 * Feature: vps-panel, Property 11: Cron expression human-readable description
 * Tests that describeExpression is consistent (same input → same output) and that
 * the description accurately reflects what the cron expression means.
 *
 * **Validates: Requirements 15.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { describeExpression, validateExpression } from '../../src/modules/cron-manager.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Arbitrary for a valid minute field (0-59) */
const minuteArb = fc.integer({ min: 0, max: 59 }).map(String);

/** Arbitrary for a valid hour field (0-23) */
const hourArb = fc.integer({ min: 0, max: 23 }).map(String);

/** Arbitrary for a valid day-of-month field (1-31) */
const dayOfMonthArb = fc.integer({ min: 1, max: 31 }).map(String);

/** Arbitrary for a valid month field (1-12) */
const monthArb = fc.integer({ min: 1, max: 12 }).map(String);

/** Arbitrary for a valid day-of-week field (0-6) */
const dayOfWeekArb = fc.integer({ min: 0, max: 6 }).map(String);

/** Arbitrary for a step value in minute field */
const minuteStepArb = fc.integer({ min: 1, max: 30 }).map((n) => `*/${n}`);

/** Arbitrary for a step value in hour field */
const hourStepArb = fc.integer({ min: 1, max: 12 }).map((n) => `*/${n}`);

/** Arbitrary for a comma-separated list of weekdays (2-3 values, no duplicates) */
const weekdayListArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 2, maxLength: 3 })
  .map((days) => days.sort((a, b) => a - b).join(','));

/** Arbitrary for a wildcard */
const wildcardArb = fc.constant('*');

/**
 * Arbitrary generating well-formed 5-field cron expressions from specific
 * patterns that describeExpression handles.
 */
const knownPatternArb = fc.oneof(
  // Every minute: * * * * *
  fc.constant('* * * * *'),
  // Every N minutes: */N * * * *
  minuteStepArb.map((step) => `${step} * * * *`),
  // Every N hours: 0 */N * * *
  hourStepArb.map((step) => `0 ${step} * * *`),
  // Every hour: 0 * * * *
  fc.constant('0 * * * *'),
  // Every hour at minute M: M * * * *
  minuteArb.map((m) => `${m} * * * *`),
  // Every day at H:M: M H * * *
  fc.tuple(minuteArb, hourArb).map(([m, h]) => `${m} ${h} * * *`),
  // Specific weekdays at H:M: M H * * DOW
  fc
    .tuple(minuteArb, hourArb, fc.oneof(weekdayListArb, dayOfWeekArb, fc.constant('1-5'), fc.constant('0,6')))
    .map(([m, h, dow]) => `${m} ${h} * * ${dow}`),
  // Day of month at H:M: M H DOM * *
  fc.tuple(minuteArb, hourArb, dayOfMonthArb).map(([m, h, dom]) => `${m} ${h} ${dom} * *`),
  // Specific month and day at H:M: M H DOM MON *
  fc
    .tuple(minuteArb, hourArb, dayOfMonthArb, monthArb)
    .map(([m, h, dom, mon]) => `${m} ${h} ${dom} ${mon} *`),
);

/**
 * Arbitrary for arbitrary valid 5-field cron expressions (may produce "Custom schedule" fallback).
 */
const validCronArb = fc
  .tuple(
    fc.oneof(minuteArb, minuteStepArb, wildcardArb),
    fc.oneof(hourArb, hourStepArb, wildcardArb),
    fc.oneof(dayOfMonthArb, wildcardArb),
    fc.oneof(monthArb, wildcardArb),
    fc.oneof(dayOfWeekArb, weekdayListArb, wildcardArb),
  )
  .map(([min, hour, dom, mon, dow]) => `${min} ${hour} ${dom} ${mon} ${dow}`);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Cron Expression Human-Readable Description Property Tests', () => {
  it('Property 11.1: Determinism — describeExpression returns the same output for the same input', () => {
    fc.assert(
      fc.property(validCronArb, (expr) => {
        const result1 = describeExpression(expr);
        const result2 = describeExpression(expr);
        const result3 = describeExpression(expr);

        expect(result1).toBe(result2);
        expect(result2).toBe(result3);
      }),
      { numRuns: 1000 },
    );
  });

  it('Property 11.2: Non-empty output — describeExpression always returns a non-empty string', () => {
    fc.assert(
      fc.property(validCronArb, (expr) => {
        const description = describeExpression(expr);

        expect(typeof description).toBe('string');
        expect(description.length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });

  it('Property 11.3: Known patterns produce descriptive output (not fallback)', () => {
    fc.assert(
      fc.property(knownPatternArb, (expr) => {
        const description = describeExpression(expr);

        // Known patterns should NOT produce the "Custom schedule" fallback
        expect(description).not.toMatch(/^Custom schedule/);
        // Should be a meaningful English description
        expect(description.length).toBeGreaterThan(3);
      }),
      { numRuns: 1000 },
    );
  });

  it('Property 11.4: Every-minute pattern produces "Every minute"', () => {
    const description = describeExpression('* * * * *');
    expect(description).toBe('Every minute');
  });

  it('Property 11.5: Step minute patterns produce "Every N minutes"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (step) => {
        const expr = `*/${step} * * * *`;
        const description = describeExpression(expr);

        expect(description).toBe(`Every ${step} minutes`);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 11.6: Step hour patterns produce "Every N hours"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (step) => {
        const expr = `0 */${step} * * *`;
        const description = describeExpression(expr);

        expect(description).toBe(`Every ${step} hours`);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 11.7: Daily patterns include correct time in description', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        (minute, hour) => {
          const expr = `${minute} ${hour} * * *`;
          const description = describeExpression(expr);

          // Should contain "Every day at" and a time
          expect(description).toContain('Every day at');

          // Verify the time is correctly formatted (12-hour with AM/PM)
          const period = hour >= 12 ? 'PM' : 'AM';
          const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
          const displayMinute = minute.toString().padStart(2, '0');
          const expectedTime = `${displayHour}:${displayMinute} ${period}`;

          expect(description).toContain(expectedTime);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Property 11.8: Weekday patterns (1-5) produce "Weekdays at ..."', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        (minute, hour) => {
          const expr = `${minute} ${hour} * * 1-5`;
          const description = describeExpression(expr);

          expect(description).toContain('Weekdays at');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 11.9: Weekend patterns (0,6) produce "Weekends at ..."', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        (minute, hour) => {
          const expr = `${minute} ${hour} * * 0,6`;
          const description = describeExpression(expr);

          expect(description).toContain('Weekends at');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 11.10: Month-day patterns include the day number', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 1, max: 28 }), // Use 1-28 to avoid invalid day-of-month issues
        (minute, hour, day) => {
          const expr = `${minute} ${hour} ${day} * *`;
          const description = describeExpression(expr);

          expect(description).toContain(`Day ${day}`);
          expect(description).toContain('every month');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 11.11: Specific month patterns include the month name', () => {
    const monthNames = [
      '', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 12 }),
        (minute, hour, day, month) => {
          const expr = `${minute} ${hour} ${day} ${month} *`;
          const description = describeExpression(expr);

          expect(description).toContain(monthNames[month]);
          expect(description).toContain(String(day));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 11.12: Invalid expressions (less than 5 fields) return the input as-is', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        (numFields) => {
          const fields = Array.from({ length: numFields }, () => '*');
          const expr = fields.join(' ');
          const description = describeExpression(expr);

          // Should return the expression as-is when less than 5 fields
          expect(description).toBe(expr);
        },
      ),
      { numRuns: 50 },
    );
  });
});
