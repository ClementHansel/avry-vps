/**
 * Socket.IO Terminal Event Handlers
 *
 * Handles terminal session lifecycle events:
 * - terminal:create — Create a new PTY session
 * - terminal:data — Send input data to a terminal session
 * - terminal:resize — Resize a terminal session
 * - terminal:close — Close a terminal session
 *
 * Uses Socket.IO rooms (`terminal:{sessionId}`) for scoped data broadcasting.
 * Terminal data streams bidirectionally between client and server.
 *
 * Requirements: 10.1, 10.2
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { TerminalManager } from '../modules/terminal-manager.js';
/**
 * Register terminal Socket.IO event handlers for a connected socket.
 */
export declare function registerTerminalHandlers(io: SocketIOServer, socket: Socket, terminalManager: TerminalManager): void;
//# sourceMappingURL=terminal.d.ts.map