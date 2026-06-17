/**
 * Routes Index
 *
 * Registers all API routers on the Express application.
 * All routes are prefixed with /api.
 * Auth middleware is applied globally to protected routes.
 * Webhook receive endpoint is excluded from auth.
 */
import type { Express } from 'express';
import type { AuthModule } from '../modules/auth.js';
import type { AuditLogger } from '../modules/audit-logger.js';
import type { ContainerManager } from '../modules/container-manager.js';
import type { FileManager } from '../modules/file-manager.js';
import type { DomainManager } from '../modules/domain-manager.js';
import type { SSLManager } from '../modules/ssl-manager.js';
import type { CronManager } from '../modules/cron-manager.js';
import type { DatabaseManager } from '../modules/database-manager.js';
import type { BackupManager } from '../modules/backup-manager.js';
import type { ProjectManager } from '../modules/project-manager.js';
import type { BuildPipeline } from '../modules/build-pipeline.js';
import type { WebhookHandler } from '../modules/webhook-handler.js';
import type { TunnelManager } from '../modules/tunnel-manager.js';
import type { CICDBridge } from '../modules/cicd-bridge.js';
import type { SecurityManager } from '../modules/security-manager.js';
import type { JobQueue } from '../modules/job-queue.js';
import type { AlertSystem } from '../modules/alert-system.js';
export interface ModuleRegistry {
    authModule: AuthModule;
    auditLogger: AuditLogger;
    containerManager: ContainerManager;
    fileManager: FileManager;
    domainManager: DomainManager;
    sslManager: SSLManager;
    cronManager: CronManager;
    databaseManager: DatabaseManager;
    backupManager: BackupManager;
    projectManager: ProjectManager;
    buildPipeline: BuildPipeline;
    webhookHandler: WebhookHandler;
    tunnelManager: TunnelManager;
    cicdBridge: CICDBridge;
    securityManager: SecurityManager;
    jobQueue: JobQueue;
    alertSystem: AlertSystem;
}
/**
 * Register all API routes on the Express app.
 */
export declare function registerRoutes(app: Express, modules: ModuleRegistry): void;
//# sourceMappingURL=index.d.ts.map