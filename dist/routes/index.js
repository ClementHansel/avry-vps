"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const auth_js_1 = require("./auth.js");
const containers_js_1 = require("./containers.js");
const files_js_1 = require("./files.js");
const domains_js_1 = require("./domains.js");
const ssl_js_1 = require("./ssl.js");
const cron_js_1 = require("./cron.js");
const databases_js_1 = require("./databases.js");
const backups_js_1 = require("./backups.js");
const projects_js_1 = require("./projects.js");
const pipelines_js_1 = require("./pipelines.js");
const webhooks_js_1 = require("./webhooks.js");
const tunnels_js_1 = require("./tunnels.js");
const cicd_js_1 = require("./cicd.js");
const security_js_1 = require("./security.js");
const audit_js_1 = require("./audit.js");
const jobs_js_1 = require("./jobs.js");
const alerts_js_1 = require("./alerts.js");
const auth_js_2 = require("../middleware/auth.js");
/**
 * Register all API routes on the Express app.
 */
function registerRoutes(app, modules) {
    const { authModule, auditLogger } = modules;
    // Auth middleware for protected routes
    // Paths are relative to the /api mount point (Express strips the prefix)
    const authMiddleware = (0, auth_js_2.createAuthMiddleware)(authModule, {
        publicPaths: [
            '/health',
            '/login',
            '/auth/login',
            '/webhooks',
        ],
    });
    // Apply auth middleware globally
    app.use('/api', authMiddleware);
    // Register route modules
    app.use('/api/auth', (0, auth_js_1.createAuthRouter)(authModule, auditLogger));
    app.use('/api/containers', (0, containers_js_1.createContainersRouter)(modules.containerManager, auditLogger));
    app.use('/api/files', (0, files_js_1.createFilesRouter)(modules.fileManager, auditLogger));
    app.use('/api/domains', (0, domains_js_1.createDomainsRouter)(modules.domainManager, auditLogger));
    app.use('/api/ssl', (0, ssl_js_1.createSslRouter)(modules.sslManager, auditLogger));
    app.use('/api/cron', (0, cron_js_1.createCronRouter)(modules.cronManager, auditLogger));
    app.use('/api/databases', (0, databases_js_1.createDatabasesRouter)(modules.databaseManager, auditLogger));
    app.use('/api/backups', (0, backups_js_1.createBackupsRouter)(modules.backupManager, auditLogger));
    app.use('/api/projects', (0, projects_js_1.createProjectsRouter)(modules.projectManager, auditLogger));
    app.use('/api/pipelines', (0, pipelines_js_1.createPipelinesRouter)(modules.buildPipeline, auditLogger));
    app.use('/api/webhooks', (0, webhooks_js_1.createWebhooksRouter)(modules.webhookHandler, auditLogger));
    app.use('/api/tunnels', (0, tunnels_js_1.createTunnelsRouter)(modules.tunnelManager, auditLogger));
    app.use('/api/cicd', (0, cicd_js_1.createCicdRouter)(modules.cicdBridge, auditLogger));
    app.use('/api/security', (0, security_js_1.createSecurityRouter)(modules.securityManager, auditLogger));
    app.use('/api/audit', (0, audit_js_1.createAuditRouter)(auditLogger));
    app.use('/api/jobs', (0, jobs_js_1.createJobsRouter)(modules.jobQueue, auditLogger));
    app.use('/api/alerts', (0, alerts_js_1.createAlertsRouter)(modules.alertSystem, auditLogger));
}
//# sourceMappingURL=index.js.map