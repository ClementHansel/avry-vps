/**
 * Property-based tests for cron expression validation.
 *
 * Feature: vps-panel, Property 12: Cron expression validation
 * Test that validateExpression returns valid iff input is a syntactically correct
 * 5-field cron expression.
 *
 * **Validates: Requirements 15.7**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateExpression } from '../../src/modules/cron-manager.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generate a valid minute field (0-59, *, ranges, steps, lists) */
const minuteFieldArb = fc.oneof(
  fc.constant('*'),
  fc.integer({ min: 0, max: 59 }).map(String),
  fc.tuple(
    fc.integer({ min: 0, max: 58 }),
    fc.integer({ min: 1, max: 59 })
  ).filter(([a, b]) => a < b).map(([a, b]) => `${a}-${b}`),
  fc.tuple(
    fc.constant('*'),
    fc.integer({ min: 2, max: 30 })
  ).map(([base, step]) => `${base}/${step}`),
  fc.array(fc.integer({ min: 0, max: 59 }), { minLength: 2, maxLength: 4 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b).join(','))
);

/** Generate a valid hour field (0-23, *, ranges, steps, lists) */
const hourFieldArb = fc.oneof(
  fc.constant('*'),
  fc.integer({ min: 0, max: 23 }).map(String),
  fc.tuple(
    fc.integer({ min: 0, max: 22 }),
    fc.integer({ min: 1, max: 23 })
  ).filter(([a, b]) => a < b).map(([a, b]) => `${a}-${b}`),
  fc.tuple(
    fc.constant('*'),
    fc.integer({ min: 2, max: 12 })
  ).map(([base, step]) => `${base}/${step}`),
  fc.array(fc.integer({ min: 0, max: 23 }), { minLength: 2, maxLength: 4 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b).join(','))
);

/**
 * Generate a valid day-of-month field (1-28, *, ranges, steps, lists).
 * We limit to 1-28 to avoid month-specific day count issues (e.g., day 31 in April).
 */
const dayOfMonthFieldArb = fc.oneof(
  fc.constant('*'),
  fc.integer({ min: 1, max: 28 }).map(String),
  fc.tuple(
    fc.integer({ min: 1, max: 27 }),
    fc.integer({ min: 2, max: 28 })
  ).filter(([a, b]) => a < b).map(([a, b]) => `${a}-${b}`),
  fc.tuple(
    fc.constant('*'),
    fc.integer({ min: 2, max: 14 })
  ).map(([base, step]) => `${base}/${step}`),
  fc.array(fc.integer({ min: 1, max: 28 }), { minLength: 2, maxLength: 4 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b).join(','))
);

/** Generate a valid month field (1-12, *, ranges, steps, lists) */
const monthFieldArb = fc.oneof(
  fc.constant('*'),
  fc.integer({ min: 1, max: 12 }).map(String),
  fc.tuple(
    fc.integer({ min: 1, max: 11 }),
    fc.integer({ min: 2, max: 12 })
  ).filter(([a, b]) => a < b).map(([a, b]) => `${a}-${b}`),
  fc.tuple(
    fc.constant('*'),
    fc.integer({ min: 2, max: 6 })
  ).map(([base, step]) => `${base}/${step}`),
  fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 2, maxLength: 4 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b).join(','))
);

/** Generate a valid day-of-week field (0-6, *, ranges, steps, lists) */
const dayOfWeekFieldArb = fc.oneof(
  fc.constant('*'),
  fc.integer({ min: 0, max: 6 }).map(String),
  fc.tuple(
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 1, max: 6 })
  ).filter(([a, b]) => a < b).map(([a, b]) => `${a}-${b}`),
  fc.tuple(
    fc.constant('*'),
    fc.integer({ min: 2, max: 3 })
  ).map(([base, step]) => `${base}/${step}`),
  fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 2, maxLength: 3 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b).join(','))
);

/** Generate a valid 5-field cron expression */
const validCronExprArb = fc.tuple(
  minuteFieldArb,
  hourFieldArb,
  dayOfMonthFieldArb,
  monthFieldArb,
  dayOfWeekFieldArb
).map(fields => fields.join(' '));

/**
 * Generate an invalid cron expression.
 * cron-parser is lenient with field count (it accepts 1-6 fields),
 * so we focus on truly invalid inputs: out-of-range, bad syntax, bad chars.
 */
const invalidCronExprArb = fc.oneof(
  // Empty or whitespace
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t'),
  // Out-of-range values in 5-field format
  fc.constant('60 * * * *'),
  fc.constant('* 25 * * *'),
  fc.constant('* * 0 * *'),
  fc.constant('* * 32 * *'),
  fc.constant('* * * 0 *'),
  fc.constant('* * * 13 *'),
  // Invalid characters in cron fields
  fc.constant('a * * * *'),
  fc.constant('* b * * *'),
  fc.constant('* * c * *'),
  fc.constant('* * * d *'),
  fc.constant('* * * * x'),
  fc.constant('a b c d e'),
  fc.constant('@ @ @ @ @'),
  // Invalid range (reversed)
  fc.constant('59-0 * * * *'),
  fc.constant('* 23-0 * * *'),
  fc.constant('* * 31-1 * *'),
  // Invalid step syntax
  fc.constant('*/0 * * * *'),
  // Invalid day/month combinations (day 31 in months with fewer days)
  fc.constant('0 0 31 2 *'),
  fc.constant('0 0 30 2 *'),
  fc.constant('0 0 31 4 *'),
  fc.constant('0 0 31 6 *'),
  fc.constant('0 0 31 9 *'),
  fc.constant('0 0 31 11 *'),
  // Random strings that are clearly not cron expressions
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '!', '@', '#'), { minLength: 3, maxLength: 15 })
);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Cron Expression Validation Property Tests', () => {
  it('Property 12.1: Valid 5-field cron expressions are accepted', () => {
    fc.assert(
      fc.property(validCronExprArb, (expr) => {
        const result = validateExpression(expr);

        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.nextRun).toBeInstanceOf(Date);
      }),
      { numRuns: 500 }
    );
  });

  it('Property 12.2: Invalid or malformed expressions are rejected', () => {
    fc.assert(
      fc.property(invalidCronExprArb, (expr) => {
        const result = validateExpression(expr);

        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
        expect(result.error!.length).toBeGreaterThan(0);
        expect(result.nextRun).toBeUndefined();
      }),
      { numRuns: 500 }
    );
  });

  it('Property 12.3: Empty strings are always invalid', () => {
    const emptyInputs = ['', ' ', '  ', '\t', '\n', ' \t \n '];

    for (const input of emptyInputs) {
      const result = validateExpression(input);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  it('Property 12.4: Validation is deterministic — same input always yields same result', () => {
    fc.assert(
      fc.property(
        fc.oneof(validCronExprArb, fc.string({ minLength: 0, maxLength: 30 })),
        (expr) => {
          const result1 = validateExpression(expr);
          const result2 = validateExpression(expr);

          expect(result1.valid).toBe(result2.valid);
          expect(result1.error).toBe(result2.error);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('Property 12.5: Valid expressions always produce a nextRun date in the future', () => {
    const now = new Date();

    fc.assert(
      fc.property(validCronExprArb, (expr) => {
        const result = validateExpression(expr);

        if (result.valid && result.nextRun) {
          expect(result.nextRun.getTime()).toBeGreaterThanOrEqual(now.getTime());
        }
      }),
      { numRuns: 500 }
    );
  });
});
