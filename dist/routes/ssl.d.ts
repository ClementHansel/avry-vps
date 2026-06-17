/**
 * SSL Routes
 *
 * Endpoints for SSL certificate management:
 * provision, upload, status, list.
 */
import { Router } from 'express';
import type { SSLManager } from '../modules/ssl-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createSslRouter(sslManager: SSLManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=ssl.d.ts.map