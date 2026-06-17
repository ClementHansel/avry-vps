"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTerminalHandlers = registerTerminalHandlers;
const index_js_1 = require("./index.js");
// ─── Handler Registration ──────────────────────────────────────────────────────
/**
 * Register terminal Socket.IO event handlers for a connected socket.
 */
function registerTerminalHandlers(io, socket, terminalManager) {
    const userId = (0, index_js_1.getSocketUserId)(socket);
    if (!userId)
        return;
    // ─── terminal:create ─────────────────────────────────────────────────────
    socket.on('terminal:create', async (payload) => {
        try {
            const session = await terminalManager.createSession(userId, payload?.shell);
            // Join the terminal room to receive output data
            socket.join(`terminal:${session.id}`);
            socket.emit('terminal:created', { session });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to create terminal session';
            socket.emit('terminal:error', { message });
        }
    });
    // ─── terminal:data ───────────────────────────────────────────────────────
    socket.on('terminal:data', (payload) => {
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
    socket.on('terminal:resize', (payload) => {
        if (!payload?.sessionId || !payload.cols || !payload.rows) {
            socket.emit('terminal:error', { message: 'Invalid terminal:resize payload' });
            return;
        }
        try {
            terminalManager.resizeSession(payload.sessionId, payload.cols, payload.rows);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to resize terminal';
            socket.emit('terminal:error', { message });
        }
    });
    // ─── terminal:close ──────────────────────────────────────────────────────
    socket.on('terminal:close', (payload) => {
        if (!payload?.sessionId) {
            socket.emit('terminal:error', { message: 'Invalid terminal:close payload' });
            return;
        }
        terminalManager.closeSession(payload.sessionId);
        socket.leave(`terminal:${payload.sessionId}`);
    });
    // ─── terminal:attach (reconnect support) ─────────────────────────────────
    socket.on('terminal:attach', (payload) => {
        if (!payload?.sessionId) {
            socket.emit('terminal:error', { message: 'Invalid terminal:attach payload' });
            return;
        }
        const sessions = terminalManager.getActiveSessions(userId);
        const session = sessions.find((s) => s.id === payload.sessionId);
        if (session) {
            socket.join(`terminal:${session.id}`);
            socket.emit('terminal:attached', { session });
        }
        else {
            socket.emit('terminal:error', { message: `Session not found: ${payload.sessionId}` });
        }
    });
    // ─── Cleanup on disconnect ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        // Don't close terminal sessions on disconnect — allow reconnection.
        // Sessions are cleaned up on auth session expiry via closeAllSessions.
    });
}
//# sourceMappingURL=terminal.js.map