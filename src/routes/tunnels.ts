/**
 * Tunnel Routes
 *
 * Endpoints for tunnel management:
 * CRUD configurations, trigger push, transfer history, generate CLI script.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { TunnelManager } from '../modules/tunnel-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createTunnelsRouter(
  tunnelManager: TunnelManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/tunnels
   * List all tunnel configurations.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const configs = tunnelManager.listConfigurations();
      res.json(configs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/tunnels
   * Create a new tunnel configuration.
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const config = tunnelManager.createConfiguration(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.create',
        targetResource: `tunnel:${config.id}`,
        details: { name: config.name, remotePath: config.remotePath },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(201).json(config);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.create',
        targetResource: 'tunnel',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * PUT /api/tunnels/:id
   * Update a tunnel configuration.
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const config = tunnelManager.updateConfiguration(req.params.id, req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.update',
        targetResource: `tunnel:${req.params.id}`,
        details: req.body,
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json(config);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.update',
        targetResource: `tunnel:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/tunnels/:id
   * Delete a tunnel configuration.
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      tunnelManager.deleteConfiguration(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.delete',
        targetResource: `tunnel:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Tunnel configuration deleted' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.delete',
        targetResource: `tunnel:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/tunnels/:id/push
   * Trigger a file push/deploy via tunnel.
   */
  router.post('/:id/push', async (req: Request, res: Response) => {
    try {
      // Expect raw binary body (tar.gz archive)
      const files = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body);

      const jobId = await tunnelManager.triggerPush(req.params.id, files);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.push',
        targetResource: `tunnel:${req.params.id}`,
        details: { jobId, size: files.length },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Transfer initiated' });
    } catch (error: any) {
      if (error.message.includes('already in progress')) {
        res.status(409).json({ error: error.message });
        return;
      }

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'tunnel.push',
        targetResource: `tunnel:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/tunnels/:id/history
   * Get transfer history for a tunnel configuration.
   */
  router.get('/:id/history', async (req: Request, res: Response) => {
    try {
      const history = tunnelManager.getTransferHistory(req.params.id);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/tunnels/:id/cli-script
   * Generate and download a CLI client script.
   */
  router.get('/:id/cli-script', async (req: Request, res: Response) => {
    try {
      const script = tunnelManager.generateCliScript(req.params.id);

      res.setHeader('Content-Type', 'application/x-shellscript');
      res.setHeader('Content-Disposition', `attachment; filename="tunnel-push.sh"`);
      res.send(script);
    } catch (error: any) {
      res.status(404).json({ error: error.message });
    }
  });

  return router;
}
