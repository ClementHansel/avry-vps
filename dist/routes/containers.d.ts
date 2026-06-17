/**
 * Container Routes
 *
 * Endpoints for container lifecycle management:
 * list, start, stop, restart, redeploy, stats, health.
 */
import { Router } from 'express';
import type { ContainerManager } from '../modules/container-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createContainersRouter(containerManager: ContainerManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=containers.d.ts.map