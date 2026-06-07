/**
 * Container Routes
 *
 * Endpoints for container lifecycle management:
 * list, start, stop, restart, redeploy, stats, health.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ContainerManager } from '../modules/container-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createContainersRouter(
  containerManager: ContainerManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/containers
   * List all containers with basic info.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const containers = await containerManager.listContainers();
      res.json(containers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/containers/:id
   * Get detailed container info.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const container = await containerManager.getContainer(req.params.id);
      res.json(container);
    } catch (error: any) {
      res.status(404).json({ error: error.message });
    }
  });

  /**
   * GET /api/containers/:id/stats
   * Get container resource stats.
   */
  router.get('/:id/stats', async (req: Request, res: Response) => {
    try {
      const stats = await containerManager.getContainerStats(req.params.id);
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/containers/:id/health
   * Get container health status.
   */
  router.get('/:id/health', async (req: Request, res: Response) => {
    try {
      const health = await containerManager.getHealthStatus(req.params.id);
      res.json({ health });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/containers/:id/start
   * Start a stopped container.
   */
  router.post('/:id/start', async (req: Request, res: Response) => {
    try {
      await containerManager.startContainer(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.start',
        targetResource: `container:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Container started' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.start',
        targetResource: `container:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/containers/:id/stop
   * Stop a running container.
   */
  router.post('/:id/stop', async (req: Request, res: Response) => {
    try {
      await containerManager.stopContainer(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.stop',
        targetResource: `container:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Container stopped' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.stop',
        targetResource: `container:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/containers/:id/restart
   * Restart a container.
   */
  router.post('/:id/restart', async (req: Request, res: Response) => {
    try {
      await containerManager.restartContainer(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.restart',
        targetResource: `container:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Container restarted' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.restart',
        targetResource: `container:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/containers/:id/redeploy
   * Pull latest image and redeploy container preserving config.
   */
  router.post('/:id/redeploy', async (req: Request, res: Response) => {
    try {
      const jobId = await containerManager.pullAndRedeploy(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.redeploy',
        targetResource: `container:${req.params.id}`,
        details: { jobId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Redeploy initiated' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'container.redeploy',
        targetResource: `container:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
