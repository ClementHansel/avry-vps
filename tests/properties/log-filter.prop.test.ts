/**
 * Property-based tests for log filtering correctness.
 *
 * Feature: vps-panel, Property 5: Log filtering correctness
 * Test that filtering by search term and time range returns exactly matching entries.
 * For any generated set of log entries, filterLogs returns exactly those entries whose
 * content contains the search term (case-insensitive), and filterByTimeRange returns
 * exactly those entries whose timestamp falls within the specified range.
 *
 * **Validates: Requirements 4.3, 4.4**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createLogViewer, type LogEntry, type LogStream, type TimeRange, getTimeSince } from '../../src/modules/log-viewer.js';

// Create a log viewer instance (no Docker/Socket.IO needed for filter functions)
const logViewer = createLogViewer();

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generate a valid LogStream type.
 */
const logStreamArb: fc.Arbitrary<LogStream> = fc.constantFrom('stdout', 'stderr');

/**
 * Generate a timestamp within a reasonable range (last 48 hours to now).
 */
const timestampArb: fc.Arbitrary<Date> = fc.date({
  min: new Date(Date.now() - 48 * 60 * 60 * 1000),
  max: new Date(),
});

/**
 * Generate log content — printable ASCII strings of various lengths.
 */
const logContentArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ' ', '-', '_', ':', '.', '/', '[', ']', '(', ')', '=', '+', ','
  ),
  { minLength: 1, maxLength: 80 }
);

/**
 * Generate a single LogEntry.
 */
const logEntryArb: fc.Arbitrary<LogEntry> = fc.tuple(
  timestampArb,
  logContentArb,
  logStreamArb
).map(([timestamp, content, stream]) => ({ timestamp, content, stream }));

/**
 * Generate an array of log entries (1-50 entries).
 */
const logEntriesArb: fc.Arbitrary<LogEntry[]> = fc.array(logEntryArb, { minLength: 1, maxLength: 50 });

/**
 * Generate a valid search term (1-200 characters, non-empty).
 */
const searchTermArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ' ', '-', '_', ':', '.'
  ),
  { minLength: 1, maxLength: 50 }
);

/**
 * Generate a time range value.
 */
const timeRangeArb: fc.Arbitrary<TimeRange> = fc.constantFrom('1h', '6h', '24h', 'all');

// ─── Oracle Functions ────────────────────────────────────────────────────────

/**
 * Reference implementation for search filtering — case-insensitive substring match.
 */
function oracleFilterLogs(logs: LogEntry[], searchTerm: string): LogEntry[] {
  if (searchTerm.length < 1 || searchTerm.length > 200) {
    return [];
  }
  const lower = searchTerm.toLowerCase();
  return logs.filter((entry) => entry.content.toLowerCase().includes(lower));
}

/**
 * Reference implementation for time range filtering.
 */
function oracleFilterByTimeRange(logs: LogEntry[], range: TimeRange): LogEntry[] {
  if (range === 'all') {
    return logs;
  }
  const sinceMs = getTimeSince(range) * 1000;
  return logs.filter((entry) => entry.timestamp.getTime() >= sinceMs);
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Log Filtering Correctness Property Tests', () => {
  describe('filterLogs - search term filtering', () => {
    it('Property 5.1: filterLogs returns exactly entries whose content contains the search term (case-insensitive)', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          searchTermArb,
          (logs, searchTerm) => {
            const result = logViewer.filterLogs(logs, searchTerm);
            const expected = oracleFilterLogs(logs, searchTerm);

            expect(result).toHaveLength(expected.length);
            expect(result).toEqual(expected);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.2: filterLogs is case-insensitive — same results regardless of search term case', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          searchTermArb,
          (logs, searchTerm) => {
            const lowerResult = logViewer.filterLogs(logs, searchTerm.toLowerCase());
            const upperResult = logViewer.filterLogs(logs, searchTerm.toUpperCase());
            const mixedResult = logViewer.filterLogs(logs, searchTerm);

            // All case variants should return the same set of entries
            expect(lowerResult).toHaveLength(upperResult.length);
            expect(lowerResult).toHaveLength(mixedResult.length);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.3: filterLogs returns empty array for search terms outside valid length (0 or >200 chars)', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          fc.constantFrom('', 'x'.repeat(201), 'y'.repeat(250)),
          (logs, invalidTerm) => {
            const result = logViewer.filterLogs(logs, invalidTerm);
            expect(result).toEqual([]);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Property 5.4: filterLogs result is always a subset of the input preserving order', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          searchTermArb,
          (logs, searchTerm) => {
            const result = logViewer.filterLogs(logs, searchTerm);

            // Every result entry must be in the original list
            let lastIdx = -1;
            for (const entry of result) {
              const idx = logs.indexOf(entry, lastIdx + 1);
              expect(idx).toBeGreaterThan(lastIdx);
              lastIdx = idx;
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.5: if search term is a substring of entry content, entry is included in results', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          fc.integer({ min: 0, max: 49 }),
          (logs, entryIdx) => {
            // Pick a valid entry from the array
            const idx = entryIdx % logs.length;
            const entry = logs[idx];
            // Extract a substring from the content (at least 1 char) to use as search
            if (entry.content.length >= 1) {
              const startPos = Math.floor(entry.content.length / 3);
              const endPos = Math.min(startPos + 5, entry.content.length);
              const term = entry.content.substring(startPos, endPos);
              if (term.length >= 1 && term.length <= 200) {
                const result = logViewer.filterLogs(logs, term);
                // The entry must appear in the results
                expect(result).toContain(entry);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('filterByTimeRange - time range filtering', () => {
    it('Property 5.6: filterByTimeRange returns exactly entries within the specified time range', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          timeRangeArb,
          (logs, range) => {
            const result = logViewer.filterByTimeRange(logs, range);
            const expected = oracleFilterByTimeRange(logs, range);

            expect(result).toHaveLength(expected.length);
            expect(result).toEqual(expected);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.7: filterByTimeRange with "all" returns the full input array unchanged', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          (logs) => {
            const result = logViewer.filterByTimeRange(logs, 'all');
            expect(result).toEqual(logs);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.8: time range results are monotonically more inclusive as range widens', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          (logs) => {
            const result1h = logViewer.filterByTimeRange(logs, '1h');
            const result6h = logViewer.filterByTimeRange(logs, '6h');
            const result24h = logViewer.filterByTimeRange(logs, '24h');
            const resultAll = logViewer.filterByTimeRange(logs, 'all');

            // Wider ranges must include at least as many entries
            expect(result6h.length).toBeGreaterThanOrEqual(result1h.length);
            expect(result24h.length).toBeGreaterThanOrEqual(result6h.length);
            expect(resultAll.length).toBeGreaterThanOrEqual(result24h.length);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.9: filterByTimeRange result preserves original ordering', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          timeRangeArb,
          (logs, range) => {
            const result = logViewer.filterByTimeRange(logs, range);

            // Results must appear in the same order as in the original array
            let lastIdx = -1;
            for (const entry of result) {
              const idx = logs.indexOf(entry, lastIdx + 1);
              expect(idx).toBeGreaterThan(lastIdx);
              lastIdx = idx;
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Property 5.10: entries in filterByTimeRange result all have timestamps >= the range threshold', () => {
      fc.assert(
        fc.property(
          logEntriesArb,
          timeRangeArb,
          (logs, range) => {
            const result = logViewer.filterByTimeRange(logs, range);

            if (range !== 'all') {
              const sinceMs = getTimeSince(range) * 1000;
              for (const entry of result) {
                expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(sinceMs);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
