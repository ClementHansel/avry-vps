/**
 * Pipeline Routes
 *
 * Endpoints for build pipeline management:
 * configure, trigger build, history.
 */
import { Router } from 'express';
import type { BuildPipeline } from '../modules/build-pipeline.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createPipelinesRouter(buildPipeline: BuildPipeline, auditLogger: AuditLogger): Router;
//# sourceMappingURL=pipelines.d.ts.map