/**
 * Socket.IO Alert Notification Event Handlers
 *
 * Handles in-app alert delivery to connected clients:
 * - alert:subscribe — Opt-in to receive alert notifications
 * - alert:unsubscribe — Stop receiving alert notifications
 * - alert:history — Request alert history
 *
 * Alerts are broadcast to the `alerts:subscribers` room when the AlertSystem
 * emits in-app notifications via its onInAppNotification callback.
 *
 * Requirements: 14.3
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AlertSystem } from '../modules/alert-system.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const ALERTS_ROOM = 'alerts:subscribers';

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register alert notification Socket.IO event handlers for a connected socket.
 */
export function registerAlertsHandlers(
  io: SocketIOServer,
  socket: Socket,
  alertSystem: AlertSystem
): void {
  // ─── alert:subscribe ─────────────────────────────────────────────────────

  socket.on('alert:subscribe', async () => {
    socket.join(ALERTS_ROOM);

    // Send recent alert history to the newly subscribed client
    try {
      const history = await alertSystem.getAlertHistory();
      // Send only the most recent 10 alerts as initial batch
      const recentAlerts = history.slice(0, 10);
      socket.emit('alert:history', { alerts: recentAlerts });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load alert history';
      socket.emit('alert:error', { message });
    }

    socket.emit('alert:subscribed', {});
  });

  // ─── alert:unsubscribe ───────────────────────────────────────────────────

  socket.on('alert:unsubscribe', () => {
    socket.leave(ALERTS_ROOM);
    socket.emit('alert:unsubscribed', {});
  });

  // ─── alert:history ───────────────────────────────────────────────────────

  socket.on('alert:history', async (payload?: { limit?: number }) => {
    try {
      const history = await alertSystem.getAlertHistory();
      const limit = payload?.limit ?? 50;
      const alerts = history.slice(0, limit);
      socket.emit('alert:history', { alerts });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load alert history';
      socket.emit('alert:error', { message });
    }
  });

  // ─── Cleanup on disconnect ───────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Socket.IO automatically removes the socket from all rooms on disconnect
  });
}

// ─── Utility: Create alert broadcast callback ──────────────────────────────────

/**
 * Create a callback function for the AlertSystem's onInAppNotification config.
 * This broadcasts alert notifications to all subscribed clients.
 *
 * Usage:
 * ```ts
 * const alertSystem = createAlertSystem(db, {
 *   onInAppNotification: createAlertBroadcaster(io),
 * });
 * ```
 */
export function createAlertBroadcaster(io: SocketIOServer) {
  return (alert: { id: string; timestamp: string; eventType: string; affectedResource: string; severity: string; message: string }): void => {
    io.to(ALERTS_ROOM).emit('alert:notification', {
      id: alert.id,
      timestamp: alert.timestamp,
      eventType: alert.eventType,
      affectedResource: alert.affectedResource,
      severity: alert.severity,
      message: alert.message,
    });
  };
}
