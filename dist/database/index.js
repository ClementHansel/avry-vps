"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA_SQL = exports.SCHEMA_VERSION = void 0;
exports.getDbPath = getDbPath;
exports.initializeDatabase = initializeDatabase;
exports.applyMigrations = applyMigrations;
exports.getCurrentSchemaVersion = getCurrentSchemaVersion;
exports.checkHealth = checkHealth;
exports.closeDatabase = closeDatabase;
exports.listTables = listTables;
/**
 * Database Module
 *
 * SQLite database initialization with better-sqlite3.
 * Implements schema creation, WAL mode, migration runner, and health check.
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
/** Current schema version. Increment when schema changes. */
exports.SCHEMA_VERSION = 1;
/**
 * Get the resolved database file path from config or environment.
 */
function getDbPath(config) {
    if (config?.dbPath)
        return node_path_1.default.resolve(config.dbPath);
    if (process.env.DB_PATH)
        return node_path_1.default.resolve(process.env.DB_PATH);
    return node_path_1.default.resolve('./data/panel.db');
}
/**
 * Ensure the directory for the database file exists.
 */
function ensureDirectory(filePath) {
    const dir = node_path_1.default.dirname(filePath);
    if (!node_fs_1.default.existsSync(dir)) {
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    }
}
/**
 * The full schema SQL statements to create all tables.
 */
exports.SCHEMA_SQL = `
-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Project-Resource associations
CREATE TABLE IF NOT EXISTS project_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, resource_type, resource_id)
);

-- Job Queue
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER DEFAULT 0,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  exit_code INTEGER,
  log_path TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

-- Build Pipeline Configurations
CREATE TABLE IF NOT EXISTS pipeline_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_url TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  auth_credential_encrypted TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  dockerfile_path TEXT NOT NULL DEFAULT './Dockerfile',
  build_context TEXT NOT NULL DEFAULT '.',
  build_args TEXT,
  tag_format TEXT DEFAULT '{project}:latest',
  target_container TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Webhook Configurations
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  secret TEXT,
  trigger_branch TEXT NOT NULL DEFAULT 'main',
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Webhook Events
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_ip TEXT,
  branch TEXT,
  validation_result TEXT,
  triggered_action TEXT,
  response_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id, timestamp DESC);

-- Tunnel Configurations
CREATE TABLE IF NOT EXISTS tunnel_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  remote_path TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'rsync',
  exclude_patterns TEXT,
  post_transfer_command TEXT,
  auth_token TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tunnel Transfer History
CREATE TABLE IF NOT EXISTS tunnel_transfers (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnel_configs(id) ON DELETE CASCADE,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  file_count INTEGER,
  total_size INTEGER,
  duration INTEGER,
  status TEXT NOT NULL
);

-- CI/CD Bridge Configurations
CREATE TABLE IF NOT EXISTS cicd_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  auth_method TEXT NOT NULL,
  auth_credential_encrypted TEXT NOT NULL,
  sync_direction TEXT NOT NULL,
  local_path TEXT NOT NULL,
  commit_template TEXT DEFAULT 'Auto-sync from VPS: {timestamp}',
  author_name TEXT,
  author_email TEXT,
  exclude_patterns TEXT,
  debounce_interval INTEGER DEFAULT 30,
  pre_deploy_command TEXT,
  post_deploy_command TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CI/CD Sync Events
CREATE TABLE IF NOT EXISTS cicd_sync_events (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES cicd_configs(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  commit_sha TEXT,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cicd_events_config ON cicd_sync_events(config_id, timestamp DESC);

-- Domain Configurations
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  proxy_target TEXT NOT NULL,
  ssl_enabled INTEGER DEFAULT 0,
  headers TEXT,
  websocket_upgrade INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SSL Certificates
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL REFERENCES domains(domain) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  expiry_date DATETIME NOT NULL,
  renewal_status TEXT NOT NULL,
  cert_path TEXT NOT NULL,
  key_path TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Backup Configurations
CREATE TABLE IF NOT EXISTS backup_schedules (
  id TEXT PRIMARY KEY,
  frequency TEXT NOT NULL,
  targets TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  storage_config TEXT,
  retention_count INTEGER DEFAULT 7,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Backup History
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  size INTEGER,
  targets TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL
);

-- Alert Rules
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  threshold REAL,
  consecutive_checks INTEGER DEFAULT 3,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Alert Channels
CREATE TABLE IF NOT EXISTS alert_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Alert History
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  affected_resource TEXT NOT NULL,
  severity TEXT NOT NULL,
  delivery_status TEXT,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);

-- Firewall Rules
CREATE TABLE IF NOT EXISTS firewall_rules (
  id TEXT PRIMARY KEY,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'tcp',
  source TEXT NOT NULL DEFAULT '0.0.0.0/0',
  action TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Security Scan Results
CREATE TABLE IF NOT EXISTS security_scans (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  score INTEGER NOT NULL,
  finding_count INTEGER NOT NULL,
  findings TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON security_scans(timestamp DESC);

-- Audit Log (append-only, FTS-enabled)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_resource TEXT NOT NULL,
  details TEXT,
  source_ip TEXT,
  project_id TEXT,
  result TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip TEXT
);

-- Rate Limiting
CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT PRIMARY KEY,
  failed_attempts INTEGER DEFAULT 0,
  first_attempt_at DATETIME,
  locked_until DATETIME
);

-- Concurrency Limits Configuration
CREATE TABLE IF NOT EXISTS concurrency_limits (
  operation_type TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL
);

-- Cron Jobs
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  expression TEXT NOT NULL,
  command TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT 'root',
  enabled INTEGER DEFAULT 1,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cron Executions
CREATE TABLE IF NOT EXISTS cron_executions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  exit_code INTEGER,
  output TEXT
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);
`;
/**
 * SQL for FTS5 virtual table (separated because FTS5 doesn't support IF NOT EXISTS).
 */
