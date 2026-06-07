/**
 * CI/CD Routes
 *
 * Endpoints for CI/CD bridge management:
 * configure, status, history, validate access.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CICDBridge } from '../modules/cicd-bridge.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createCicdRouter(
  cicdBridge: CICDBridge,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * POST /api/cicd/:projectId/configure
   * Configure CI/CD bridge for a project.
   */
  router.post('/:projectId/configure', async (req: Request, res: Response) => {
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
    } catch (error: any) {
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
  router.get('/:projectId/status', async (req: Request, res: Response) => {
    try {
      const status = cicdBridge.getStatus(req.params.projectId);
      res.json({ status });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/cicd/:projectId/history
   * Get sync event history for a project.
   */
  router.get('/:projectId/history', async (req: Request, res: Response) => {
    try {
      const history = cicdBridge.getSyncHistory(req.params.projectId);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/cicd/validate-access
   * Validate repository access with provided credentials.
   */
  router.post('/validate-access', async (req: Request, res: Response) => {
    try {
      const isValid = await cicdBridge.validateAccess(req.body);
      res.json({ valid: isValid });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
