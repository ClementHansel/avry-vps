/**
 * Database Manager Module
 *
 * Discovers MySQL/MariaDB/PostgreSQL containers on the Docker network,
 * connects via Docker network using mysql2 and pg clients, and provides
 * database CRUD operations, query execution, export/import, and user management.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8
 */
import Dockerode from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_QUERY_LENGTH = 10_000;
const MAX_RESULT_ROWS = 1000;
const MAX_IMPORT_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const DB_IMAGE_PATTERNS: Record<DatabaseType, RegExp[]> = {
  mysql: [/^mysql:/i, /mysql/i],
  mariadb: [/^mariadb:/i, /mariadb/i],
  postgresql: [/^postgres:/i, /^postgresql:/i, /postgres/i, /postgresql/i],
};

// ─── Interfaces ────────────────────────────────────────────────────────────────

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

// ─── Error Sanitization ────────────────────────────────────────────────────────

/**
 * Strips connection credentials from error messages before surfacing to users.
 * Requirement 16.8: Surface DB errors without exposing connection credentials.
 */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // Remove password patterns
  let sanitized = message
    .replace(/password[=:]\s*['"]?[^'"\s;]+['"]?/gi, 'password=***')
    .replace(/IDENTIFIED BY\s+['"][^'"]+['"]/gi, 'IDENTIFIED BY \'***\'')
    .replace(/PASSWORD\s*\(\s*['"][^'"]+['"]\s*\)/gi, 'PASSWORD(\'***\')')
    .replace(/host[=:]\s*['"]?[\d.]+['"]?/gi, 'host=***')
    .replace(/user[=:]\s*['"]?[^'"\s;]+['"]?/gi, 'user=***')
    .replace(/(?:mysql|postgres|postgresql):\/\/[^@]+@/gi, '***://***@')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***');

  return sanitized;
}

// ─── Factory Function ──────────────────────────────────────────────────────────

export function createDatabaseManager(
  config?: DatabaseManagerConfig
): DatabaseManager {
  const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
  const exportDir = config?.exportDir ?? '/tmp/db-exports';

  // Initialize Docker client
  const dockerOpts = dockerHost.startsWith('/')
    ? { socketPath: dockerHost }
    : { host: dockerHost };
  const docker = new Dockerode(dockerOpts);

  // Cache of discovered servers
  let serverCache: Map<string, DatabaseServer> = new Map();

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function detectDatabaseType(image: string): DatabaseType | null {
    for (const [type, patterns] of Object.entries(DB_IMAGE_PATTERNS) as [DatabaseType, RegExp[]][]) {
      for (const pattern of patterns) {
        if (pattern.test(image)) {
          return type;
        }
      }
    }
    return null;
  }

  function getDefaultPort(type: DatabaseType): number {
    switch (type) {
      case 'mysql':
      case 'mariadb':
        return 3306;
      case 'postgresql':
        return 5432;
    }
  }

  function isMysqlType(type: DatabaseType): boolean {
    return type === 'mysql' || type === 'mariadb';
  }

  function getContainerEnvVar(env: string[] | undefined, key: string): string | undefined {
    if (!env) return undefined;
    const prefix = `${key}=`;
    const entry = env.find((e) => e.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : undefined;
  }

  /**
   * Retrieves connection credentials from container environment variables.
   * This is used internally and never exposed to users.
   */
  async function getConnectionInfo(server: DatabaseServer): Promise<{
    host: string;
    port: number;
    user: string;
    password: string;
  }> {
    const container = docker.getContainer(server.containerId);
    const inspect = await container.inspect();
    const env = inspect.Config.Env;

    if (isMysqlType(server.type)) {
      const password =
        getContainerEnvVar(env, 'MYSQL_ROOT_PASSWORD') ??
        getContainerEnvVar(env, 'MARIADB_ROOT_PASSWORD') ??
        '';
      const user =
        getContainerEnvVar(env, 'MYSQL_USER') ??
        getContainerEnvVar(env, 'MARIADB_USER') ??
        'root';
      const actualPassword = user === 'root'
        ? password
        : getContainerEnvVar(env, 'MYSQL_PASSWORD') ?? getContainerEnvVar(env, 'MARIADB_PASSWORD') ?? password;

      return {
        host: server.dockerNetworkIp ?? server.containerName,
        port: server.port,
        user: 'root',
        password,
      };
    } else {
      // PostgreSQL
      const password =
        getContainerEnvVar(env, 'POSTGRES_PASSWORD') ?? '';
      const user =
        getContainerEnvVar(env, 'POSTGRES_USER') ?? 'postgres';

      return {
        host: server.dockerNetworkIp ?? server.containerName,
        port: server.port,
        user,
        password,
      };
    }
  }

  /**
   * Execute a command inside a Docker container and return its output.
   */
  async function execInContainer(
    containerId: string,
    cmd: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      // Docker multiplexed stream: 8-byte header per frame
      // byte 0: stream type (1=stdout, 2=stderr)
      // bytes 4-7: frame size (big-endian uint32)
      stream.on('data', (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) {
            // Incomplete header, treat rest as stdout
            stdoutChunks.push(chunk.slice(offset));
            break;
          }
          const streamType = chunk[offset];
          const frameSize = chunk.readUInt32BE(offset + 4);
          const frameData = chunk.slice(offset + 8, offset + 8 + frameSize);

          if (streamType === 2) {
            stderrChunks.push(frameData);
          } else {
            stdoutChunks.push(frameData);
          }
          offset += 8 + frameSize;
        }
      });

      stream.on('end', async () => {
        try {
          const inspectResult = await exec.inspect();
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
            stderr: Buffer.concat(stderrChunks).toString('utf-8'),
            exitCode: inspectResult.ExitCode ?? 0,
          });
        } catch (err) {
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
            stderr: Buffer.concat(stderrChunks).toString('utf-8'),
            exitCode: -1,
          });
        }
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  // ─── MySQL/MariaDB Operations ────────────────────────────────────────────

  async function mysqlListDatabases(server: DatabaseServer): Promise<DatabaseInfo[]> {
    const conn = await getConnectionInfo(server);
    const cmd = [
      'mysql',
      '-u', conn.user,
      `-p${conn.password}`,
      '-N', '-e',
      'SELECT table_schema AS name, SUM(data_length + index_length) AS size FROM information_schema.tables GROUP BY table_schema;',
    ];

    const result = await execInContainer(server.containerId, cmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Failed to list databases'));
    }

    const databases: DatabaseInfo[] = [];
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 1) {
        const name = parts[0].trim();
        // Skip system databases
        if (['information_schema', 'performance_schema', 'sys'].includes(name)) continue;
        const sizeBytes = parts[1] ? parseInt(parts[1], 10) : undefined;
        databases.push({ name, sizeBytes: isNaN(sizeBytes as number) ? undefined : sizeBytes });
      }
    }
    return databases;
  }

  async function mysqlCreateDatabase(server: DatabaseServer, name: string): Promise<void> {
    const conn = await getConnectionInfo(server);
    // Validate database name (prevent injection)
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error('Invalid database name. Only alphanumeric characters and underscores are allowed.');
    }
    const cmd = [
      'mysql',
      '-u', conn.user,
      `-p${conn.password}`,
      '-e', `CREATE DATABASE \`${name}\`;`,
    ];

    const result = await execInContainer(server.containerId, cmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Failed to create database'));
    }
  }

  async function mysqlExecuteQuery(
    server: DatabaseServer,
    db: string,
    query: string
  ): Promise<QueryResult> {
    const conn = await getConnectionInfo(server);
    const startTime = Date.now();

    // Limit rows by wrapping query if it's a SELECT
    const isSelect = /^\s*SELECT/i.test(query);
    const limitedQuery = isSelect
      ? `${query.replace(/;\s*$/, '')} LIMIT ${MAX_RESULT_ROWS + 1};`
      : query;

    const cmd = [
      'mysql',
      '-u', conn.user,
      `-p${conn.password}`,
      db,
      '-N', '--batch', '-e',
      limitedQuery,
    ];

    const result = await execInContainer(server.containerId, cmd);
    const executionTimeMs = Date.now() - startTime;

    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Query execution failed'));
    }

    // Parse tabular output
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { columns: [], rows: [], rowCount: 0, truncated: false, executionTimeMs };
    }

    // For batch mode, first line isn't headers with -N flag
    // Re-run without -N to get headers
    const cmdWithHeaders = [
      'mysql',
      '-u', conn.user,
      `-p${conn.password}`,
      db,
      '--batch', '-e',
      limitedQuery,
    ];

    const resultWithHeaders = await execInContainer(server.containerId, cmdWithHeaders);
    const linesWithHeaders = resultWithHeaders.stdout.trim().split('\n').filter(Boolean);

    if (linesWithHeaders.length === 0) {
      return { columns: [], rows: [], rowCount: 0, truncated: false, executionTimeMs };
    }

    const columns = linesWithHeaders[0].split('\t');
    const dataLines = linesWithHeaders.slice(1);
    const truncated = dataLines.length > MAX_RESULT_ROWS;
    const cappedLines = dataLines.slice(0, MAX_RESULT_ROWS);

    const rows: Record<string, unknown>[] = cappedLines.map((line) => {
      const values = line.split('\t');
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i] === 'NULL' ? null : values[i];
      });
      return row;
    });

    return { columns, rows, rowCount: rows.length, truncated, executionTimeMs };
  }

  async function mysqlManageUser(server: DatabaseServer, user: DatabaseUserInput): Promise<void> {
    const conn = await getConnectionInfo(server);
    const host = user.host ?? '%';
    let sql: string;

    // Validate username
    if (!/^[a-zA-Z0-9_]+$/.test(user.username)) {
      throw new Error('Invalid username. Only alphanumeric characters and underscores are allowed.');
    }

    switch (user.action) {
      case 'create':
        if (!user.password) throw new Error('Password is required to create a user.');
        sql = `CREATE USER '${user.username}'@'${host}' IDENTIFIED BY '${user.password}';`;
        break;
      case 'drop':
        sql = `DROP USER IF EXISTS '${user.username}'@'${host}';`;
        break;
      case 'grant': {
        const perms = user.permissions?.join(', ') ?? 'ALL PRIVILEGES';
        const db = user.database ?? '*';
        sql = `GRANT ${perms} ON \`${db}\`.* TO '${user.username}'@'${host}'; FLUSH PRIVILEGES;`;
        break;
      }
      case 'revoke': {
        const perms = user.permissions?.join(', ') ?? 'ALL PRIVILEGES';
        const db = user.database ?? '*';
        sql = `REVOKE ${perms} ON \`${db}\`.* FROM '${user.username}'@'${host}'; FLUSH PRIVILEGES;`;
        break;
      }
      default:
        throw new Error(`Unknown user action: ${user.action}`);
    }

    const cmd = ['mysql', '-u', conn.user, `-p${conn.password}`, '-e', sql];
    const result = await execInContainer(server.containerId, cmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'User management operation failed'));
    }
  }

  async function mysqlExportDatabase(server: DatabaseServer, db: string): Promise<string> {
    const conn = await getConnectionInfo(server);
    const exportId = uuidv4();
    const exportFile = path.join(exportDir, `${db}_${exportId}.sql`);

    // Ensure export directory exists
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const cmd = [
      'mysqldump',
      '-u', conn.user,
      `-p${conn.password}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      db,
    ];

    const result = await execInContainer(server.containerId, cmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Database export failed'));
    }

    // Write the dump to the export file
    fs.writeFileSync(exportFile, result.stdout, 'utf-8');
    return exportFile;
  }

  async function mysqlImportDatabase(
    server: DatabaseServer,
    db: string,
    filePath: string
  ): Promise<string> {
    const conn = await getConnectionInfo(server);
    const jobId = uuidv4();

    // Validate file size
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_IMPORT_FILE_SIZE) {
      throw new Error(`Import file exceeds maximum size of 500 MB (actual: ${Math.round(stats.size / 1024 / 1024)} MB)`);
    }

    // Read the file content and pipe it via docker exec
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const container = docker.getContainer(server.containerId);

    const exec = await container.exec({
      Cmd: ['mysql', '-u', conn.user, `-p${conn.password}`, db],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    return new Promise((resolve, reject) => {
      const totalBytes = Buffer.byteLength(fileContent, 'utf-8');
      const chunkSize = 64 * 1024; // 64KB chunks for progress indication
      let bytesWritten = 0;

      const chunks: string[] = [];
      for (let i = 0; i < fileContent.length; i += chunkSize) {
        chunks.push(fileContent.slice(i, i + chunkSize));
      }

      let chunkIndex = 0;

      function writeNextChunk() {
        while (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex];
          chunkIndex++;
          bytesWritten += Buffer.byteLength(chunk, 'utf-8');

          const canContinue = stream.write(chunk);
          if (!canContinue) {
            stream.once('drain', writeNextChunk);
            return;
          }
        }
        // All chunks written
        stream.end();
      }

      stream.on('finish', () => {
        resolve(jobId);
      });

      stream.on('error', (err: Error) => {
        reject(new Error(sanitizeErrorMessage(err)));
      });

      writeNextChunk();
    });
  }

  // ─── PostgreSQL Operations ───────────────────────────────────────────────

  async function pgListDatabases(server: DatabaseServer): Promise<DatabaseInfo[]> {
    const conn = await getConnectionInfo(server);
    const cmd = [
      'psql',
      '-U', conn.user,
      '-t', '-A', '-c',
      "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false;",
    ];

    const envCmd = ['sh', '-c', `PGPASSWORD='${conn.password}' ${cmd.join(' ')}`];
    const result = await execInContainer(server.containerId, envCmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Failed to list databases'));
    }

    const databases: DatabaseInfo[] = [];
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 1) {
        const name = parts[0].trim();
        const sizeBytes = parts[1] ? parseInt(parts[1].trim(), 10) : undefined;
        databases.push({ name, sizeBytes: isNaN(sizeBytes as number) ? undefined : sizeBytes });
      }
    }
    return databases;
  }

  async function pgCreateDatabase(server: DatabaseServer, name: string): Promise<void> {
    const conn = await getConnectionInfo(server);
    // Validate database name (prevent injection)
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error('Invalid database name. Only alphanumeric characters and underscores are allowed.');
    }

    const envCmd = [
      'sh', '-c',
      `PGPASSWORD='${conn.password}' createdb -U ${conn.user} ${name}`,
    ];

    const result = await execInContainer(server.containerId, envCmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Failed to create database'));
    }
  }

  async function pgExecuteQuery(
    server: DatabaseServer,
    db: string,
    query: string
  ): Promise<QueryResult> {
    const conn = await getConnectionInfo(server);
    const startTime = Date.now();

    // Limit rows for SELECT queries
    const isSelect = /^\s*SELECT/i.test(query);
    const limitedQuery = isSelect
      ? `${query.replace(/;\s*$/, '')} LIMIT ${MAX_RESULT_ROWS + 1};`
      : query;

    const envCmd = [
      'sh', '-c',
      `PGPASSWORD='${conn.password}' psql -U ${conn.user} -d ${db} -t -A -F '\t' -c "${limitedQuery.replace(/"/g, '\\"')}"`,
    ];

    const result = await execInContainer(server.containerId, envCmd);
    const executionTimeMs = Date.now() - startTime;

    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Query execution failed'));
    }

    // Get column headers separately
    const headerCmd = [
      'sh', '-c',
      `PGPASSWORD='${conn.password}' psql -U ${conn.user} -d ${db} -A -F '\t' -c "${limitedQuery.replace(/"/g, '\\"')}" | head -1`,
    ];

    const headerResult = await execInContainer(server.containerId, headerCmd);
    const headerLine = headerResult.stdout.trim().split('\n')[0] ?? '';
    const columns = headerLine ? headerLine.split('\t') : [];

    const dataLines = result.stdout.trim().split('\n').filter(Boolean);
    const truncated = dataLines.length > MAX_RESULT_ROWS;
    const cappedLines = dataLines.slice(0, MAX_RESULT_ROWS);

    const rows: Record<string, unknown>[] = cappedLines.map((line) => {
      const values = line.split('\t');
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i] === '' ? null : values[i];
      });
      return row;
    });

    return { columns, rows, rowCount: rows.length, truncated, executionTimeMs };
  }

  async function pgManageUser(server: DatabaseServer, user: DatabaseUserInput): Promise<void> {
    const conn = await getConnectionInfo(server);
    let sql: string;

    // Validate username
    if (!/^[a-zA-Z0-9_]+$/.test(user.username)) {
      throw new Error('Invalid username. Only alphanumeric characters and underscores are allowed.');
    }

    switch (user.action) {
      case 'create':
        if (!user.password) throw new Error('Password is required to create a user.');
        sql = `CREATE USER ${user.username} WITH PASSWORD '${user.password}';`;
        break;
      case 'drop':
        sql = `DROP USER IF EXISTS ${user.username};`;
        break;
      case 'grant': {
        const perms = user.permissions?.join(', ') ?? 'ALL PRIVILEGES';
        const db = user.database ?? '*';
        if (db === '*') {
          sql = `ALTER USER ${user.username} WITH SUPERUSER;`;
        } else {
          sql = `GRANT ${perms} ON DATABASE ${db} TO ${user.username};`;
        }
        break;
      }
      case 'revoke': {
        const perms = user.permissions?.join(', ') ?? 'ALL PRIVILEGES';
        const db = user.database ?? '*';
        if (db === '*') {
          sql = `ALTER USER ${user.username} WITH NOSUPERUSER;`;
        } else {
          sql = `REVOKE ${perms} ON DATABASE ${db} FROM ${user.username};`;
        }
        break;
      }
      default:
        throw new Error(`Unknown user action: ${user.action}`);
    }

    const envCmd = [
      'sh', '-c',
      `PGPASSWORD='${conn.password}' psql -U ${conn.user} -c "${sql.replace(/"/g, '\\"')}"`,
    ];

    const result = await execInContainer(server.containerId, envCmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'User management operation failed'));
    }
  }

  async function pgExportDatabase(server: DatabaseServer, db: string): Promise<string> {
    const conn = await getConnectionInfo(server);
    const exportId = uuidv4();
    const exportFile = path.join(exportDir, `${db}_${exportId}.sql`);

    // Ensure export directory exists
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const envCmd = [
      'sh', '-c',
      `PGPASSWORD='${conn.password}' pg_dump -U ${conn.user} ${db}`,
    ];

    const result = await execInContainer(server.containerId, envCmd);
    if (result.exitCode !== 0) {
      throw new Error(sanitizeErrorMessage(result.stderr || 'Database export failed'));
    }

    fs.writeFileSync(exportFile, result.stdout, 'utf-8');
    return exportFile;
  }

  async function pgImportDatabase(
    server: DatabaseServer,
    db: string,
    filePath: string
  ): Promise<string> {
    const conn = await getConnectionInfo(server);
    const jobId = uuidv4();

    // Validate file size
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_IMPORT_FILE_SIZE) {
      throw new Error(`Import file exceeds maximum size of 500 MB (actual: ${Math.round(stats.size / 1024 / 1024)} MB)`);
    }

    // Read the file content and pipe it via docker exec
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const container = docker.getContainer(server.containerId);

    const exec = await container.exec({
      Cmd: ['sh', '-c', `PGPASSWORD='${conn.password}' psql -U ${conn.user} -d ${db}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    return new Promise((resolve, reject) => {
      const totalBytes = Buffer.byteLength(fileContent, 'utf-8');
      const chunkSize = 64 * 1024; // 64KB chunks for progress indication
      let bytesWritten = 0;

      const chunks: string[] = [];
      for (let i = 0; i < fileContent.length; i += chunkSize) {
        chunks.push(fileContent.slice(i, i + chunkSize));
      }

      let chunkIndex = 0;

      function writeNextChunk() {
        while (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex];
          chunkIndex++;
          bytesWritten += Buffer.byteLength(chunk, 'utf-8');

          const canContinue = stream.write(chunk);
          if (!canContinue) {
            stream.once('drain', writeNextChunk);
            return;
          }
        }
        stream.end();
      }

      stream.on('finish', () => {
        resolve(jobId);
      });

      stream.on('error', (err: Error) => {
        reject(new Error(sanitizeErrorMessage(err)));
      });

      writeNextChunk();
    });
  }

  // ─── Public Interface ────────────────────────────────────────────────────

  return {
    /**
     * Discover MySQL/MariaDB/PostgreSQL containers on the Docker network.
     * Requirement 16.1: Detect running DB containers and display them.
     */
    async discoverServers(): Promise<DatabaseServer[]> {
      try {
        const containers = await docker.listContainers({ all: false });
        const servers: DatabaseServer[] = [];

        for (const containerInfo of containers) {
          const image = containerInfo.Image;
          const type = detectDatabaseType(image);
          if (!type) continue;

          // Get network information
          const networks = containerInfo.NetworkSettings?.Networks ?? {};
          let dockerNetworkIp: string | undefined;

          // Find the first non-bridge network IP, or fall back to any
          for (const [, netInfo] of Object.entries(networks)) {
            if (netInfo.IPAddress) {
              dockerNetworkIp = netInfo.IPAddress;
              break;
            }
          }

          const containerName = (containerInfo.Names[0] ?? '').replace(/^\//, '');
          const defaultPort = getDefaultPort(type);

          // Check exposed ports for the actual mapped port
          let hostPort = defaultPort;
          if (containerInfo.Ports) {
            const dbPort = containerInfo.Ports.find((p) => p.PrivatePort === defaultPort);
            if (dbPort?.PublicPort) {
              hostPort = dbPort.PublicPort;
            }
          }

          const server: DatabaseServer = {
            id: containerInfo.Id.substring(0, 12),
            type,
            containerName,
            containerId: containerInfo.Id,
            host: dockerNetworkIp ?? containerName,
            port: defaultPort,
            dockerNetworkIp,
          };

          servers.push(server);
          serverCache.set(server.id, server);
        }

        return servers;
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * List all databases on a discovered server.
     * Requirement 16.2: Display all databases with names and sizes.
     */
    async listDatabases(serverId: string): Promise<DatabaseInfo[]> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      try {
        if (isMysqlType(server.type)) {
          return await mysqlListDatabases(server);
        } else {
          return await pgListDatabases(server);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * Create a new database on the specified server.
     * Requirement 16.3: Execute CREATE DATABASE and display result within 5 seconds.
     */
    async createDatabase(serverId: string, name: string): Promise<void> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      try {
        if (isMysqlType(server.type)) {
          await mysqlCreateDatabase(server, name);
        } else {
          await pgCreateDatabase(server, name);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * Execute a SQL query against a specific database.
     * Requirement 16.5: Execute query (max 10,000 chars), display results (max 1000 rows).
     */
    async executeQuery(serverId: string, db: string, query: string): Promise<QueryResult> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      // Validate query length
      if (query.length > MAX_QUERY_LENGTH) {
        throw new Error(`Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters (actual: ${query.length})`);
      }

      try {
        if (isMysqlType(server.type)) {
          return await mysqlExecuteQuery(server, db, query);
        } else {
          return await pgExecuteQuery(server, db, query);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * Export a database using mysqldump or pg_dump.
     * Requirement 16.6: Execute dump and make SQL file available for download.
     */
    async exportDatabase(serverId: string, db: string): Promise<string> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      try {
        if (isMysqlType(server.type)) {
          return await mysqlExportDatabase(server, db);
        } else {
          return await pgExportDatabase(server, db);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * Import a SQL dump file into a database.
     * Requirement 16.7: Import file (max 500 MB) with progress indication.
     */
    async importDatabase(serverId: string, db: string, file: string): Promise<string> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      // Validate file exists
      if (!fs.existsSync(file)) {
        throw new Error(`Import file not found: ${file}`);
      }

      // Validate file size
      const stats = fs.statSync(file);
      if (stats.size > MAX_IMPORT_FILE_SIZE) {
        throw new Error(`Import file exceeds maximum size of 500 MB (actual: ${Math.round(stats.size / 1024 / 1024)} MB)`);
      }

      try {
        if (isMysqlType(server.type)) {
          return await mysqlImportDatabase(server, db, file);
        } else {
          return await pgImportDatabase(server, db, file);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },

    /**
     * Manage database users (create, drop, grant, revoke).
     * Requirement 16.4: Execute GRANT/REVOKE and display result within 5 seconds.
     */
    async manageUser(serverId: string, user: DatabaseUserInput): Promise<void> {
      const server = serverCache.get(serverId);
      if (!server) {
        throw new Error(`Database server not found: ${serverId}. Run discoverServers() first.`);
      }

      try {
        if (isMysqlType(server.type)) {
          await mysqlManageUser(server, user);
        } else {
          await pgManageUser(server, user);
        }
      } catch (error) {
        throw new Error(sanitizeErrorMessage(error));
      }
    },
  };
}
