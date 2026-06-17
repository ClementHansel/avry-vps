"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDomainsRouter = createDomainsRouter;
/**
 * Domain Routes
 *
 * Endpoints for domain management:
 * CRUD, DNS validation, nginx reload.
 */
const express_1 = require("express");
function createDomainsRouter(domainManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/domains
     * List all configured domains.
     */
    router.get('/', async (req, res) => {
        try {
            const domains = await domainManager.listDomains();
            res.json(domains);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/domains
     * Add a new domain.
     */
    router.post('/', async (req, res) => {
        try {
            const domain = await domainManager.addDomain(req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.create',
                targetResource: `domain:${domain.domain}`,
                details: { proxyTarget: domain.proxyTarget },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.status(201).json(domain);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.create',
                targetResource: `domain:${req.body?.domain ?? 'unknown'}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * PUT /api/domains/:id
     * Update an existing domain.
     */
    router.put('/:id', async (req, res) => {
        try {
            const domain = await domainManager.updateDomain(req.params.id, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.update',
                targetResource: `domain:${req.params.id}`,
                details: req.body,
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json(domain);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.update',
                targetResource: `domain:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/domains/:id
     * Delete a domain.
     */
    router.delete('/:id', async (req, res) => {
        try {
            await domainManager.deleteDomain(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.delete',
                targetResource: `domain:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Domain deleted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.delete',
                targetResource: `domain:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/domains/:id/validate-dns
     * Validate DNS resolution for a domain.
     */
    router.post('/:id/validate-dns', async (req, res) => {
        try {
            const { domain } = req.body;
            if (!domain) {
                res.status(400).json({ error: 'domain field is required' });
                return;
            }
            const result = await domainManager.validateDns(domain);
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/domains/reload-nginx
     * Reload nginx configuration.
     */
    router.post('/reload-nginx', async (req, res) => {
        try {
            await domainManager.reloadNginx();
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.nginx-reload',
                targetResource: 'nginx',
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Nginx reloaded successfully' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'domain.nginx-reload',
                targetResource: 'nginx',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=domains.js.map