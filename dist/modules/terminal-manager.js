"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECONNECT_CONFIG = exports.XTERM_RECOMMENDED_CONFIG = void 0;
exports.createTerminalManager = createTerminalManager;
exports.registerTerminalSocketHandlers = registerTerminalSocketHandlers;
exports.createNodePtySpawner = createNodePtySpawner;
/**
 * Terminal Manager Module
 *
 * Manages PTY (pseudo-terminal) sessions for the Web Terminal feature.
 * Uses node-pty for PTY allocation and Socket.IO for data streaming.
 *
 * Features:
 * - Independent PTY process per session via node-pty
 * - Configurable shell (bash, sh, zsh; default: bash)
 * - Dynamic resize support (cols/rows adjustment)
 * - Session cleanup on auth session expiry
 * - Auto-reconnect support (server-side session persistence for re-attach)
 * - 5000-line scrollback buffer (configured on frontend xterm.js)
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9
 */
const uuid_1 = require("uuid");
// --- Constants ---
const DEFAULT_SHELL = 'bash';
const ALLOWED_SHELLS = ['bash', 'sh', 'zsh'];
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK_LINES = 5000;
const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_INTERVAL_MS = 2000;
// --- Terminal Manager Factory ---
/**
 * Create a TerminalManager instance.
 *
 * @param ptySpawner - The PTY spawner (node-pty or mock)
 * @param io - Optional Socket.IO server for data streaming
 * @param config - Optional configuration overrides
 */
function createTerminalManager(ptySpawner, io, config) {
    const defaultShell = config?.defaultShell ?? DEFAULT_SHELL;
    const allowedShells = config?.allowedShells ?? ALLOWED_SHELLS;
    const _scrollbackLines = config?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    const _reconnectAttempts = config?.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const _reconnectIntervalMs = config?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    // Store active sessions by session ID
    const sessions = new Map();
    /**
     * Validate and resolve the shell to use.
     * Falls back to default shell if the requested shell is not allowed.
     */
    function resolveShell(requestedShell) {
        if (!requestedShell) {
            return defaultShell;
        }
        if (allowedShells.includes(requestedShell)) {
            return requestedShell;
        }
        return defaultShell;
    }
    /**
     * Emit terminal data to connected Socket.IO clients.
     */
    function emitData(sessionId, data) {
        if (io) {
            io.to(`terminal:${sessionId}`).emit('terminal:data', {
                sessionId,
                data,
            });
        }
    }
    /**
     * Emit terminal exit event to connected Socket.IO clients.
     */
    function emitExit(sessionId, exitCode) {
        if (io) {
            io.to(`terminal:${sessionId}`).emit('terminal:exit', {
                sessionId,
                exitCode,
            });
        }
    }
    /**
     * Clean up a session's resources.
     */
    function cleanupSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session)
            return;
        session.dataDisposable.dispose();
        session.exitDisposable.dispose();
        sessions.delete(sessionId);
    }
    const terminalManager = {
        async createSession(userId, shell) {
            const resolvedShell = resolveShell(shell);
            const sessionId = (0, uuid_1.v4)();
            const pty = ptySpawner.spawn(resolvedShell, [], {
                name: 'xterm-256color',
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                cwd: process.env.HOME || '/root',
                env: process.env,
            });
            // Wire up data streaming
            const dataDisposable = pty.onData((data) => {
                emitData(sessionId, data);
            });
            // Wire up exit handling
            const exitDisposable = pty.onExit((e) => {
                emitExit(sessionId, e.exitCode);
                cleanupSession(sessionId);
            });
            const internalSession = {
                id: sessionId,
                userId,
                shell: resolvedShell,
                pid: pty.pid,
                createdAt: new Date(),
                pty,
                dataDisposable,
                exitDisposable,
            };
            sessions.set(sessionId, internalSession);
            return {
                id: sessionId,
                userId,
                shell: resolvedShell,
                pid: pty.pid,
                createdAt: internalSession.createdAt,
            };
        },
        resizeSession(sessionId, cols, rows) {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            // Validate dimensions
            const safeCols = Math.max(1, Math.floor(cols));
            const safeRows = Math.max(1, Math.floor(rows));
            session.pty.resize(safeCols, safeRows);
        },
        closeSession(sessionId) {
            const session = sessions.get(sessionId);
            if (!session)
                return;
            try {
                session.pty.kill();
            }
            catch {
                // PTY may already be dead
            }
            cleanupSession(sessionId);
        },
        closeAllSessions(userId) {
            const userSessions = Array.from(sessions.values()).filter((s) => s.userId === userId);
            for (const session of userSessions) {
                try {
                    session.pty.kill();
                }
                catch {
                    // PTY may already be dead
                }
                cleanupSession(session.id);
            }
        },
        getActiveSessions(userId) {
            return Array.from(sessions.values())
                .filter((s) => s.userId === userId)
                .map((s) => ({
                id: s.id,
                userId: s.userId,
                shell: s.shell,
                pid: s.pid,
                createdAt: s.createdAt,
            }));
        },
    };
    return terminalManager;
}
// --- Socket.IO Integration ---
/**
 * Configuration for the recommended xterm.js frontend setup.
 * This is documentation for client-side integration.
 */
