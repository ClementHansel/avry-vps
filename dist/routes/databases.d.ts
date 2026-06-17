/**
 * Database Routes
 *
 * Endpoints for database management:
 * discover servers, list databases, create, query, export, import, manage users.
 */
import { Router } from 'express';
import type { DatabaseManager } from '../modules/database-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createDatabasesRouter(databaseManager: DatabaseManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=databases.d.ts.map