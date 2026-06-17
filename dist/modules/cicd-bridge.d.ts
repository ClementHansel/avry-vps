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
    debounceInterval?: number;
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
export declare function createCICDBridge(db: Database.Database, options?: CICDBridgeOptions): CICDBridge;
//# sourceMappingURL=cicd-bridge.d.ts.map