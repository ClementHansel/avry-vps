"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileManager = createFileManager;
exports.detectLanguage = detectLanguage;
exports.formatPermissions = formatPermissions;
/**
 * File Manager Module
 *
 * Provides secure file system browsing, reading, and writing with
 * path traversal prevention, symlink resolution, and syntax highlighting metadata.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_ROOT_PATH = '/opt/aivery';
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
/**
 * Map of file extensions to syntax highlighting language identifiers.
 */
const EXTENSION_LANGUAGE_MAP = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.xml': 'xml',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.md': 'markdown',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.fish': 'shell',
    '.ps1': 'powershell',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.dockerfile': 'dockerfile',
    '.docker': 'dockerfile',
    '.toml': 'toml',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.conf': 'ini',
    '.env': 'shell',
    '.log': 'plaintext',
    '.txt': 'plaintext',
    '.csv': 'plaintext',
    '.svg': 'xml',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.php': 'php',
    '.lua': 'lua',
    '.swift': 'swift',
    '.r': 'r',
    '.R': 'r',
    '.pl': 'perl',
    '.pm': 'perl',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hs': 'haskell',
    '.tf': 'hcl',
    '.hcl': 'hcl',
    '.proto': 'protobuf',
    '.makefile': 'makefile',
    '.cmake': 'cmake',
    '.nginx': 'nginx',
};
/**
 * Special filenames that map to specific languages.
 */
const FILENAME_LANGUAGE_MAP = {
    'Dockerfile': 'dockerfile',
    'Makefile': 'makefile',
    'Vagrantfile': 'ruby',
    'Gemfile': 'ruby',
    'Rakefile': 'ruby',
    'Jenkinsfile': 'groovy',
    '.gitignore': 'gitignore',
    '.dockerignore': 'gitignore',
    '.editorconfig': 'ini',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    'compose.yml': 'yaml',
    'compose.yaml': 'yaml',
};
// ─── Implementation ────────────────────────────────────────────────────────────
function createFileManager(config) {
    const rootPath = node_path_1.default.resolve(config?.rootPath ?? DEFAULT_ROOT_PATH);
    const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxFileSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    // ─── isPathAllowed ───────────────────────────────────────────────────────
    function isPathAllowed(targetPath) {
        // Reject null bytes
        if (targetPath.includes('\0')) {
            return false;
        }
        // Decode URL-encoded characters iteratively to catch double/triple encoding
        let decodedPath = targetPath;
        try {
            let prev = decodedPath;
            decodedPath = decodeURIComponent(decodedPath);
            // Keep decoding until stable (handles double/triple encoding)
            while (decodedPath !== prev) {
                prev = decodedPath;
                decodedPath = decodeURIComponent(decodedPath);
            }
        }
        catch {
            // If decoding fails, reject
            return false;
        }
        // Reject null bytes in decoded path
        if (decodedPath.includes('\0')) {
            return false;
        }
        // Resolve the path to an absolute path
        const resolvedPath = node_path_1.default.resolve(rootPath, decodedPath);
        // Check that the resolved path starts with the root
        if (!resolvedPath.startsWith(rootPath + node_path_1.default.sep) && resolvedPath !== rootPath) {
            return false;
        }
        // If the path exists, resolve symlinks and check again
        try {
            const realPath = node_fs_1.default.realpathSync(resolvedPath);
            if (!realPath.startsWith(rootPath + node_path_1.default.sep) && realPath !== rootPath) {
                return false;
            }
        }
        catch {
            // Path doesn't exist yet — that's okay for write operations.
            // The resolved path check above is sufficient.
        }
        return true;
    }
    // ─── resolveAndValidate ──────────────────────────────────────────────────
    function resolveAndValidate(targetPath) {
        if (!isPathAllowed(targetPath)) {
            throw new Error(`Access denied: path is outside the allowed root directory`);
        }
        // Decode iteratively and resolve the path
        let decodedPath = targetPath;
        try {
            let prev = decodedPath;
            decodedPath = decodeURIComponent(decodedPath);
            while (decodedPath !== prev) {
                prev = decodedPath;
                decodedPath = decodeURIComponent(decodedPath);
            }
        }
        catch {
            throw new Error(`Access denied: invalid path encoding`);
        }
        return node_path_1.default.resolve(rootPath, decodedPath);
    }
    // ─── listDirectory ──────────────────────────────────────────────────────
    async function listDirectory(dirPath) {
        const resolvedPath = resolveAndValidate(dirPath);
        const stat = await node_fs_1.default.promises.stat(resolvedPath);
        if (!stat.isDirectory()) {
            throw new Error(`Not a directory: ${dirPath}`);
        }
        const allEntries = await node_fs_1.default.promises.readdir(resolvedPath, { withFileTypes: true });
        const total = allEntries.length;
        const truncated = total > maxEntries;
        const entriesToProcess = allEntries.slice(0, maxEntries);
        const entries = [];
        for (const dirent of entriesToProcess) {
            const entryPath = node_path_1.default.join(resolvedPath, dirent.name);
            try {
                const entryStat = await node_fs_1.default.promises.lstat(entryPath);
                entries.push({
                    name: dirent.name,
                    type: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file',
                    size: entryStat.size,
                    permissions: formatPermissions(entryStat.mode),
                    lastModified: entryStat.mtime,
                });
            }
            catch {
                // Skip entries we can't stat (e.g., broken symlinks)
                entries.push({
                    name: dirent.name,
                    type: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file',
                    size: 0,
                    permissions: '----------',
                    lastModified: new Date(0),
                });
            }
        }
        return {
            entries,
            truncated,
            total,
            path: dirPath,
        };
    }
    // ─── readFile ────────────────────────────────────────────────────────────
    async function readFile(filePath) {
        const resolvedPath = resolveAndValidate(filePath);
        const stat = await node_fs_1.default.promises.stat(resolvedPath);
        if (stat.isDirectory()) {
            throw new Error(`Cannot read a directory as a file: ${filePath}`);
        }
        if (stat.size > maxFileSize) {
            throw new Error(`File too large to read: ${stat.size} bytes exceeds the ${maxFileSize} byte limit`);
        }
        const content = await node_fs_1.default.promises.readFile(resolvedPath, 'utf-8');
        const language = detectLanguage(resolvedPath);
        return {
            content,
            language,
            size: stat.size,
            path: filePath,
        };
    }
    // ─── writeFile ───────────────────────────────────────────────────────────
    async function writeFile(filePath, content) {
        const resolvedPath = resolveAndValidate(filePath);
        // Ensure the parent directory exists
        const parentDir = node_path_1.default.dirname(resolvedPath);
        await node_fs_1.default.promises.mkdir(parentDir, { recursive: true });
        await node_fs_1.default.promises.writeFile(resolvedPath, content, 'utf-8');
    }
    // ─── getFileInfo ─────────────────────────────────────────────────────────
    async function getFileInfo(filePath) {
        const resolvedPath = resolveAndValidate(filePath);
        const stat = await node_fs_1.default.promises.lstat(resolvedPath);
        return {
            name: node_path_1.default.basename(resolvedPath),
            size: stat.size,
            permissions: formatPermissions(stat.mode),
            lastModified: stat.mtime,
            type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
        };
    }
    // ─── Return the public API ─────────────────────────────────────────────────
    return {
        listDirectory,
        readFile,
        writeFile,
        getFileInfo,
        isPathAllowed,
    };
}
// ─── Internal Helpers ──────────────────────────────────────────────────────────
/**
 * Detect the programming language of a file based on its name and extension.
 */
