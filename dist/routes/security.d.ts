/**
 * Security Routes
 *
 * Endpoints for security management:
 * score, firewall CRUD, ban/unban, scan, hardening.
 */
import { Router } from 'express';
import type { SecurityManager } from '../modules/security-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createSecurityRouter(securityManager: SecurityManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=security.d.ts.map