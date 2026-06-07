/**
 * Socket.IO Event Handlers - Main Setup
 *
 * Applies auth middleware on connection and registers all event handlers.
 * Each handler module exports a function that takes (io, socket) and registers
 * event listeners scoped to that socket connection.
 *
 * Requirements: 10.1, 10.2, 4.2, 20.3, 11.2, 14.3, 1.6
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AuthModule, Session } from '../modules/auth.js';
import type { TerminalManager } from '../modules/terminal-manager.js';
import type { LogViewer } from '../modules/log-viewer.js';
import type { JobQueue } from '../modules/job-queue.js';
import type { ResourceWidget } from '../modules/resource-widget.js';
import type { AlertSystem, AlertRecord } from '../modules/alert-system.js';
import type { ContainerManager } from '../modules/container-manager.js';
import { createSocketAuthMiddleware } from '../middleware/auth.js';
import { registerTerminalHandlers } from './terminal.js';
import { registerLogsHandlers } from './logs.js';
import { registerJobsHandlers } from './jobs.js';
import { registerMetricsHandlers } from './metrics.js';
import { registerAlertsHandlers } from './alerts.js';
import { registerContainersHandlers } from './containers.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SocketDependencies {
  authModule: AuthModule;
  terminalManager: TerminalManager;
  logViewer: LogViewer;
  jobQueue: JobQueue;
  resourceWidget: ResourceWidget;
  alertSystem: AlertSystem;
  containerManager: ContainerManager;
}

// ─── Helper to extract session from authenticated socket ───────────────────────

/**
 * Extract the session attached by the auth middleware from a socket.
 */
export function getSocketSession(socket: Socket): Session | null {
  return (socket as any).session ?? null;
}

/**
 * Extract the user ID (username) from an authenticated socket.
 */
export function getSocketUserId(socket: Socket): string | null {
  const session = getSocketSession(socket);
  return session?.username ?? null;
}

// ─── Main Setup ────────────────────────────────────────────────────────────────

/**
 * Initialize Socket.IO with auth middleware and register all event handlers.
 *
 * @param io - The Socket.IO server instance
 * @param deps - All module dependencies needed by socket handlers
 */
export function setupSocketHandlers(
  io: SocketIOServer,
  deps: SocketDependencies
): void {
  // Apply auth validation middleware to all connections
  io.use(createSocketAuthMiddleware(deps.authModule));

  // Register connection handler
  io.on('connection', (socket: Socket) => {
    const session = getSocketSession(socket);
    if (!session) {
      // This shouldn't happen since auth middleware rejects invalid connections,
      // but handle gracefully just in case
      socket.disconnect(true);
      return;
    }

    // Register all domain-specific event handlers
    registerTerminalHandlers(io, socket, deps.terminalManager);
    registerLogsHandlers(io, socket, deps.logViewer);
    registerJobsHandlers(io, socket, deps.jobQueue);
    registerMetricsHandlers(io, socket, deps.resourceWidget);
    registerAlertsHandlers(io, socket, deps.alertSystem);
    registerContainersHandlers(io, socket, deps.containerManager);

    // Join a user-specific room for targeted notifications
    socket.join(`user:${session.username}`);

    // Handle disconnect cleanup
    socket.on('disconnect', () => {
      // Individual handlers manage their own cleanup via socket 'disconnect' event
    });
  });
}

/**
 * Create the in-app alert notification callback for the AlertSystem.
 * This broadcasts alerts to all connected authenticated clients.
 */
export function createAlertNotificationCallback(io: SocketIOServer) {
  return (alert: AlertRecord): void => {
    io.emit('alert:notification', {
      id: alert.id,
      timestamp: alert.timestamp,
      eventType: alert.eventType,
      affectedResource: alert.affectedResource,
      severity: alert.severity,
      message: alert.message,
    });
  };
}
