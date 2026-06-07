import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTerminalManager,
  XTERM_RECOMMENDED_CONFIG,
  RECONNECT_CONFIG,
  type TerminalManager,
  type PtySpawner,
  type IPty,
} from '../../src/modules/terminal-manager.js';

/**
 * Unit tests for Terminal Manager module.
 *
 * These tests mock node-pty since PTY allocation requires a real terminal.
 * We test the session management logic, resize handling, cleanup, and
 * Socket.IO integration behavior.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8, 10.9
 */

// --- Mock Helpers ---

function createMockPty(overrides?: Partial<IPty>): IPty {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  return {
    pid: Math.floor(Math.random() * 10000) + 1000,
    onData: (callback: (data: string) => void) => {
      dataCallbacks.push(callback);
      return { dispose: () => { const idx = dataCallbacks.indexOf(callback); if (idx >= 0) dataCallbacks.splice(idx, 1); } };
    },
    onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => {
      exitCallbacks.push(callback);
      return { dispose: () => { const idx = exitCallbacks.indexOf(callback); if (idx >= 0) exitCallbacks.splice(idx, 1); } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Expose callbacks for triggering in tests
    _triggerData: (data: string) => dataCallbacks.forEach((cb) => cb(data)),
    _triggerExit: (e: { exitCode: number; signal?: number }) => exitCallbacks.forEach((cb) => cb(e)),
    ...overrides,
  } as IPty & { _triggerData: (data: string) => void; _triggerExit: (e: { exitCode: number; signal?: number }) => void };
}

function createMockSpawner(mockPty?: IPty): PtySpawner & { lastSpawnArgs: any; spawnCount: number } {
  const spawner = {
    lastSpawnArgs: null as any,
    spawnCount: 0,
    spawn(shell: string, args: string[], options: any) {
      spawner.lastSpawnArgs = { shell, args, options };
      spawner.spawnCount++;
      return mockPty ?? createMockPty();
    },
  };
  return spawner;
}

function createMockSocketIO() {
  const emitted: Array<{ room: string; event: string; data: any }> = [];
  return {
    to: (room: string) => ({
      emit: (event: string, data: any) => {
        emitted.push({ room, event, data });
      },
    }),
    emitted,
  };
}

// --- Tests ---

describe('Terminal Manager', () => {
  let terminalManager: TerminalManager;
  let spawner: ReturnType<typeof createMockSpawner>;
  let mockPty: ReturnType<typeof createMockPty>;

  beforeEach(() => {
    mockPty = createMockPty();
    spawner = createMockSpawner(mockPty);
    terminalManager = createTerminalManager(spawner, null);
  });

  describe('createSession', () => {
    it('should create a session with default shell (bash)', async () => {
      const session = await terminalManager.createSession('user-1');

      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      expect(session.userId).toBe('user-1');
      expect(session.shell).toBe('bash');
      expect(session.pid).toBe(mockPty.pid);
      expect(session.createdAt).toBeInstanceOf(Date);
    });

    it('should spawn PTY with correct parameters', async () => {
      await terminalManager.createSession('user-1');

      expect(spawner.lastSpawnArgs.shell).toBe('bash');
      expect(spawner.lastSpawnArgs.args).toEqual([]);
      expect(spawner.lastSpawnArgs.options.name).toBe('xterm-256color');
      expect(spawner.lastSpawnArgs.options.cols).toBe(80);
      expect(spawner.lastSpawnArgs.options.rows).toBe(24);
    });

    it('should create a session with specified shell', async () => {
      const session = await terminalManager.createSession('user-1', 'zsh');

      expect(session.shell).toBe('zsh');
      expect(spawner.lastSpawnArgs.shell).toBe('zsh');
    });

    it('should fall back to default shell for invalid shell', async () => {
      const session = await terminalManager.createSession('user-1', 'fish');

      expect(session.shell).toBe('bash');
      expect(spawner.lastSpawnArgs.shell).toBe('bash');
    });

    it('should support sh shell', async () => {
      const session = await terminalManager.createSession('user-1', 'sh');

      expect(session.shell).toBe('sh');
      expect(spawner.lastSpawnArgs.shell).toBe('sh');
    });

    it('should create multiple independent sessions', async () => {
      const session1 = await terminalManager.createSession('user-1');
      const session2 = await terminalManager.createSession('user-1');

      expect(session1.id).not.toBe(session2.id);
      expect(spawner.spawnCount).toBe(2);
    });

    it('should assign unique IDs to each session', async () => {
      const sessions = await Promise.all([
        terminalManager.createSession('user-1'),
        terminalManager.createSession('user-2'),
        terminalManager.createSession('user-1'),
      ]);

      const ids = sessions.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('resizeSession', () => {
    it('should resize the PTY with new dimensions', async () => {
      const session = await terminalManager.createSession('user-1');
      terminalManager.resizeSession(session.id, 120, 40);

      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should enforce minimum dimensions of 1x1', async () => {
      const session = await terminalManager.createSession('user-1');
      terminalManager.resizeSession(session.id, 0, -5);

      expect(mockPty.resize).toHaveBeenCalledWith(1, 1);
    });

    it('should floor fractional dimensions', async () => {
      const session = await terminalManager.createSession('user-1');
      terminalManager.resizeSession(session.id, 80.7, 24.3);

      expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
    });

    it('should throw for non-existent session', () => {
      expect(() => terminalManager.resizeSession('nonexistent', 80, 24)).toThrow(
        'Session not found: nonexistent'
      );
    });
  });

  describe('closeSession', () => {
    it('should kill the PTY process', async () => {
      const session = await terminalManager.createSession('user-1');
      terminalManager.closeSession(session.id);

      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('should remove session from active sessions', async () => {
      const session = await terminalManager.createSession('user-1');
      terminalManager.closeSession(session.id);

      const active = terminalManager.getActiveSessions('user-1');
      expect(active).toHaveLength(0);
    });

    it('should not throw for non-existent session', () => {
      expect(() => terminalManager.closeSession('nonexistent')).not.toThrow();
    });

    it('should handle PTY already dead gracefully', async () => {
      const deadPty = createMockPty({
        kill: vi.fn(() => { throw new Error('Process already dead'); }),
      });
      const deadSpawner = createMockSpawner(deadPty);
      const manager = createTerminalManager(deadSpawner, null);

      const session = await manager.createSession('user-1');
      // Should not throw even if kill fails
      expect(() => manager.closeSession(session.id)).not.toThrow();
    });
  });

  describe('closeAllSessions', () => {
    it('should close all sessions for a specific user', async () => {
      // Create multiple PTYs that track kills
      const kills: string[] = [];
      let callCount = 0;
      const multiSpawner: PtySpawner = {
        spawn(_shell, _args, _options) {
          const id = `pty-${callCount++}`;
          const pty = createMockPty({
            kill: vi.fn(() => { kills.push(id); }),
          });
          return pty;
        },
      };

      const manager = createTerminalManager(multiSpawner, null);

      await manager.createSession('user-1');
      await manager.createSession('user-1');
      await manager.createSession('user-2');

      manager.closeAllSessions('user-1');

      expect(manager.getActiveSessions('user-1')).toHaveLength(0);
      expect(manager.getActiveSessions('user-2')).toHaveLength(1);
      expect(kills).toHaveLength(2);
    });

    it('should not affect other users sessions', async () => {
      let callCount = 0;
      const multiSpawner: PtySpawner = {
        spawn(_shell, _args, _options) {
          callCount++;
          return createMockPty();
        },
      };
      const manager = createTerminalManager(multiSpawner, null);

      await manager.createSession('user-1');
      await manager.createSession('user-2');
      await manager.createSession('user-2');

      manager.closeAllSessions('user-1');

      expect(manager.getActiveSessions('user-1')).toHaveLength(0);
      expect(manager.getActiveSessions('user-2')).toHaveLength(2);
    });

    it('should handle no sessions for user gracefully', () => {
      expect(() => terminalManager.closeAllSessions('nonexistent-user')).not.toThrow();
    });
  });

  describe('getActiveSessions', () => {
    it('should return empty array for user with no sessions', () => {
      const sessions = terminalManager.getActiveSessions('user-1');
      expect(sessions).toEqual([]);
    });

    it('should return all active sessions for a user', async () => {
      await terminalManager.createSession('user-1', 'bash');
      await terminalManager.createSession('user-1', 'zsh');

      const sessions = terminalManager.getActiveSessions('user-1');
      expect(sessions).toHaveLength(2);
      expect(sessions[0].userId).toBe('user-1');
      expect(sessions[1].userId).toBe('user-1');
    });

    it('should not include sessions from other users', async () => {
      await terminalManager.createSession('user-1');
      await terminalManager.createSession('user-2');

      const sessions = terminalManager.getActiveSessions('user-1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe('user-1');
    });

    it('should not include closed sessions', async () => {
      const session = await terminalManager.createSession('user-1');
      await terminalManager.createSession('user-1');

      terminalManager.closeSession(session.id);

      const sessions = terminalManager.getActiveSessions('user-1');
      expect(sessions).toHaveLength(1);
    });

    it('should return session data without internal PTY reference', async () => {
      await terminalManager.createSession('user-1');

      const sessions = terminalManager.getActiveSessions('user-1');
      const session = sessions[0];

      // Should only have public fields
      expect(Object.keys(session).sort()).toEqual(
        ['createdAt', 'id', 'pid', 'shell', 'userId'].sort()
      );
    });
  });

  describe('PTY exit handling', () => {
    it('should clean up session when PTY process exits', async () => {
      const session = await terminalManager.createSession('user-1');

      // Simulate PTY exit
      (mockPty as any)._triggerExit({ exitCode: 0 });

      const sessions = terminalManager.getActiveSessions('user-1');
      expect(sessions).toHaveLength(0);
    });
  });

  describe('Socket.IO data streaming', () => {
    it('should emit terminal:data events when PTY produces output', async () => {
      const mockIO = createMockSocketIO();
      const manager = createTerminalManager(spawner, mockIO as any);

      const session = await manager.createSession('user-1');

      // Simulate PTY output
      (mockPty as any)._triggerData('Hello, world!\r\n');

      expect(mockIO.emitted).toHaveLength(1);
      expect(mockIO.emitted[0]).toEqual({
        room: `terminal:${session.id}`,
        event: 'terminal:data',
        data: { sessionId: session.id, data: 'Hello, world!\r\n' },
      });
    });

    it('should emit terminal:exit events when PTY exits', async () => {
      const mockIO = createMockSocketIO();
      const manager = createTerminalManager(spawner, mockIO as any);

      const session = await manager.createSession('user-1');

      // Simulate PTY exit
      (mockPty as any)._triggerExit({ exitCode: 0 });

      const exitEvents = mockIO.emitted.filter((e) => e.event === 'terminal:exit');
      expect(exitEvents).toHaveLength(1);
      expect(exitEvents[0]).toEqual({
        room: `terminal:${session.id}`,
        event: 'terminal:exit',
        data: { sessionId: session.id, exitCode: 0 },
      });
    });

    it('should not throw when no Socket.IO server is provided', async () => {
      const manager = createTerminalManager(spawner, null);
      const session = await manager.createSession('user-1');

      // Simulate PTY output - should not throw
      expect(() => (mockPty as any)._triggerData('test')).not.toThrow();
    });
  });

  describe('configurable shell', () => {
    it('should use custom default shell from config', async () => {
      const manager = createTerminalManager(spawner, null, { defaultShell: 'zsh' });
      const session = await manager.createSession('user-1');

      expect(session.shell).toBe('zsh');
      expect(spawner.lastSpawnArgs.shell).toBe('zsh');
    });

    it('should use custom allowed shells from config', async () => {
      const manager = createTerminalManager(spawner, null, {
        allowedShells: ['bash', 'fish'],
      });

      // fish is now allowed
      const session = await manager.createSession('user-1', 'fish');
      expect(session.shell).toBe('fish');

      // zsh is no longer allowed, falls back to default
      const session2 = await manager.createSession('user-1', 'zsh');
      expect(session2.shell).toBe('bash');
    });
  });

  describe('session expiry cleanup (Requirement 10.8)', () => {
    it('should close all terminal sessions when user auth expires', async () => {
      let callCount = 0;
      const multiSpawner: PtySpawner = {
        spawn() {
          callCount++;
          return createMockPty();
        },
      };
      const manager = createTerminalManager(multiSpawner, null);

      await manager.createSession('user-1');
      await manager.createSession('user-1');
      await manager.createSession('user-1');

      expect(manager.getActiveSessions('user-1')).toHaveLength(3);

      // Simulate auth session expiry by calling closeAllSessions
      manager.closeAllSessions('user-1');

      expect(manager.getActiveSessions('user-1')).toHaveLength(0);
    });
  });

  describe('constants and configuration', () => {
    it('should export recommended xterm.js config with 5000-line scrollback', () => {
      expect(XTERM_RECOMMENDED_CONFIG.scrollback).toBe(5000);
      expect(XTERM_RECOMMENDED_CONFIG.cursorBlink).toBe(true);
      expect(XTERM_RECOMMENDED_CONFIG.fontSize).toBe(14);
    });

    it('should export reconnect config with 3 attempts at 2-second intervals', () => {
      expect(RECONNECT_CONFIG.attempts).toBe(3);
      expect(RECONNECT_CONFIG.intervalMs).toBe(2000);
    });
  });
});
