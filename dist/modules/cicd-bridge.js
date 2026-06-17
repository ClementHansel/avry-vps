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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCICDBridge = createCICDBridge;
const simple_git_1 = __importStar(require("simple-git"));
const chokidar_1 = __importDefault(require("chokidar"));
const uuid_1 = require("uuid");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// ─── Helpers ───────────────────────────────────────────────────────────────────
function buildAuthenticatedUrl(repoUrl, authMethod, credential) {
    if (authMethod === 'pat' || authMethod === 'github-app') {
        try {
            const url = new URL(repoUrl);
            url.username = credential;
            return url.toString();
        }
        catch {
            return repoUrl.replace('https://', `https://${credential}@`);
        }
    }
    return repoUrl;
}
function formatCommitMessage(template, timestamp) {
    return template.replace(/\{timestamp\}/g, timestamp.toISOString());
}
function parseConfigRow(row) {
    return {
        repoUrl: row.repo_url,
        branch: row.branch,
        authMethod: row.auth_method,
        authCredential: row.auth_credential_encrypted,
        syncDirection: row.sync_direction,
        localPath: row.local_path,
        commitTemplate: row.commit_template ?? undefined,
        authorName: row.author_name ?? undefined,
        authorEmail: row.author_email ?? undefined,
        excludePatterns: row.exclude_patterns ? JSON.parse(row.exclude_patterns) : undefined,
        debounceInterval: row.debounce_interval,
        preDeployCommand: row.pre_deploy_command ?? undefined,
        postDeployCommand: row.post_deploy_command ?? undefined,
    };
}
function parseSyncEventRow(row) {
    return {
        id: row.id,
        configId: row.config_id,
        direction: row.direction,
        commitSha: row.commit_sha ?? undefined,
        origin: row.origin,
        status: row.status,
        errorMessage: row.error_message ?? undefined,
        timestamp: row.timestamp,
    };
}
// ─── Factory ───────────────────────────────────────────────────────────────────
function createCICDBridge(db, options) {
    const deps = options?.deps;
    // In-memory state for watchers and statuses
    const watchers = new Map();
    const projectStatuses = new Map();
    // Ensure tables exist
    ensureTables(db);
    // ─── Prepared Statements ─────────────────────────────────────────────────
    const getConfigByProjectStmt = db.prepare(`
    SELECT * FROM cicd_configs WHERE project_id = ?
  `);
    const insertConfigStmt = db.prepare(`
    INSERT INTO cicd_configs (
      id, project_id, repo_url, branch, auth_method, auth_credential_encrypted,
      sync_direction, local_path, commit_template, author_name, author_email,
      exclude_patterns, debounce_interval, pre_deploy_command, post_deploy_command
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const updateConfigStmt = db.prepare(`
    UPDATE cicd_configs SET
      repo_url = ?, branch = ?, auth_method = ?, auth_credential_encrypted = ?,
      sync_direction = ?, local_path = ?, commit_template = ?, author_name = ?,
      author_email = ?, exclude_patterns = ?, debounce_interval = ?,
      pre_deploy_command = ?, post_deploy_command = ?
    WHERE project_id = ?
  `);
    const insertSyncEventStmt = db.prepare(`
    INSERT INTO cicd_sync_events (id, config_id, direction, commit_sha, origin, status, error_message, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const getSyncEventsByConfigStmt = db.prepare(`
    SELECT * FROM cicd_sync_events
    WHERE config_id = ?
    ORDER BY timestamp DESC
    LIMIT 50
  `);
    const getRecentSyncEventByCommitStmt = db.prepare(`
    SELECT * FROM cicd_sync_events
    WHERE config_id = ? AND commit_sha = ? AND origin = ?
    LIMIT 1
  `);
    // ─── recordSyncEvent ─────────────────────────────────────────────────────
    function recordSyncEvent(configId, direction, origin, status, commitSha, errorMessage) {
        const id = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        insertSyncEventStmt.run(id, configId, direction, commitSha ?? null, origin, status, errorMessage ?? null, timestamp);
    }
    // ─── isCommitFromOrigin ──────────────────────────────────────────────────
    /**
     * Check if a commit SHA was already processed from a given origin.
     * This prevents sync loops: VPS-initiated commits should not trigger GitHub-to-VPS sync,
     * and vice-versa.
     */
    function isCommitFromOrigin(configId, commitSha, origin) {
        const row = getRecentSyncEventByCommitStmt.get(configId, commitSha, origin);
        return !!row;
    }
    // ─── setStatus ───────────────────────────────────────────────────────────
    function setStatus(projectId, status) {
        projectStatuses.set(projectId, status);
    }
    // ─── configure ───────────────────────────────────────────────────────────
    async function configure(projectId, config) {
        // Validate access first (requirement 25.10)
        const hasAccess = await validateAccess(config);
        if (!hasAccess) {
            throw new Error('Repository access validation failed. Check credentials and repository URL.');
        }
        const existing = getConfigByProjectStmt.get(projectId);
        const excludePatternsJson = config.excludePatterns
            ? JSON.stringify(config.excludePatterns)
            : null;
        const debounceInterval = config.debounceInterval ?? 30;
        const commitTemplate = config.commitTemplate ?? 'Auto-sync from VPS: {timestamp}';
        if (existing) {
            // Stop any existing watcher before reconfiguring
            stopWatching(projectId);
            updateConfigStmt.run(config.repoUrl, config.branch, config.authMethod, config.authCredential, config.syncDirection, config.localPath, commitTemplate, config.authorName ?? null, config.authorEmail ?? null, excludePatternsJson, debounceInterval, config.preDeployCommand ?? null, config.postDeployCommand ?? null, projectId);
        }
        else {
            const id = (0, uuid_1.v4)();
            insertConfigStmt.run(id, projectId, config.repoUrl, config.branch, config.authMethod, config.authCredential, config.syncDirection, config.localPath, commitTemplate, config.authorName ?? null, config.authorEmail ?? null, excludePatternsJson, debounceInterval, config.preDeployCommand ?? null, config.postDeployCommand ?? null);
        }
        // Reset status to idle
        setStatus(projectId, 'idle');
    }
    // ─── getStatus ───────────────────────────────────────────────────────────
    function getStatus(projectId) {
        return projectStatuses.get(projectId) ?? 'idle';
    }
    // ─── getSyncHistory ──────────────────────────────────────────────────────
    function getSyncHistory(projectId) {
        const configRow = getConfigByProjectStmt.get(projectId);
        if (!configRow)
            return [];
        const rows = getSyncEventsByConfigStmt.all(configRow.id);
        return rows.map(parseSyncEventRow);
    }
    // ─── validateAccess ──────────────────────────────────────────────────────
    async function validateAccess(config) {
        try {
            const authenticatedUrl = buildAuthenticatedUrl(config.repoUrl, config.authMethod, config.authCredential);
            const git = (0, simple_git_1.default)();
            // Use ls-remote to check access without cloning
            await git.listRemote([authenticatedUrl, 'HEAD']);
            return true;
        }
        catch {
            return false;
        }
    }
    // ─── startWatching ───────────────────────────────────────────────────────
    function startWatching(projectId) {
        // Prevent duplicate watchers
        if (watchers.has(projectId)) {
            return;
        }
        const configRow = getConfigByProjectStmt.get(projectId);
        if (!configRow) {
            throw new Error(`No CI/CD configuration found for project ${projectId}`);
        }
        const config = parseConfigRow(configRow);
        // Only watch if direction includes VPS-to-GitHub
        if (config.syncDirection === 'github-to-vps') {
            return; // No filesystem watching needed for GitHub-to-VPS only
        }
        const debounceMs = (config.debounceInterval ?? 30) * 1000;
        const excludePatterns = config.excludePatterns ?? [];
        // Build ignored patterns for chokidar
        const ignored = [
            /(^|[/\\])\../, // dotfiles by default (includes .git)
            ...excludePatterns.map((pattern) => {
                // Convert glob-like patterns to regex or use string matching
                return new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
            }),
        ];
        const watcher = chokidar_1.default.watch(config.localPath, {
            ignored,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100,
            },
        });
        const state = {
            watcher,
            debounceTimer: null,
            pendingChanges: new Set(),
        };
        const handleChange = (filePath) => {
            state.pendingChanges.add(filePath);
            // Reset debounce timer
            if (state.debounceTimer) {
                clearTimeout(state.debounceTimer);
            }
            state.debounceTimer = setTimeout(() => {
                // Trigger commit and push
                commitAndPush(projectId, configRow.id, config, Array.from(state.pendingChanges));
                state.pendingChanges.clear();
            }, debounceMs);
        };
        watcher
            .on('add', handleChange)
            .on('change', handleChange)
            .on('unlink', handleChange);
        watchers.set(projectId, state);
    }
    // ─── stopWatching ────────────────────────────────────────────────────────
    function stopWatching(projectId) {
        const state = watchers.get(projectId);
        if (!state)
            return;
        // Clear debounce timer
        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
        }
        // Close the watcher
        state.watcher.close();
        watchers.delete(projectId);
    }
    // ─── commitAndPush ───────────────────────────────────────────────────────
    async function commitAndPush(projectId, configId, config, changedFiles) {
        setStatus(projectId, 'syncing-vps-to-github');
        try {
            const authenticatedUrl = buildAuthenticatedUrl(config.repoUrl, config.authMethod, config.authCredential);
            const git = (0, simple_git_1.default)(config.localPath);
            // Check if this is a git repo, if not initialize it
            const isRepo = await git.checkIsRepo();
            if (!isRepo) {
                await git.init();
                await git.addRemote('origin', authenticatedUrl);
            }
            // Set author config if specified
            if (config.authorName) {
                await git.addConfig('user.name', config.authorName);
            }
            if (config.authorEmail) {
                await git.addConfig('user.email', config.authorEmail);
            }
            // Stage all changes
            await git.add('.');
            // Check if there are actually staged changes
            const status = await git.status();
            if (status.staged.length === 0 && status.files.length === 0) {
                setStatus(projectId, 'idle');
                return;
            }
            // Generate commit message from template
            const template = config.commitTemplate ?? 'Auto-sync from VPS: {timestamp}';
            const commitMessage = formatCommitMessage(template, new Date());
            // Commit
            const commitResult = await git.commit(commitMessage);
            const commitSha = commitResult.commit || undefined;
            // Push
            await git.push('origin', config.branch);
            // Record sync event with VPS origin (to prevent loops)
            recordSyncEvent(configId, 'vps-to-github', 'vps', 'success', commitSha);
            setStatus(projectId, 'idle');
        }
        catch (error) {
            const errorMessage = error instanceof simple_git_1.GitError
                ? error.message
                : (error?.message ?? 'Unknown error during VPS-to-GitHub sync');
            recordSyncEvent(configId, 'vps-to-github', 'vps', 'failed', undefined, errorMessage);
            setStatus(projectId, 'error');
        }
    }
    // ─── handleGitHubPush ────────────────────────────────────────────────────
    async function handleGitHubPush(projectId, commitSha) {
        const configRow = getConfigByProjectStmt.get(projectId);
        if (!configRow) {
            throw new Error(`No CI/CD configuration found for project ${projectId}`);
        }
        const config = parseConfigRow(configRow);
        // Only handle if direction includes GitHub-to-VPS
        if (config.syncDirection === 'vps-to-github') {
            return; // Ignore GitHub pushes when direction is VPS-to-GitHub only
        }
        // ─── Sync Loop Prevention (Requirement 25.7) ───────────────────────────
        // Check if this commit originated from VPS (i.e., was pushed by our VPS-to-GitHub sync)
        if (isCommitFromOrigin(configRow.id, commitSha, 'vps')) {
            // This commit originated from VPS, skip processing to prevent loop
            return;
        }
        setStatus(projectId, 'syncing-github-to-vps');
        try {
            // Execute pre-deploy command if configured (Requirement 25.6)
            if (config.preDeployCommand) {
                await execAsync(config.preDeployCommand, { cwd: config.localPath });
            }
            const authenticatedUrl = buildAuthenticatedUrl(config.repoUrl, config.authMethod, config.authCredential);
            const git = (0, simple_git_1.default)(config.localPath);
            // Check if this is a git repo
            const isRepo = await git.checkIsRepo();
            if (!isRepo) {
                // Clone the repo
                const tempGit = (0, simple_git_1.default)();
                await tempGit.clone(authenticatedUrl, config.localPath, [
                    '--branch',
                    config.branch,
                    '--single-branch',
                ]);
            }
            else {
                // Pull latest changes
                try {
                    await git.fetch('origin', config.branch);
                    await git.pull('origin', config.branch);
                }
                catch (pullError) {
                    // ─── Merge Conflict Handling (Requirement 25.9) ──────────────────
                    const errorMsg = pullError?.message ?? '';
                    if (errorMsg.includes('CONFLICT') ||
                        errorMsg.includes('merge conflict') ||
                        errorMsg.includes('Merge conflict')) {
                        // Abort the merge to preserve VPS state
                        try {
                            await git.merge(['--abort']);
                        }
                        catch {
                            // If abort fails, try reset
                            try {
                                await git.reset(['--hard', 'HEAD']);
                            }
                            catch {
                                // Last resort - ignore
                            }
                        }
                        // Record conflict
                        recordSyncEvent(configRow.id, 'github-to-vps', 'github', 'conflict', commitSha, `Merge conflict detected. Pull aborted, VPS state preserved. Conflicting files require manual resolution.`);
                        setStatus(projectId, 'error');
                        return;
                    }
                    // Re-throw other errors
                    throw pullError;
                }
            }
            // Record sync event with GitHub origin (to prevent loops)
            recordSyncEvent(configRow.id, 'github-to-vps', 'github', 'success', commitSha);
            // Execute post-deploy command if configured (Requirement 25.6)
            if (config.postDeployCommand) {
                await execAsync(config.postDeployCommand, { cwd: config.localPath });
            }
            // Trigger build pipeline if available (Requirement 25.3)
            if (deps?.triggerBuild) {
                try {
                    await deps.triggerBuild(projectId);
                }
                catch {
                    // Build trigger failure is non-fatal for the sync
                }
            }
            setStatus(projectId, 'idle');
        }
        catch (error) {
            const errorMessage = error instanceof simple_git_1.GitError
                ? error.message
                : (error?.message ?? 'Unknown error during GitHub-to-VPS sync');
            recordSyncEvent(configRow.id, 'github-to-vps', 'github', 'failed', commitSha, errorMessage);
            setStatus(projectId, 'error');
        }
    }
    // ─── getConfig ───────────────────────────────────────────────────────────
    function getConfig(projectId) {
        const row = getConfigByProjectStmt.get(projectId);
        if (!row)
            return null;
        return parseConfigRow(row);
    }
    // ─── destroy ─────────────────────────────────────────────────────────────
    function destroy() {
        for (const [projectId] of watchers) {
            stopWatching(projectId);
        }
    }
    // ─── Table Setup ─────────────────────────────────────────────────────────
    function ensureTables(database) {
        database.exec(`
      CREATE TABLE IF NOT EXISTS cicd_configs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        auth_method TEXT NOT NULL,
        auth_credential_encrypted TEXT NOT NULL,
        sync_direction TEXT NOT NULL,
        local_path TEXT NOT NULL,
        commit_template TEXT DEFAULT 'Auto-sync from VPS: {timestamp}',
        author_name TEXT,
        author_email TEXT,
        exclude_patterns TEXT,
        debounce_interval INTEGER DEFAULT 30,
        pre_deploy_command TEXT,
        post_deploy_command TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cicd_sync_events (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        commit_sha TEXT,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_cicd_configs_project ON cicd_configs(project_id);
      CREATE INDEX IF NOT EXISTS idx_cicd_events_config ON cicd_sync_events(config_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cicd_events_commit ON cicd_sync_events(config_id, commit_sha, origin);
    `);
    }
    // ─── Return Public Interface ─────────────────────────────────────────────
    return {
        configure,
        getStatus,
        getSyncHistory,
        validateAccess,
        startWatching,
        stopWatching,
        handleGitHubPush,
        getConfig,
        destroy,
    };
}
//# sourceMappingURL=cicd-bridge.js.map