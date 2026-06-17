/**
 * Backup Routes
 *
 * Endpoints for backup management:
 * configure schedule, trigger backup, restore, list, delete.
 */
import { Router } from 'express';
import type { BackupManager } from '../modules/backup-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createBackupsRouter(backupManager: BackupManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=backups.d.ts.map