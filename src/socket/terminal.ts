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
import { getSocketUserId } from './index.js';

// ─── Event Payload Types ───────────────────────────────────────────────────────

interface TerminalCreatePayload {
  shell?: string;
}

interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

interface TerminalClosePayload {
  sessionId: string;
}

interface TerminalAttachPayload {
  sessionId: string;
}

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register terminal Socket.IO event handlers for a connected socket.
 */
export function registerTerminalHandlers(
  io: SocketIOServer,
  socket: Socket,
  terminalManager: TerminalManager
): void {
  const userId = getSocketUserId(socket);
  if (!userId) return;

  // ─── terminal:create ─────────────────────────────────────────────────────

  socket.on('terminal:create', async (payload?: TerminalCreatePayload) => {
    try {
      const session = await terminalManager.createSession(userId, payload?.shell);

      // Join the terminal room to receive output data
      socket.join(`terminal:${session.id}`);

      socket.emit('terminal:created', { session });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create terminal session';
      socket.emit('terminal:error', { message });
    }
  });

  // ─── terminal:data ───────────────────────────────────────────────────────

  socket.on('terminal:data', (payload: TerminalDataPayload) => {
    if (!payload?.sessionId || typeof payload.data !== 'string') {
      socket.emit('terminal:error', { message: 'Invalid terminal:data payload' });
      return;
    }

    // Verify the session belongs to this user
    const sessions = terminalManager.getActiveSessions(userId);
    const session = sessions.find((s) => s.id === payload.sessionId);
    if (!session) {
      socket.emit('terminal:error', { message: `Session not found: ${payload.sessionId}` });
      return;
    }

    // Forward input to the PTY via the internal input event
    // The terminal manager's PTY data handler picks this up
    io.to(`terminal:${payload.sessionId}`).emit('terminal:input', {
      sessionId: payload.sessionId,
      data: payload.data,
    });
  });

  // ─── terminal:resize ─────────────────────────────────────────────────────

  socket.on('terminal:resize', (payload: TerminalResizePayload) => {
    if (!payload?.sessionId || !payload.cols || !payload.rows) {
      socket.emit('terminal:error', { message: 'Invalid terminal:resize payload' });
      return;
    }

    try {
      terminalManager.resizeSession(payload.sessionId, payload.cols, payload.rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resize terminal';
      socket.emit('terminal:error', { message });
    }
  });

  // ─── terminal:close ──────────────────────────────────────────────────────

  socket.on('terminal:close', (payload: TerminalClosePayload) => {
    if (!payload?.sessionId) {
      socket.emit('terminal:error', { message: 'Invalid terminal:close payload' });
      return;
    }

    terminalManager.closeSession(payload.sessionId);
    socket.leave(`terminal:${payload.sessionId}`);
  });

  // ─── terminal:attach (reconnect support) ─────────────────────────────────

  socket.on('terminal:attach', (payload: TerminalAttachPayload) => {
    if (!payload?.sessionId) {
      socket.emit('terminal:error', { message: 'Invalid terminal:attach payload' });
      return;
    }

    const sessions = terminalManager.getActiveSessions(userId);
    const session = sessions.find((s) => s.id === payload.sessionId);

    if (session) {
      socket.join(`terminal:${session.id}`);
      socket.emit('terminal:attached', { session });
    } else {
      socket.emit('terminal:error', { message: `Session not found: ${payload.sessionId}` });
    }
  });

  // ─── Cleanup on disconnect ───────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Don't close terminal sessions on disconnect — allow reconnection.
    // Sessions are cleaned up on auth session expiry via closeAllSessions.
  });
}
