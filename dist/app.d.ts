/**
 * VPS Panel - Application Factory
 *
 * Initializes all modules in correct dependency order, wires cross-cutting concerns
 * (audit logging, alert system, job queue), and implements graceful degradation when
 * system resources are unavailable.
 *
 * Requirements: All (final integration and wiring)
 */
import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createAuthModule } from './modules/auth.js';
import { type RateLimiter } from './modules/rate-limiter.js';
import { createContainerManager } from './modules/container-manager.js';
import { createFileManager } from './modules/file-manager.js';
import { createTerminalManager } from './modules/terminal-manager.js';
import { createLogViewer } from './modules/log-viewer.js';
import { createDomainManager } from './modules/domain-manager.js';
import { createSSLManager } from './modules/ssl-manager.js';
import { createCronManager } from './modules/cron-manager.js';
import { createDatabaseManager } from './modules/database-manager.js';
import { createBackupManager } from './modules/backup-manager.js';
import { createResourceWidget } from './modules/resource-widget.js';
import { createAlertSystem } from './modules/alert-system.js';
import { createAuditLogger } from './modules/audit-logger.js';
import { createProjectManager } from './modules/project-manager.js';
import { createJobQueue } from './modules/job-queue.js';
import { createBuildPipeline } from './modules/build-pipeline.js';
import { createWebhookHandler } from './modules/webhook-handler.js';
import { createTunnelManager } from './modules/tunnel-manager.js';
import { createCICDBridge } from './modules/cicd-bridge.js';
import { createSecurityManager } from './modules/security-manager.js';
import { type EnvConfig } from './config/env.js';
import type Database from 'better-sqlite3';
export interface AppInstance {
    app: ReturnType<typeof express>;
    io: SocketIOServer;
    httpServer: ReturnType<typeof createServer>;
    config: EnvConfig;
    db: Database.Database;
    modules: ModuleInstances;
    degradation: DegradationStatus;
    startBackgroundServices(): void;
    shutdown(): void;
}
export interface ModuleInstances {
    authModule: ReturnType<typeof createAuthModule>;
    rateLimiter: RateLimiter;
    auditLogger: ReturnType<typeof createAuditLogger>;
    alertSystem: ReturnType<typeof createAlertSystem>;
    containerManager: ReturnType<typeof createContainerManager>;
    fileManager: ReturnType<typeof createFileManager>;
    terminalManager: ReturnType<typeof createTerminalManager>;
    logViewer: ReturnType<typeof createLogViewer>;
    domainManager: ReturnType<typeof createDomainManager>;
    sslManager: ReturnType<typeof createSSLManager>;
    cronManager: ReturnType<typeof createCronManager>;
    databaseManager: ReturnType<typeof createDatabaseManager>;
    jobQueue: ReturnType<typeof createJobQueue>;
    backupManager: ReturnType<typeof createBackupManager>;
    resourceWidget: ReturnType<typeof createResourceWidget>;
    buildPipeline: ReturnType<typeof createBuildPipeline>;
    webhookHandler: ReturnType<typeof createWebhookHandler>;
    tunnelManager: ReturnType<typeof createTunnelManager>;
    cicdBridge: ReturnType<typeof createCICDBridge>;
    securityManager: ReturnType<typeof createSecurityManager>;
    projectManager: ReturnType<typeof createProjectManager>;
}
export interface DegradationStatus {
    /** Docker socket is reachable — false means read-only container operations */
    dockerAvailable: boolean;
    /** /proc filesystem is accessible — false means Docker stats API fallback */
    procAvailable: boolean;
    /** node-pty is available — false means terminal sessions disabled */
    ptyAvailable: boolean;
}
/**
 * Check if the Docker socket is reachable for read/write operations.
 */
export declare function isDockerSocketReachable(dockerHost: string): boolean;
/**
 * Check if /proc filesystem is accessible for resource metrics.
 */
export declare function isProcAvailable(): boolean;
/**
 * Check if node-pty module is available.
 */
export declare function isPtyAvailable(): boolean;
/**
 * Create and initialize the complete VPS Panel application.
 *
 * Module initialization order:
 * 1. Database (foundation for all persistent state)
 * 2. Audit Logger (needed by all state-changing modules)
 * 3. Alert System (needed by health monitoring, backup, security)
 * 4. Rate Limiter + Auth (gate for all access)
 * 5. Job Queue (needed by build pipeline, backup, tunnel, database ops)
 * 6. Container Manager (core Docker operations)
 * 7. File Manager (filesystem access)
 * 8. Terminal Manager (PTY sessions)
 * 9. Log Viewer (container log streaming)
 * 10. Domain Manager + SSL Manager (reverse proxy)
 * 11. Cron Manager (scheduled tasks)
 * 12. Database Manager (discovered DB containers)
 * 13. Backup Manager (depends on alert system)
 * 14. Resource Widget (system metrics, depends on /proc or Docker stats)
 * 15. Build Pipeline (depends on job queue)
 * 16. Webhook Handler (depends on build pipeline)
 * 17. Tunnel Manager (depends on job queue)
 * 18. CI/CD Bridge (depends on build pipeline)
 * 19. Security Manager (firewall, scanning)
 * 20. Project Manager (depends on container manager)
 */
export declare function createApp(envConfig?: EnvConfig): AppInstance;
//# sourceMappingURL=app.d.ts.map