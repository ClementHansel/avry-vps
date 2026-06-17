"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackupsRouter = createBackupsRouter;
/**
 * Backup Routes
 *
 * Endpoints for backup management:
 * configure schedule, trigger backup, restore, list, delete.
 */
const express_1 = require("express");
function createBackupsRouter(backupManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/backups
     * List all backups.
     */
    router.get('/', async (req, res) => {
        try {
            const backups = await backupManager.listBackups();
            res.json(backups);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/backups/configure
     * Configure backup schedule.
     */
    router.post('/configure', async (req, res) => {
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
        }
        catch (error) {
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
    router.post('/trigger', async (req, res) => {
        try {
            const targets = req.body.targets;
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
        }
        catch (error) {
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
    router.post('/:id/restore', async (req, res) => {
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
        }
        catch (error) {
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
    router.delete('/:id', async (req, res) => {
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
        }
        catch (error) {
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
//# sourceMappingURL=backups.js.map