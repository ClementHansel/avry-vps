/**
 * Database Module
 *
 * SQLite database initialization with better-sqlite3.
 * Implements schema creation, WAL mode, migration runner, and health check.
 */
import Database from 'better-sqlite3';
export interface DatabaseConfig {
    /** Path to the SQLite database file. Defaults to DB_PATH env or ./data/panel.db */
    dbPath?: string;
    /** Enable WAL mode for better concurrent read performance. Default: true */
    walMode?: boolean;
    /** Enable verbose logging. Default: false */
    verbose?: boolean;
}
export interface HealthCheckResult {
    healthy: boolean;
    latencyMs: number;
    walMode: boolean;
    error?: string;
}
/** Current schema version. Increment when schema changes. */
export declare const SCHEMA_VERSION = 1;
/**
 * Get the resolved database file path from config or environment.
 */
export declare function getDbPath(config?: DatabaseConfig): string;
/**
 * The full schema SQL statements to create all tables.
 */
export declare const SCHEMA_SQL = "\n-- Projects\nCREATE TABLE IF NOT EXISTS projects (\n  id TEXT PRIMARY KEY,\n  name TEXT UNIQUE NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Project-Resource associations\nCREATE TABLE IF NOT EXISTS project_resources (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  resource_type TEXT NOT NULL,\n  resource_id TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  UNIQUE(project_id, resource_type, resource_id)\n);\n\n-- Job Queue\nCREATE TABLE IF NOT EXISTS jobs (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,\n  status TEXT NOT NULL DEFAULT 'queued',\n  priority INTEGER DEFAULT 0,\n  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  started_at DATETIME,\n  completed_at DATETIME,\n  exit_code INTEGER,\n  log_path TEXT,\n  metadata TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);\nCREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);\nCREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);\n\n-- Build Pipeline Configurations\nCREATE TABLE IF NOT EXISTS pipeline_configs (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  repo_url TEXT NOT NULL,\n  auth_method TEXT NOT NULL,\n  auth_credential_encrypted TEXT NOT NULL,\n  branch TEXT NOT NULL DEFAULT 'main',\n  dockerfile_path TEXT NOT NULL DEFAULT './Dockerfile',\n  build_context TEXT NOT NULL DEFAULT '.',\n  build_args TEXT,\n  tag_format TEXT DEFAULT '{project}:latest',\n  target_container TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Webhook Configurations\nCREATE TABLE IF NOT EXISTS webhook_configs (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  token TEXT UNIQUE NOT NULL,\n  secret TEXT,\n  trigger_branch TEXT NOT NULL DEFAULT 'main',\n  enabled INTEGER DEFAULT 1,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Webhook Events\nCREATE TABLE IF NOT EXISTS webhook_events (\n  id TEXT PRIMARY KEY,\n  webhook_id TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  source_ip TEXT,\n  branch TEXT,\n  validation_result TEXT,\n  triggered_action TEXT,\n  response_code INTEGER\n);\n\nCREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id, timestamp DESC);\n\n-- Tunnel Configurations\nCREATE TABLE IF NOT EXISTS tunnel_configs (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,\n  remote_path TEXT NOT NULL,\n  protocol TEXT NOT NULL DEFAULT 'rsync',\n  exclude_patterns TEXT,\n  post_transfer_command TEXT,\n  auth_token TEXT UNIQUE NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Tunnel Transfer History\nCREATE TABLE IF NOT EXISTS tunnel_transfers (\n  id TEXT PRIMARY KEY,\n  tunnel_id TEXT NOT NULL REFERENCES tunnel_configs(id) ON DELETE CASCADE,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  file_count INTEGER,\n  total_size INTEGER,\n  duration INTEGER,\n  status TEXT NOT NULL\n);\n\n-- CI/CD Bridge Configurations\nCREATE TABLE IF NOT EXISTS cicd_configs (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  repo_url TEXT NOT NULL,\n  branch TEXT NOT NULL DEFAULT 'main',\n  auth_method TEXT NOT NULL,\n  auth_credential_encrypted TEXT NOT NULL,\n  sync_direction TEXT NOT NULL,\n  local_path TEXT NOT NULL,\n  commit_template TEXT DEFAULT 'Auto-sync from VPS: {timestamp}',\n  author_name TEXT,\n  author_email TEXT,\n  exclude_patterns TEXT,\n  debounce_interval INTEGER DEFAULT 30,\n  pre_deploy_command TEXT,\n  post_deploy_command TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- CI/CD Sync Events\nCREATE TABLE IF NOT EXISTS cicd_sync_events (\n  id TEXT PRIMARY KEY,\n  config_id TEXT NOT NULL REFERENCES cicd_configs(id) ON DELETE CASCADE,\n  direction TEXT NOT NULL,\n  commit_sha TEXT,\n  origin TEXT NOT NULL,\n  status TEXT NOT NULL,\n  error_message TEXT,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE INDEX IF NOT EXISTS idx_cicd_events_config ON cicd_sync_events(config_id, timestamp DESC);\n\n-- Domain Configurations\nCREATE TABLE IF NOT EXISTS domains (\n  id TEXT PRIMARY KEY,\n  domain TEXT UNIQUE NOT NULL,\n  proxy_target TEXT NOT NULL,\n  ssl_enabled INTEGER DEFAULT 0,\n  headers TEXT,\n  websocket_upgrade INTEGER DEFAULT 0,\n  active INTEGER DEFAULT 1,\n  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- SSL Certificates\nCREATE TABLE IF NOT EXISTS certificates (\n  id TEXT PRIMARY KEY,\n  domain TEXT NOT NULL REFERENCES domains(domain) ON DELETE CASCADE,\n  issuer TEXT NOT NULL,\n  expiry_date DATETIME NOT NULL,\n  renewal_status TEXT NOT NULL,\n  cert_path TEXT NOT NULL,\n  key_path TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Backup Configurations\nCREATE TABLE IF NOT EXISTS backup_schedules (\n  id TEXT PRIMARY KEY,\n  frequency TEXT NOT NULL,\n  targets TEXT NOT NULL,\n  storage_type TEXT NOT NULL,\n  storage_config TEXT,\n  retention_count INTEGER DEFAULT 7,\n  enabled INTEGER DEFAULT 1,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Backup History\nCREATE TABLE IF NOT EXISTS backups (\n  id TEXT PRIMARY KEY,\n  schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  size INTEGER,\n  targets TEXT NOT NULL,\n  storage_type TEXT NOT NULL,\n  storage_path TEXT NOT NULL,\n  status TEXT NOT NULL\n);\n\n-- Alert Rules\nCREATE TABLE IF NOT EXISTS alert_rules (\n  id TEXT PRIMARY KEY,\n  resource_type TEXT NOT NULL,\n  threshold REAL,\n  consecutive_checks INTEGER DEFAULT 3,\n  enabled INTEGER DEFAULT 1,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Alert Channels\nCREATE TABLE IF NOT EXISTS alert_channels (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  config TEXT NOT NULL,\n  enabled INTEGER DEFAULT 1,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Alert History\nCREATE TABLE IF NOT EXISTS alerts (\n  id TEXT PRIMARY KEY,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  event_type TEXT NOT NULL,\n  affected_resource TEXT NOT NULL,\n  severity TEXT NOT NULL,\n  delivery_status TEXT,\n  message TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);\n\n-- Firewall Rules\nCREATE TABLE IF NOT EXISTS firewall_rules (\n  id TEXT PRIMARY KEY,\n  port INTEGER NOT NULL,\n  protocol TEXT NOT NULL DEFAULT 'tcp',\n  source TEXT NOT NULL DEFAULT '0.0.0.0/0',\n  action TEXT NOT NULL,\n  description TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Security Scan Results\nCREATE TABLE IF NOT EXISTS security_scans (\n  id TEXT PRIMARY KEY,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  score INTEGER NOT NULL,\n  finding_count INTEGER NOT NULL,\n  findings TEXT NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_scans_timestamp ON security_scans(timestamp DESC);\n\n-- Audit Log (append-only, FTS-enabled)\nCREATE TABLE IF NOT EXISTS audit_log (\n  id TEXT PRIMARY KEY,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  actor TEXT NOT NULL,\n  action_type TEXT NOT NULL,\n  target_resource TEXT NOT NULL,\n  details TEXT,\n  source_ip TEXT,\n  project_id TEXT,\n  result TEXT NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);\nCREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);\nCREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action_type);\nCREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);\n\n-- Sessions\nCREATE TABLE IF NOT EXISTS sessions (\n  id TEXT PRIMARY KEY,\n  username TEXT NOT NULL,\n  token TEXT UNIQUE NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,\n  ip TEXT\n);\n\n-- Rate Limiting\nCREATE TABLE IF NOT EXISTS rate_limits (\n  ip TEXT PRIMARY KEY,\n  failed_attempts INTEGER DEFAULT 0,\n  first_attempt_at DATETIME,\n  locked_until DATETIME\n);\n\n-- Concurrency Limits Configuration\nCREATE TABLE IF NOT EXISTS concurrency_limits (\n  operation_type TEXT PRIMARY KEY,\n  max_concurrent INTEGER NOT NULL\n);\n\n-- Cron Jobs\nCREATE TABLE IF NOT EXISTS cron_jobs (\n  id TEXT PRIMARY KEY,\n  expression TEXT NOT NULL,\n  command TEXT NOT NULL,\n  user TEXT NOT NULL DEFAULT 'root',\n  enabled INTEGER DEFAULT 1,\n  description TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Cron Executions\nCREATE TABLE IF NOT EXISTS cron_executions (\n  id TEXT PRIMARY KEY,\n  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,\n  exit_code INTEGER,\n  output TEXT\n);\n\n-- Schema version tracking\nCREATE TABLE IF NOT EXISTS schema_migrations (\n  version INTEGER PRIMARY KEY,\n  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  description TEXT\n);\n";
/**
 * Initialize the database connection and apply schema.
 * Returns the database instance ready for use.
 */
export declare function initializeDatabase(config?: DatabaseConfig): Database.Database;
/**
 * Apply database schema migrations.
 * Uses a simple version-based approach — checks current version and applies pending migrations.
 */
export declare function applyMigrations(db: Database.Database): void;
/**
 * Get the current schema version from the database.
 */
export declare function getCurrentSchemaVersion(db: Database.Database): number;
/**
 * Check database health by running a simple query and verifying WAL mode.
 */
export declare function checkHealth(db: Database.Database): HealthCheckResult;
/**
 * Close the database connection gracefully.
 */
export declare function closeDatabase(db: Database.Database): void;
/**
 * Get a list of all table names in the database.
 * Useful for verification and diagnostics.
 */
export declare function listTables(db: Database.Database): string[];
//# sourceMappingURL=index.d.ts.map