"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTunnelManager = createTunnelManager;
const uuid_1 = require("uuid");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
// ─── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Generate a secure random auth token using UUID v4 (no dashes).
 */
function generateAuthToken() {
    return (0, uuid_1.v4)().replace(/-/g, '') + (0, uuid_1.v4)().replace(/-/g, '');
}
function parseConfigRow(row) {
    let excludePatterns = [];
    if (row.exclude_patterns) {
        try {
            excludePatterns = JSON.parse(row.exclude_patterns);
        }
        catch {
            excludePatterns = [];
        }
    }
    return {
        id: row.id,
        name: row.name,
        projectId: row.project_id ?? undefined,
        remotePath: row.remote_path,
        protocol: row.protocol,
        excludePatterns,
        postTransferCommand: row.post_transfer_command ?? undefined,
        authToken: row.auth_token,
        createdAt: row.created_at,
    };
}
function parseTransferRow(row) {
    return {
        id: row.id,
        tunnelId: row.tunnel_id,
        timestamp: row.timestamp,
        fileCount: row.file_count ?? 0,
        totalSize: row.total_size ?? 0,
        duration: row.duration ?? 0,
        status: row.status,
    };
}
// ─── Implementation ────────────────────────────────────────────────────────────
function createTunnelManager(config) {
    const { db, deps, baseUrl = '' } = config;
    // Track in-progress transfers per config to reject concurrent pushes
    const activeTransfers = new Set();
    // ─── Prepared Statements ─────────────────────────────────────────────────
    const insertConfigStmt = db.prepare(`
    INSERT INTO tunnel_configs (id, name, project_id, remote_path, protocol, exclude_patterns, post_transfer_command, auth_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const updateConfigStmt = db.prepare(`
    UPDATE tunnel_configs
    SET name = ?, project_id = ?, remote_path = ?, protocol = ?, exclude_patterns = ?, post_transfer_command = ?
    WHERE id = ?
  `);
    const deleteConfigStmt = db.prepare(`
    DELETE FROM tunnel_configs WHERE id = ?
  `);
    const getConfigByIdStmt = db.prepare(`
    SELECT id, name, project_id, remote_path, protocol, exclude_patterns, post_transfer_command, auth_token, created_at
    FROM tunnel_configs
    WHERE id = ?
  `);
    const getAllConfigsStmt = db.prepare(`
    SELECT id, name, project_id, remote_path, protocol, exclude_patterns, post_transfer_command, auth_token, created_at
    FROM tunnel_configs
    ORDER BY created_at DESC
  `);
    const insertTransferStmt = db.prepare(`
    INSERT INTO tunnel_transfers (id, tunnel_id, timestamp, file_count, total_size, duration, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    const updateTransferStmt = db.prepare(`
    UPDATE tunnel_transfers
    SET file_count = ?, total_size = ?, duration = ?, status = ?
    WHERE id = ?
  `);
    const getTransferHistoryStmt = db.prepare(`
    SELECT id, tunnel_id, timestamp, file_count, total_size, duration, status
    FROM tunnel_transfers
    WHERE tunnel_id = ?
    ORDER BY timestamp DESC
    LIMIT 50
  `);
    const getInProgressTransferStmt = db.prepare(`
    SELECT id FROM tunnel_transfers
    WHERE tunnel_id = ? AND status = 'in-progress'
    LIMIT 1
  `);
    // ─── Public Methods ──────────────────────────────────────────────────────
    function listConfigurations() {
        const rows = getAllConfigsStmt.all();
        return rows.map(parseConfigRow);
    }
    function createConfiguration(input) {
        const id = (0, uuid_1.v4)();
        const authToken = generateAuthToken();
        const now = new Date().toISOString();
        const protocol = input.protocol ?? 'rsync';
        const excludePatterns = JSON.stringify(input.excludePatterns ?? []);
        insertConfigStmt.run(id, input.name, input.projectId ?? null, input.remotePath, protocol, excludePatterns, input.postTransferCommand ?? null, authToken, now);
        return {
            id,
            name: input.name,
            projectId: input.projectId,
            remotePath: input.remotePath,
            protocol,
            excludePatterns: input.excludePatterns ?? [],
            postTransferCommand: input.postTransferCommand,
            authToken,
            createdAt: now,
        };
    }
    function updateConfiguration(id, input) {
        const existing = getConfigByIdStmt.get(id);
        if (!existing) {
            throw new Error(`Tunnel configuration ${id} not found`);
        }
        const current = parseConfigRow(existing);
        const updatedName = input.name ?? current.name;
        const updatedProjectId = input.projectId !== undefined ? input.projectId : current.projectId;
        const updatedRemotePath = input.remotePath ?? current.remotePath;
        const updatedProtocol = input.protocol ?? current.protocol;
        const updatedExcludePatterns = input.excludePatterns ?? current.excludePatterns;
        const updatedPostTransferCommand = input.postTransferCommand !== undefined
            ? input.postTransferCommand
            : current.postTransferCommand;
        updateConfigStmt.run(updatedName, updatedProjectId ?? null, updatedRemotePath, updatedProtocol, JSON.stringify(updatedExcludePatterns), updatedPostTransferCommand ?? null, id);
        return {
            id,
            name: updatedName,
            projectId: updatedProjectId,
            remotePath: updatedRemotePath,
            protocol: updatedProtocol,
            excludePatterns: updatedExcludePatterns,
            postTransferCommand: updatedPostTransferCommand,
            authToken: current.authToken,
            createdAt: current.createdAt,
        };
    }
    function deleteConfiguration(id) {
        const existing = getConfigByIdStmt.get(id);
        if (!existing) {
            throw new Error(`Tunnel configuration ${id} not found`);
        }
        deleteConfigStmt.run(id);
        activeTransfers.delete(id);
    }
    async function triggerPush(configId, files) {
        // Look up the configuration
        const configRow = getConfigByIdStmt.get(configId);
        if (!configRow) {
            throw new Error(`Tunnel configuration ${configId} not found`);
        }
        const tunnelConfig = parseConfigRow(configRow);
        // Check for concurrent transfer (Requirement 24.9)
        if (activeTransfers.has(configId)) {
            throw new Error('A transfer is already in progress for this tunnel configuration');
        }
        // Also check DB for in-progress transfers as a safety net
        const inProgress = getInProgressTransferStmt.get(configId);
        if (inProgress) {
            throw new Error('A transfer is already in progress for this tunnel configuration');
        }
        // Create transfer record
        const transferId = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        insertTransferStmt.run(transferId, configId, timestamp, 0, files.length, 0, 'in-progress');
        // Mark as active
        activeTransfers.add(configId);
        // Create the execute generator for the job
        const execute = async function* () {
            const startTime = Date.now();
            let fileCount = 0;
            // Declare paths outside try/catch for access in catch block
            const remotePath = tunnelConfig.remotePath;
            const backupPath = `${remotePath}.backup-${Date.now()}`;
            const tempDir = `/tmp/tunnel-${transferId}`;
            try {
                yield `[tunnel] Starting transfer for "${tunnelConfig.name}"`;
                yield `[tunnel] Protocol: ${tunnelConfig.protocol}`;
                yield `[tunnel] Remote path: ${remotePath}`;
                yield `[tunnel] Creating backup at ${backupPath}`;
                // Backup current state for rollback on failure (Requirement 24.8)
                try {
                    if (fs.existsSync(remotePath)) {
                        (0, child_process_1.execSync)(`cp -a "${remotePath}" "${backupPath}"`, { timeout: 30000 });
                        yield `[tunnel] Backup created successfully`;
                    }
                    else {
                        fs.mkdirSync(remotePath, { recursive: true });
                        yield `[tunnel] Created remote directory: ${remotePath}`;
                    }
                }
                catch (backupError) {
                    const msg = backupError instanceof Error ? backupError.message : String(backupError);
                    yield `[tunnel] Warning: Could not create backup: ${msg}`;
                }
                // Write the received file buffer to a temp archive
                const archivePath = `${tempDir}/upload.tar.gz`;
                fs.mkdirSync(tempDir, { recursive: true });
                fs.writeFileSync(archivePath, files);
                yield `[tunnel] Received ${files.length} bytes`;
                // Extract to temp staging directory
                const stagingPath = `${tempDir}/staging`;
                fs.mkdirSync(stagingPath, { recursive: true });
                try {
                    (0, child_process_1.execSync)(`tar -xzf "${archivePath}" -C "${stagingPath}"`, { timeout: 60000 });
                    yield `[tunnel] Archive extracted to staging`;
                }
                catch (extractError) {
                    const msg = extractError instanceof Error ? extractError.message : String(extractError);
                    throw new Error(`Failed to extract archive: ${msg}`);
                }
                // Count files in staging
                try {
                    const countOutput = (0, child_process_1.execSync)(`find "${stagingPath}" -type f | wc -l`, { timeout: 10000 });
                    fileCount = parseInt(countOutput.toString().trim(), 10) || 0;
                    yield `[tunnel] Files to transfer: ${fileCount}`;
                }
                catch {
                    yield `[tunnel] Could not count files`;
                }
                // Build exclude args for rsync/cp
                const excludeArgs = tunnelConfig.excludePatterns
                    .map(pattern => `--exclude="${pattern}"`)
                    .join(' ');
                // Transfer files to remote path
                if (tunnelConfig.protocol === 'rsync') {
                    const rsyncCmd = `rsync -a --delete ${excludeArgs} "${stagingPath}/" "${remotePath}/"`;
                    yield `[tunnel] Executing: rsync transfer`;
                    try {
                        (0, child_process_1.execSync)(rsyncCmd, { timeout: 120000 });
                        yield `[tunnel] rsync transfer completed`;
                    }
                    catch (rsyncError) {
                        const msg = rsyncError instanceof Error ? rsyncError.message : String(rsyncError);
                        throw new Error(`rsync transfer failed: ${msg}`);
                    }
                }
                else {
                    // SCP-style copy (local copy since files are already on VPS)
                    const cpCmd = `cp -a "${stagingPath}/." "${remotePath}/"`;
                    yield `[tunnel] Executing: file copy transfer`;
                    try {
                        (0, child_process_1.execSync)(cpCmd, { timeout: 120000 });
                        yield `[tunnel] File copy transfer completed`;
                    }
                    catch (cpError) {
                        const msg = cpError instanceof Error ? cpError.message : String(cpError);
                        throw new Error(`File copy transfer failed: ${msg}`);
                    }
                }
                yield `[tunnel] Transfer completed successfully`;
                // Execute post-transfer command if configured (Requirement 24.4)
                if (tunnelConfig.postTransferCommand) {
                    yield `[tunnel] Executing post-transfer command: ${tunnelConfig.postTransferCommand}`;
                    try {
                        const output = (0, child_process_1.execSync)(tunnelConfig.postTransferCommand, {
                            cwd: remotePath,
                            timeout: 300000, // 5 minute timeout for post-transfer commands
                        });
                        const outputStr = output.toString().trim();
                        if (outputStr) {
                            for (const line of outputStr.split('\n')) {
                                yield `[post-transfer] ${line}`;
                            }
                        }
                        yield `[tunnel] Post-transfer command completed successfully`;
                    }
                    catch (cmdError) {
                        const msg = cmdError instanceof Error ? cmdError.message : String(cmdError);
                        yield `[tunnel] Post-transfer command failed: ${msg}`;
                        // Post-transfer command failure doesn't rollback the transfer
                    }
                }
                // Update transfer record with success
                const duration = Math.round((Date.now() - startTime) / 1000);
                updateTransferStmt.run(fileCount, files.length, duration, 'completed', transferId);
                // Clean up temp files
                try {
                    (0, child_process_1.execSync)(`rm -rf "${tempDir}"`, { timeout: 10000 });
                }
                catch {
                    // Ignore cleanup errors
                }
                // Remove backup on success
                try {
                    if (fs.existsSync(backupPath)) {
                        (0, child_process_1.execSync)(`rm -rf "${backupPath}"`, { timeout: 30000 });
                    }
                }
                catch {
                    // Ignore backup cleanup errors
                }
                yield `[tunnel] Transfer complete. Files: ${fileCount}, Size: ${files.length} bytes, Duration: ${duration}s`;
            }
            catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                yield `[tunnel] ERROR: ${errorMsg}`;
                // Rollback: restore from backup if it exists (Requirement 24.8)
                const backupExists = fs.existsSync(backupPath);
                if (backupExists) {
                    yield `[tunnel] Rolling back to previous deployment state`;
                    try {
                        (0, child_process_1.execSync)(`rm -rf "${remotePath}" && mv "${backupPath}" "${remotePath}"`, { timeout: 30000 });
                        yield `[tunnel] Rollback completed successfully`;
                    }
                    catch (rollbackError) {
                        const rbMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                        yield `[tunnel] WARNING: Rollback failed: ${rbMsg}`;
                    }
                }
                // Update transfer record with failure
                const duration = Math.round((Date.now() - startTime) / 1000);
                updateTransferStmt.run(fileCount, files.length, duration, 'failed', transferId);
                // Clean up temp files
                try {
                    (0, child_process_1.execSync)(`rm -rf "${tempDir}"`, { timeout: 10000 });
                }
                catch {
                    // Ignore cleanup errors
                }
                yield `[tunnel] Transfer failed: ${errorMsg}`;
                throw error;
            }
        };
        // Submit to job queue
        const jobId = await deps.submitJob({
            type: 'tunnel-transfer',
            projectId: tunnelConfig.projectId,
            execute,
            onComplete: (result) => {
                // Remove from active transfers when job completes
                activeTransfers.delete(configId);
                // If the job failed or was cancelled but the transfer record is still in-progress, mark it
                if (result.status !== 'completed') {
                    const duration = Math.round(result.duration);
                    updateTransferStmt.run(0, files.length, duration, 'failed', transferId);
                }
            },
            metadata: {
                tunnelId: configId,
                tunnelName: tunnelConfig.name,
                transferId,
            },
        });
        return jobId;
    }
    function getTransferHistory(configId) {
        const rows = getTransferHistoryStmt.all(configId);
        return rows.map(parseTransferRow);
    }
    function generateCliScript(configId) {
        const configRow = getConfigByIdStmt.get(configId);
        if (!configRow) {
            throw new Error(`Tunnel configuration ${configId} not found`);
        }
        const tunnelConfig = parseConfigRow(configRow);
        const endpoint = `${baseUrl}/api/tunnels/${configId}/push`;
        return `#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Aivory VPS Panel - Tunnel CLI Client
# Configuration: ${tunnelConfig.name}
# Generated: ${new Date().toISOString()}
# ─────────────────────────────────────────────────────────────────────────────
#
# Usage:
#   ./tunnel-push.sh [source_directory]
#
# This script reads configuration from .tunnel.json in the project root,
# or uses the source directory provided as an argument.
#
# .tunnel.json format:
# {
#   "endpoint": "${endpoint}",
#   "authToken": "${tunnelConfig.authToken}",
#   "sourceDir": ".",
#   "exclude": ${JSON.stringify(tunnelConfig.excludePatterns)}
# }
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Colors
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m' # No Color

# Default values (can be overridden by .tunnel.json)
ENDPOINT="${endpoint}"
AUTH_TOKEN="${tunnelConfig.authToken}"
SOURCE_DIR="."
EXCLUDE_PATTERNS=(${tunnelConfig.excludePatterns.map(p => `"${p}"`).join(' ')})

# Check for .tunnel.json in current directory or project root
TUNNEL_CONFIG=""
if [ -f ".tunnel.json" ]; then
  TUNNEL_CONFIG=".tunnel.json"
elif [ -f "\${HOME}/.tunnel.json" ]; then
  TUNNEL_CONFIG="\${HOME}/.tunnel.json"
fi

if [ -n "\${TUNNEL_CONFIG}" ]; then
  echo -e "\${BLUE}Reading configuration from \${TUNNEL_CONFIG}\${NC}"
  
  # Parse JSON config (requires jq)
  if command -v jq &> /dev/null; then
    ENDPOINT=\$(jq -r '.endpoint // empty' "\${TUNNEL_CONFIG}" 2>/dev/null || echo "\${ENDPOINT}")
    AUTH_TOKEN=\$(jq -r '.authToken // empty' "\${TUNNEL_CONFIG}" 2>/dev/null || echo "\${AUTH_TOKEN}")
    SOURCE_DIR=\$(jq -r '.sourceDir // "."' "\${TUNNEL_CONFIG}" 2>/dev/null || echo "\${SOURCE_DIR}")
    
    # Read exclude patterns from JSON
    EXCLUDE_JSON=\$(jq -r '.exclude[]? // empty' "\${TUNNEL_CONFIG}" 2>/dev/null)
    if [ -n "\${EXCLUDE_JSON}" ]; then
      mapfile -t EXCLUDE_PATTERNS <<< "\${EXCLUDE_JSON}"
    fi
  else
    echo -e "\${YELLOW}Warning: jq not found. Using default configuration values.\${NC}"
    echo -e "\${YELLOW}Install jq for .tunnel.json support: sudo apt-get install jq\${NC}"
  fi
fi

# Override source dir from command line argument if provided
if [ \$# -ge 1 ]; then
  SOURCE_DIR="\$1"
fi

# Validate source directory
if [ ! -d "\${SOURCE_DIR}" ]; then
  echo -e "\${RED}Error: Source directory '\${SOURCE_DIR}' does not exist\${NC}"
  exit 1
fi

# Check for required tools
if ! command -v tar &> /dev/null; then
  echo -e "\${RED}Error: tar is required but not installed\${NC}"
  exit 1
fi

if ! command -v curl &> /dev/null; then
  echo -e "\${RED}Error: curl is required but not installed\${NC}"
  exit 1
fi

echo -e "\${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${BLUE}  Aivory VPS Panel - Tunnel Push\${NC}"
echo -e "\${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""
echo -e "  Configuration: \${GREEN}${tunnelConfig.name}\${NC}"
echo -e "  Source:        \${SOURCE_DIR}"
echo -e "  Endpoint:      \${ENDPOINT}"
echo ""

# Build tar exclude args
EXCLUDE_ARGS=""
for pattern in "\${EXCLUDE_PATTERNS[@]}"; do
  if [ -n "\${pattern}" ]; then
    EXCLUDE_ARGS="\${EXCLUDE_ARGS} --exclude=\${pattern}"
  fi
done

# Create archive
ARCHIVE_FILE=\$(mktemp /tmp/tunnel-push-XXXXXX.tar.gz)
echo -e "\${BLUE}Creating archive...\${NC}"

# shellcheck disable=SC2086
tar -czf "\${ARCHIVE_FILE}" -C "\${SOURCE_DIR}" \${EXCLUDE_ARGS} . 2>/dev/null

ARCHIVE_SIZE=\$(stat -f%z "\${ARCHIVE_FILE}" 2>/dev/null || stat -c%s "\${ARCHIVE_FILE}" 2>/dev/null || echo "unknown")
echo -e "  Archive size: \${GREEN}\${ARCHIVE_SIZE} bytes\${NC}"

# Upload
echo -e "\${BLUE}Uploading to VPS...\${NC}"

HTTP_RESPONSE=\$(curl -s -w "\\n%{http_code}" \\
  -X POST "\${ENDPOINT}" \\
  -H "Authorization: Bearer \${AUTH_TOKEN}" \\
  -H "Content-Type: application/octet-stream" \\
  --data-binary "@\${ARCHIVE_FILE}")

HTTP_CODE=\$(echo "\${HTTP_RESPONSE}" | tail -n1)
RESPONSE_BODY=\$(echo "\${HTTP_RESPONSE}" | sed '\$d')

# Clean up archive
rm -f "\${ARCHIVE_FILE}"

# Check response
if [ "\${HTTP_CODE}" = "200" ] || [ "\${HTTP_CODE}" = "202" ]; then
  echo ""
  echo -e "\${GREEN}✓ Transfer submitted successfully\${NC}"
  if [ -n "\${RESPONSE_BODY}" ]; then
    echo -e "  Response: \${RESPONSE_BODY}"
  fi
  echo ""
  exit 0
elif [ "\${HTTP_CODE}" = "409" ]; then
  echo ""
  echo -e "\${YELLOW}⚠ A transfer is already in progress for this configuration\${NC}"
  echo -e "  Wait for the current transfer to complete before pushing again."
  echo ""
  exit 1
elif [ "\${HTTP_CODE}" = "401" ]; then
  echo ""
  echo -e "\${RED}✗ Authentication failed\${NC}"
  echo -e "  Check that your auth token is correct."
  echo ""
  exit 1
else
  echo ""
  echo -e "\${RED}✗ Transfer failed (HTTP \${HTTP_CODE})\${NC}"
  if [ -n "\${RESPONSE_BODY}" ]; then
    echo -e "  Response: \${RESPONSE_BODY}"
  fi
  echo ""
  exit 1
fi
`;
    }
    // ─── Return the public API ──────────────────────────────────────────────
    return {
        listConfigurations,
        createConfiguration,
        updateConfiguration,
        deleteConfiguration,
        triggerPush,
        getTransferHistory,
        generateCliScript,
    };
}
//# sourceMappingURL=tunnel-manager.js.map