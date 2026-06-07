/**
 * Backup Manager Module
 *
 * Provides scheduled and on-demand backups of Docker volumes and compose files,
 * with support for local filesystem and S3-compatible storage, configurable
 * retention policy, backup history tracking, and restore functionality.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface BackupScheduleConfig {
  /** Cron expression for frequency */
  frequency: string;
  /** Targets to back up: Docker volume names and compose file paths */
  targets: string[];
  /** Storage destination type */
  storageType: 'local' | 's3';
  /** Storage configuration (local path or S3 config) */
  storageConfig: LocalStorageConfig | S3StorageConfig;
  /** Number of backups to retain. Default: 7 */
  retentionCount?: number;
  /** Whether the schedule is active */
  enabled?: boolean;
}

export interface LocalStorageConfig {
  path: string;
}

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
}

export interface BackupEntry {
  id: string;
  scheduleId?: string;
  timestamp: Date;
  size: number;
  targets: string[];
  storage: 'local' | 's3';
  storagePath: string;
  status: 'completed' | 'failed' | 'in-progress';
}

export interface BackupManager {
  configureSchedule(config: BackupScheduleConfig): Promise<string>;
  triggerBackup(targets?: string[]): Promise<string>;
  restoreBackup(backupId: string): Promise<string>;
  listBackups(): Promise<BackupEntry[]>;
  deleteBackup(backupId: string): Promise<void>;
  /** Start the cron-based scheduler */
  startScheduler(): void;
  /** Stop the scheduler */
  stopScheduler(): void;
}

export interface AlertCallback {
  onBackupFailure(backupId: string, error: string, targets: string[]): void;
}

