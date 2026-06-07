/**
 * Backup Routes
 *
 * Endpoints for backup management:
 * configure schedule, trigger backup, restore, list, delete.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BackupManager } from '../modules/backup-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';

export function createBackupsRouter(
  backupManager: BackupManager,
  auditLogger: AuditLogger
): Router {
  const router = Router();

  /**
   * GET /api/backups
   * List all backups.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const backups = await backupManager.listBackups();
      res.json(backups);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/configure
   * Configure backup schedule.
   */
  router.post('/configure', async (req: Request, res: Response) => {
    try {
      const scheduleId = await backupManager.configureSchedule(req.body);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.configure',
        targetResource: `backup-schedule:${scheduleId}`,
        details: req.body,
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ scheduleId, message: 'Backup schedule configured' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.configure',
        targetResource: 'backup-schedule',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(400).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/trigger
   * Trigger an immediate backup.
   */
  router.post('/trigger', async (req: Request, res: Response) => {
    try {
      const targets = req.body.targets as string[] | undefined;
      const jobId = await backupManager.triggerBackup(targets);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.trigger',
        targetResource: 'backup',
        details: { jobId, targets },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Backup triggered' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.trigger',
        targetResource: 'backup',
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/backups/:id/restore
   * Restore from a backup.
   */
  router.post('/:id/restore', async (req: Request, res: Response) => {
    try {
      const jobId = await backupManager.restoreBackup(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore',
        targetResource: `backup:${req.params.id}`,
        details: { jobId },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ jobId, message: 'Restore initiated' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.restore',
        targetResource: `backup:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/backups/:id
   * Delete a backup.
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await backupManager.deleteBackup(req.params.id);

      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.delete',
        targetResource: `backup:${req.params.id}`,
        details: {},
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'success',
      });

      res.json({ message: 'Backup deleted' });
    } catch (error: any) {
      await auditLogger.log({
        actor: req.session?.username ?? 'unknown',
        actionType: 'backup.delete',
        targetResource: `backup:${req.params.id}`,
        details: { error: error.message },
        sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        result: 'failure',
      });

      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
