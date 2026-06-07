/**
 * Environment Configuration Module
 *
 * Centralized environment variable validation and typed access.
 * Validates all required environment variables on startup and fails
 * with non-zero exit code and clear error message if required vars are missing.
 *
 * Requirements: 8.3, 8.5, 6.5
 */

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface EnvConfig {
  /** HTTP port the panel listens on */
  PORT: number;
  /** JWT secret for Supabase auth token validation */
  SUPABASE_JWT_SECRET: string;
  /** Docker daemon host (socket path or tcp://...) */
  DOCKER_HOST: string;
  /** Deployment environment: development, staging, production */
  ENVIRONMENT: string;
  /** Allowed CORS origins */
  CORS_ORIGINS: string[];
  /** SQLite database file path */
  DB_PATH: string;
  /** Admin username for login */
  ADMIN_USERNAME: string;
  /** Admin password for login (required in production) */
  ADMIN_PASSWORD: string;
  /** Whether TLS is configured (enables HTTPS redirect) */
  TLS_ENABLED: boolean;
  /** SMTP host for email alerts */
  SMTP_HOST: string;
  /** SMTP port for email alerts */
  SMTP_PORT: number;
  /** SMTP username */
  SMTP_USER: string;
  /** SMTP password */
  SMTP_PASS: string;
  /** Webhook URL for alert delivery (Slack/Discord) */
  ALERT_WEBHOOK_URL: string;
  /** S3-compatible endpoint for backups */
  BACKUP_S3_ENDPOINT: string;
  /** S3 bucket name for backups */
  BACKUP_S3_BUCKET: string;
  /** S3 access key for backups */
  BACKUP_S3_ACCESS_KEY: string;
  /** S3 secret key for backups */
  BACKUP_S3_SECRET_KEY: string;
  /** Panel subdomain (used in Nginx config) */
  PANEL_DOMAIN: string;
}

// ─── Required Variables ────────────────────────────────────────────────────────

const REQUIRED_VARS = ['PORT', 'SUPABASE_JWT_SECRET', 'ENVIRONMENT'] as const;

// DOCKER_HOST defaults to /var/run/docker.sock if not set

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates all required environment variables and returns a typed config object.
 * Exits the process with code 1 if any required variable is missing.
 */
export function validateEnv(): EnvConfig {
  const missing: string[] = [];

  for (const varName of REQUIRED_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    const message = `[FATAL] Missing required environment variables: ${missing.join(', ')}. ` +
      `The VPS Panel cannot start without these values. ` +
      `Please set them in your environment or .env file.`;
    console.error(message);
    process.exit(1);
  }

  const environment = process.env.ENVIRONMENT as EnvConfig['ENVIRONMENT'];

  const port = parseInt(process.env.PORT!, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(
      `[FATAL] Invalid PORT value "${process.env.PORT}". Must be a number between 1 and 65535.`
    );
    process.exit(1);
  }

  return {
    PORT: port,
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET!,
    DOCKER_HOST: process.env.DOCKER_HOST || '/var/run/docker.sock',
    ENVIRONMENT: environment,
    CORS_ORIGINS: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : ['*'],
    DB_PATH: process.env.DB_PATH || '/app/data/panel.db',
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
    TLS_ENABLED: process.env.TLS_ENABLED === 'true' || process.env.TLS_ENABLED === '1',
    SMTP_HOST: process.env.SMTP_HOST || '',
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',
    BACKUP_S3_ENDPOINT: process.env.BACKUP_S3_ENDPOINT || '',
    BACKUP_S3_BUCKET: process.env.BACKUP_S3_BUCKET || '',
    BACKUP_S3_ACCESS_KEY: process.env.BACKUP_S3_ACCESS_KEY || '',
    BACKUP_S3_SECRET_KEY: process.env.BACKUP_S3_SECRET_KEY || '',
    PANEL_DOMAIN: process.env.PANEL_DOMAIN || 'panel.aivory.id',
  };
}

/**
 * Validates environment without exiting the process.
 * Returns an array of error messages (empty if valid).
 * Useful for testing.
 */
export function validateEnvSafe(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];

  for (const varName of REQUIRED_VARS) {
    const value = env[varName];
    if (!value || value.trim() === '') {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  }

  if (env.PORT) {
    const port = parseInt(env.PORT, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push(`Invalid PORT value "${env.PORT}". Must be a number between 1 and 65535.`);
    }
  }

  return errors;
}

/**
 * Get a summary of the current configuration for logging (secrets masked).
 */
export function getConfigSummary(config: EnvConfig): Record<string, string> {
  return {
    PORT: String(config.PORT),
    ENVIRONMENT: config.ENVIRONMENT,
    DOCKER_HOST: config.DOCKER_HOST,
    DB_PATH: config.DB_PATH,
    CORS_ORIGINS: config.CORS_ORIGINS.join(', '),
    TLS_ENABLED: String(config.TLS_ENABLED),
    PANEL_DOMAIN: config.PANEL_DOMAIN,
    ADMIN_USERNAME: config.ADMIN_USERNAME,
    SUPABASE_JWT_SECRET: '***masked***',
    ADMIN_PASSWORD: config.ADMIN_PASSWORD ? '***set***' : '***not set***',
    SMTP_HOST: config.SMTP_HOST || '(not configured)',
    ALERT_WEBHOOK_URL: config.ALERT_WEBHOOK_URL || '(not configured)',
    BACKUP_S3_ENDPOINT: config.BACKUP_S3_ENDPOINT || '(not configured)',
  };
}
