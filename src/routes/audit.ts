/**
 * Audit Routes
 *
 * Endpoints for audit log access:
 * query, search, export.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createAuditRouter(auditLogger: AuditLogger): Router {
  const router = Router();

  /**
   * GET /api/audit
   * Query audit log with filters.
   * Query params: startDate, endDate, actor, actionType, targetResource, projectId, result, page
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const filter: Record<string, any> = {};

      if (req.query.startDate) {
        filter.startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        filter.endDate = new Date(req.query.endDate as string);
      }
      if (req.query.actor) {
        filter.actor = req.query.actor as string;
      }
      if (req.query.actionType) {
        filter.actionType = req.query.actionType as string;
      }
      if (req.query.targetResource) {
        filter.targetResource = req.query.targetResource as string;
      }
      if (req.query.projectId) {
        filter.projectId = req.query.projectId as string;
      }
      if (req.query.result) {
        filter.result = req.query.result as 'success' | 'failure';
      }
      if (req.query.page) {
        filter.page = parseInt(req.query.page as string, 10);
      }

      const result = await auditLogger.query(filter);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/audit/search?term=...
   * Full-text search audit logs.
   */
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const term = req.query.term as string;
      if (!term) {
        res.status(400).json({ error: 'Search term is required' });
        return;
      }

      const filter: Record<string, any> = {};
      if (req.query.page) {
        filter.page = parseInt(req.query.page as string, 10);
      }
      if (req.query.startDate) {
        filter.startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        filter.endDate = new Date(req.query.endDate as string);
      }

      const result = await auditLogger.search(term, filter);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/audit/export?format=json|csv
   * Export audit logs in specified format.
   */
  router.get('/export', async (req: Request, res: Response) => {
    try {
      const format = (req.query.format as 'json' | 'csv') ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        res.status(400).json({ error: 'Format must be "json" or "csv"' });
        return;
      }

      const filter: Record<string, any> = {};
      if (req.query.startDate) {
        filter.startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        filter.endDate = new Date(req.query.endDate as string);
      }
      if (req.query.actor) {
        filter.actor = req.query.actor as string;
      }
      if (req.query.actionType) {
        filter.actionType = req.query.actionType as string;
      }

      const data = await auditLogger.export(filter, format);

      const contentType = format === 'json' ? 'application/json' : 'text/csv';
      const extension = format === 'json' ? 'json' : 'csv';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="audit-log.${extension}"`);
      res.send(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
