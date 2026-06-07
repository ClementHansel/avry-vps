/**
 * Property 19: Audit log query correctness
 *
 * Tests that for any set of audit entries and any combination of filters
 * and search terms, the query returns exactly matching entries.
 *
 * **Validates: Requirements 27.3, 27.4, 27.5**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/index';
import {
  createAuditLogger,
  type AuditEntry,
  type AuditFilter,
  type AuditLogger,
} from '../../src/modules/audit-logger';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-filter-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string, db: Database.Database): void {
  db.close();
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

const actorArb = fc.stringOf(fc.constantFrom('admin', 'system', 'user1', 'user2', 'deployer'), {
  minLength: 1,
  maxLength: 1,
}).map((_) => _); // map to force re-evaluation
const actorPoolArb = fc.constantFrom('admin', 'system', 'user1', 'user2', 'deployer');

const actionTypeArb = fc.constantFrom(
  'container.start',
  'container.stop',
  'container.restart',
  'file.edit',
  'domain.add',
  'domain.delete',
  'backup.trigger',
  'login',
  'logout'
);

const targetResourceArb = fc.constantFrom(
  'container/nginx',
  'container/postgres',
  'file/config.yml',
  'domain/example.com',
  'backup/daily',
  'user/admin'
);

const resultArb = fc.constantFrom('success' as const, 'failure' as const);

const projectIdArb = fc.option(
  fc.constantFrom('proj-alpha', 'proj-beta', 'proj-gamma'),
  { nil: undefined }
);

const sourceIpArb = fc.constantFrom(
  '192.168.1.1',
  '10.0.0.1',
  '172.16.0.5',
  '127.0.0.1'
);

/**
 * Generate a date within a constrained range for testing date-range filters.
 * We use dates between 2024-01-01 and 2024-01-31 to keep filter ranges meaningful.
 */
const timestampArb = fc.integer({ min: 1704067200000, max: 1706745600000 }).map(
  (ms) => new Date(ms)
);

interface TestAuditEntry extends AuditEntry {
  _timestamp: Date;
}

