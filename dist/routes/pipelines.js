"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPipelinesRouter = createPipelinesRouter;
/**
 * Pipeline Routes
 *
 * Endpoints for build pipeline management:
 * configure, trigger build, history.
 */
const express_1 = require("express");
function createPipelinesRouter(buildPipeline, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * POST /api/pipelines/:projectId/configure
     * Configure a build pipeline for a project.
     */
    router.post('/:projectId/configure', async (req, res) => {
        try {
            await buildPipeline.configurePipeline(req.params.projectId, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'pipeline.configure',
                targetResource: `pipeline:${req.params.projectId}`,
                details: { repoUrl: req.body.repoUrl, branch: req.body.branch },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'success',
            });
            res.json({ message: 'Pipeline configured' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'pipeline.configure',
                targetResource: `pipeline:${req.params.projectId}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * POST /api/pipelines/:projectId/trigger
     * Trigger a build for a project.
     */
    router.post('/:projectId/trigger', async (req, res) => {
        try {
            const jobId = await buildPipeline.triggerBuild(req.params.projectId);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'pipeline.trigger',
                targetResource: `pipeline:${req.params.projectId}`,
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'success',
            });
            res.json({ jobId, message: 'Build triggered' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'pipeline.trigger',
                targetResource: `pipeline:${req.params.projectId}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/pipelines/:projectId/history
     * Get build history for a project.
     */
    router.get('/:projectId/history', async (req, res) => {
        try {
            const history = await buildPipeline.getBuildHistory(req.params.projectId);
            res.json(history);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=pipelines.js.map