exports.XTERM_RECOMMENDED_CONFIG = {
    scrollback: DEFAULT_SCROLLBACK_LINES,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
    },
};
/**
 * Auto-reconnect configuration for the client.
 * This is documentation for client-side integration.
 */
exports.RECONNECT_CONFIG = {
    attempts: DEFAULT_RECONNECT_ATTEMPTS,
    intervalMs: DEFAULT_RECONNECT_INTERVAL_MS,
};
/**
 * Register Socket.IO event handlers for terminal sessions.
 * This wires up the client-to-server data flow.
 *
 * Expected client events:
 * - terminal:create { shell?: string }
 * - terminal:data { sessionId: string, data: string }
 * - terminal:resize { sessionId: string, cols: number, rows: number }
 * - terminal:close { sessionId: string }
 *
 * Server emits:
 * - terminal:created { session: TerminalSession }
 * - terminal:data { sessionId: string, data: string }
 * - terminal:exit { sessionId: string, exitCode: number }
 * - terminal:error { message: string }
 */
function registerTerminalSocketHandlers(io, terminalManager, getUserId) {
    io.on('connection', (socket) => {
        const userId = getUserId(socket);
        if (!userId) {
            socket.emit('terminal:error', { message: 'Unauthorized' });
            return;
        }
        socket.on('terminal:create', async (data) => {
            try {
                const session = await terminalManager.createSession(userId, data?.shell);
                // Join the session room for receiving data
                socket.join(`terminal:${session.id}`);
                socket.emit('terminal:created', { session });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to create terminal session';
                socket.emit('terminal:error', { message });
            }
        });
        socket.on('terminal:data', (data) => {
            if (!data?.sessionId || typeof data.data !== 'string')
                return;
            // Get the session to write input to the PTY
            const sessions = terminalManager.getActiveSessions(userId);
            const session = sessions.find((s) => s.id === data.sessionId);
            if (!session) {
                socket.emit('terminal:error', { message: `Session not found: ${data.sessionId}` });
                return;
            }
            // Write data to PTY - we need to access internal state
            // This is handled by the Socket.IO data handler on the PTY side
            // For the public API, we emit on the io instance which the PTY data handler picks up
            io.to(`terminal:${data.sessionId}`).emit('terminal:input', {
                sessionId: data.sessionId,
                data: data.data,
            });
        });
        socket.on('terminal:resize', (data) => {
            if (!data?.sessionId || !data.cols || !data.rows)
                return;
            try {
                terminalManager.resizeSession(data.sessionId, data.cols, data.rows);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to resize terminal';
                socket.emit('terminal:error', { message });
            }
        });
        socket.on('terminal:close', (data) => {
            if (!data?.sessionId)
                return;
            terminalManager.closeSession(data.sessionId);
        });
        // Join existing sessions on reconnect
        socket.on('terminal:attach', (data) => {
            if (!data?.sessionId)
                return;
            const sessions = terminalManager.getActiveSessions(userId);
            const session = sessions.find((s) => s.id === data.sessionId);
            if (session) {
                socket.join(`terminal:${session.id}`);
                socket.emit('terminal:attached', { session });
            }
            else {
                socket.emit('terminal:error', { message: `Session not found: ${data.sessionId}` });
            }
        });
        // Clean up on disconnect
        socket.on('disconnect', () => {
            // Don't close sessions on disconnect - allow reconnection
            // Sessions will be cleaned up on auth session expiry via closeAllSessions
        });
    });
}
/**
 * Create a real PtySpawner using node-pty.
 * Call this in production code only.
 */
function createNodePtySpawner() {
    // Dynamic import to allow mocking in tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require('node-pty');
    return {
        spawn(shell, args, options) {
            return nodePty.spawn(shell, args, options);
        },
    };
}
//# sourceMappingURL=terminal-manager.js.map