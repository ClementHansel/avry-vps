export type DatabaseType = 'mysql' | 'mariadb' | 'postgresql';
export interface DatabaseServer {
    id: string;
    type: DatabaseType;
    containerName: string;
    containerId: string;
    host: string;
    port: number;
    dockerNetworkIp?: string;
}
export interface DatabaseInfo {
    name: string;
    sizeBytes?: number;
}
export interface QueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    executionTimeMs: number;
}
export interface DatabaseUserInput {
    username: string;
    password?: string;
    action: 'create' | 'drop' | 'grant' | 'revoke';
    database?: string;
    permissions?: string[];
    host?: string;
}
export interface ImportProgress {
    status: 'pending' | 'importing' | 'completed' | 'failed';
    bytesProcessed: number;
    totalBytes: number;
    percentComplete: number;
    error?: string;
}
export interface DatabaseManager {
    discoverServers(): Promise<DatabaseServer[]>;
    listDatabases(serverId: string): Promise<DatabaseInfo[]>;
    createDatabase(serverId: string, name: string): Promise<void>;
    executeQuery(serverId: string, db: string, query: string): Promise<QueryResult>;
    exportDatabase(serverId: string, db: string): Promise<string>;
    importDatabase(serverId: string, db: string, file: string): Promise<string>;
    manageUser(serverId: string, user: DatabaseUserInput): Promise<void>;
}
export interface DatabaseManagerConfig {
    dockerHost?: string;
    exportDir?: string;
}
export declare function createDatabaseManager(config?: DatabaseManagerConfig): DatabaseManager;
//# sourceMappingURL=database-manager.d.ts.map