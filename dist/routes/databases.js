"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDatabasesRouter = createDatabasesRouter;
/**
 * Database Routes
 *
 * Endpoints for database management:
 * discover servers, list databases, create, query, export, import, manage users.
 */
const express_1 = require("express");
function createDatabasesRouter(databaseManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/databases/servers
     * Discover available database servers.
     */
    router.get('/servers', async (req, res) => {
        try {
            const servers = await databaseManager.discoverServers();
            res.json(servers);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/databases/:serverId
     * List databases on a server.
     */
    router.get('/:serverId', async (req, res) => {
        try {
            const databases = await databaseManager.listDatabases(req.params.serverId);
            res.json(databases);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/databases/:serverId/create
     * Create a new database on a server.
     */
    router.post('/:serverId/create', async (req, res) => {
        try {
            const { name } = req.body;
            if (!name) {
                res.status(400).json({ error: 'name is required' });
                return;
            }
            await databaseManager.createDatabase(req.params.serverId, name);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.create',
                targetResource: `database:${req.params.serverId}/${name}`,
                details: { serverId: req.params.serverId, name },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.status(201).json({ message: `Database '${name}' created` });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.create',
                targetResource: `database:${req.params.serverId}/${req.body?.name ?? 'unknown'}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/databases/:serverId/:db/query
     * Execute a query against a database.
     */
    router.post('/:serverId/:db/query', async (req, res) => {
        try {
            const { query } = req.body;
            if (!query) {
                res.status(400).json({ error: 'query is required' });
                return;
            }
            const result = await databaseManager.executeQuery(req.params.serverId, req.params.db, query);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.query',
                targetResource: `database:${req.params.serverId}/${req.params.db}`,
                details: { queryLength: query.length },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/databases/:serverId/:db/export
     * Export a database (returns job ID).
     */
    router.post('/:serverId/:db/export', async (req, res) => {
        try {
            const jobId = await databaseManager.exportDatabase(req.params.serverId, req.params.db);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.export',
                targetResource: `database:${req.params.serverId}/${req.params.db}`,
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ jobId, message: 'Database export started' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.export',
                targetResource: `database:${req.params.serverId}/${req.params.db}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/databases/:serverId/:db/import
     * Import a database dump (returns job ID).
     */
    router.post('/:serverId/:db/import', async (req, res) => {
        try {
            const { file } = req.body;
            if (!file) {
                res.status(400).json({ error: 'file path is required' });
                return;
            }
            const jobId = await databaseManager.importDatabase(req.params.serverId, req.params.db, file);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.import',
                targetResource: `database:${req.params.serverId}/${req.params.db}`,
                details: { jobId, file },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ jobId, message: 'Database import started' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.import',
                targetResource: `database:${req.params.serverId}/${req.params.db}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/databases/:serverId/users
     * Manage database users (create, update permissions, delete).
     */
    router.post('/:serverId/users', async (req, res) => {
        try {
            await databaseManager.manageUser(req.params.serverId, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.manage-user',
                targetResource: `database:${req.params.serverId}`,
                details: { username: req.body?.username, action: req.body?.action },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'User operation completed' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'database.manage-user',
                targetResource: `database:${req.params.serverId}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=databases.js.map