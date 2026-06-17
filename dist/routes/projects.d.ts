/**
 * Project Routes
 *
 * Endpoints for multi-project management:
 * CRUD, associate resources, deploy, stop, restart, health.
 */
import { Router } from 'express';
import type { ProjectManager } from '../modules/project-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createProjectsRouter(projectManager: ProjectManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=projects.d.ts.map