function detectLanguage(filePath) {
    const basename = node_path_1.default.basename(filePath);
    // Check for known full filenames first
    if (FILENAME_LANGUAGE_MAP[basename]) {
        return FILENAME_LANGUAGE_MAP[basename];
    }
    // Check by extension
    const ext = node_path_1.default.extname(filePath).toLowerCase();
    if (EXTENSION_LANGUAGE_MAP[ext]) {
        return EXTENSION_LANGUAGE_MAP[ext];
    }
    return 'plaintext';
}
/**
 * Convert a file mode integer to a Unix permission string (e.g., "-rwxr-xr-x").
 */
function formatPermissions(mode) {
    const typeChar = getTypeChar(mode);
    const owner = triplet((mode >> 6) & 7);
    const group = triplet((mode >> 3) & 7);
    const other = triplet(mode & 7);
    return `${typeChar}${owner}${group}${other}`;
}
function getTypeChar(mode) {
    const S_IFMT = 0o170000;
    const S_IFDIR = 0o040000;
    const S_IFLNK = 0o120000;
    const S_IFREG = 0o100000;
    const S_IFBLK = 0o060000;
    const S_IFCHR = 0o020000;
    const S_IFIFO = 0o010000;
    const S_IFSOCK = 0o140000;
    const type = mode & S_IFMT;
    switch (type) {
        case S_IFDIR: return 'd';
        case S_IFLNK: return 'l';
        case S_IFREG: return '-';
        case S_IFBLK: return 'b';
        case S_IFCHR: return 'c';
        case S_IFIFO: return 'p';
        case S_IFSOCK: return 's';
        default: return '-';
    }
}
function triplet(perm) {
    const r = (perm & 4) ? 'r' : '-';
    const w = (perm & 2) ? 'w' : '-';
    const x = (perm & 1) ? 'x' : '-';
    return `${r}${w}${x}`;
}
//# sourceMappingURL=file-manager.js.map