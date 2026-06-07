/**
 * CI/CD Bridge Module
 *
 * Bi-directional synchronization between VPS filesystem and GitHub repositories:
 * - Configure sync direction (VPS-to-GitHub, GitHub-to-VPS, bidirectional)
 * - Use chokidar for filesystem watching with configurable debounce (default 30s)
 * - Commit and push to GitHub on VPS file changes (VPS-to-GitHub/bidirectional)
 * - Pull and trigger build pipeline on GitHub push webhook (GitHub-to-VPS/bidirectional)
 * - Track commit origin in SQLite to prevent sync loops
 * - Support commit templates, author config, exclude patterns
 * - Execute pre-deploy and post-deploy commands
 * - Handle auth errors, merge conflicts (abort pull, preserve VPS state, show conflicts)
 * - Validate repository access before saving config
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10
 */
import type Database from 'better-sqlite3';
import simpleGit, { SimpleGit, GitError } from 'simple-git';
import chokidar, { FSWatcher } from 'chokidar';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

// ─── Interfaces ────────────────────────────────────────────────────────────────

export type SyncDirection = 'vps-to-github' | 'github-to-vps' | 'bidirectional';
export type CICDStatus = 'idle' | 'syncing-vps-to-github' | 'syncing-github-to-vps' | 'error';
export type SyncEventStatus = 'success' | 'failed' | 'conflict';
export type SyncEventOrigin = 'vps' | 'github';

export interface CICDConfig {
  repoUrl: string;
  branch: string;
  authMethod: 'pat' | 'github-app';
  authCredential: string;
  syncDirection: SyncDirection;
  localPath: string;
  commitTemplate?: string;
  authorName?: string;
  authorEmail?: string;
  excludePatterns?: string[];
  debounceInterval?: number; // seconds, default 30
  preDeployCommand?: string;
  postDeployCommand?: string;
}

export interface SyncEvent {
  id: string;
  configId: string;
  direction: SyncDirection;
  commitSha?: string;
  origin: SyncEventOrigin;
  status: SyncEventStatus;
  errorMessage?: string;
  timestamp: string;
}

export interface CICDBridge {
  /** Configure CI/CD bridge for a project. Validates access before saving. */
  configure(projectId: string, config: CICDConfig): Promise<void>;
  /** Get the current sync status for a project. */
  getStatus(projectId: string): CICDStatus;
  /** Get sync event history for a project (last 50). */
  getSyncHistory(projectId: string): SyncEvent[];
  /** Validate repository access using the provided config. */
  validateAccess(config: CICDConfig): Promise<boolean>;
  /** Start filesystem watching for a project (VPS-to-GitHub or bidirectional). */
  startWatching(projectId: string): void;
  /** Stop filesystem watching for a project. */
  stopWatching(projectId: string): void;
  /** Handle an incoming GitHub push. Pull and trigger build pipeline. */
  handleGitHubPush(projectId: string, commitSha: string): Promise<void>;
  /** Get the CI/CD config for a project (if configured). */
  getConfig(projectId: string): CICDConfig | null;
  /** Cleanup resources (stop all watchers). */
  destroy(): void;
}

export interface CICDBridgeDeps {
  /** Trigger the build pipeline for a given project. Returns job ID. */
  triggerBuild?: (projectId: string) => Promise<string>;
}

