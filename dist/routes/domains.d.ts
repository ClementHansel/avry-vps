/**
 * Domain Routes
 *
 * Endpoints for domain management:
 * CRUD, DNS validation, nginx reload.
 */
import { Router } from 'express';
import type { DomainManager } from '../modules/domain-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createDomainsRouter(domainManager: DomainManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=domains.d.ts.map