/**
 * Compose Manager Unit Tests
 *
 * Tests for Docker Compose file discovery, compose-up, compose-down,
 * compose-pull operations with timeout handling and output capture.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { createComposeManager, isComposeFileName } from '../../src/modules/compose-manager.js';
import type { ComposeManager } from '../../src/modules/compose-manager.js';

// ─── Mock node:child_process ───────────────────────────────────────────────────

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// ─── Mock node:fs/promises ─────────────────────────────────────────────────────

const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args: any[]) => mockReaddir(...args),
  stat: (...args: any[]) => mockStat(...args),
}));

// ─── Helper: create a mock child process ───────────────────────────────────────

function createMockChildProcess(options?: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  delayMs?: number;
}) {
  const { exitCode = 0, stdout = '', stderr = '', error, delayMs = 0 } = options ?? {};

  const stdoutListeners: Array<(data: Buffer) => void> = [];
  const stderrListeners: Array<(data: Buffer) => void> = [];
  const closeListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];

  const child = {
    stdout: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutListeners.push(cb);
      },
    },
    stderr: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrListeners.push(cb);
      },
    },
    on: (event: string, cb: any) => {
      if (event === 'close') closeListeners.push(cb);
      if (event === 'error') errorListeners.push(cb);
    },
    kill: vi.fn(),
    pid: 12345,
  };

  // Emit data and close asynchronously
  setTimeout(() => {
    if (error) {
      for (const cb of errorListeners) cb(error);
      return;
    }

    if (stdout) {
      for (const cb of stdoutListeners) cb(Buffer.from(stdout));
    }
    if (stderr) {
      for (const cb of stderrListeners) cb(Buffer.from(stderr));
    }
    for (const cb of closeListeners) cb(exitCode);
  }, delayMs);

  return child;
}

// ─── Helper: set up filesystem mock ────────────────────────────────────────────

interface MockFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  children?: MockFsEntry[];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function setupFileSystemMock(rootPath: string, tree: MockFsEntry[]) {
  const dirContents = new Map<string, string[]>();
  const statResults = new Map<string, { isFile: () => boolean; isDirectory: () => boolean }>();

  function buildMaps(basePath: string, entries: MockFsEntry[]) {
    const names = entries.map((e) => e.name);
    dirContents.set(normalizePath(basePath), names);

    for (const entry of entries) {
      const fullPath = join(basePath, entry.name);
      statResults.set(normalizePath(fullPath), {
        isFile: () => entry.isFile,
        isDirectory: () => entry.isDirectory,
      });

      if (entry.isDirectory && entry.children) {
        buildMaps(fullPath, entry.children);
      }
    }
  }

  // Use resolve to match what the module will do internally
  const resolvedRoot = resolve(rootPath);
  buildMaps(resolvedRoot, tree);

  mockReaddir.mockImplementation(async (dir: string) => {
    const normalized = normalizePath(dir);
    const contents = dirContents.get(normalized);
    if (contents !== undefined) return contents;
    throw new Error(`ENOENT: no such file or directory '${dir}'`);
  });

  mockStat.mockImplementation(async (filePath: string) => {
    const normalized = normalizePath(filePath);
    const result = statResults.get(normalized);
    if (result) return result;
    throw new Error(`ENOENT: no such file or directory '${filePath}'`);
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Compose Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── isComposeFileName ───────────────────────────────────────────────────

  describe('isComposeFileName', () => {
    it('should match docker-compose.yml', () => {
      expect(isComposeFileName('docker-compose.yml')).toBe(true);
    });

    it('should match docker-compose.*.yml patterns', () => {
      expect(isComposeFileName('docker-compose.prod.yml')).toBe(true);
      expect(isComposeFileName('docker-compose.dev.yml')).toBe(true);
      expect(isComposeFileName('docker-compose.override.yml')).toBe(true);
      expect(isComposeFileName('docker-compose.full-stack.yml')).toBe(true);
    });

    it('should match compose.yml', () => {
      expect(isComposeFileName('compose.yml')).toBe(true);
    });

    it('should not match unrelated files', () => {
      expect(isComposeFileName('Dockerfile')).toBe(false);
      expect(isComposeFileName('package.json')).toBe(false);
      expect(isComposeFileName('docker-compose.yaml')).toBe(false);
      expect(isComposeFileName('compose.yaml')).toBe(false);
      expect(isComposeFileName('my-docker-compose.yml')).toBe(false);
      expect(isComposeFileName('docker-compose.yml.bak')).toBe(false);
    });

    it('should not match docker-compose..yml (empty middle segment)', () => {
      // The pattern /^docker-compose\..+\.yml$/ cannot match "docker-compose..yml"
      // because after matching the first \. there is only ".yml" left, and .+\.yml 
      // cannot match that (needs at least one char before the last .yml)
      expect(isComposeFileName('docker-compose..yml')).toBe(false);
    });
  });

  // ─── discoverComposeFiles ────────────────────────────────────────────────

  describe('discoverComposeFiles', () => {
    it('should find compose files in the root directory', async () => {
      setupFileSystemMock('/opt/aivery', [
        { name: 'docker-compose.yml', isFile: true, isDirectory: false },
        { name: 'src', isFile: false, isDirectory: true, children: [] },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('docker-compose.yml');
      expect(files[0].depth).toBe(0);
    });

    it('should find compose files recursively in subdirectories', async () => {
      setupFileSystemMock('/opt/aivery', [
        { name: 'docker-compose.yml', isFile: true, isDirectory: false },
        {
          name: 'backend',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'docker-compose.prod.yml', isFile: true, isDirectory: false },
            {
              name: 'services',
              isFile: false,
              isDirectory: true,
              children: [
                { name: 'compose.yml', isFile: true, isDirectory: false },
              ],
            },
          ],
        },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(3);
      expect(files.map((f) => f.fileName).sort()).toEqual([
        'compose.yml',
        'docker-compose.prod.yml',
        'docker-compose.yml',
      ]);
    });

    it('should respect maxDepth limit', async () => {
      // Create a deeply nested structure
      setupFileSystemMock('/opt/aivery', [
        {
          name: 'level1',
          isFile: false,
          isDirectory: true,
          children: [
            {
              name: 'level2',
              isFile: false,
              isDirectory: true,
              children: [
                { name: 'docker-compose.yml', isFile: true, isDirectory: false },
              ],
            },
          ],
        },
      ]);

      // With maxDepth 1, should not find the file at depth 2
      const manager = createComposeManager({ rootDir: '/opt/aivery', maxDepth: 1 });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(0);
    });

    it('should find files at exactly maxDepth', async () => {
      setupFileSystemMock('/opt/aivery', [
        {
          name: 'level1',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'docker-compose.yml', isFile: true, isDirectory: false },
          ],
        },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery', maxDepth: 1 });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(1);
      expect(files[0].depth).toBe(1);
    });

    it('should skip node_modules, .git, and __pycache__ directories', async () => {
      setupFileSystemMock('/opt/aivery', [
        {
          name: 'node_modules',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'docker-compose.yml', isFile: true, isDirectory: false },
          ],
        },
        {
          name: '.git',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'docker-compose.yml', isFile: true, isDirectory: false },
          ],
        },
        {
          name: '__pycache__',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'docker-compose.yml', isFile: true, isDirectory: false },
          ],
        },
        { name: 'docker-compose.yml', isFile: true, isDirectory: false },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('docker-compose.yml');
    });

    it('should handle unreadable directories gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(0);
    });

    it('should handle non-existent root directory', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const manager = createComposeManager({ rootDir: '/nonexistent' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(0);
    });

    it('should return empty array when no compose files found', async () => {
      setupFileSystemMock('/opt/aivery', [
        { name: 'package.json', isFile: true, isDirectory: false },
        { name: 'Dockerfile', isFile: true, isDirectory: false },
        {
          name: 'src',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'index.ts', isFile: true, isDirectory: false },
          ],
        },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      expect(files).toHaveLength(0);
    });

    it('should include correct filePath, directory, and depth for each file', async () => {
      setupFileSystemMock('/opt/aivery', [
        {
          name: 'project',
          isFile: false,
          isDirectory: true,
          children: [
            { name: 'compose.yml', isFile: true, isDirectory: false },
          ],
        },
      ]);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const files = await manager.discoverComposeFiles();

      const expectedDir = join(resolve('/opt/aivery'), 'project');
      const expectedFile = join(resolve('/opt/aivery'), 'project', 'compose.yml');

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        filePath: expectedFile,
        directory: expectedDir,
        fileName: 'compose.yml',
        depth: 1,
      });
    });

    it('should use default root /opt/aivery when no config provided', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const manager = createComposeManager();
      await manager.discoverComposeFiles();

      // On Windows the path resolution may differ, but the call should be made
      expect(mockReaddir).toHaveBeenCalled();
    });
  });

  // ─── composeUp ───────────────────────────────────────────────────────────

  describe('composeUp', () => {
    it('should execute docker-compose up -d with the file path', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 0,
        stdout: 'Creating network... done\nCreating service... done\n',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composeUp('/opt/aivery/project/docker-compose.yml');

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Creating network... done');
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker-compose',
        expect.arrayContaining(['-f', expect.stringContaining('docker-compose.yml'), 'up', '-d']),
        expect.any(Object)
      );
    });

    it('should return failure with exit code on non-zero exit', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 1,
        stderr: 'Error: service "web" depends on undefined service "db"',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composeUp('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('depends on undefined service');
      expect(result.error).toBe('Command failed with exit code 1');
    });

    it('should kill the process and return timeout error after 120s', async () => {
      vi.useFakeTimers();

      // Process that never exits
      const closeListeners: Array<(code: number | null) => void> = [];
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: any) => {
          if (event === 'close') closeListeners.push(cb);
        },
        kill: vi.fn(() => {
          // Simulate process exit after kill
          setTimeout(() => {
            for (const cb of closeListeners) cb(null);
          }, 0);
        }),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        upTimeoutMs: 120_000,
      });

      const resultPromise = manager.composeUp('/opt/aivery/docker-compose.yml');

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(120_001);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(null);
      expect(result.error).toContain('timed out after 120s');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should handle spawn errors gracefully', async () => {
      const mockChild = createMockChildProcess({
        error: new Error('ENOENT: docker-compose not found'),
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composeUp('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(null);
      expect(result.error).toContain('Failed to execute command');
      expect(result.error).toContain('docker-compose not found');
    });

    it('should combine stdout and stderr in output', async () => {
      const stdoutListeners: Array<(data: Buffer) => void> = [];
      const stderrListeners: Array<(data: Buffer) => void> = [];
      const closeListeners: Array<(code: number | null) => void> = [];

      const mockChild = {
        stdout: {
          on: (event: string, cb: (data: Buffer) => void) => {
            if (event === 'data') stdoutListeners.push(cb);
          },
        },
        stderr: {
          on: (event: string, cb: (data: Buffer) => void) => {
            if (event === 'data') stderrListeners.push(cb);
          },
        },
        on: (event: string, cb: any) => {
          if (event === 'close') closeListeners.push(cb);
        },
        kill: vi.fn(),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const resultPromise = manager.composeUp('/opt/aivery/docker-compose.yml');

      // Emit stdout and stderr
      setTimeout(() => {
        for (const cb of stdoutListeners) cb(Buffer.from('stdout data\n'));
        for (const cb of stderrListeners) cb(Buffer.from('stderr data\n'));
        for (const cb of closeListeners) cb(0);
      }, 0);

      const result = await resultPromise;

      expect(result.output).toContain('stdout data');
      expect(result.output).toContain('stderr data');
    });

    it('should use custom compose binary when configured', async () => {
      const mockChild = createMockChildProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        composeBinary: 'docker compose',
      });
      await manager.composeUp('/opt/aivery/docker-compose.yml');

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker compose',
        expect.any(Array),
        expect.any(Object)
      );
    });
  });

  // ─── composeDown ─────────────────────────────────────────────────────────

  describe('composeDown', () => {
    it('should execute docker-compose down with the file path', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 0,
        stdout: 'Stopping service... done\nRemoving network... done\n',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composeDown('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker-compose',
        expect.arrayContaining(['-f', expect.any(String), 'down']),
        expect.any(Object)
      );
    });

    it('should return failure with exit code on error', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 1,
        stderr: 'Error: No containers to stop',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composeDown('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('Command failed with exit code 1');
    });

    it('should use 120s timeout for down command', async () => {
      vi.useFakeTimers();

      const closeListeners: Array<(code: number | null) => void> = [];
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: any) => {
          if (event === 'close') closeListeners.push(cb);
        },
        kill: vi.fn(() => {
          setTimeout(() => {
            for (const cb of closeListeners) cb(null);
          }, 0);
        }),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        downTimeoutMs: 120_000,
      });

      const resultPromise = manager.composeDown('/opt/aivery/docker-compose.yml');

      await vi.advanceTimersByTimeAsync(120_001);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out after 120s');

      vi.useRealTimers();
    });
  });

  // ─── composePull ─────────────────────────────────────────────────────────

  describe('composePull', () => {
    it('should execute docker-compose pull with the file path', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 0,
        stdout: 'Pulling web... done\nPulling db... done\n',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composePull('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Pulling web... done');
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker-compose',
        expect.arrayContaining(['-f', expect.any(String), 'pull']),
        expect.any(Object)
      );
    });

    it('should return failure when pull fails', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 1,
        stderr: 'Error: pull access denied for private-image',
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({ rootDir: '/opt/aivery' });
      const result = await manager.composePull('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('pull access denied');
    });

    it('should use 300s timeout for pull command', async () => {
      vi.useFakeTimers();

      const closeListeners: Array<(code: number | null) => void> = [];
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: any) => {
          if (event === 'close') closeListeners.push(cb);
        },
        kill: vi.fn(() => {
          setTimeout(() => {
            for (const cb of closeListeners) cb(null);
          }, 0);
        }),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        pullTimeoutMs: 300_000,
      });

      const resultPromise = manager.composePull('/opt/aivery/docker-compose.yml');

      await vi.advanceTimersByTimeAsync(300_001);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out after 300s');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should not timeout if process completes within time limit', async () => {
      const mockChild = createMockChildProcess({
        exitCode: 0,
        stdout: 'Pull complete',
        delayMs: 5,
      });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        pullTimeoutMs: 300_000,
      });
      const result = await manager.composePull('/opt/aivery/docker-compose.yml');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ─── Configuration ───────────────────────────────────────────────────────

  describe('Configuration', () => {
    it('should use default values when no config provided', async () => {
      const mockChild = createMockChildProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockChild);

      const manager = createComposeManager();
      await manager.composeUp('/opt/aivery/docker-compose.yml');

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker-compose',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('should accept custom timeout values', async () => {
      vi.useFakeTimers();

      const closeListeners: Array<(code: number | null) => void> = [];
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: any) => {
          if (event === 'close') closeListeners.push(cb);
        },
        kill: vi.fn(() => {
          setTimeout(() => {
            for (const cb of closeListeners) cb(null);
          }, 0);
        }),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(mockChild);

      // Use a very short timeout
      const manager = createComposeManager({
        rootDir: '/opt/aivery',
        upTimeoutMs: 5000,
      });

      const resultPromise = manager.composeUp('/opt/aivery/docker-compose.yml');

      await vi.advanceTimersByTimeAsync(5001);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out after 5s');

      vi.useRealTimers();
    });
  });
});
