"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComposeManager = createComposeManager;
exports.isComposeFileName = isComposeFileName;
/**
 * Docker Compose Manager Module
 *
 * Provides Docker Compose file discovery and lifecycle operations
 * (up, down, pull) with timeout handling and output capture.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
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
function createComposeManager(config) {
    const rootDir = (0, node_path_1.resolve)(config?.rootDir ?? DEFAULT_ROOT_DIR);
    const maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
    const upTimeoutMs = config?.upTimeoutMs ?? DEFAULT_UP_TIMEOUT_MS;
    const downTimeoutMs = config?.downTimeoutMs ?? DEFAULT_DOWN_TIMEOUT_MS;
    const pullTimeoutMs = config?.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
    const composeBinary = config?.composeBinary ?? DEFAULT_COMPOSE_BINARY;
    // ─── Helpers ─────────────────────────────────────────────────────────────
    function isComposeFileName(fileName) {
        return COMPOSE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
    }
    async function scanDirectory(dir, currentDepth) {
        if (currentDepth > maxDepth) {
            return [];
        }
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir);
        }
        catch {
            // Directory not readable or doesn't exist
            return [];
        }
        const results = [];
        const subdirs = [];
        for (const entry of entries) {
            const fullPath = (0, node_path_1.join)(dir, entry);
            let entryStat;
            try {
                entryStat = await (0, promises_1.stat)(fullPath);
            }
            catch {
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
            }
            else if (entryStat.isDirectory()) {
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
    function executeComposeCommand(filePath, args, timeoutMs) {
        return new Promise((resolvePromise) => {
            const resolvedPath = (0, node_path_1.resolve)(filePath);
            const fullArgs = ['-f', resolvedPath, ...args];
            let output = '';
            let timedOut = false;
            let processExited = false;
            const child = (0, node_child_process_1.spawn)(composeBinary, fullArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                // Run from the compose file's directory
                cwd: resolvedPath.substring(0, resolvedPath.lastIndexOf('/') || resolvedPath.lastIndexOf('\\')),
            });
            // Collect stdout
            child.stdout?.on('data', (data) => {
                output += data.toString();
            });
            // Collect stderr
            child.stderr?.on('data', (data) => {
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
                }
                else if (code === 0) {
                    resolvePromise({
                        success: true,
                        output,
                        exitCode: 0,
                    });
                }
                else {
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
    async function discoverComposeFiles() {
        return scanDirectory(rootDir, 0);
    }
    async function composeUp(filePath) {
        return executeComposeCommand(filePath, ['up', '-d'], upTimeoutMs);
    }
    async function composeDown(filePath) {
        return executeComposeCommand(filePath, ['down'], downTimeoutMs);
    }
    async function composePull(filePath) {
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
function isComposeFileName(fileName) {
    return COMPOSE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}
//# sourceMappingURL=compose-manager.js.map