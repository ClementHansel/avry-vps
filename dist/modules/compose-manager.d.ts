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
export declare function createComposeManager(config?: ComposeManagerConfig): ComposeManager;
export declare function isComposeFileName(fileName: string): boolean;
//# sourceMappingURL=compose-manager.d.ts.map