/**
 * Audit Logger Module
 *
 * Provides comprehensive, immutable activity logging with full-text search,
 * pagination, export, retention purging, and storage monitoring.
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string;
  actionType: string;
  targetResource: string;
  details: Record<string, any>;
  sourceIp: string;
  projectId?: string;
  result: 'success' | 'failure';
}

export interface AuditRecord extends AuditEntry {
  id: string;
  timestamp: Date;
}

export interface AuditFilter {
  startDate?: Date;
  endDate?: Date;
  actor?: string;
  actionType?: string;
  targetResource?: string;
  projectId?: string;
  result?: 'success' | 'failure';
  page?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface StorageInfo {
  usedBytes: number;
  maxBytes: number;
  usagePercent: number;
  alertThresholdPercent: number;
  isNearCapacity: boolean;
}

export interface AuditLoggerConfig {
  /** Retention period in days. Default: 365 */
  retentionDays?: number;
  /** Maximum storage in bytes. Default: 1GB */
  maxStorageBytes?: number;
  /** Alert threshold percentage. Default: 90 */
  alertThresholdPercent?: number;
  /** Purge interval in milliseconds. Default: 24 hours */
  purgeIntervalMs?: number;
  /** Callback invoked when storage exceeds threshold */
  onStorageAlert?: (info: StorageInfo) => void;
}

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
  query(filter: AuditFilter): Promise<PaginatedResult<AuditRecord>>;
  search(term: string, filter?: AuditFilter): Promise<PaginatedResult<AuditRecord>>;
  export(filter: AuditFilter, format: 'json' | 'csv'): Promise<Buffer>;
  getStorageUsage(): Promise<StorageInfo>;
  /** Start the background retention purge scheduler */
  startPurgeScheduler(): void;
  /** Stop the background retention purge scheduler */
  stopPurgeScheduler(): void;
  /** Run retention purge immediately (for testing/manual trigger) */
  purgeExpiredEntries(): number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024; // 1GB
const DEFAULT_ALERT_THRESHOLD_PERCENT = 90;
const DEFAULT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── FTS5 Triggers SQL ─────────────────────────────────────────────────────────

/**
 * SQL statements to create triggers that sync audit_log inserts to audit_log_fts.
 * These ensure FTS5 is always up-to-date without manual intervention.
 */
export const FTS5_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN
  INSERT INTO audit_log_fts(rowid, action_type, target_resource, details)
  VALUES (new.rowid, new.action_type, new.target_resource, new.details);
