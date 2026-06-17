"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAlertsRouter = createAlertsRouter;
/**
 * Alert Routes
 *
 * Endpoints for alert system management:
 * configure channels, configure rules, history.
 */
const express_1 = require("express");
function createAlertsRouter(alertSystem, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/alerts/channels
     * List configured alert channels.
     */
    router.get('/channels', async (req, res) => {
        try {
            const channels = alertSystem.getChannels();
            res.json(channels);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/alerts/channels
     * Configure or update an alert channel.
     */
    router.post('/channels', async (req, res) => {
        try {
            const channelId = await alertSystem.configureChannel(req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.configure-channel',
                targetResource: `alert-channel:${channelId}`,
                details: { type: req.body.type },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ id: channelId, message: 'Channel configured' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.configure-channel',
                targetResource: 'alert-channel',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/alerts/channels/:id
     * Remove an alert channel.
     */
    router.delete('/channels/:id', async (req, res) => {
        try {
            alertSystem.removeChannel(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.remove-channel',
                targetResource: `alert-channel:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Channel removed' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.remove-channel',
                targetResource: `alert-channel:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/alerts/rules
     * List configured alert rules.
     */
    router.get('/rules', async (req, res) => {
        try {
            const rules = alertSystem.getRules();
            res.json(rules);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/alerts/rules
     * Configure or update an alert rule.
     */
    router.post('/rules', async (req, res) => {
        try {
            const ruleId = await alertSystem.configureRule(req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.configure-rule',
                targetResource: `alert-rule:${ruleId}`,
                details: { resourceType: req.body.resourceType, threshold: req.body.threshold },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ id: ruleId, message: 'Rule configured' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.configure-rule',
                targetResource: 'alert-rule',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/alerts/rules/:id
     * Remove an alert rule.
     */
    router.delete('/rules/:id', async (req, res) => {
        try {
            alertSystem.removeRule(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.remove-rule',
                targetResource: `alert-rule:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Rule removed' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'alert.remove-rule',
                targetResource: `alert-rule:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/alerts/history
     * Get alert history.
     */
    router.get('/history', async (req, res) => {
        try {
            const history = await alertSystem.getAlertHistory();
            res.json(history);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=alerts.js.map