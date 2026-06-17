import type { Server as SocketIOServer, Socket } from 'socket.io';
export interface TerminalSession {
    id: string;
    userId: string;
    shell: string;
    pid: number;
    createdAt: Date;
}
export interface TerminalManager {
    createSession(userId: string, shell?: string): Promise<TerminalSession>;
    resizeSession(sessionId: string, cols: number, rows: number): void;
    closeSession(sessionId: string): void;
    closeAllSessions(userId: string): void;
    getActiveSessions(userId: string): TerminalSession[];
}
export interface TerminalManagerConfig {
    defaultShell?: string;
    allowedShells?: string[];
    /** Scrollback buffer size for xterm.js frontend config (default: 5000) */
    scrollbackLines?: number;
    /** Auto-reconnect attempts (default: 3) */
    reconnectAttempts?: number;
    /** Auto-reconnect interval in ms (default: 2000) */
    reconnectIntervalMs?: number;
}
/**
 * IPty interface - abstracts node-pty's IPty for testability.
 */
export interface IPty {
    pid: number;
    onData: (callback: (data: string) => void) => {
        dispose: () => void;
    };
    onExit: (callback: (e: {
        exitCode: number;
        signal?: number;
    }) => void) => {
        dispose: () => void;
    };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
}
/**
 * PtySpawner interface - abstracts node-pty's spawn for testability.
 */
export interface PtySpawner {
    spawn(shell: string, args: string[], options: {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: Record<string, string>;
    }): IPty;
}
/**
 * Create a TerminalManager instance.
 *
 * @param ptySpawner - The PTY spawner (node-pty or mock)
 * @param io - Optional Socket.IO server for data streaming
 * @param config - Optional configuration overrides
 */
export declare function createTerminalManager(ptySpawner: PtySpawner, io?: SocketIOServer | null, config?: TerminalManagerConfig): TerminalManager;
/**
 * Configuration for the recommended xterm.js frontend setup.
 * This is documentation for client-side integration.
 */
export declare const XTERM_RECOMMENDED_CONFIG: {
    scrollback: number;
    cursorBlink: boolean;
    fontSize: number;
    fontFamily: string;
    theme: {
        background: string;
        foreground: string;
    };
};
/**
 * Auto-reconnect configuration for the client.
 * This is documentation for client-side integration.
 */
export declare const RECONNECT_CONFIG: {
    attempts: number;
    intervalMs: number;
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
export declare function registerTerminalSocketHandlers(io: SocketIOServer, terminalManager: TerminalManager, getUserId: (socket: Socket) => string | null): void;
/**
 * Create a real PtySpawner using node-pty.
 * Call this in production code only.
 */
export declare function createNodePtySpawner(): PtySpawner;
//# sourceMappingURL=terminal-manager.d.ts.map