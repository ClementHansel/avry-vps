/**
 * Audit Routes
 *
 * Endpoints for audit log access:
 * query, search, export.
 */
import { Router } from 'express';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createAuditRouter(auditLogger: AuditLogger): Router;
//# sourceMappingURL=audit.d.ts.map