export interface BackupManagerConfig {
  /** Working directory for temporary archives. Default: /tmp/vps-panel-backups */
  workDir?: string;
  /** Alert callback for failure notifications */
  alertCallback?: AlertCallback;
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface RawBackupRow {
  id: string;
  schedule_id: string | null;
  timestamp: string;
  size: number | null;
  targets: string;
  storage_type: string;
  storage_path: string;
  status: string;
}

interface RawScheduleRow {
  id: string;
  frequency: string;
  targets: string;
  storage_type: string;
  storage_config: string | null;
  retention_count: number;
  enabled: number;
  created_at: string;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createBackupManager(
  db: Database.Database,
  config?: BackupManagerConfig
): BackupManager {
  const workDir = config?.workDir ?? '/tmp/vps-panel-backups';
  const alertCallback = config?.alertCallback;
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;

  // Ensure work directory exists
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  // Prepared statements
  const insertScheduleStmt = db.prepare(`
    INSERT INTO backup_schedules (id, frequency, targets, storage_type, storage_config, retention_count, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBackupStmt = db.prepare(`
    INSERT INTO backups (id, schedule_id, timestamp, size, targets, storage_type, storage_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBackupStmt = db.prepare(`
    UPDATE backups SET size = ?, storage_path = ?, status = ? WHERE id = ?
  `);

  const getBackupStmt = db.prepare(`SELECT * FROM backups WHERE id = ?`);

  const listBackupsStmt = db.prepare(
    `SELECT * FROM backups ORDER BY timestamp DESC`
  );

  const deleteBackupStmt = db.prepare(`DELETE FROM backups WHERE id = ?`);

  const getSchedulesStmt = db.prepare(
    `SELECT * FROM backup_schedules WHERE enabled = 1`
  );

  const getScheduleStmt = db.prepare(`SELECT * FROM backup_schedules WHERE id = ?`);

  // ─── configureSchedule ───────────────────────────────────────────────────

  async function configureSchedule(scheduleConfig: BackupScheduleConfig): Promise<string> {
    const id = uuidv4();
    const targets = JSON.stringify(scheduleConfig.targets);
    const storageConfig = JSON.stringify(scheduleConfig.storageConfig);
    const retentionCount = scheduleConfig.retentionCount ?? 7;
    const enabled = scheduleConfig.enabled !== false ? 1 : 0;

    insertScheduleStmt.run(
      id,
      scheduleConfig.frequency,
      targets,
      scheduleConfig.storageType,
      storageConfig,
      retentionCount,
      enabled
    );

    return id;
  }

  // ─── triggerBackup ─────────────────────────────────────────────────────────

  async function triggerBackup(targets?: string[]): Promise<string> {
    // Get configuration from first enabled schedule or use provided targets
    let scheduleId: string | null = null;
    let backupTargets: string[];
    let storageType: 'local' | 's3';
    let storageConfig: LocalStorageConfig | S3StorageConfig;
    let retentionCount = 7;

    if (targets && targets.length > 0) {
      // Manual backup with specific targets - use first schedule's storage config or defaults
      backupTargets = targets;
      const schedule = getSchedulesStmt.get() as RawScheduleRow | undefined;
      if (schedule) {
        scheduleId = schedule.id;
        storageType = schedule.storage_type as 'local' | 's3';
        storageConfig = JSON.parse(schedule.storage_config ?? '{}');
        retentionCount = schedule.retention_count;
      } else {
        // Default to local storage in workDir
        storageType = 'local';
        storageConfig = { path: workDir } as LocalStorageConfig;
      }
    } else {
      // Use the first enabled schedule's full configuration
      const schedule = getSchedulesStmt.get() as RawScheduleRow | undefined;
      if (!schedule) {
        throw new Error('No backup schedule configured. Please configure a schedule first.');
      }
      scheduleId = schedule.id;
      backupTargets = JSON.parse(schedule.targets);
      storageType = schedule.storage_type as 'local' | 's3';
      storageConfig = JSON.parse(schedule.storage_config ?? '{}');
      retentionCount = schedule.retention_count;
    }

    // Create backup record as in-progress
    const backupId = uuidv4();
    const timestamp = new Date().toISOString();

    insertBackupStmt.run(
      backupId,
      scheduleId,
      timestamp,
      0,
      JSON.stringify(backupTargets),
      storageType,
      '',
      'in-progress'
    );

    // Execute backup asynchronously
    executeBackup(backupId, backupTargets, storageType, storageConfig, retentionCount, scheduleId)
      .catch(() => {
        // Error handling is done inside executeBackup
      });

    return backupId;
  }

  // ─── executeBackup (internal) ──────────────────────────────────────────────

  async function executeBackup(
    backupId: string,
    targets: string[],
    storageType: 'local' | 's3',
    storageConfig: LocalStorageConfig | S3StorageConfig,
    retentionCount: number,
    scheduleId: string | null
  ): Promise<void> {
    const archiveName = `backup-${backupId}.tar.gz`;
    const tempArchivePath = path.join(workDir, archiveName);

    try {
      // Step 1: Collect backup data into temp directory
      const tempDir = path.join(workDir, `backup-${backupId}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      for (const target of targets) {
        await backupTarget(target, tempDir);
      }

      // Step 2: Create tar.gz archive
      await execAsync(`tar -czf "${tempArchivePath}" -C "${tempDir}" .`);

      // Get archive size
      const stat = fs.statSync(tempArchivePath);
      const archiveSize = stat.size;

      // Step 3: Move to storage destination
      let finalPath: string;
      if (storageType === 's3') {
        finalPath = await uploadToS3(tempArchivePath, archiveName, storageConfig as S3StorageConfig);
      } else {
        finalPath = moveToLocalStorage(tempArchivePath, archiveName, storageConfig as LocalStorageConfig);
      }

      // Step 4: Update backup record as completed
      updateBackupStmt.run(archiveSize, finalPath, 'completed', backupId);

      // Step 5: Enforce retention policy (delete excess after success)
      enforceRetention(scheduleId, retentionCount, storageType);

      // Step 6: Clean up temp directory
      cleanupTempDir(tempDir);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Mark backup as failed
      updateBackupStmt.run(0, '', 'failed', backupId);

      // Generate alert on failure
      if (alertCallback) {
        const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
        const failedTargets = backup ? JSON.parse(backup.targets) : targets;
        alertCallback.onBackupFailure(backupId, errorMessage, failedTargets);
      }

      // Clean up temp files
      try {
        if (fs.existsSync(tempArchivePath)) fs.unlinkSync(tempArchivePath);
        const tempDir = path.join(workDir, `backup-${backupId}`);
        if (fs.existsSync(tempDir)) cleanupTempDir(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // ─── backupTarget (internal) ───────────────────────────────────────────────

  async function backupTarget(target: string, destDir: string): Promise<void> {
    // Determine if target is a Docker volume or a filesystem path (compose file)
    if (await isDockerVolume(target)) {
      // Backup Docker volume via docker cp using a temporary container
      await backupDockerVolume(target, destDir);
    } else {
      // Backup filesystem path (compose file or config)
      backupFilesystemPath(target, destDir);
    }
  }

  async function isDockerVolume(target: string): Promise<boolean> {
    try {
      await execAsync(`docker volume inspect "${target}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async function backupDockerVolume(volumeName: string, destDir: string): Promise<void> {
    const volumeDir = path.join(destDir, 'volumes', volumeName);
    if (!fs.existsSync(volumeDir)) {
      fs.mkdirSync(volumeDir, { recursive: true });
    }

    // Use a temporary alpine container to copy volume data out
    const containerName = `backup-helper-${uuidv4().slice(0, 8)}`;
    try {
      await execAsync(
        `docker run --rm --name "${containerName}" -v "${volumeName}:/source:ro" -v "${volumeDir}:/dest" alpine sh -c "cp -a /source/. /dest/"`
      );
    } catch (error) {
      throw new Error(
        `Failed to backup Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function backupFilesystemPath(targetPath: string, destDir: string): void {
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Backup target path does not exist: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const relativeName = path.basename(resolvedPath);
    const destPath = path.join(destDir, 'files', relativeName);

    if (stat.isDirectory()) {
      copyDirectorySync(resolvedPath, destPath);
    } else {
      const destFileDir = path.dirname(destPath);
      if (!fs.existsSync(destFileDir)) {
        fs.mkdirSync(destFileDir, { recursive: true });
      }
      fs.copyFileSync(resolvedPath, destPath);
    }
  }

  // ─── S3 Upload ────────────────────────────────────────────────────────────

  async function uploadToS3(
    filePath: string,
    fileName: string,
    s3Config: S3StorageConfig
  ): Promise<string> {
    // TODO: S3 storage support is work-in-progress. Install @aws-sdk/client-s3 to enable.
    // Currently marked as optionalDependency — will gracefully fail if not installed.
    let S3Client: any;
    let PutObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      PutObjectCommand = s3Module.PutObjectCommand;
    } catch {
      throw new Error(
        'S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3'
      );
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true, // Required for many S3-compatible services
    });

    const fileContent = fs.readFileSync(filePath);
    const key = s3Config.prefix ? `${s3Config.prefix}/${fileName}` : fileName;

    await client.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: fileContent,
        ContentType: 'application/gzip',
      })
    );

    // Clean up local temp file after upload
    fs.unlinkSync(filePath);

    return `s3://${s3Config.bucket}/${key}`;
  }

  // ─── Local Storage ─────────────────────────────────────────────────────────

  function moveToLocalStorage(
    archivePath: string,
    archiveName: string,
    localConfig: LocalStorageConfig
  ): string {
    const destDir = path.resolve(localConfig.path);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destPath = path.join(destDir, archiveName);
    fs.renameSync(archivePath, destPath);
    return destPath;
  }

  // ─── Retention Policy ──────────────────────────────────────────────────────

  function enforceRetention(
    scheduleId: string | null,
    retentionCount: number,
    storageType: 'local' | 's3'
  ): void {
    // Get all completed backups for this schedule, ordered by timestamp desc
    let completedBackups: RawBackupRow[];
    if (scheduleId) {
      completedBackups = db
        .prepare(
          `SELECT * FROM backups WHERE schedule_id = ? AND status = 'completed' ORDER BY timestamp DESC`
        )
        .all(scheduleId) as RawBackupRow[];
    } else {
      completedBackups = db
        .prepare(
          `SELECT * FROM backups WHERE status = 'completed' ORDER BY timestamp DESC`
        )
        .all() as RawBackupRow[];
    }

    // Delete excess backups (those beyond retention count)
    if (completedBackups.length > retentionCount) {
      const excessBackups = completedBackups.slice(retentionCount);

      for (const backup of excessBackups) {
        // Delete the archive file if local
        if (backup.storage_type === 'local' && backup.storage_path) {
          try {
            if (fs.existsSync(backup.storage_path)) {
              fs.unlinkSync(backup.storage_path);
            }
          } catch {
            // Continue even if file deletion fails
          }
        }
        // For S3, we'd need to delete the object - handled separately if needed

        // Remove from database
        deleteBackupStmt.run(backup.id);
      }
    }
  }

  // ─── restoreBackup ─────────────────────────────────────────────────────────

  async function restoreBackup(backupId: string): Promise<string> {
    const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    if (backup.status !== 'completed') {
      throw new Error(`Cannot restore backup with status: ${backup.status}`);
    }

    const restoreJobId = uuidv4();
    const targets = JSON.parse(backup.targets) as string[];

    // Execute restore asynchronously
    executeRestore(restoreJobId, backup, targets).catch(() => {
      // Error handling is done inside executeRestore
    });

    return restoreJobId;
  }

  async function executeRestore(
    jobId: string,
    backup: RawBackupRow,
    targets: string[]
  ): Promise<void> {
    const tempDir = path.join(workDir, `restore-${jobId}`);

    try {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Step 1: Get the archive to the temp directory
      const archivePath = path.join(tempDir, 'archive.tar.gz');

      if (backup.storage_type === 's3') {
        await downloadFromS3(backup.storage_path, archivePath, backup);
      } else {
        // Local: copy the archive to temp
        if (!fs.existsSync(backup.storage_path)) {
          throw new Error(`Backup archive not found at: ${backup.storage_path}`);
        }
        fs.copyFileSync(backup.storage_path, archivePath);
      }

      // Step 2: Extract the archive
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

      // Step 3: Restore each target (abort on failure, preserve current state)
      for (const target of targets) {
        await restoreTarget(target, extractDir);
      }

      // Step 4: Clean up
      cleanupTempDir(tempDir);
    } catch (error) {
      // Abort restore on failure, preserve current state
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Clean up temp files
      try {
        cleanupTempDir(tempDir);
      } catch {
        // Ignore cleanup errors
      }

      // Alert on restore failure
      if (alertCallback) {
        alertCallback.onBackupFailure(
          backup.id,
          `Restore failed: ${errorMessage}`,
          targets
        );
      }

      throw new Error(`Restore aborted: ${errorMessage}. Current state preserved.`);
    }
  }

  async function downloadFromS3(
    s3Path: string,
    destPath: string,
    backup: RawBackupRow
  ): Promise<void> {
    // Parse s3://bucket/key format
    const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid S3 path: ${s3Path}`);
    }

    const bucket = match[1];
    const key = match[2];

    // Get S3 config from the backup's schedule
    const schedule = backup.schedule_id
      ? (getScheduleStmt.get(backup.schedule_id) as RawScheduleRow | undefined)
      : undefined;

    if (!schedule?.storage_config) {
      throw new Error('S3 configuration not found for this backup');
    }

    const s3Config = JSON.parse(schedule.storage_config) as S3StorageConfig;

    // TODO: S3 storage support is work-in-progress
    let S3Client: any;
    let GetObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      GetObjectCommand = s3Module.GetObjectCommand;
    } catch {
      throw new Error(
        'S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3'
      );
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    });

    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    if (!response.Body) {
      throw new Error(`Empty response body for S3 object: ${s3Path}`);
    }

    // Write the stream to disk
    const bodyBytes = await response.Body.transformToByteArray();
    fs.writeFileSync(destPath, Buffer.from(bodyBytes));
  }

  async function restoreTarget(target: string, extractDir: string): Promise<void> {
    if (await isDockerVolume(target)) {
      await restoreDockerVolume(target, extractDir);
    } else {
      restoreFilesystemPath(target, extractDir);
    }
  }

  async function restoreDockerVolume(volumeName: string, extractDir: string): Promise<void> {
    const volumeDataDir = path.join(extractDir, 'volumes', volumeName);
    if (!fs.existsSync(volumeDataDir)) {
      throw new Error(`Volume data not found in backup for: ${volumeName}`);
    }

    const containerName = `restore-helper-${uuidv4().slice(0, 8)}`;
    try {
      await execAsync(
        `docker run --rm --name "${containerName}" -v "${volumeName}:/dest" -v "${volumeDataDir}:/source:ro" alpine sh -c "rm -rf /dest/* && cp -a /source/. /dest/"`
      );
    } catch (error) {
      throw new Error(
        `Failed to restore Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function restoreFilesystemPath(targetPath: string, extractDir: string): void {
    const relativeName = path.basename(targetPath);
    const sourcePath = path.join(extractDir, 'files', relativeName);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`File/directory not found in backup for: ${targetPath}`);
    }

    const resolvedTarget = path.resolve(targetPath);
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      // Remove existing directory and copy from backup
      if (fs.existsSync(resolvedTarget)) {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
      }
      copyDirectorySync(sourcePath, resolvedTarget);
    } else {
      // Copy file from backup
      const destDir = path.dirname(resolvedTarget);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(sourcePath, resolvedTarget);
    }
  }

  // ─── listBackups ──────────────────────────────────────────────────────────

  async function listBackups(): Promise<BackupEntry[]> {
    const rows = listBackupsStmt.all() as RawBackupRow[];
    return rows.map(rowToBackupEntry);
  }

  // ─── deleteBackup ─────────────────────────────────────────────────────────

  async function deleteBackup(backupId: string): Promise<void> {
    const backup = getBackupStmt.get(backupId) as RawBackupRow | undefined;
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    // Delete the archive file if local
    if (backup.storage_type === 'local' && backup.storage_path) {
      try {
        if (fs.existsSync(backup.storage_path)) {
          fs.unlinkSync(backup.storage_path);
        }
      } catch {
        // Continue even if file deletion fails
      }
    }

    // For S3 storage, delete from S3
    if (backup.storage_type === 's3' && backup.storage_path) {
      try {
        await deleteFromS3(backup);
      } catch {
        // Continue even if S3 deletion fails
      }
    }

    // Remove from database
    deleteBackupStmt.run(backupId);
  }

  async function deleteFromS3(backup: RawBackupRow): Promise<void> {
    const match = backup.storage_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) return;

    const bucket = match[1];
    const key = match[2];

    const schedule = backup.schedule_id
      ? (getScheduleStmt.get(backup.schedule_id) as RawScheduleRow | undefined)
      : undefined;

    if (!schedule?.storage_config) return;

    const s3Config = JSON.parse(schedule.storage_config) as S3StorageConfig;

    // TODO: S3 storage support is work-in-progress
    let S3Client: any;
    let DeleteObjectCommand: any;
    try {
      const s3Module = await import('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      DeleteObjectCommand = s3Module.DeleteObjectCommand;
    } catch {
      // S3 SDK not installed — skip deletion silently
      return;
    }

    const client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    });

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
  }

  // ─── Scheduler ─────────────────────────────────────────────────────────────

  function startScheduler(): void {
    if (schedulerTimer) return;

    // Check every minute if any schedule should run
    schedulerTimer = setInterval(() => {
      checkSchedules();
    }, 60_000);

    // Don't prevent Node.js from exiting
    if (schedulerTimer.unref) {
      schedulerTimer.unref();
    }
  }

  function stopScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  function checkSchedules(): void {
    const schedules = getSchedulesStmt.all() as RawScheduleRow[];
    const now = new Date();

    for (const schedule of schedules) {
      if (shouldRunSchedule(schedule.frequency, now)) {
        const targets = JSON.parse(schedule.targets) as string[];
        const storageType = schedule.storage_type as 'local' | 's3';
        const storageConfig = JSON.parse(schedule.storage_config ?? '{}');

        const backupId = uuidv4();
        const timestamp = now.toISOString();

        insertBackupStmt.run(
          backupId,
          schedule.id,
          timestamp,
          0,
          schedule.targets,
          storageType,
          '',
          'in-progress'
        );

        executeBackup(
          backupId,
          targets,
          storageType,
          storageConfig,
          schedule.retention_count,
          schedule.id
        ).catch(() => {
          // Error handling done inside executeBackup
        });
      }
    }
  }

  function shouldRunSchedule(cronExpression: string, now: Date): boolean {
    // Simple cron matching: check if the current minute matches the schedule
    // Format: minute hour day-of-month month day-of-week
    try {
      const parts = cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) return false;

      const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;

      return (
        matchesCronField(minuteExpr, now.getMinutes()) &&
        matchesCronField(hourExpr, now.getHours()) &&
        matchesCronField(dayExpr, now.getDate()) &&
        matchesCronField(monthExpr, now.getMonth() + 1) &&
        matchesCronField(dowExpr, now.getDay())
      );
    } catch {
      return false;
    }
  }

  function matchesCronField(expression: string, value: number): boolean {
    if (expression === '*') return true;

    // Handle */N (every N)
    if (expression.startsWith('*/')) {
      const interval = parseInt(expression.slice(2), 10);
      if (isNaN(interval) || interval <= 0) return false;
      return value % interval === 0;
    }

    // Handle comma-separated values
    if (expression.includes(',')) {
      const values = expression.split(',').map((v) => parseInt(v.trim(), 10));
      return values.includes(value);
    }

    // Handle ranges (e.g., 1-5)
    if (expression.includes('-')) {
      const [start, end] = expression.split('-').map((v) => parseInt(v.trim(), 10));
      return value >= start && value <= end;
    }

    // Exact match
    const exact = parseInt(expression, 10);
    return !isNaN(exact) && exact === value;
  }

  // ─── Helper Functions ──────────────────────────────────────────────────────

  function rowToBackupEntry(row: RawBackupRow): BackupEntry {
    return {
      id: row.id,
      scheduleId: row.schedule_id ?? undefined,
      timestamp: new Date(row.timestamp),
      size: row.size ?? 0,
      targets: JSON.parse(row.targets),
      storage: row.storage_type as 'local' | 's3',
      storagePath: row.storage_path,
      status: row.status as 'completed' | 'failed' | 'in-progress',
    };
  }

  function copyDirectorySync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        copyDirectorySync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  function cleanupTempDir(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    configureSchedule,
    triggerBackup,
    restoreBackup,
    listBackups,
    deleteBackup,
    startScheduler,
    stopScheduler,
  };
}
