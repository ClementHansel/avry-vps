/**
 * Socket.IO Resource Metrics Event Handlers
 *
 * Handles resource metrics push:
 * - Emits `resource:update` every 5 seconds with system and container metrics
 * - Clients automatically receive updates once connected (broadcast to all)
 * - metrics:subscribe — Opt-in for metrics updates (joins metrics room)
 * - metrics:unsubscribe — Stop receiving metrics updates
 *
 * The ResourceWidget module handles periodic collection and emission.
 * This handler provides per-socket subscription management for clients
 * that want to control when they receive updates.
 *
 * Requirements: 11.2
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ResourceWidget } from '../modules/resource-widget.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const METRICS_ROOM = 'metrics:subscribers';

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register resource metrics Socket.IO event handlers for a connected socket.
 *
 * The ResourceWidget emits `resource:update` globally to all connected clients.
 * This handler provides optional subscription management for clients that want
 * explicit control, and sends the latest cached update on subscribe.
 */
export function registerMetricsHandlers(
  io: SocketIOServer,
  socket: Socket,
  resourceWidget: ResourceWidget
): void {
  // ─── metrics:subscribe ───────────────────────────────────────────────────

  socket.on('metrics:subscribe', () => {
    socket.join(METRICS_ROOM);

    // Send the latest cached metrics immediately so the client doesn't
    // have to wait for the next 5-second tick
    const latest = resourceWidget.getLatestUpdate();
    if (latest) {
      socket.emit('resource:update', latest);
    }

    socket.emit('metrics:subscribed', { interval: 5000 });
  });

  // ─── metrics:unsubscribe ─────────────────────────────────────────────────

  socket.on('metrics:unsubscribe', () => {
    socket.leave(METRICS_ROOM);
    socket.emit('metrics:unsubscribed', {});
  });

  // ─── Cleanup on disconnect ───────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Socket.IO automatically removes the socket from all rooms on disconnect
  });
}

// ─── Utility: Start metrics broadcasting ───────────────────────────────────────

/**
 * Start the resource widget monitoring loop that broadcasts metrics to all
 * connected clients every 5 seconds.
 *
 * This should be called once during server initialization, not per-socket.
 */
export function startMetricsBroadcast(
  io: SocketIOServer,
  resourceWidget: ResourceWidget
): void {
  resourceWidget.startMonitoring(io);
}

/**
 * Stop the resource widget monitoring loop.
 */
export function stopMetricsBroadcast(resourceWidget: ResourceWidget): void {
  resourceWidget.stopMonitoring();
}
