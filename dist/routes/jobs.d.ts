/**
 * Job Routes
 *
 * Endpoints for job queue management:
 * list, status, cancel.
 */
import { Router } from 'express';
import type { JobQueue } from '../modules/job-queue.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createJobsRouter(jobQueue: JobQueue, auditLogger: AuditLogger): Router;
//# sourceMappingURL=jobs.d.ts.map