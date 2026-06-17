/**
 * Socket.IO Log Streaming Event Handlers
 *
 * Handles container log streaming events:
 * - logs:subscribe — Subscribe to real-time log stream for a container
 * - logs:unsubscribe — Stop receiving log stream for a container
 *
 * Uses Socket.IO rooms (`logs:{containerId}`) for scoped log broadcasting.
 * Log entries are delivered within 2 seconds of generation.
 *
 * Requirements: 4.2
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { LogViewer } from '../modules/log-viewer.js';
/**
 * Register log streaming Socket.IO event handlers for a connected socket.
 */
export declare function registerLogsHandlers(io: SocketIOServer, socket: Socket, logViewer: LogViewer): void;
//# sourceMappingURL=logs.d.ts.map