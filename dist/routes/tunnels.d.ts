/**
 * Tunnel Routes
 *
 * Endpoints for tunnel management:
 * CRUD configurations, trigger push, transfer history, generate CLI script.
 */
import { Router } from 'express';
import type { TunnelManager } from '../modules/tunnel-manager.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createTunnelsRouter(tunnelManager: TunnelManager, auditLogger: AuditLogger): Router;
//# sourceMappingURL=tunnels.d.ts.map