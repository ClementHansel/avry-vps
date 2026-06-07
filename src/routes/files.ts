/**
 * File Routes
 *
 * Endpoints for file system operations:
 * list directory, read file, write file.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { FileManager } from '../modules/file-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createFilesRouter(
  fileManager: FileManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/files/list?path=...
   * List directory contents.
   */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const dirPath = (req.query.path as string) ?? '/';
      const listing = await fileManager.listDirectory(dirPath);
      res.json(listing);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * GET /api/files/read?path=...
   * Read file content with syntax highlighting metadata.
   */
  router.get('/read', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Path query parameter is required' });
        return;
      }

      const content = await fileManager.readFile(filePath);
      res.json(content);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * PUT /api/files/write
   * Write content to a file.
   */
  router.put('/write', async (req: Request, res: Response) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath || content === undefined) {
        res.status(400).json({ error: 'path and content are required' });
        return;
      }

      await fileManager.writeFile(filePath, content);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'file.write',
        targetResource: `file:${filePath}`,
        details: { size: content.length },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'File saved successfully' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'file.write',
        targetResource: `file:${req.body?.path ?? 'unknown'}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
