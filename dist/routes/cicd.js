"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCicdRouter = createCicdRouter;
/**
 * CI/CD Routes
 *
 * Endpoints for CI/CD bridge management:
 * configure, status, history, validate access.
 */
const express_1 = require("express");
function createCicdRouter(cicdBridge, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * POST /api/cicd/:projectId/configure
     * Configure CI/CD bridge for a project.
     */
    router.post('/:projectId/configure', async (req, res) => {
        try {
            await cicdBridge.configure(req.params.projectId, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cicd.configure',
                targetResource: `cicd:${req.params.projectId}`,
                details: { repoUrl: req.body.repoUrl, syncDirection: req.body.syncDirection },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'success',
            });
            res.json({ message: 'CI/CD bridge configured' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'cicd.configure',
                targetResource: `cicd:${req.params.projectId}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.projectId,
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * GET /api/cicd/:projectId/status
     * Get current sync status for a project.
     */
    router.get('/:projectId/status', async (req, res) => {
        try {
            const status = cicdBridge.getStatus(req.params.projectId);
            res.json({ status });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/cicd/:projectId/history
     * Get sync event history for a project.
     */
    router.get('/:projectId/history', async (req, res) => {
        try {
            const history = cicdBridge.getSyncHistory(req.params.projectId);
            res.json(history);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/cicd/validate-access
     * Validate repository access with provided credentials.
     */
    router.post('/validate-access', async (req, res) => {
        try {
            const isValid = await cicdBridge.validateAccess(req.body);
            res.json({ valid: isValid });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=cicd.js.map