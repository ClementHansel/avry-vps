"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCronRouter = createCronRouter;
/**
 * Cron Routes
 *
 * Endpoints for cron job management:
 * CRUD, validate expression, describe expression, execution history.
 */
const express_1 = require("express");
function createCronRouter(cronManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/cron
     * List all cron jobs.
     */
    router.get('/', async (req, res) => {
        try {
            const jobs = await cronManager.listJobs();
            res.json(jobs);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/cron
     * Create a new cron job.
     */
    router.post('/', async (req, res) => {
        try {
            const job = await cronManager.createJob(req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.create',
                targetResource: `cron:${job.id}`,
                details: { expression: job.expression, command: job.command },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.status(201).json(job);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.create',
                targetResource: 'cron:new',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * PUT /api/cron/:id
     * Update an existing cron job.
     */
    router.put('/:id', async (req, res) => {
        try {
            const job = await cronManager.updateJob(req.params.id, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.update',
                targetResource: `cron:${req.params.id}`,
                details: req.body,
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json(job);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.update',
                targetResource: `cron:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/cron/:id
     * Delete a cron job.
     */
    router.delete('/:id', async (req, res) => {
        try {
            await cronManager.deleteJob(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.delete',
                targetResource: `cron:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Cron job deleted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cron.delete',
                targetResource: `cron:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/cron/validate
     * Validate a cron expression.
     */
    router.post('/validate', (req, res) => {
        try {
            const { expression } = req.body;
            if (!expression) {
                res.status(400).json({ error: 'expression is required' });
                return;
            }
            const result = cronManager.validateExpression(expression);
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/cron/describe
     * Get a human-readable description of a cron expression.
     */
    router.post('/describe', (req, res) => {
        try {
            const { expression } = req.body;
            if (!expression) {
                res.status(400).json({ error: 'expression is required' });
                return;
            }
            const description = cronManager.describeExpression(expression);
            res.json({ description });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/cron/:id/history
     * Get execution history for a cron job.
     */
    router.get('/:id/history', async (req, res) => {
        try {
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
            const history = await cronManager.getJobHistory(req.params.id, limit);
            res.json(history);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=cron.js.map