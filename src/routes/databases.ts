/**
 * Database Routes
 *
 * Endpoints for database management:
 * discover servers, list databases, create, query, export, import, manage users.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { DatabaseManager } from '../modules/database-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createDatabasesRouter(
  databaseManager: DatabaseManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/databases/servers
   * Discover available database servers.
   */
  router.get('/servers', async (req: Request, res: Response) => {
    try {
      const servers = await databaseManager.discoverServers();
      res.json(servers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/databases/:serverId
   * List databases on a server.
   */
  router.get('/:serverId', async (req: Request, res: Response) => {
    try {
      const databases = await databaseManager.listDatabases(req.params.serverId);
      res.json(databases);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/databases/:serverId/create
   * Create a new database on a server.
   */
  router.post('/:serverId/create', async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      await databaseManager.createDatabase(req.params.serverId, name);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.create',
        targetResource: `database:${req.params.serverId}/${name}`,
        details: { serverId: req.params.serverId, name },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.status(201).json({ message: `Database '${name}' created` });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.create',
        targetResource: `database:${req.params.serverId}/${req.body?.name ?? 'unknown'}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/databases/:serverId/:db/query
   * Execute a query against a database.
   */
  router.post('/:serverId/:db/query', async (req: Request, res: Response) => {
    try {
      const { query } = req.body;
      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const result = await databaseManager.executeQuery(
        req.params.serverId,
        req.params.db,
        query
      );

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.query',
        targetResource: `database:${req.params.serverId}/${req.params.db}`,
        details: { queryLength: query.length },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/databases/:serverId/:db/export
   * Export a database (returns job ID).
   */
  router.post('/:serverId/:db/export', async (req: Request, res: Response) => {
    try {
      const jobId = await databaseManager.exportDatabase(
        req.params.serverId,
        req.params.db
      );

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.export',
        targetResource: `database:${req.params.serverId}/${req.params.db}`,
        details: { jobId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Database export started' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.export',
        targetResource: `database:${req.params.serverId}/${req.params.db}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/databases/:serverId/:db/import
   * Import a database dump (returns job ID).
   */
  router.post('/:serverId/:db/import', async (req: Request, res: Response) => {
    try {
      const { file } = req.body;
      if (!file) {
        res.status(400).json({ error: 'file path is required' });
        return;
      }

      const jobId = await databaseManager.importDatabase(
        req.params.serverId,
        req.params.db,
        file
      );

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.import',
        targetResource: `database:${req.params.serverId}/${req.params.db}`,
        details: { jobId, file },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Database import started' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.import',
        targetResource: `database:${req.params.serverId}/${req.params.db}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/databases/:serverId/users
   * Manage database users (create, update permissions, delete).
   */
  router.post('/:serverId/users', async (req: Request, res: Response) => {
    try {
      await databaseManager.manageUser(req.params.serverId, req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.manage-user',
        targetResource: `database:${req.params.serverId}`,
        details: { username: req.body?.username, action: req.body?.action },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'User operation completed' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'database.manage-user',
        targetResource: `database:${req.params.serverId}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
