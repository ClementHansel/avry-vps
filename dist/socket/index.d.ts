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
export interface SocketDependencies {
    authModule: AuthModule;
    terminalManager: TerminalManager;
    logViewer: LogViewer;
    jobQueue: JobQueue;
    resourceWidget: ResourceWidget;
    alertSystem: AlertSystem;
    containerManager: ContainerManager;
}
/**
 * Extract the session attached by the auth middleware from a socket.
 */
export declare function getSocketSession(socket: Socket): Session | null;
/**
 * Extract the user ID (username) from an authenticated socket.
 */
export declare function getSocketUserId(socket: Socket): string | null;
/**
 * Initialize Socket.IO with auth middleware and register all event handlers.
 *
 * @param io - The Socket.IO server instance
 * @param deps - All module dependencies needed by socket handlers
 */
export declare function setupSocketHandlers(io: SocketIOServer, deps: SocketDependencies): void;
/**
 * Create the in-app alert notification callback for the AlertSystem.
 * This broadcasts alerts to all connected authenticated clients.
 */
export declare function createAlertNotificationCallback(io: SocketIOServer): (alert: AlertRecord) => void;
//# sourceMappingURL=index.d.ts.map