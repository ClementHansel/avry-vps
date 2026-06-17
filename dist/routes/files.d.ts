/**
 * File Routes
 *
 * Endpoints for file system operations:
 * list directory, read file, write file.
 */
import { Router } from 'express';
import type { FileManager } from '../modules/file-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createFilesRouter(fileManager: FileManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=files.d.ts.map