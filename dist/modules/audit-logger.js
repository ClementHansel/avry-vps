"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FTS5_TRIGGER_SQL = void 0;
exports.createAuditLogger = createAuditLogger;
exports.ensureFtsTriggers = ensureFtsTriggers;
const uuid_1 = require("uuid");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
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
exports.FTS5_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN
  INSERT INTO audit_log_fts(rowid, action_type, target_resource, details)
  VALUES (new.rowid, new.action_type, new.target_resource, new.details);
END;
`;
// ─── Implementation ────────────────────────────────────────────────────────────
function createAuditLogger(db, dbPath, config) {
    const retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const maxStorageBytes = config?.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    const alertThresholdPercent = config?.alertThresholdPercent ?? DEFAULT_ALERT_THRESHOLD_PERCENT;
    const purgeIntervalMs = config?.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
    const onStorageAlert = config?.onStorageAlert;
    let purgeTimer = null;
    // Ensure FTS5 triggers exist
    ensureFtsTriggers(db);
    // Prepared statements for performance
    const insertStmt = db.prepare(`
    INSERT INTO audit_log (id, timestamp, actor, action_type, target_resource, details, source_ip, project_id, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM audit_log`);
    // ─── log ───────────────────────────────────────────────────────────────────
    async function log(entry) {
        const id = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        const details = JSON.stringify(entry.details);
        insertStmt.run(id, timestamp, entry.actor, entry.actionType, entry.targetResource, details, entry.sourceIp, entry.projectId ?? null, entry.result);
    }
    // ─── query ─────────────────────────────────────────────────────────────────
    async function query(filter) {
        const { whereClause, params } = buildWhereClause(filter);
        const page = Math.max(1, filter.page ?? 1);
        const offset = (page - 1) * PAGE_SIZE;
        const countSql = `SELECT COUNT(*) as total FROM audit_log ${whereClause}`;
        const countRow = db.prepare(countSql).get(...params);
        const total = countRow.total;
        const dataSql = `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        const rows = db.prepare(dataSql).all(...params, PAGE_SIZE, offset);
        return {
            data: rows.map(rowToRecord),
            total,
            page,
            pageSize: PAGE_SIZE,
            totalPages: Math.ceil(total / PAGE_SIZE),
        };
    }
    // ─── search ────────────────────────────────────────────────────────────────
    async function search(term, filter) {
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
        const countRow = db.prepare(countSql).get(sanitizedTerm, ...filterParams);
        const total = countRow.total;
        const dataSql = `SELECT al.* FROM audit_log al ${joinWhere} ORDER BY al.timestamp DESC LIMIT ? OFFSET ?`;
        const rows = db.prepare(dataSql).all(sanitizedTerm, ...filterParams, PAGE_SIZE, offset);
        return {
            data: rows.map(rowToRecord),
            total,
            page,
            pageSize: PAGE_SIZE,
            totalPages: Math.ceil(total / PAGE_SIZE),
        };
    }
    // ─── export ────────────────────────────────────────────────────────────────
    async function exportData(filter, format) {
        const { whereClause, params } = buildWhereClause(filter);
        const sql = `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC`;
        const rows = db.prepare(sql).all(...params);
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
        const csvLines = [headers.join(',')];
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
    async function getStorageUsage() {
        let usedBytes = 0;
        try {
            const resolvedPath = node_path_1.default.resolve(dbPath);
            const stat = node_fs_1.default.statSync(resolvedPath);
            usedBytes = stat.size;
            // Also check WAL and SHM files
            const walPath = resolvedPath + '-wal';
            const shmPath = resolvedPath + '-shm';
            if (node_fs_1.default.existsSync(walPath)) {
                usedBytes += node_fs_1.default.statSync(walPath).size;
            }
            if (node_fs_1.default.existsSync(shmPath)) {
                usedBytes += node_fs_1.default.statSync(shmPath).size;
            }
        }
        catch {
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
    function purgeExpiredEntries() {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffIso = cutoffDate.toISOString();
        // Delete from FTS first (using rowids that will be deleted)
        const rowidsToDelete = db
            .prepare(`SELECT rowid FROM audit_log WHERE timestamp < ?`)
            .all(cutoffIso);
        if (rowidsToDelete.length === 0)
            return 0;
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
    function startPurgeScheduler() {
        if (purgeTimer)
            return;
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
    function stopPurgeScheduler() {
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
function rowToRecord(row) {
    return {
        id: row.id,
        timestamp: new Date(row.timestamp),
        actor: row.actor,
        actionType: row.action_type,
        targetResource: row.target_resource,
        details: row.details ? JSON.parse(row.details) : {},
        sourceIp: row.source_ip ?? '',
        projectId: row.project_id ?? undefined,
        result: row.result,
    };
}
function buildWhereClause(filter, tableAlias) {
    const conditions = [];
    const params = [];
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
function sanitizeFtsQuery(term) {
    // Remove special FTS5 syntax characters and wrap words in quotes
    const cleaned = term.replace(/["\*\(\)]/g, '').trim();
    if (!cleaned)
        return '""';
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
function escapeCsvField(value) {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}
/**
 * Ensure FTS5 triggers are installed on the audit_log table.
 * This is idempotent — safe to call multiple times.
 */
function ensureFtsTriggers(db) {
    db.exec(exports.FTS5_TRIGGER_SQL);
}
//# sourceMappingURL=audit-logger.js.map