const auditEntryArb: fc.Arbitrary<TestAuditEntry> = fc.record({
  actor: actorPoolArb,
  actionType: actionTypeArb,
  targetResource: targetResourceArb,
  details: fc.constant({}),
  sourceIp: sourceIpArb,
  projectId: projectIdArb,
  result: resultArb,
  _timestamp: timestampArb,
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 19: Audit log query correctness', () => {
  let dbPath: string;
  let db: Database.Database;
  let logger: AuditLogger;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    logger = createAuditLogger(db, dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath, db);
  });

  /**
   * Helper: Insert entries directly with controlled timestamps.
   * We bypass the logger.log() method to set precise timestamps for filter testing.
   */
  function insertEntries(entries: TestAuditEntry[]): void {
    const stmt = db.prepare(`
      INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, project_id, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction((items: TestAuditEntry[]) => {
      for (let i = 0; i < items.length; i++) {
        const entry = items[i];
        stmt.run(
          `entry-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          entry._timestamp.toISOString(),
          entry.actor,
          entry.actionType,
          entry.targetResource,
          JSON.stringify(entry.details),
          entry.sourceIp,
          entry.projectId ?? null,
          entry.result
        );
      }
    });

    insertAll(entries);
  }

  /**
   * Reference filter: determines which entries match a given filter.
   */
  function matchesFilter(entry: TestAuditEntry, filter: AuditFilter): boolean {
    if (filter.startDate && entry._timestamp < filter.startDate) return false;
    if (filter.endDate && entry._timestamp > filter.endDate) return false;
    if (filter.actor && entry.actor !== filter.actor) return false;
    if (filter.actionType && entry.actionType !== filter.actionType) return false;
    if (filter.targetResource && entry.targetResource !== filter.targetResource) return false;
    if (filter.projectId && entry.projectId !== filter.projectId) return false;
    if (filter.result && entry.result !== filter.result) return false;
    return true;
  }

  it('query with actor filter returns exactly matching entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 30 }),
        actorPoolArb,
        async (entries, filterActor) => {
          // Fresh DB for each run
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = { actor: filterActor, page: 1 };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            // Total count should match
            if (result.total !== expected.length) {
              return false;
            }

            // Every returned entry should have the correct actor
            for (const record of result.data) {
              if (record.actor !== filterActor) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with actionType filter returns exactly matching entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 30 }),
        actionTypeArb,
        async (entries, filterActionType) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = { actionType: filterActionType, page: 1 };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            if (result.total !== expected.length) {
              return false;
            }

            for (const record of result.data) {
              if (record.actionType !== filterActionType) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with result filter returns exactly matching entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 30 }),
        resultArb,
        async (entries, filterResult) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = { result: filterResult, page: 1 };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            if (result.total !== expected.length) {
              return false;
            }

            for (const record of result.data) {
              if (record.result !== filterResult) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with date range filter returns only entries within range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 30 }),
        // Generate two timestamps and use them as start/end range
        timestampArb,
        timestampArb,
        async (entries, date1, date2) => {
          const startDate = date1 < date2 ? date1 : date2;
          const endDate = date1 < date2 ? date2 : date1;

          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = { startDate, endDate, page: 1 };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            if (result.total !== expected.length) {
              return false;
            }

            // Every returned record should be within range
            for (const record of result.data) {
              if (record.timestamp < startDate || record.timestamp > endDate) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with projectId filter returns only entries for that project', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 30 }),
        fc.constantFrom('proj-alpha', 'proj-beta', 'proj-gamma'),
        async (entries, filterProjectId) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = { projectId: filterProjectId, page: 1 };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            if (result.total !== expected.length) {
              return false;
            }

            for (const record of result.data) {
              if (record.projectId !== filterProjectId) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with combined filters returns intersection of all filter criteria', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 5, maxLength: 40 }),
        actorPoolArb,
        actionTypeArb,
        resultArb,
        async (entries, filterActor, filterActionType, filterResult) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const filter: AuditFilter = {
              actor: filterActor,
              actionType: filterActionType,
              result: filterResult,
              page: 1,
            };
            const result = await localLogger.query(filter);

            const expected = entries.filter((e) => matchesFilter(e, filter));

            if (result.total !== expected.length) {
              return false;
            }

            for (const record of result.data) {
              if (
                record.actor !== filterActor ||
                record.actionType !== filterActionType ||
                record.result !== filterResult
              ) {
                return false;
              }
            }

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('query with no filters returns all entries with correct total', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 0, maxLength: 30 }),
        async (entries) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const result = await localLogger.query({ page: 1 });

            return result.total === entries.length;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('search with term matches entries containing the term in action_type or target_resource', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 1, maxLength: 20 }),
        // Pick a search term that exists in our domain vocabulary
        fc.constantFrom('container', 'file', 'domain', 'backup', 'login', 'logout'),
        async (entries, searchTerm) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const result = await localLogger.search(searchTerm);

            // Every returned result should contain the search term somewhere
            // in action_type or target_resource (FTS5 indexes these)
            for (const record of result.data) {
              const matchesActionType = record.actionType
                .toLowerCase()
                .includes(searchTerm.toLowerCase());
              const matchesTarget = record.targetResource
                .toLowerCase()
                .includes(searchTerm.toLowerCase());

              if (!matchesActionType && !matchesTarget) {
                return false;
              }
            }

            // Count entries that should match (reference implementation)
            const expectedMatching = entries.filter((e) => {
              const matchesAction = e.actionType
                .toLowerCase()
                .includes(searchTerm.toLowerCase());
              const matchesTarget = e.targetResource
                .toLowerCase()
                .includes(searchTerm.toLowerCase());
              return matchesAction || matchesTarget;
            });

            return result.total === expectedMatching.length;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('pagination returns correct page info and respects page size of 50', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate more entries than page size to test pagination
        fc.array(auditEntryArb, { minLength: 51, maxLength: 80 }),
        fc.integer({ min: 1, max: 3 }),
        async (entries, page) => {
          const localDbPath = createTempDbPath();
          const localDb = initializeDatabase({ dbPath: localDbPath });
          const localLogger = createAuditLogger(localDb, localDbPath);

          try {
            insertEntriesLocal(localDb, entries);

            const result = await localLogger.query({ page });

            // Total should match all entries
            if (result.total !== entries.length) return false;

            // Page size is 50
            if (result.pageSize !== 50) return false;

            // Current page matches requested page
            if (result.page !== page) return false;

            // Total pages should be ceil(total / 50)
            const expectedTotalPages = Math.ceil(entries.length / 50);
            if (result.totalPages !== expectedTotalPages) return false;

            // Data length should be min(50, remaining entries)
            const expectedDataLength = Math.min(50, entries.length - (page - 1) * 50);
            if (expectedDataLength > 0 && result.data.length !== expectedDataLength) return false;

            return true;
          } finally {
            cleanupDb(localDbPath, localDb);
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});

// ─── Shared Helper for inserting entries with controlled timestamps ────────────

function insertEntriesLocal(db: Database.Database, entries: TestAuditEntry[]): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, project_id, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((items: TestAuditEntry[]) => {
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      stmt.run(
        `entry-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        entry._timestamp.toISOString(),
        entry.actor,
        entry.actionType,
        entry.targetResource,
        JSON.stringify(entry.details),
        entry.sourceIp,
        entry.projectId ?? null,
        entry.result
      );
    }
  });

  insertAll(entries);
}

interface TestAuditEntry extends AuditEntry {
  _timestamp: Date;
}