const FTS5_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS audit_log_fts USING fts5(
  action_type,
  target_resource,
  details,
  content=audit_log,
  content_rowid=rowid
);
`;
/**
 * Default concurrency limits to seed on first boot.
 */
const DEFAULT_CONCURRENCY_LIMITS = `
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('build', 2);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('deploy', 3);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-import', 1);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('db-export', 1);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('backup', 1);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('restore', 1);
INSERT OR IGNORE INTO concurrency_limits (operation_type, max_concurrent) VALUES ('tunnel-transfer', 2);
`;
/**
 * Initialize the database connection and apply schema.
 * Returns the database instance ready for use.
 */
function initializeDatabase(config) {
    const dbPath = getDbPath(config);
    ensureDirectory(dbPath);
    const verbose = config?.verbose ? console.log : undefined;
    const db = new better_sqlite3_1.default(dbPath, { verbose });
    // Enable WAL mode for better concurrent read performance
    if (config?.walMode !== false) {
        db.pragma('journal_mode = WAL');
    }
    // Performance pragmas
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    // Run migrations
    applyMigrations(db);
    return db;
}
/**
 * Apply database schema migrations.
 * Uses a simple version-based approach — checks current version and applies pending migrations.
 */
function applyMigrations(db) {
    // Ensure schema_migrations table exists first
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    );
  `);
    const currentVersion = getCurrentSchemaVersion(db);
    if (currentVersion < 1) {
        applyMigrationV1(db);
    }
    // Future migrations go here:
    // if (currentVersion < 2) { applyMigrationV2(db); }
}
/**
 * Get the current schema version from the database.
 */
function getCurrentSchemaVersion(db) {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get();
    return row?.version ?? 0;
}
/**
 * Migration V1: Initial schema creation.
 */
function applyMigrationV1(db) {
    db.transaction(() => {
        // Apply main schema
        db.exec(exports.SCHEMA_SQL);
        // Apply FTS5 virtual table
        db.exec(FTS5_SQL);
        // Seed default concurrency limits
        db.exec(DEFAULT_CONCURRENCY_LIMITS);
        // Record migration
        db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(1, 'Initial schema - all tables, indexes, FTS5, and default concurrency limits');
    })();
}
/**
 * Check database health by running a simple query and verifying WAL mode.
 */
function checkHealth(db) {
    const start = performance.now();
    try {
        // Run a simple integrity check query
        const row = db.prepare('SELECT 1 as ok').get();
        if (!row || row.ok !== 1) {
            return {
                healthy: false,
                latencyMs: performance.now() - start,
                walMode: false,
                error: 'Integrity check failed: unexpected result',
            };
        }
        // Check WAL mode status
        const journalMode = db.pragma('journal_mode', { simple: true });
        const walEnabled = journalMode === 'wal';
        return {
            healthy: true,
            latencyMs: performance.now() - start,
            walMode: walEnabled,
        };
    }
    catch (error) {
        return {
            healthy: false,
            latencyMs: performance.now() - start,
            walMode: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * Close the database connection gracefully.
 */
function closeDatabase(db) {
    db.close();
}
/**
 * Get a list of all table names in the database.
 * Useful for verification and diagnostics.
 */
function listTables(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return rows.map((r) => r.name);
}
//# sourceMappingURL=index.js.map