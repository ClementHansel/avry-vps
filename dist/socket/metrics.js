"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMetricsHandlers = registerMetricsHandlers;
exports.startMetricsBroadcast = startMetricsBroadcast;
exports.stopMetricsBroadcast = stopMetricsBroadcast;
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
function registerMetricsHandlers(io, socket, resourceWidget) {
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
function startMetricsBroadcast(io, resourceWidget) {
    resourceWidget.startMonitoring(io);
}
/**
 * Stop the resource widget monitoring loop.
 */
function stopMetricsBroadcast(resourceWidget) {
    resourceWidget.stopMonitoring();
}
//# sourceMappingURL=metrics.js.map