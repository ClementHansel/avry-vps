"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContainersRouter = createContainersRouter;
/**
 * Container Routes
 *
 * Endpoints for container lifecycle management:
 * list, start, stop, restart, redeploy, stats, health.
 */
const express_1 = require("express");
function createContainersRouter(containerManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/containers
     * List all containers with basic info.
     */
    router.get('/', async (req, res) => {
        try {
            const containers = await containerManager.listContainers();
            res.json(containers);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/containers/:id
     * Get detailed container info.
     */
    router.get('/:id', async (req, res) => {
        try {
            const container = await containerManager.getContainer(req.params.id);
            res.json(container);
        }
        catch (error) {
            res.status(404).json({ error: error.message });
        }
    });
    /**
     * GET /api/containers/:id/stats
     * Get container resource stats.
     */
    router.get('/:id/stats', async (req, res) => {
        try {
            const stats = await containerManager.getContainerStats(req.params.id);
            res.json(stats);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/containers/:id/health
     * Get container health status.
     */
    router.get('/:id/health', async (req, res) => {
        try {
            const health = await containerManager.getHealthStatus(req.params.id);
            res.json({ health });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/containers/:id/start
     * Start a stopped container.
     */
    router.post('/:id/start', async (req, res) => {
        try {
            await containerManager.startContainer(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.start',
                targetResource: `container:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Container started' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.start',
                targetResource: `container:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/containers/:id/stop
     * Stop a running container.
     */
    router.post('/:id/stop', async (req, res) => {
        try {
            await containerManager.stopContainer(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.stop',
                targetResource: `container:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Container stopped' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.stop',
                targetResource: `container:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/containers/:id/restart
     * Restart a container.
     */
    router.post('/:id/restart', async (req, res) => {
        try {
            await containerManager.restartContainer(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.restart',
                targetResource: `container:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Container restarted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.restart',
                targetResource: `container:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/containers/:id/redeploy
     * Pull latest image and redeploy container preserving config.
     */
    router.post('/:id/redeploy', async (req, res) => {
        try {
            const jobId = await containerManager.pullAndRedeploy(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.redeploy',
                targetResource: `container:${req.params.id}`,
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ jobId, message: 'Redeploy initiated' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'container.redeploy',
                targetResource: `container:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=containers.js.map