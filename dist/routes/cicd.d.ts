/**
 * CI/CD Routes
 *
 * Endpoints for CI/CD bridge management:
 * configure, status, history, validate access.
 */
import { Router } from 'express';
import type { CICDBridge } from '../modules/cicd-bridge.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createCicdRouter(cicdBridge: CICDBridge, auditLogger: AuditLogger): Router;
//# sourceMappingURL=cicd.d.ts.map