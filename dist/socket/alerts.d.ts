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
/**
 * Register alert notification Socket.IO event handlers for a connected socket.
 */
export declare function registerAlertsHandlers(io: SocketIOServer, socket: Socket, alertSystem: AlertSystem): void;
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
export declare function createAlertBroadcaster(io: SocketIOServer): (alert: {
    id: string;
    timestamp: string;
    eventType: string;
    affectedResource: string;
    severity: string;
    message: string;
}) => void;
//# sourceMappingURL=alerts.d.ts.map