END;
`;

// ─── Implementation ────────────────────────────────────────────────────────────

export function createAuditLogger(
  db: Database.Database,
  dbPath: string,
  config?: AuditLoggerConfig
): AuditLogger {
  const retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxStorageBytes = config?.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
  const alertThresholdPercent = config?.alertThresholdPercent ?? DEFAULT_ALERT_THRESHOLD_PERCENT;
  const purgeIntervalMs = config?.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
  const onStorageAlert = config?.onStorageAlert;

  let purgeTimer: ReturnType<typeof setInterval> | null = null;

  // Ensure FTS5 triggers exist
  ensureFtsTriggers(db);

  // Prepared statements for performance
  const insertStmt = db.prepare(`
    INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, project_id, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM audit_log`);

  // ─── log ───────────────────────────────────────────────────────────────────

  async function log(entry: AuditEntry): Promise<void> {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const details = JSON.stringify(entry.details);

    insertStmt.run(
      id,
      timestamp,
      entry.actor,
      entry.actionType,
      entry.targetResource,
      details,
      entry.sourceIp,
      entry.projectId ?? null,
      entry.result
    );
  }

  // ─── query ─────────────────────────────────────────────────────────────────

  async function query(filter: AuditFilter): Promise<PaginatedResult<AuditRecord>> {
    const { whereClause, params } = buildWhereClause(filter);
    const page = Math.max(1, filter.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const countSql = `SELECT COUNT(*) as total FROM audit_log ${whereClause}`;
    const countRow = db.prepare(countSql).get(...params) as { total: number };
    const total = countRow.total;

    const dataSql = `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(...params, PAGE_SIZE, offset) as RawAuditRow[];

    return {
      data: rows.map(rowToRecord),
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  // ─── search ────────────────────────────────────────────────────────────────

  async function search(
    term: string,
    filter?: AuditFilter
  ): Promise<PaginatedResult<AuditRecord>> {
    const page = Math.max(1, filter?.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    // Build additional filter conditions for audit_log table
    const { whereClause: additionalWhere, params: filterParams } = buildWhereClause(filter ?? {}, 'al');

    // Use FTS5 MATCH to find matching rowids, then join with audit_log
    const ftsCondition = `audit_log_fts MATCH ?`;
    const sanitizedTerm = sanitizeFtsQuery(term);

    let joinWhere = `WHERE al.rowid IN (SELECT rowid FROM audit_log_fts WHERE ${ftsCondition})`;
    if (additionalWhere) {
      // Strip leading WHERE from additionalWhere and append
      const extraConditions = additionalWhere.replace(/^\s*WHERE\s+/i, '');
      joinWhere += ` AND ${extraConditions}`;
    }

    const countSql = `SELECT COUNT(*) as total FROM audit_log al ${joinWhere}`;
    const countRow = db.prepare(countSql).get(sanitizedTerm, ...filterParams) as { total: number };
    const total = countRow.total;

    const dataSql = `SELECT al.* FROM audit_log al ${joinWhere} ORDER BY al.timestamp DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(sanitizedTerm, ...filterParams, PAGE_SIZE, offset) as RawAuditRow[];

    return {
      data: rows.map(rowToRecord),
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  // ─── export ────────────────────────────────────────────────────────────────

  async function exportData(
    filter: AuditFilter,
    format: 'json' | 'csv'
  ): Promise<Buffer> {
    const { whereClause, params } = buildWhereClause(filter);
    const sql = `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC`;
    const rows = db.prepare(sql).all(...params) as RawAuditRow[];
    const records = rows.map(rowToRecord);

    if (format === 'json') {
      return Buffer.from(JSON.stringify(records, null, 2), 'utf-8');
    }

    // CSV format
    const headers = [
      'id',
      'timestamp',
      'actor',
      'actionType',
      'targetResource',
      'details',
      'sourceIp',
      'projectId',
      'result',
    ];
    const csvLines: string[] = [headers.join(',')];

    for (const record of records) {
      const row = [
        escapeCsvField(record.id),
        escapeCsvField(record.timestamp.toISOString()),
        escapeCsvField(record.actor),
        escapeCsvField(record.actionType),
        escapeCsvField(record.targetResource),
        escapeCsvField(JSON.stringify(record.details)),
        escapeCsvField(record.sourceIp),
        escapeCsvField(record.projectId ?? ''),
        escapeCsvField(record.result),
      ];
      csvLines.push(row.join(','));
    }

    return Buffer.from(csvLines.join('\n'), 'utf-8');
  }

  // ─── getStorageUsage ───────────────────────────────────────────────────────

  async function getStorageUsage(): Promise<StorageInfo> {
    let usedBytes = 0;

    try {
      const resolvedPath = path.resolve(dbPath);
      const stat = fs.statSync(resolvedPath);
      usedBytes = stat.size;

      // Also check WAL and SHM files
      const walPath = resolvedPath + '-wal';
      const shmPath = resolvedPath + '-shm';
      if (fs.existsSync(walPath)) {
        usedBytes += fs.statSync(walPath).size;
      }
      if (fs.existsSync(shmPath)) {
        usedBytes += fs.statSync(shmPath).size;
      }
    } catch {
      // If we can't read the file, report 0
    }

    const usagePercent = maxStorageBytes > 0 ? (usedBytes / maxStorageBytes) * 100 : 0;
    const isNearCapacity = usagePercent >= alertThresholdPercent;

    return {
      usedBytes,
      maxBytes: maxStorageBytes,
      usagePercent: Math.round(usagePercent * 100) / 100,
      alertThresholdPercent,
      isNearCapacity,
    };
  }

  // ─── purgeExpiredEntries ───────────────────────────────────────────────────

  function purgeExpiredEntries(): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffIso = cutoffDate.toISOString();

    // Delete from FTS first (using rowids that will be deleted)
    const rowidsToDelete = db
      .prepare(`SELECT rowid FROM audit_log WHERE timestamp < ?`)
      .all(cutoffIso) as { rowid: number }[];

    if (rowidsToDelete.length === 0) return 0;

    const deleteTransaction = db.transaction(() => {
      // Delete from FTS
      for (const { rowid } of rowidsToDelete) {
        db.prepare(`DELETE FROM audit_log_fts WHERE rowid = ?`).run(rowid);
      }

      // Delete from main table
      const result = db
        .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
        .run(cutoffIso);

      return result.changes;
    });

    return deleteTransaction();
  }

  // ─── Purge Scheduler ───────────────────────────────────────────────────────

  function startPurgeScheduler(): void {
    if (purgeTimer) return;

    purgeTimer = setInterval(async () => {
      purgeExpiredEntries();

      // Check storage usage and alert if needed
      const usage = await getStorageUsage();
      if (usage.isNearCapacity && onStorageAlert) {
        onStorageAlert(usage);
      }
    }, purgeIntervalMs);

    // Don't prevent Node.js from exiting
    if (purgeTimer.unref) {
      purgeTimer.unref();
    }
  }

  function stopPurgeScheduler(): void {
    if (purgeTimer) {
      clearInterval(purgeTimer);
      purgeTimer = null;
    }
  }

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    log,
    query,
    search,
    export: exportData,
    getStorageUsage,
    startPurgeScheduler,
    stopPurgeScheduler,
    purgeExpiredEntries,
  };
}

// ─── Internal Helpers ──────────────────────────────────────────────────────────

interface RawAuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action_type: string;
  target_resource: string;
  details: string | null;
  source_ip: string | null;
  project_id: string | null;
  result: string;
}

function rowToRecord(row: RawAuditRow): AuditRecord {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    actor: row.actor,
    actionType: row.action_type,
    targetResource: row.target_resource,
    details: row.details ? JSON.parse(row.details) : {},
    sourceIp: row.source_ip ?? '',
    projectId: row.project_id ?? undefined,
    result: row.result as 'success' | 'failure',
  };
}

function buildWhereClause(
  filter: AuditFilter,
  tableAlias?: string
): { whereClause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  const prefix = tableAlias ? `${tableAlias}.` : '';

  if (filter.startDate) {
    conditions.push(`${prefix}timestamp >= ?`);
    params.push(filter.startDate.toISOString());
  }

  if (filter.endDate) {
    conditions.push(`${prefix}timestamp <= ?`);
    params.push(filter.endDate.toISOString());
  }

  if (filter.actor) {
    conditions.push(`${prefix}actor = ?`);
    params.push(filter.actor);
  }

  if (filter.actionType) {
    conditions.push(`${prefix}action_type = ?`);
    params.push(filter.actionType);
  }

  if (filter.targetResource) {
    conditions.push(`${prefix}target_resource = ?`);
    params.push(filter.targetResource);
  }

  if (filter.projectId) {
    conditions.push(`${prefix}project_id = ?`);
    params.push(filter.projectId);
  }

  if (filter.result) {
    conditions.push(`${prefix}result = ?`);
    params.push(filter.result);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

/**
 * Sanitize an FTS5 query term to prevent syntax errors.
 * Wraps each word in double quotes for exact matching.
 */
function sanitizeFtsQuery(term: string): string {
  // Remove special FTS5 syntax characters and wrap words in quotes
  const cleaned = term.replace(/["\*\(\)]/g, '').trim();
  if (!cleaned) return '""';

  // Split into words and quote each for safe matching
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return `"${words[0]}"`;
  }

  // Multiple words: use OR to match any
  return words.map((w) => `"${w}"`).join(' OR ');
}

/**
 * Escape a field value for CSV output.
 */
function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Ensure FTS5 triggers are installed on the audit_log table.
 * This is idempotent — safe to call multiple times.
 */
export function ensureFtsTriggers(db: Database.Database): void {
  db.exec(FTS5_TRIGGER_SQL);
}
