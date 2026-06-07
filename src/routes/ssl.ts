/**
 * SSL Routes
 *
 * Endpoints for SSL certificate management:
 * provision, upload, status, list.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSLManager } from '../modules/ssl-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createSslRouter(
  sslManager: SSLManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/ssl
   * List all certificates.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const certs = await sslManager.listCertificates();
      res.json(certs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ssl/:domain/status
   * Get certificate status for a domain.
   */
  router.get('/:domain/status', async (req: Request, res: Response) => {
    try {
      const status = await sslManager.getCertificateStatus(req.params.domain);
      res.json(status);
    } catch (error: any) {
      res.status(404).json({ error: error.message });
    }
  });

  /**
   * POST /api/ssl/:domain/provision
   * Provision a Let's Encrypt certificate for a domain.
   */
  router.post('/:domain/provision', async (req: Request, res: Response) => {
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
    } catch (error: any) {
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
  router.post('/:domain/upload', async (req: Request, res: Response) => {
    try {
      const { cert, key } = req.body;
      if (!cert || !key) {
        res.status(400).json({ error: 'cert and key are required' });
        return;
      }

      await sslManager.uploadCertificate(
        req.params.domain,
        Buffer.from(cert, 'utf-8'),
        Buffer.from(key, 'utf-8')
      );

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'ssl.upload',
        targetResource: `domain:${req.params.domain}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Certificate uploaded successfully' });
    } catch (error: any) {
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
