/**
 * Environment Configuration Module
 *
 * Centralized environment variable validation and typed access.
 * Validates all required environment variables on startup and fails
 * with non-zero exit code and clear error message if required vars are missing.
 *
 * Requirements: 8.3, 8.5, 6.5
 */
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
/**
 * Validates all required environment variables and returns a typed config object.
 * Exits the process with code 1 if any required variable is missing.
 */
export declare function validateEnv(): EnvConfig;
/**
 * Validates environment without exiting the process.
 * Returns an array of error messages (empty if valid).
 * Useful for testing.
 */
export declare function validateEnvSafe(env: Record<string, string | undefined>): string[];
/**
 * Get a summary of the current configuration for logging (secrets masked).
 */
export declare function getConfigSummary(config: EnvConfig): Record<string, string>;
//# sourceMappingURL=env.d.ts.map