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
/**
 * Register resource metrics Socket.IO event handlers for a connected socket.
 *
 * The ResourceWidget emits `resource:update` globally to all connected clients.
 * This handler provides optional subscription management for clients that want
 * explicit control, and sends the latest cached update on subscribe.
 */
export declare function registerMetricsHandlers(io: SocketIOServer, socket: Socket, resourceWidget: ResourceWidget): void;
/**
 * Start the resource widget monitoring loop that broadcasts metrics to all
 * connected clients every 5 seconds.
 *
 * This should be called once during server initialization, not per-socket.
 */
export declare function startMetricsBroadcast(io: SocketIOServer, resourceWidget: ResourceWidget): void;
/**
 * Stop the resource widget monitoring loop.
 */
export declare function stopMetricsBroadcast(resourceWidget: ResourceWidget): void;
//# sourceMappingURL=metrics.d.ts.map