/**
 * Pipeline Routes
 *
 * Endpoints for build pipeline management:
 * configure, trigger build, history.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BuildPipeline } from '../modules/build-pipeline.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createPipelinesRouter(
  buildPipeline: BuildPipeline,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * POST /api/pipelines/:projectId/configure
   * Configure a build pipeline for a project.
   */
  router.post('/:projectId/configure', async (req: Request, res: Response) => {
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
    } catch (error: any) {
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
  router.post('/:projectId/trigger', async (req: Request, res: Response) => {
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
    } catch (error: any) {
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
  router.get('/:projectId/history', async (req: Request, res: Response) => {
    try {
      const history = await buildPipeline.getBuildHistory(req.params.projectId);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
