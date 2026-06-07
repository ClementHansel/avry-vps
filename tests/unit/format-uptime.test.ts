/**
 * Unit tests for the uptime formatting utility.
 * Tests formatUptime and parseUptime functions including edge cases
 * and the round-trip property.
 */
import { describe, it, expect } from 'vitest';
import { formatUptime, parseUptime } from '../../src/utils/format-uptime.js';

describe('formatUptime', () => {
  it('should format 0 seconds as "0m"', () => {
    expect(formatUptime(0)).toBe('0m');
  });

  it('should format seconds less than a minute as "0m" (rounds down)', () => {
    expect(formatUptime(29)).toBe('0m');
  });

  it('should round up to 1m when seconds >= 30', () => {
    expect(formatUptime(30)).toBe('1m');
  });

  it('should format exact minutes', () => {
    expect(formatUptime(60)).toBe('1m');
    expect(formatUptime(120)).toBe('2m');
    expect(formatUptime(300)).toBe('5m');
  });

  it('should format hours and minutes', () => {
    expect(formatUptime(3600)).toBe('1h');
    expect(formatUptime(3660)).toBe('1h 1m');
    expect(formatUptime(5400)).toBe('1h 30m');
  });

  it('should format days, hours, and minutes', () => {
    expect(formatUptime(86400)).toBe('1d');
    expect(formatUptime(90000)).toBe('1d 1h');
    expect(formatUptime(90060)).toBe('1d 1h 1m');
  });

  it('should omit zero-value components', () => {
    // 2 days, 0 hours, 30 minutes = 2*86400 + 30*60 = 174600
    expect(formatUptime(174600)).toBe('2d 30m');
    // 0 days, 5 hours, 0 minutes = 5*3600 = 18000
    expect(formatUptime(18000)).toBe('5h');
  });

  it('should handle large values', () => {
    // 365 days
    expect(formatUptime(365 * 86400)).toBe('365d');
    // 100 days, 23 hours, 59 minutes
    const seconds = 100 * 86400 + 23 * 3600 + 59 * 60;
    expect(formatUptime(seconds)).toBe('100d 23h 59m');
  });

  it('should treat negative values as 0', () => {
    expect(formatUptime(-1)).toBe('0m');
    expect(formatUptime(-1000)).toBe('0m');
  });

  it('should treat NaN and Infinity as 0', () => {
    expect(formatUptime(NaN)).toBe('0m');
    expect(formatUptime(Infinity)).toBe('0m');
    expect(formatUptime(-Infinity)).toBe('0m');
  });

  it('should round fractional seconds to nearest minute', () => {
    // 89.9 seconds rounds to 1 minute (90/60 = 1.5 → rounds to 2? No: Math.round(89.9/60) = Math.round(1.498) = 1)
    expect(formatUptime(89.9)).toBe('1m');
    // 90 seconds = 1.5 minutes → rounds to 2 minutes
    expect(formatUptime(90)).toBe('2m');
  });
});

describe('parseUptime', () => {
  it('should parse "0m" as 0 seconds', () => {
    expect(parseUptime('0m')).toBe(0);
  });

  it('should parse minutes only', () => {
    expect(parseUptime('5m')).toBe(300);
    expect(parseUptime('30m')).toBe(1800);
  });

  it('should parse hours and minutes', () => {
    expect(parseUptime('1h 30m')).toBe(5400);
    expect(parseUptime('2h 15m')).toBe(8100);
  });

  it('should parse days, hours, and minutes', () => {
    expect(parseUptime('1d 1h 1m')).toBe(90060);
    expect(parseUptime('2d 3h 45m')).toBe(186300);
  });

  it('should parse partial formats', () => {
    expect(parseUptime('1d')).toBe(86400);
    expect(parseUptime('1h')).toBe(3600);
    expect(parseUptime('2d 30m')).toBe(174600);
  });

  it('should return 0 for empty or invalid input', () => {
    expect(parseUptime('')).toBe(0);
    expect(parseUptime('hello')).toBe(0);
  });
});

describe('round-trip property', () => {
  it('should satisfy parseUptime(formatUptime(x)) === x rounded to nearest minute', () => {
    const testCases = [0, 30, 60, 90, 120, 3600, 3660, 5400, 86400, 90060, 174600, 999999];

    for (const seconds of testCases) {
      const formatted = formatUptime(seconds);
      const parsed = parseUptime(formatted);
      const expected = Math.round(seconds / 60) * 60;
      expect(parsed).toBe(expected);
    }
  });

  it('should round-trip correctly for values already on minute boundaries', () => {
    const minuteValues = [0, 60, 120, 180, 3600, 7200, 86400, 172800];

    for (const seconds of minuteValues) {
      const formatted = formatUptime(seconds);
      const parsed = parseUptime(formatted);
      expect(parsed).toBe(seconds);
    }
  });
});
