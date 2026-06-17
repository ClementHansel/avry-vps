"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSslRouter = createSslRouter;
/**
 * SSL Routes
 *
 * Endpoints for SSL certificate management:
 * provision, upload, status, list.
 */
const express_1 = require("express");
function createSslRouter(sslManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/ssl
     * List all certificates.
     */
    router.get('/', async (req, res) => {
        try {
            const certs = await sslManager.listCertificates();
            res.json(certs);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/ssl/:domain/status
     * Get certificate status for a domain.
     */
    router.get('/:domain/status', async (req, res) => {
        try {
            const status = await sslManager.getCertificateStatus(req.params.domain);
            res.json(status);
        }
        catch (error) {
            res.status(404).json({ error: error.message });
        }
    });
    /**
     * POST /api/ssl/:domain/provision
     * Provision a Let's Encrypt certificate for a domain.
     */
    router.post('/:domain/provision', async (req, res) => {
        try {
            const jobId = await sslManager.provisionCertificate(req.params.domain);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'ssl.provision',
                targetResource: `domain:${req.params.domain}`,
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ jobId, message: 'Certificate provisioning started' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'ssl.provision',
                targetResource: `domain:${req.params.domain}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/ssl/:domain/upload
     * Upload a custom certificate and private key.
     */
    router.post('/:domain/upload', async (req, res) => {
        try {
            const { cert, key } = req.body;
            if (!cert || !key) {
                res.status(400).json({ error: 'cert and key are required' });
                return;
            }
            await sslManager.uploadCertificate(req.params.domain, Buffer.from(cert, 'utf-8'), Buffer.from(key, 'utf-8'));
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'ssl.upload',
                targetResource: `domain:${req.params.domain}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Certificate uploaded successfully' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'ssl.upload',
                targetResource: `domain:${req.params.domain}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=ssl.js.map