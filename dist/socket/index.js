"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSocketSession = getSocketSession;
exports.getSocketUserId = getSocketUserId;
exports.setupSocketHandlers = setupSocketHandlers;
exports.createAlertNotificationCallback = createAlertNotificationCallback;
const auth_js_1 = require("../middleware/auth.js");
const terminal_js_1 = require("./terminal.js");
const logs_js_1 = require("./logs.js");
const jobs_js_1 = require("./jobs.js");
const metrics_js_1 = require("./metrics.js");
const alerts_js_1 = require("./alerts.js");
const containers_js_1 = require("./containers.js");
// ─── Helper to extract session from authenticated socket ───────────────────────
/**
 * Extract the session attached by the auth middleware from a socket.
 */
function getSocketSession(socket) {
    return socket.session ?? null;
}
/**
 * Extract the user ID (username) from an authenticated socket.
 */
function getSocketUserId(socket) {
    const session = getSocketSession(socket);
    return session?.username ?? null;
}
// ─── Main Setup ────────────────────────────────────────────────────────────────
/**
 * Initialize Socket.IO with auth middleware and register all event handlers.
 *
 * @param io - The Socket.IO server instance
 * @param deps - All module dependencies needed by socket handlers
 */
function setupSocketHandlers(io, deps) {
    // Apply auth validation middleware to all connections
    io.use((0, auth_js_1.createSocketAuthMiddleware)(deps.authModule));
    // Register connection handler
    io.on('connection', (socket) => {
        const session = getSocketSession(socket);
        if (!session) {
            // This shouldn't happen since auth middleware rejects invalid connections,
            // but handle gracefully just in case
            socket.disconnect(true);
            return;
        }
        // Register all domain-specific event handlers
        (0, terminal_js_1.registerTerminalHandlers)(io, socket, deps.terminalManager);
        (0, logs_js_1.registerLogsHandlers)(io, socket, deps.logViewer);
        (0, jobs_js_1.registerJobsHandlers)(io, socket, deps.jobQueue);
        (0, metrics_js_1.registerMetricsHandlers)(io, socket, deps.resourceWidget);
        (0, alerts_js_1.registerAlertsHandlers)(io, socket, deps.alertSystem);
        (0, containers_js_1.registerContainersHandlers)(io, socket, deps.containerManager);
        // Join a user-specific room for targeted notifications
        socket.join(`user:${session.username}`);
        // Handle disconnect cleanup
        socket.on('disconnect', () => {
            // Individual handlers manage their own cleanup via socket 'disconnect' event
        });
    });
}
/**
 * Create the in-app alert notification callback for the AlertSystem.
 * This broadcasts alerts to all connected authenticated clients.
 */
function createAlertNotificationCallback(io) {
    return (alert) => {
        io.emit('alert:notification', {
            id: alert.id,
            timestamp: alert.timestamp,
            eventType: alert.eventType,
            affectedResource: alert.affectedResource,
            severity: alert.severity,
            message: alert.message,
        });
    };
}
//# sourceMappingURL=index.js.map