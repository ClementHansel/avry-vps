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

// ─── Event Payload Types ───────────────────────────────────────────────────────

interface LogsSubscribePayload {
  containerId: string;
}

interface LogsUnsubscribePayload {
  containerId: string;
}

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register log streaming Socket.IO event handlers for a connected socket.
 */
export function registerLogsHandlers(
  io: SocketIOServer,
  socket: Socket,
  logViewer: LogViewer
): void {
  // Track which containers this socket is subscribed to for cleanup
  const subscribedContainers = new Set<string>();

  // ─── logs:subscribe ──────────────────────────────────────────────────────

  socket.on('logs:subscribe', (payload: LogsSubscribePayload) => {
    if (!payload?.containerId) {
      socket.emit('logs:error', { message: 'Invalid logs:subscribe payload: containerId required' });
      return;
    }

    const { containerId } = payload;
    const room = `logs:${containerId}`;

    // Join the room to receive log entries
    socket.join(room);
    subscribedContainers.add(containerId);

    // Start the log stream for this container if not already streaming
    // The log viewer emits to the room, so multiple subscribers share one stream
    try {
      logViewer.startLogStream(containerId, room);
      socket.emit('logs:subscribed', { containerId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start log stream';
      socket.emit('logs:error', { containerId, message });
    }
  });

  // ─── logs:unsubscribe ────────────────────────────────────────────────────

  socket.on('logs:unsubscribe', (payload: LogsUnsubscribePayload) => {
    if (!payload?.containerId) {
      socket.emit('logs:error', { message: 'Invalid logs:unsubscribe payload: containerId required' });
      return;
    }

    const { containerId } = payload;
    const room = `logs:${containerId}`;

    // Leave the room
    socket.leave(room);
    subscribedContainers.delete(containerId);

    // Check if anyone else is still in the room before stopping the stream
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (!roomSockets || roomSockets.size === 0) {
      logViewer.stopLogStream(containerId);
    }

    socket.emit('logs:unsubscribed', { containerId });
  });

  // ─── Cleanup on disconnect ───────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Clean up any log streams that no longer have subscribers
    for (const containerId of subscribedContainers) {
      const room = `logs:${containerId}`;
      const roomSockets = io.sockets.adapter.rooms.get(room);
      if (!roomSockets || roomSockets.size === 0) {
        logViewer.stopLogStream(containerId);
      }
    }
    subscribedContainers.clear();
  });
}
