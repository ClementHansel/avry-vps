export interface FileEntry {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    permissions: string;
    lastModified: Date;
}
export interface FileContent {
    content: string;
    language: string;
    size: number;
    path: string;
}
export interface FileMetadata {
    name: string;
    size: number;
    permissions: string;
    lastModified: Date;
    type: 'file' | 'directory' | 'symlink';
}
export interface DirectoryListing {
    entries: FileEntry[];
    truncated: boolean;
    total: number;
    path: string;
}
export interface FileManager {
    listDirectory(dirPath: string): Promise<DirectoryListing>;
    readFile(filePath: string): Promise<FileContent>;
    writeFile(filePath: string, content: string): Promise<void>;
    getFileInfo(filePath: string): Promise<FileMetadata>;
    isPathAllowed(targetPath: string): boolean;
}
export interface FileManagerConfig {
    /** Root path for the file manager. Default: /opt/aivery */
    rootPath?: string;
    /** Maximum entries per directory listing. Default: 500 */
    maxEntries?: number;
    /** Maximum file size for reading in bytes. Default: 10MB */
    maxFileSize?: number;
}
export declare function createFileManager(config?: FileManagerConfig): FileManager;
/**
 * Detect the programming language of a file based on its name and extension.
 */
export declare function detectLanguage(filePath: string): string;
/**
 * Convert a file mode integer to a Unix permission string (e.g., "-rwxr-xr-x").
 */
export declare function formatPermissions(mode: number): string;
//# sourceMappingURL=file-manager.d.ts.map