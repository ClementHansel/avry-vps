/**
 * Property 20: Audit log export round-trip
 *
 * Tests that exporting to JSON and parsing back produces equivalent records
 * preserving all fields and ordering (reverse chronological).
 *
 * **Validates: Requirements 27.8**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAuditLogger, type AuditEntry, type AuditRecord } from '../../src/modules/audit-logger';
import { initializeDatabase } from '../../src/database/index';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createTempDb(): { db: Database.Database; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-export-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initializeDatabase({ dbPath, walMode: false });
  return { db, dbPath };
}

function cleanupTempDb(db: Database.Database, dbPath: string): void {
  db.close();
  const dir = path.dirname(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

const actionTypes = [
  'container.start', 'container.stop', 'container.restart', 'container.deploy',
  'file.edit', 'file.create', 'file.delete',
  'domain.add', 'domain.update', 'domain.delete',
  'ssl.provision', 'ssl.upload',
  'database.create', 'database.query', 'database.export',
  'backup.trigger', 'backup.restore',
  'cron.create', 'cron.update', 'cron.delete',
  'build.trigger', 'tunnel.push',
  'auth.login', 'auth.logout', 'auth.failed_login',
  'security.firewall_add', 'security.scan',
];

const arbActor = fc.oneof(
  fc.constantFrom('admin', 'operator', 'system', 'root'),
  fc.stringMatching(/^[a-z][a-z0-9]{2,19}$/)
);

const arbActionType = fc.constantFrom(...actionTypes);

const arbTargetResource = fc.oneof(
  fc.constant('container:nginx-proxy'),
  fc.constant('file:/opt/aivery/config.yml'),
  fc.constant('domain:panel.aivory.id'),
  fc.constant('database:main_db'),
  fc.constant('backup:schedule-1'),
  fc.stringMatching(/^[a-z0-9]{5,20}$/).map(s => `resource:${s}`)
);

const arbSourceIp = fc.ipV4();

const arbResult = fc.constantFrom('success', 'failure') as fc.Arbitrary<'success' | 'failure'>;

const arbDetails = fc.oneof(
  fc.constant({}),
  fc.record({
    oldValue: fc.string({ minLength: 1, maxLength: 50 }),
    newValue: fc.string({ minLength: 1, maxLength: 50 }),
  }),
  fc.record({
    reason: fc.string({ minLength: 1, maxLength: 100 }),
    count: fc.integer({ min: 0, max: 1000 }),
  })
);

const arbProjectId = fc.oneof(
  fc.constant(undefined),
  fc.uuid()
);

const arbAuditEntry: fc.Arbitrary<AuditEntry> = fc.record({
  actor: arbActor,
  actionType: arbActionType,
  targetResource: arbTargetResource,
  details: arbDetails,
  sourceIp: arbSourceIp,
  projectId: arbProjectId,
  result: arbResult,
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 20: Audit log export round-trip', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    const temp = createTempDb();
    db = temp.db;
    dbPath = temp.dbPath;
  });

  afterEach(() => {
    cleanupTempDb(db, dbPath);
  });

  it('exporting to JSON and parsing back preserves all fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAuditEntry, { minLength: 1, maxLength: 20 }),
        async (entries) => {
          // Clean up and reinitialize for each property run
          cleanupTempDb(db, dbPath);
          const temp = createTempDb();
          db = temp.db;
          dbPath = temp.dbPath;

          const logger = createAuditLogger(db, dbPath);

          // Insert all entries
          for (const entry of entries) {
            await logger.log(entry);
            // Small delay to ensure distinct timestamps
            await new Promise(resolve => setTimeout(resolve, 2));
          }

          // Export to JSON
          const buffer = await logger.export({}, 'json');
          const jsonString = buffer.toString('utf-8');
          const parsed: AuditRecord[] = JSON.parse(jsonString);

          // Verify count matches
          if (parsed.length !== entries.length) {
            return false;
          }

          // Verify all fields are preserved for each record
          // The export is in reverse chronological order, so the last inserted entry is first
          for (const record of parsed) {
            // Each exported record must have all required fields
            if (!record.id || typeof record.id !== 'string') return false;
            if (!record.timestamp) return false;
            if (!record.actor || typeof record.actor !== 'string') return false;
            if (!record.actionType || typeof record.actionType !== 'string') return false;
            if (!record.targetResource || typeof record.targetResource !== 'string') return false;
            if (record.details === undefined || record.details === null) return false;
            if (record.sourceIp === undefined) return false;
            if (!record.result || !['success', 'failure'].includes(record.result)) return false;
          }

          // Verify that each input entry has a matching record in the output
          for (const entry of entries) {
            const match = parsed.find(
              r =>
                r.actor === entry.actor &&
                r.actionType === entry.actionType &&
                r.targetResource === entry.targetResource &&
                r.result === entry.result &&
                r.sourceIp === entry.sourceIp &&
                JSON.stringify(r.details) === JSON.stringify(entry.details) &&
                (entry.projectId === undefined
                  ? r.projectId === undefined || r.projectId === null
                  : r.projectId === entry.projectId)
            );
            if (!match) return false;
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('exported JSON maintains reverse chronological ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAuditEntry, { minLength: 2, maxLength: 15 }),
        async (entries) => {
          // Clean up and reinitialize for each property run
          cleanupTempDb(db, dbPath);
          const temp = createTempDb();
          db = temp.db;
          dbPath = temp.dbPath;

          const logger = createAuditLogger(db, dbPath);

          // Insert entries with small delays for distinct timestamps
          for (const entry of entries) {
            await logger.log(entry);
            await new Promise(resolve => setTimeout(resolve, 2));
          }

          // Export to JSON
          const buffer = await logger.export({}, 'json');
          const jsonString = buffer.toString('utf-8');
          const parsed: AuditRecord[] = JSON.parse(jsonString);

          // Verify reverse chronological ordering (each timestamp >= next)
          for (let i = 0; i < parsed.length - 1; i++) {
            const currentTs = new Date(parsed[i].timestamp).getTime();
            const nextTs = new Date(parsed[i + 1].timestamp).getTime();
            if (currentTs < nextTs) {
              return false;
            }
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});
