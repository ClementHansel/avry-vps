/**
 * Auth Routes
 *
 * Handles login and logout.
 * Login is publicly accessible; logout requires authentication.
 */
import { Router } from 'express';
import type { AuthModule } from '../modules/auth.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createAuthRouter(authModule: AuthModule, auditLogger: AuditLogger): Router;
//# sourceMappingURL=auth.d.ts.map