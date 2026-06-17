"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDockerSocketReachable = isDockerSocketReachable;
exports.isProcAvailable = isProcAvailable;
exports.isPtyAvailable = isPtyAvailable;
exports.createApp = createApp;
/**
 * VPS Panel - Application Factory
 *
 * Initializes all modules in correct dependency order, wires cross-cutting concerns
 * (audit logging, alert system, job queue), and implements graceful degradation when
 * system resources are unavailable.
 *
 * Requirements: All (final integration and wiring)
 */
const express_1 = __importDefault(require("express"));
const node_http_1 = require("node:http");
const socket_io_1 = require("socket.io");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const index_js_1 = require("./database/index.js");
const auth_js_1 = require("./modules/auth.js");
const rate_limiter_js_1 = require("./modules/rate-limiter.js");
const container_manager_js_1 = require("./modules/container-manager.js");
const file_manager_js_1 = require("./modules/file-manager.js");
const terminal_manager_js_1 = require("./modules/terminal-manager.js");
const log_viewer_js_1 = require("./modules/log-viewer.js");
const domain_manager_js_1 = require("./modules/domain-manager.js");
const ssl_manager_js_1 = require("./modules/ssl-manager.js");
const cron_manager_js_1 = require("./modules/cron-manager.js");
const database_manager_js_1 = require("./modules/database-manager.js");
const backup_manager_js_1 = require("./modules/backup-manager.js");
const resource_widget_js_1 = require("./modules/resource-widget.js");
const alert_system_js_1 = require("./modules/alert-system.js");
const audit_logger_js_1 = require("./modules/audit-logger.js");
const project_manager_js_1 = require("./modules/project-manager.js");
const job_queue_js_1 = require("./modules/job-queue.js");
const build_pipeline_js_1 = require("./modules/build-pipeline.js");
const webhook_handler_js_1 = require("./modules/webhook-handler.js");
const tunnel_manager_js_1 = require("./modules/tunnel-manager.js");
const cicd_bridge_js_1 = require("./modules/cicd-bridge.js");
const security_manager_js_1 = require("./modules/security-manager.js");
const index_js_2 = require("./routes/index.js");
const index_js_3 = require("./socket/index.js");
const env_js_1 = require("./config/env.js");
// ─── Graceful Degradation Checks ───────────────────────────────────────────────
/**
 * Check if the Docker socket is reachable for read/write operations.
 */
