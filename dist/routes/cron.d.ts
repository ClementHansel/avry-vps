/**
 * Cron Routes
 *
 * Endpoints for cron job management:
 * CRUD, validate expression, describe expression, execution history.
 */
import { Router } from 'express';
import type { CronManager } from '../modules/cron-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createCronRouter(cronManager: CronManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=cron.d.ts.map