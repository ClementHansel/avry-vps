/**
 * Cron Routes
 *
 * Endpoints for cron job management:
 * CRUD, validate expression, describe expression, execution history.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CronManager } from '../modules/cron-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createCronRouter(
  cronManager: CronManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/cron
   * List all cron jobs.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const jobs = await cronManager.listJobs();
      res.json(jobs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/cron
   * Create a new cron job.
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const job = await cronManager.createJob(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.create',
        targetResource: `cron:${job.id}`,
        details: { expression: job.expression, command: job.command },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(201).json(job);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.create',
        targetResource: 'cron:new',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * PUT /api/cron/:id
   * Update an existing cron job.
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const job = await cronManager.updateJob(req.params.id, req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.update',
        targetResource: `cron:${req.params.id}`,
        details: req.body,
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json(job);
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.update',
        targetResource: `cron:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/cron/:id
   * Delete a cron job.
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await cronManager.deleteJob(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.delete',
        targetResource: `cron:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Cron job deleted' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'cron.delete',
        targetResource: `cron:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/cron/validate
   * Validate a cron expression.
   */
  router.post('/validate', (req: Request, res: Response) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        res.status(400).json({ error: 'expression is required' });
        return;
      }

      const result = cronManager.validateExpression(expression);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/cron/describe
   * Get a human-readable description of a cron expression.
   */
  router.post('/describe', (req: Request, res: Response) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        res.status(400).json({ error: 'expression is required' });
        return;
      }

      const description = cronManager.describeExpression(expression);
      res.json({ description });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/cron/:id/history
   * Get execution history for a cron job.
   */
  router.get('/:id/history', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const history = await cronManager.getJobHistory(req.params.id, limit);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