export interface CICDBridgeOptions {
  /** Dependencies for triggering builds. */
  deps?: CICDBridgeDeps;
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface RawCICDConfigRow {
  id: string;
  project_id: string;
  repo_url: string;
  branch: string;
  auth_method: string;
  auth_credential_encrypted: string;
  sync_direction: string;
  local_path: string;
  commit_template: string | null;
  author_name: string | null;
  author_email: string | null;
  exclude_patterns: string | null;
  debounce_interval: number;
  pre_deploy_command: string | null;
  post_deploy_command: string | null;
  created_at: string;
}

interface RawSyncEventRow {
  id: string;
  config_id: string;
  direction: string;
  commit_sha: string | null;
  origin: string;
  status: string;
  error_message: string | null;
  timestamp: string;
}

interface WatcherState {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingChanges: Set<string>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildAuthenticatedUrl(repoUrl: string, authMethod: string, credential: string): string {
  if (authMethod === 'pat' || authMethod === 'github-app') {
    try {
      const url = new URL(repoUrl);
      url.username = credential;
      return url.toString();
    } catch {
      return repoUrl.replace('https://', `https://${credential}@`);
    }
  }
  return repoUrl;
}

function formatCommitMessage(template: string, timestamp: Date): string {
  return template.replace(/\{timestamp\}/g, timestamp.toISOString());
}

function parseConfigRow(row: RawCICDConfigRow): CICDConfig {
  return {
    repoUrl: row.repo_url,
    branch: row.branch,
    authMethod: row.auth_method as CICDConfig['authMethod'],
    authCredential: row.auth_credential_encrypted,
    syncDirection: row.sync_direction as SyncDirection,
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

function parseSyncEventRow(row: RawSyncEventRow): SyncEvent {
  return {
    id: row.id,
    configId: row.config_id,
    direction: row.direction as SyncDirection,
    commitSha: row.commit_sha ?? undefined,
    origin: row.origin as SyncEventOrigin,
    status: row.status as SyncEventStatus,
    errorMessage: row.error_message ?? undefined,
    timestamp: row.timestamp,
  };
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createCICDBridge(
  db: Database.Database,
  options?: CICDBridgeOptions
): CICDBridge {
  const deps = options?.deps;

  // In-memory state for watchers and statuses
  const watchers = new Map<string, WatcherState>();
  const projectStatuses = new Map<string, CICDStatus>();

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

  function recordSyncEvent(
    configId: string,
    direction: SyncDirection,
    origin: SyncEventOrigin,
    status: SyncEventStatus,
    commitSha?: string,
    errorMessage?: string
  ): void {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    insertSyncEventStmt.run(
      id,
      configId,
      direction,
      commitSha ?? null,
      origin,
      status,
      errorMessage ?? null,
      timestamp
    );
  }

  // ─── isCommitFromOrigin ──────────────────────────────────────────────────

  /**
   * Check if a commit SHA was already processed from a given origin.
   * This prevents sync loops: VPS-initiated commits should not trigger GitHub-to-VPS sync,
   * and vice-versa.
   */
  function isCommitFromOrigin(configId: string, commitSha: string, origin: SyncEventOrigin): boolean {
    const row = getRecentSyncEventByCommitStmt.get(configId, commitSha, origin) as RawSyncEventRow | undefined;
    return !!row;
  }

  // ─── setStatus ───────────────────────────────────────────────────────────

  function setStatus(projectId: string, status: CICDStatus): void {
    projectStatuses.set(projectId, status);
  }

  // ─── configure ───────────────────────────────────────────────────────────

  async function configure(projectId: string, config: CICDConfig): Promise<void> {
    // Validate access first (requirement 25.10)
    const hasAccess = await validateAccess(config);
    if (!hasAccess) {
      throw new Error('Repository access validation failed. Check credentials and repository URL.');
    }

    const existing = getConfigByProjectStmt.get(projectId) as RawCICDConfigRow | undefined;

    const excludePatternsJson = config.excludePatterns
      ? JSON.stringify(config.excludePatterns)
      : null;
    const debounceInterval = config.debounceInterval ?? 30;
    const commitTemplate = config.commitTemplate ?? 'Auto-sync from VPS: {timestamp}';

    if (existing) {
      // Stop any existing watcher before reconfiguring
      stopWatching(projectId);

      updateConfigStmt.run(
        config.repoUrl,
        config.branch,
        config.authMethod,
        config.authCredential,
        config.syncDirection,
        config.localPath,
        commitTemplate,
        config.authorName ?? null,
        config.authorEmail ?? null,
        excludePatternsJson,
        debounceInterval,
        config.preDeployCommand ?? null,
        config.postDeployCommand ?? null,
        projectId
      );
    } else {
      const id = uuidv4();
      insertConfigStmt.run(
        id,
        projectId,
        config.repoUrl,
        config.branch,
        config.authMethod,
        config.authCredential,
        config.syncDirection,
        config.localPath,
        commitTemplate,
        config.authorName ?? null,
        config.authorEmail ?? null,
        excludePatternsJson,
        debounceInterval,
        config.preDeployCommand ?? null,
        config.postDeployCommand ?? null
      );
    }

    // Reset status to idle
    setStatus(projectId, 'idle');
  }

  // ─── getStatus ───────────────────────────────────────────────────────────

  function getStatus(projectId: string): CICDStatus {
    return projectStatuses.get(projectId) ?? 'idle';
  }

  // ─── getSyncHistory ──────────────────────────────────────────────────────

  function getSyncHistory(projectId: string): SyncEvent[] {
    const configRow = getConfigByProjectStmt.get(projectId) as RawCICDConfigRow | undefined;
    if (!configRow) return [];

    const rows = getSyncEventsByConfigStmt.all(configRow.id) as RawSyncEventRow[];
    return rows.map(parseSyncEventRow);
  }

  // ─── validateAccess ──────────────────────────────────────────────────────

  async function validateAccess(config: CICDConfig): Promise<boolean> {
    try {
      const authenticatedUrl = buildAuthenticatedUrl(
        config.repoUrl,
        config.authMethod,
        config.authCredential
      );

      const git = simpleGit();
      // Use ls-remote to check access without cloning
      await git.listRemote([authenticatedUrl, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  // ─── startWatching ───────────────────────────────────────────────────────

  function startWatching(projectId: string): void {
    // Prevent duplicate watchers
    if (watchers.has(projectId)) {
      return;
    }

    const configRow = getConfigByProjectStmt.get(projectId) as RawCICDConfigRow | undefined;
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

    const watcher = chokidar.watch(config.localPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    const state: WatcherState = {
      watcher,
      debounceTimer: null,
      pendingChanges: new Set(),
    };

    const handleChange = (filePath: string) => {
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

  function stopWatching(projectId: string): void {
    const state = watchers.get(projectId);
    if (!state) return;

    // Clear debounce timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Close the watcher
    state.watcher.close();
    watchers.delete(projectId);
  }

  // ─── commitAndPush ───────────────────────────────────────────────────────

  async function commitAndPush(
    projectId: string,
    configId: string,
    config: CICDConfig,
    changedFiles: string[]
  ): Promise<void> {
    setStatus(projectId, 'syncing-vps-to-github');

    try {
      const authenticatedUrl = buildAuthenticatedUrl(
        config.repoUrl,
        config.authMethod,
        config.authCredential
      );

      const git = simpleGit(config.localPath);

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
    } catch (error: any) {
      const errorMessage = error instanceof GitError
        ? error.message
        : (error?.message ?? 'Unknown error during VPS-to-GitHub sync');

      recordSyncEvent(configId, 'vps-to-github', 'vps', 'failed', undefined, errorMessage);
      setStatus(projectId, 'error');
    }
  }

  // ─── handleGitHubPush ────────────────────────────────────────────────────

  async function handleGitHubPush(projectId: string, commitSha: string): Promise<void> {
    const configRow = getConfigByProjectStmt.get(projectId) as RawCICDConfigRow | undefined;
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

      const authenticatedUrl = buildAuthenticatedUrl(
        config.repoUrl,
        config.authMethod,
        config.authCredential
      );

      const git = simpleGit(config.localPath);

      // Check if this is a git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        // Clone the repo
        const tempGit = simpleGit();
        await tempGit.clone(authenticatedUrl, config.localPath, [
          '--branch',
          config.branch,
          '--single-branch',
        ]);
      } else {
        // Pull latest changes
        try {
          await git.fetch('origin', config.branch);
          await git.pull('origin', config.branch);
        } catch (pullError: any) {
          // ─── Merge Conflict Handling (Requirement 25.9) ──────────────────
          const errorMsg = pullError?.message ?? '';
          if (
            errorMsg.includes('CONFLICT') ||
            errorMsg.includes('merge conflict') ||
            errorMsg.includes('Merge conflict')
          ) {
            // Abort the merge to preserve VPS state
            try {
              await git.merge(['--abort']);
            } catch {
              // If abort fails, try reset
              try {
                await git.reset(['--hard', 'HEAD']);
              } catch {
                // Last resort - ignore
              }
            }

            // Record conflict
            recordSyncEvent(
              configRow.id,
              'github-to-vps',
              'github',
              'conflict',
              commitSha,
              `Merge conflict detected. Pull aborted, VPS state preserved. Conflicting files require manual resolution.`
            );
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
        } catch {
          // Build trigger failure is non-fatal for the sync
        }
      }

      setStatus(projectId, 'idle');
    } catch (error: any) {
      const errorMessage = error instanceof GitError
        ? error.message
        : (error?.message ?? 'Unknown error during GitHub-to-VPS sync');

      recordSyncEvent(
        configRow.id,
        'github-to-vps',
        'github',
        'failed',
        commitSha,
        errorMessage
      );
      setStatus(projectId, 'error');
    }
  }

  // ─── getConfig ───────────────────────────────────────────────────────────

  function getConfig(projectId: string): CICDConfig | null {
    const row = getConfigByProjectStmt.get(projectId) as RawCICDConfigRow | undefined;
    if (!row) return null;
    return parseConfigRow(row);
  }

  // ─── destroy ─────────────────────────────────────────────────────────────

  function destroy(): void {
    for (const [projectId] of watchers) {
      stopWatching(projectId);
    }
  }

  // ─── Table Setup ─────────────────────────────────────────────────────────

  function ensureTables(database: Database.Database): void {
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
