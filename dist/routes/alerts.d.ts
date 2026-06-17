/**
 * Alert Routes
 *
 * Endpoints for alert system management:
 * configure channels, configure rules, history.
 */
import { Router } from 'express';
import type { AlertSystem } from '../modules/alert-system.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createAlertsRouter(alertSystem: AlertSystem, auditLogger: AuditLogger): Router;
//# sourceMappingURL=alerts.d.ts.map