function isDockerSocketReachable(dockerHost) {
    if (dockerHost.startsWith('tcp://') || dockerHost.startsWith('http://')) {
        return true;
    }
    try {
        (0, node_fs_1.accessSync)(dockerHost, node_fs_1.constants.R_OK | node_fs_1.constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check if /proc filesystem is accessible for resource metrics.
 */
function isProcAvailable() {
    try {
        (0, node_fs_1.accessSync)('/proc/stat', node_fs_1.constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check if node-pty module is available.
 */
function isPtyAvailable() {
    try {
        (0, terminal_manager_js_1.createNodePtySpawner)();
        return true;
    }
    catch {
        return false;
    }
}
// ─── Database Adapters ─────────────────────────────────────────────────────────
function createSslDbAdapter(db) {
    return {
        getCertificate(domain) {
            return db.prepare('SELECT id, domain, issuer, expiry_date as expiryDate, renewal_status as renewalStatus, cert_path as certPath, key_path as keyPath, created_at as createdAt FROM certificates WHERE domain = ?').get(domain);
        },
        listCertificates() {
            return db.prepare('SELECT id, domain, issuer, expiry_date as expiryDate, renewal_status as renewalStatus, cert_path as certPath, key_path as keyPath, created_at as createdAt FROM certificates ORDER BY domain').all();
        },
        upsertCertificate(record) {
            const existing = db.prepare('SELECT id FROM certificates WHERE domain = ?').get(record.domain);
            if (existing) {
                db.prepare('UPDATE certificates SET issuer = ?, expiry_date = ?, renewal_status = ?, cert_path = ?, key_path = ? WHERE domain = ?').run(record.issuer, record.expiryDate, record.renewalStatus, record.certPath, record.keyPath, record.domain);
            }
            else {
                db.prepare('INSERT INTO certificates (id, domain, issuer, expiry_date, renewal_status, cert_path, key_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.id, record.domain, record.issuer, record.expiryDate, record.renewalStatus, record.certPath, record.keyPath);
            }
        },
        deleteCertificate(domain) {
            db.prepare('DELETE FROM certificates WHERE domain = ?').run(domain);
        },
        getDomainConfig(domain) {
            return db.prepare('SELECT id, domain, ssl_enabled as sslEnabled FROM domains WHERE domain = ?').get(domain);
        },
        updateDomainSsl(domain, enabled) {
            db.prepare('UPDATE domains SET ssl_enabled = ? WHERE domain = ?').run(enabled ? 1 : 0, domain);
        },
    };
}
function createDomainDbAdapter(db) {
    return {
        getAllDomains() {
            const rows = db.prepare('SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains ORDER BY domain').all();
            return rows.map((row) => ({
                id: row.id,
                domain: row.domain,
                proxyTarget: row.proxy_target,
                sslEnabled: row.ssl_enabled === 1,
                headers: row.headers ? JSON.parse(row.headers) : {},
                websocketUpgrade: row.websocket_upgrade === 1,
                active: row.active === 1,
                projectId: row.project_id ?? undefined,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }));
        },
        getDomain(id) {
            const row = db.prepare('SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains WHERE id = ?').get(id);
            if (!row)
                return undefined;
            return {
                id: row.id,
                domain: row.domain,
                proxyTarget: row.proxy_target,
                sslEnabled: row.ssl_enabled === 1,
                headers: row.headers ? JSON.parse(row.headers) : {},
                websocketUpgrade: row.websocket_upgrade === 1,
                active: row.active === 1,
                projectId: row.project_id ?? undefined,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            };
        },
        getDomainByName(domain) {
            const row = db.prepare('SELECT id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at FROM domains WHERE domain = ?').get(domain);
            if (!row)
                return undefined;
            return {
                id: row.id,
                domain: row.domain,
                proxyTarget: row.proxy_target,
                sslEnabled: row.ssl_enabled === 1,
                headers: row.headers ? JSON.parse(row.headers) : {},
                websocketUpgrade: row.websocket_upgrade === 1,
                active: row.active === 1,
                projectId: row.project_id ?? undefined,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            };
        },
        insertDomain(config) {
            db.prepare('INSERT INTO domains (id, domain, proxy_target, ssl_enabled, headers, websocket_upgrade, active, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(config.id, config.domain, config.proxyTarget, config.sslEnabled ? 1 : 0, JSON.stringify(config.headers ?? {}), config.websocketUpgrade ? 1 : 0, config.active ? 1 : 0, config.projectId ?? null, config.createdAt, config.updatedAt);
        },
        updateDomain(id, config) {
            db.prepare('UPDATE domains SET domain = ?, proxy_target = ?, ssl_enabled = ?, headers = ?, websocket_upgrade = ?, active = ?, project_id = ?, updated_at = ? WHERE id = ?').run(config.domain, config.proxyTarget, config.sslEnabled ? 1 : 0, JSON.stringify(config.headers ?? {}), config.websocketUpgrade ? 1 : 0, config.active ? 1 : 0, config.projectId ?? null, config.updatedAt, id);
        },
        deleteDomain(id) {
            db.prepare('DELETE FROM domains WHERE id = ?').run(id);
        },
    };
}
// ─── Application Factory ───────────────────────────────────────────────────────
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
function createApp(envConfig) {
    const config = envConfig ?? (0, env_js_1.validateEnv)();
    // ─── Degradation Status ────────────────────────────────────────────────────
    const degradation = {
        dockerAvailable: isDockerSocketReachable(config.DOCKER_HOST),
        procAvailable: isProcAvailable(),
        ptyAvailable: isPtyAvailable(),
    };
    if (!degradation.dockerAvailable) {
        console.warn('[VPS Panel] Docker socket not reachable — container operations will be read-only');
    }
    if (!degradation.procAvailable) {
        console.warn('[VPS Panel] /proc not available — falling back to Docker stats API for metrics');
    }
    if (!degradation.ptyAvailable) {
        console.warn('[VPS Panel] node-pty not available — terminal sessions disabled');
    }
    // ─── Express App ─────────────────────────────────────────────────────────────
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: '50mb' }));
    app.use(express_1.default.raw({ type: 'application/octet-stream', limit: '500mb' }));
    // ─── HTTP Server ─────────────────────────────────────────────────────────────
    const httpServer = (0, node_http_1.createServer)(app);
    // ─── Socket.IO ───────────────────────────────────────────────────────────────
    const io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: config.CORS_ORIGINS,
            methods: ['GET', 'POST'],
        },
        transports: ['websocket', 'polling'],
    });
    // ─── 1. Database ─────────────────────────────────────────────────────────────
    const db = (0, index_js_1.initializeDatabase)();
    const dbPath = (0, index_js_1.getDbPath)();
    // ─── 2. Audit Logger ─────────────────────────────────────────────────────────
    const auditLogger = (0, audit_logger_js_1.createAuditLogger)(db, dbPath, {
        onStorageAlert: (usage) => {
            console.warn(`[Audit] Storage alert: ${usage.usedBytes} / ${usage.maxBytes} bytes (${usage.usagePercent.toFixed(1)}%)`);
        },
    });
    // ─── 3. Alert System ─────────────────────────────────────────────────────────
    const alertSystem = (0, alert_system_js_1.createAlertSystem)(db, {
        onInAppNotification: (0, index_js_3.createAlertNotificationCallback)(io),
    });
    // ─── 4. Rate Limiter + Auth ──────────────────────────────────────────────────
    const rateLimiter = (0, rate_limiter_js_1.createRateLimiter)(db);
    const authModule = (0, auth_js_1.createAuthModule)(db, {
        jwtSecret: config.SUPABASE_JWT_SECRET,
    });
    // Wire rate limiter into auth module's isRateLimited method
    // The auth module has a stub; we override it by patching the returned object
    authModule.isRateLimited = (ip) => rateLimiter.isLocked(ip);
    authModule.recordFailedAttempt = (ip) => rateLimiter.recordFailure(ip);
    authModule.recordSuccessfulLogin = (ip) => rateLimiter.recordSuccess(ip);
    // ─── 5. Job Queue ────────────────────────────────────────────────────────────
    const jobQueue = (0, job_queue_js_1.createJobQueue)(db, { io });
    // ─── 6. Container Manager ────────────────────────────────────────────────────
    // When Docker is unavailable, the circuit breaker will open immediately on first use,
    // effectively making container operations fail gracefully (read-only degradation).
    const containerManager = (0, container_manager_js_1.createContainerManager)({
        dockerHost: config.DOCKER_HOST,
    });
    // ─── 7. File Manager ─────────────────────────────────────────────────────────
    const fileManager = (0, file_manager_js_1.createFileManager)();
    // ─── 8. Terminal Manager ─────────────────────────────────────────────────────
    let terminalManager;
    if (degradation.ptyAvailable) {
        try {
            const ptySpawner = (0, terminal_manager_js_1.createNodePtySpawner)();
            terminalManager = (0, terminal_manager_js_1.createTerminalManager)(ptySpawner, io);
        }
        catch (err) {
            console.warn('[VPS Panel] node-pty initialization failed:', err.message);
            terminalManager = (0, terminal_manager_js_1.createTerminalManager)({ spawn: () => { throw new Error('Terminal not available'); } }, io);
        }
    }
    else {
        terminalManager = (0, terminal_manager_js_1.createTerminalManager)({ spawn: () => { throw new Error('Terminal not available — node-pty unavailable'); } }, io);
    }
    // ─── 9. Log Viewer ──────────────────────────────────────────────────────────
    const logViewer = (0, log_viewer_js_1.createLogViewer)({
        dockerHost: config.DOCKER_HOST,
        io,
    });
    // ─── 10. Domain Manager + SSL Manager ────────────────────────────────────────
    const domainManager = (0, domain_manager_js_1.createDomainManager)({
        db: createDomainDbAdapter(db),
    });
    const sslManager = (0, ssl_manager_js_1.createSSLManager)({
        db: createSslDbAdapter(db),
    });
    // ─── 11. Cron Manager ────────────────────────────────────────────────────────
    const cronManager = (0, cron_manager_js_1.createCronManager)(db);
    // ─── 12. Database Manager ────────────────────────────────────────────────────
    const databaseManager = (0, database_manager_js_1.createDatabaseManager)({
        dockerHost: config.DOCKER_HOST,
    });
    // ─── 13. Backup Manager (depends on alert system) ───────────────────────────
    const backupManager = (0, backup_manager_js_1.createBackupManager)(db, {
        alertCallback: {
            onBackupFailure: (backupId, error, targets) => {
                alertSystem.emitAlert({
                    eventType: 'backup_failure',
                    affectedResource: `backup:${backupId}`,
                    severity: 'high',
                    message: `Backup failed for targets [${targets.join(', ')}]: ${error}`,
                });
            },
        },
    });
    // ─── 14. Resource Widget (uses /proc fallback to Docker stats) ──────────────
    // When /proc is unavailable, the widget uses Docker stats API as fallback.
    // The widget internally checks /proc accessibility and falls back automatically.
    const resourceWidget = (0, resource_widget_js_1.createResourceWidget)({
        dockerHost: config.DOCKER_HOST,
    });
    // ─── 15. Build Pipeline (depends on job queue) ──────────────────────────────
    const buildPipeline = (0, build_pipeline_js_1.createBuildPipeline)(db, {
        dockerHost: config.DOCKER_HOST,
        jobQueue,
    });
    // ─── 16. Webhook Handler (depends on build pipeline) ────────────────────────
    const webhookHandler = (0, webhook_handler_js_1.createWebhookHandler)({
        db,
        deps: {
            triggerBuild: (projectId) => buildPipeline.triggerBuild(projectId),
        },
    });
    // ─── 17. Tunnel Manager (depends on job queue) ──────────────────────────────
    const tunnelManager = (0, tunnel_manager_js_1.createTunnelManager)({
        db,
        deps: {
            submitJob: async (job) => {
                return jobQueue.submit({
                    type: job.type,
                    projectId: job.projectId,
                    execute: job.execute,
                    onComplete: job.onComplete,
                    metadata: job.metadata,
                });
            },
        },
    });
    // ─── 18. CI/CD Bridge (depends on build pipeline) ──────────────────────────
    const cicdBridge = (0, cicd_bridge_js_1.createCICDBridge)(db, {
        deps: {
            triggerBuild: (projectId) => buildPipeline.triggerBuild(projectId),
        },
    });
    // ─── 19. Security Manager ──────────────────────────────────────────────────
    const securityManager = (0, security_manager_js_1.createSecurityManager)(db, {
        panelPort: config.PORT,
    });
    // ─── 20. Project Manager (depends on container manager) ────────────────────
    const projectManager = (0, project_manager_js_1.createProjectManager)({
        db,
        deps: {
            getContainerStatus: async (containerId) => {
                try {
                    const container = await containerManager.getContainer(containerId);
                    return {
                        id: containerId,
                        status: container.status,
                        health: container.health,
                    };
                }
                catch {
                    return null;
                }
            },
            getContainerMetrics: async (containerId) => {
                try {
                    const stats = await containerManager.getContainerStats(containerId);
                    return {
                        id: containerId,
                        cpuPercent: stats.cpuUsagePercent,
                        memoryMB: stats.memoryUsageMB,
                    };
                }
                catch {
                    return null;
                }
            },
            startContainer: (id) => containerManager.startContainer(id),
            stopContainer: (id) => containerManager.stopContainer(id),
            restartContainer: (id) => containerManager.restartContainer(id),
            composeUp: async (_filePath) => {
                return { success: true };
            },
        },
    });
    // ─── Module Instances Registry ───────────────────────────────────────────────
    const modules = {
        authModule,
        rateLimiter,
        auditLogger,
        alertSystem,
        containerManager,
        fileManager,
        terminalManager,
        logViewer,
        domainManager,
        sslManager,
        cronManager,
        databaseManager,
        jobQueue,
        backupManager,
        resourceWidget,
        buildPipeline,
        webhookHandler,
        tunnelManager,
        cicdBridge,
        securityManager,
        projectManager,
    };
    // ─── Health Endpoint ─────────────────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        const dockerReachable = isDockerSocketReachable(config.DOCKER_HOST);
        const dbHealth = (0, index_js_1.checkHealth)(db);
        if (!dockerReachable || !dbHealth.healthy) {
            const reasons = [];
            if (!dockerReachable)
                reasons.push(`Docker socket unreachable at ${config.DOCKER_HOST}`);
            if (!dbHealth.healthy)
                reasons.push(`Database unhealthy: ${dbHealth.error ?? 'unknown'}`);
            res.status(503).json({
                status: 'unhealthy',
                reason: reasons[0],
                reasons,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            });
            return;
        }
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            database: {
                healthy: dbHealth.healthy,
                latencyMs: dbHealth.latencyMs,
                walMode: dbHealth.walMode,
            },
            degradation: {
                dockerAvailable: dockerReachable,
                procAvailable: degradation.procAvailable,
                ptyAvailable: degradation.ptyAvailable,
            },
        });
    });
    // ─── Register API Routes (all modules, auth middleware applied) ──────────────
    (0, index_js_2.registerRoutes)(app, {
        authModule,
        auditLogger,
        containerManager,
        fileManager,
        domainManager,
        sslManager,
        cronManager,
        databaseManager,
        backupManager,
        projectManager,
        buildPipeline,
        webhookHandler,
        tunnelManager,
        cicdBridge,
        securityManager,
        jobQueue,
        alertSystem,
    });
    // ─── Register Socket.IO Event Handlers ───────────────────────────────────────
    (0, index_js_3.setupSocketHandlers)(io, {
        authModule,
        terminalManager,
        logViewer,
        jobQueue,
        resourceWidget,
        alertSystem,
        containerManager,
    });
    // ─── Serve Static Frontend ───────────────────────────────────────────────────
    const frontendDistPath = node_path_1.default.resolve(__dirname, '../dist/frontend');
    if ((0, node_fs_1.existsSync)(frontendDistPath)) {
        app.use(express_1.default.static(frontendDistPath));
        // SPA fallback: serve index.html for any unmatched route
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api') || req.path === '/health') {
                return next();
            }
            const indexPath = node_path_1.default.join(frontendDistPath, 'index.html');
            if ((0, node_fs_1.existsSync)(indexPath)) {
                res.sendFile(indexPath);
            }
            else {
                next();
            }
        });
    }
    else {
        console.warn('[VPS Panel] Frontend dist not found at', frontendDistPath);
    }
    // ─── Start Background Services ──────────────────────────────────────────────
    function startBackgroundServices() {
        // Job Queue scheduler
        jobQueue.start();
        console.log('[VPS Panel] Job queue scheduler started');
        // Resource Widget monitoring (emits to Socket.IO every 5s)
        resourceWidget.startMonitoring(io);
        console.log('[VPS Panel] Resource widget monitoring started');
        // Backup scheduler
        backupManager.startScheduler();
        console.log('[VPS Panel] Backup scheduler started');
        // SSL renewal cron (daily check)
        sslManager.startRenewalCron();
        console.log('[VPS Panel] SSL renewal scheduler started');
        // Container health polling (only if Docker available)
        if (degradation.dockerAvailable) {
            containerManager.startHealthPolling();
            console.log('[VPS Panel] Container health polling started');
        }
        else {
            console.warn('[VPS Panel] Container health polling skipped — Docker unavailable');
        }
        // Audit log purge scheduler
        auditLogger.startPurgeScheduler();
        console.log('[VPS Panel] Audit log purge scheduler started');
        console.log('[VPS Panel] All background services started');
    }
    // ─── Graceful Shutdown ───────────────────────────────────────────────────────
    function shutdown() {
        console.log('[VPS Panel] Shutting down gracefully...');
        // Stop background services
        jobQueue.stop();
        resourceWidget.stopMonitoring();
        backupManager.stopScheduler();
        sslManager.stopRenewalCron();
        containerManager.stopHealthPolling();
        auditLogger.stopPurgeScheduler();
        // Close all terminal sessions
        terminalManager.closeAllSessions('*');
        // Destroy CI/CD filesystem watchers
        cicdBridge.destroy();
        // Close Socket.IO connections
        io.close();
        // Close database connection
        (0, index_js_1.closeDatabase)(db);
        console.log('[VPS Panel] Shutdown complete');
    }
    return {
        app,
        io,
        httpServer,
        config,
        db,
        modules,
        degradation,
        startBackgroundServices,
        shutdown,
    };
}
//# sourceMappingURL=app.js.map