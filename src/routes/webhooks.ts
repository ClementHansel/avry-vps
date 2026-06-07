/**
 * Webhook Routes
 *
 * Endpoints for webhook management:
 * generate URL, receive events, history.
 *
 * Note: The receive endpoint (/api/webhooks/:projectId/:token) is excluded
 * from auth middleware as it must be publicly accessible for Git providers.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WebhookHandler } from '../modules/webhook-handler.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createWebhooksRouter(
  webhookHandler: WebhookHandler,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * POST /api/webhooks/:projectId/generate
   * Generate a webhook URL for a project.
   */
  router.post('/:projectId/generate', async (req: Request, res: Response) => {
    try {
      const { triggerBranch } = req.body;
      const config = webhookHandler.generateWebhookUrl(req.params.projectId, { triggerBranch });

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'webhook.generate',
        targetResource: `webhook:${req.params.projectId}`,
        details: { triggerBranch: config.triggerBranch },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        projectId: req.params.projectId,
        result: 'success',
      });

      res.json(config);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'webhook.generate',
        targetResource: `webhook:${req.params.projectId}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        projectId: req.params.projectId,
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/webhooks/:projectId/:token
   * Receive webhook events from Git providers.
   * This endpoint is publicly accessible (excluded from auth middleware).
   */
  router.post('/:projectId/:token', async (req: Request, res: Response) => {
    try {
      const { projectId, token } = req.params;
      const sourceIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';

      // Pass raw body as string for signature validation
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

      const result = await webhookHandler.handleRequest(
        projectId,
        token,
        req.headers as Record<string, string | undefined>,
        body,
        sourceIp
      );

      res.status(result.statusCode).json({
        message: result.message,
        jobId: result.jobId,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/webhooks/:projectId/history
   * Get webhook event history for a project.
   */
  router.get('/:projectId/history', async (req: Request, res: Response) => {
    try {
      const history = webhookHandler.getWebhookHistory(req.params.projectId);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
