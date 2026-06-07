/**
 * Docker Compose Manager Module
 *
 * Provides Docker Compose file discovery and lifecycle operations
 * (up, down, pull) with timeout handling and output capture.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface ComposeFile {
  /** Absolute path to the compose file */
  filePath: string;
  /** Directory containing the compose file */
  directory: string;
  /** File name (e.g., docker-compose.yml) */
  fileName: string;
  /** Depth from the root directory (0 = root) */
  depth: number;
}

export interface ComposeCommandResult {
  /** Whether the command succeeded (exit code 0) */
  success: boolean;
  /** Combined stdout and stderr output */
  output: string;
  /** Process exit code (null if killed by timeout) */
  exitCode: number | null;
  /** Error message if the command failed or timed out */
  error?: string;
}

export interface ComposeManager {
  /** Recursively discover compose files from the root directory up to maxDepth */
  discoverComposeFiles(): Promise<ComposeFile[]>;
  /** Run `docker-compose -f <file> up -d` with a 120s timeout */
  composeUp(filePath: string): Promise<ComposeCommandResult>;
  /** Run `docker-compose -f <file> down` with a 120s timeout */
  composeDown(filePath: string): Promise<ComposeCommandResult>;
  /** Run `docker-compose -f <file> pull` with a 300s timeout */
  composePull(filePath: string): Promise<ComposeCommandResult>;
}

export interface ComposeManagerConfig {
  /** Root directory to scan for compose files. Default: /opt/aivery */
  rootDir?: string;
  /** Maximum directory depth for recursive scanning. Default: 5 */
  maxDepth?: number;
  /** Timeout for compose-up in ms. Default: 120000 (120s) */
  upTimeoutMs?: number;
  /** Timeout for compose-down in ms. Default: 120000 (120s) */
  downTimeoutMs?: number;
  /** Timeout for compose-pull in ms. Default: 300000 (300s) */
  pullTimeoutMs?: number;
  /** Override the docker-compose binary path (for testing). Default: 'docker-compose' */
  composeBinary?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_ROOT_DIR = '/opt/aivery';
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_UP_TIMEOUT_MS = 120_000;
const DEFAULT_DOWN_TIMEOUT_MS = 120_000;
const DEFAULT_PULL_TIMEOUT_MS = 300_000;
const DEFAULT_COMPOSE_BINARY = 'docker-compose';

/**
 * Pattern matchers for compose file names.
 * Matches: docker-compose.yml, docker-compose.*.yml, compose.yml
 */
const COMPOSE_FILE_PATTERNS = [
  /^docker-compose\.yml$/,
  /^docker-compose\..+\.yml$/,
  /^compose\.yml$/,
];

// ─── Implementation ────────────────────────────────────────────────────────────

export function createComposeManager(config?: ComposeManagerConfig): ComposeManager {
  const rootDir = resolve(config?.rootDir ?? DEFAULT_ROOT_DIR);
  const maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const upTimeoutMs = config?.upTimeoutMs ?? DEFAULT_UP_TIMEOUT_MS;
  const downTimeoutMs = config?.downTimeoutMs ?? DEFAULT_DOWN_TIMEOUT_MS;
  const pullTimeoutMs = config?.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
  const composeBinary = config?.composeBinary ?? DEFAULT_COMPOSE_BINARY;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function isComposeFileName(fileName: string): boolean {
    return COMPOSE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
  }

  async function scanDirectory(dir: string, currentDepth: number): Promise<ComposeFile[]> {
    if (currentDepth > maxDepth) {
      return [];
    }

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Directory not readable or doesn't exist
      return [];
    }

    const results: ComposeFile[] = [];
    const subdirs: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        // Skip entries we can't stat
        continue;
      }

      if (entryStat.isFile() && isComposeFileName(entry)) {
        results.push({
          filePath: fullPath,
          directory: dir,
          fileName: entry,
          depth: currentDepth,
        });
      } else if (entryStat.isDirectory()) {
        // Skip common directories that shouldn't contain compose files
        if (entry === 'node_modules' || entry === '.git' || entry === '__pycache__') {
          continue;
        }
        subdirs.push(fullPath);
      }
    }

    // Recurse into subdirectories
    for (const subdir of subdirs) {
      const subResults = await scanDirectory(subdir, currentDepth + 1);
      results.push(...subResults);
    }

    return results;
  }

  function executeComposeCommand(
    filePath: string,
    args: string[],
    timeoutMs: number
  ): Promise<ComposeCommandResult> {
    return new Promise((resolvePromise) => {
      const resolvedPath = resolve(filePath);
      const fullArgs = ['-f', resolvedPath, ...args];

      let output = '';
      let timedOut = false;
      let processExited = false;

      const child = spawn(composeBinary, fullArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Run from the compose file's directory
        cwd: resolvedPath.substring(0, resolvedPath.lastIndexOf('/') || resolvedPath.lastIndexOf('\\')),
      });

      // Collect stdout
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      // Collect stderr
      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      // Set up timeout
      const timer = setTimeout(() => {
        if (!processExited) {
          timedOut = true;
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.on('close', (code) => {
        processExited = true;
        clearTimeout(timer);

        if (timedOut) {
          resolvePromise({
            success: false,
            output,
            exitCode: null,
            error: `Command timed out after ${timeoutMs / 1000}s`,
          });
        } else if (code === 0) {
          resolvePromise({
            success: true,
            output,
            exitCode: 0,
          });
        } else {
          resolvePromise({
            success: false,
            output,
            exitCode: code,
            error: `Command failed with exit code ${code}`,
          });
        }
      });

      child.on('error', (err) => {
        processExited = true;
        clearTimeout(timer);
        resolvePromise({
          success: false,
          output,
          exitCode: null,
          error: `Failed to execute command: ${err.message}`,
        });
      });
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async function discoverComposeFiles(): Promise<ComposeFile[]> {
    return scanDirectory(rootDir, 0);
  }

  async function composeUp(filePath: string): Promise<ComposeCommandResult> {
    return executeComposeCommand(filePath, ['up', '-d'], upTimeoutMs);
  }

  async function composeDown(filePath: string): Promise<ComposeCommandResult> {
    return executeComposeCommand(filePath, ['down'], downTimeoutMs);
  }

  async function composePull(filePath: string): Promise<ComposeCommandResult> {
    return executeComposeCommand(filePath, ['pull'], pullTimeoutMs);
  }

  return {
    discoverComposeFiles,
    composeUp,
    composeDown,
    composePull,
  };
}

// ─── Exported helpers for testing ──────────────────────────────────────────────

export function isComposeFileName(fileName: string): boolean {
  return COMPOSE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}
