"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSecurityRouter = createSecurityRouter;
/**
 * Security Routes
 *
 * Endpoints for security management:
 * score, firewall CRUD, ban/unban, scan, hardening.
 */
const express_1 = require("express");
function createSecurityRouter(securityManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/security/score
     * Get the overall security score.
     */
    router.get('/score', async (req, res) => {
        try {
            const score = await securityManager.getSecurityScore();
            res.json(score);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/security/firewall
     * List all firewall rules.
     */
    router.get('/firewall', async (req, res) => {
        try {
            const rules = await securityManager.listFirewallRules();
            res.json(rules);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/security/firewall
     * Add a new firewall rule.
     */
    router.post('/firewall', async (req, res) => {
        try {
            const rule = await securityManager.addFirewallRule(req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.firewall-add',
                targetResource: `firewall-rule:${rule.id}`,
                details: { port: rule.port, protocol: rule.protocol, action: rule.action, source: rule.source },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.status(201).json(rule);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.firewall-add',
                targetResource: 'firewall-rule',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/security/firewall/:id
     * Delete a firewall rule.
     */
    router.delete('/firewall/:id', async (req, res) => {
        try {
            await securityManager.deleteFirewallRule(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.firewall-delete',
                targetResource: `firewall-rule:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Firewall rule deleted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.firewall-delete',
                targetResource: `firewall-rule:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/security/banned
     * Get currently banned IPs.
     */
    router.get('/banned', async (req, res) => {
        try {
            const banned = await securityManager.getBannedIPs();
            res.json(banned);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/security/ban
     * Manually ban an IP address.
     */
    router.post('/ban', async (req, res) => {
        try {
            const { ip, duration } = req.body;
            if (!ip) {
                res.status(400).json({ error: 'IP address is required' });
                return;
            }
            await securityManager.banIP(ip, duration ?? 3600);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.ban',
                targetResource: `ip:${ip}`,
                details: { duration: duration ?? 3600 },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: `IP ${ip} banned` });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.ban',
                targetResource: `ip:${req.body?.ip ?? 'unknown'}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * POST /api/security/unban
     * Manually unban an IP address.
     */
    router.post('/unban', async (req, res) => {
        try {
            const { ip } = req.body;
            if (!ip) {
                res.status(400).json({ error: 'IP address is required' });
                return;
            }
            await securityManager.unbanIP(ip);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.unban',
                targetResource: `ip:${ip}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: `IP ${ip} unbanned` });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.unban',
                targetResource: `ip:${req.body?.ip ?? 'unknown'}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * POST /api/security/scan
     * Trigger a security scan.
     */
    router.post('/scan', async (req, res) => {
        try {
            const scanId = await securityManager.triggerScan();
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.scan',
                targetResource: `scan:${scanId}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ scanId, message: 'Security scan triggered' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.scan',
                targetResource: 'scan',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/security/scans
     * Get security scan history.
     */
    router.get('/scans', async (req, res) => {
        try {
            const history = await securityManager.getScanHistory();
            res.json(history);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/security/harden
     * Apply one-click security hardening.
     */
    router.post('/harden', async (req, res) => {
        try {
            const jobId = await securityManager.applyHardening();
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.harden',
                targetResource: 'system',
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ jobId, message: 'Hardening initiated' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'security.harden',
                targetResource: 'system',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=security.js.map