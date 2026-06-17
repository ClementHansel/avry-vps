"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJobsRouter = createJobsRouter;
/**
 * Job Routes
 *
 * Endpoints for job queue management:
 * list, status, cancel.
 */
const express_1 = require("express");
function createJobsRouter(jobQueue, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/jobs
     * List jobs with optional filtering.
     * Query params: type, projectId, status, limit, offset
     */
    router.get('/', async (req, res) => {
        try {
            const filter = {};
            if (req.query.type) {
                filter.type = req.query.type;
            }
            if (req.query.projectId) {
                filter.projectId = req.query.projectId;
            }
            if (req.query.status) {
                filter.status = req.query.status;
            }
            if (req.query.limit) {
                filter.limit = parseInt(req.query.limit, 10);
            }
            if (req.query.offset) {
                filter.offset = parseInt(req.query.offset, 10);
            }
            const jobs = await jobQueue.listJobs(filter);
            res.json(jobs);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/jobs/:id
     * Get status of a specific job.
     */
    router.get('/:id', async (req, res) => {
        try {
            const job = await jobQueue.getStatus(req.params.id);
            if (!job) {
                res.status(404).json({ error: 'Job not found' });
                return;
            }
            res.json(job);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/jobs/:id/cancel
     * Cancel a queued or running job.
     */
    router.post('/:id/cancel', async (req, res) => {
        try {
            await jobQueue.cancel(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'job.cancel',
                targetResource: `job:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Job cancelled' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'job.cancel',
                targetResource: `job:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=jobs.js.map