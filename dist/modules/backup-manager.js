"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackupManager = createBackupManager;
const uuid_1 = require("uuid");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
// ─── Implementation ────────────────────────────────────────────────────────────
function createBackupManager(db, config) {
    const workDir = config?.workDir ?? '/tmp/vps-panel-backups';
    const alertCallback = config?.alertCallback;
    let schedulerTimer = null;
    // Ensure work directory exists
    if (!node_fs_1.default.existsSync(workDir)) {
        node_fs_1.default.mkdirSync(workDir, { recursive: true });
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
    const listBackupsStmt = db.prepare(`SELECT * FROM backups ORDER BY timestamp DESC`);
    const deleteBackupStmt = db.prepare(`DELETE FROM backups WHERE id = ?`);
    const getSchedulesStmt = db.prepare(`SELECT * FROM backup_schedules WHERE enabled = 1`);
    const getScheduleStmt = db.prepare(`SELECT * FROM backup_schedules WHERE id = ?`);
    // ─── configureSchedule ───────────────────────────────────────────────────
    async function configureSchedule(scheduleConfig) {
        const id = (0, uuid_1.v4)();
        const targets = JSON.stringify(scheduleConfig.targets);
        const storageConfig = JSON.stringify(scheduleConfig.storageConfig);
        const retentionCount = scheduleConfig.retentionCount ?? 7;
        const enabled = scheduleConfig.enabled !== false ? 1 : 0;
        insertScheduleStmt.run(id, scheduleConfig.frequency, targets, scheduleConfig.storageType, storageConfig, retentionCount, enabled);
        return id;
    }
    // ─── triggerBackup ─────────────────────────────────────────────────────────
    async function triggerBackup(targets) {
        // Get configuration from first enabled schedule or use provided targets
        let scheduleId = null;
        let backupTargets;
        let storageType;
        let storageConfig;
        let retentionCount = 7;
        if (targets && targets.length > 0) {
            // Manual backup with specific targets - use first schedule's storage config or defaults
            backupTargets = targets;
            const schedule = getSchedulesStmt.get();
            if (schedule) {
                scheduleId = schedule.id;
                storageType = schedule.storage_type;
                storageConfig = JSON.parse(schedule.storage_config ?? '{}');
                retentionCount = schedule.retention_count;
            }
            else {
                // Default to local storage in workDir
                storageType = 'local';
                storageConfig = { path: workDir };
            }
        }
        else {
            // Use the first enabled schedule's full configuration
            const schedule = getSchedulesStmt.get();
            if (!schedule) {
                throw new Error('No backup schedule configured. Please configure a schedule first.');
            }
            scheduleId = schedule.id;
            backupTargets = JSON.parse(schedule.targets);
            storageType = schedule.storage_type;
            storageConfig = JSON.parse(schedule.storage_config ?? '{}');
            retentionCount = schedule.retention_count;
        }
        // Create backup record as in-progress
        const backupId = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        insertBackupStmt.run(backupId, scheduleId, timestamp, 0, JSON.stringify(backupTargets), storageType, '', 'in-progress');
        // Execute backup asynchronously
        executeBackup(backupId, backupTargets, storageType, storageConfig, retentionCount, scheduleId)
            .catch(() => {
            // Error handling is done inside executeBackup
        });
        return backupId;
    }
    // ─── executeBackup (internal) ──────────────────────────────────────────────
    async function executeBackup(backupId, targets, storageType, storageConfig, retentionCount, scheduleId) {
        const archiveName = `backup-${backupId}.tar.gz`;
        const tempArchivePath = node_path_1.default.join(workDir, archiveName);
        try {
            // Step 1: Collect backup data into temp directory
            const tempDir = node_path_1.default.join(workDir, `backup-${backupId}`);
            if (!node_fs_1.default.existsSync(tempDir)) {
                node_fs_1.default.mkdirSync(tempDir, { recursive: true });
            }
            for (const target of targets) {
                await backupTarget(target, tempDir);
            }
            // Step 2: Create tar.gz archive
            await execAsync(`tar -czf "${tempArchivePath}" -C "${tempDir}" .`);
            // Get archive size
            const stat = node_fs_1.default.statSync(tempArchivePath);
            const archiveSize = stat.size;
            // Step 3: Move to storage destination
            let finalPath;
            if (storageType === 's3') {
                finalPath = await uploadToS3(tempArchivePath, archiveName, storageConfig);
            }
            else {
                finalPath = moveToLocalStorage(tempArchivePath, archiveName, storageConfig);
            }
            // Step 4: Update backup record as completed
            updateBackupStmt.run(archiveSize, finalPath, 'completed', backupId);
            // Step 5: Enforce retention policy (delete excess after success)
            enforceRetention(scheduleId, retentionCount, storageType);
            // Step 6: Clean up temp directory
            cleanupTempDir(tempDir);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Mark backup as failed
            updateBackupStmt.run(0, '', 'failed', backupId);
            // Generate alert on failure
            if (alertCallback) {
                const backup = getBackupStmt.get(backupId);
                const failedTargets = backup ? JSON.parse(backup.targets) : targets;
                alertCallback.onBackupFailure(backupId, errorMessage, failedTargets);
            }
            // Clean up temp files
            try {
                if (node_fs_1.default.existsSync(tempArchivePath))
                    node_fs_1.default.unlinkSync(tempArchivePath);
                const tempDir = node_path_1.default.join(workDir, `backup-${backupId}`);
                if (node_fs_1.default.existsSync(tempDir))
                    cleanupTempDir(tempDir);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
    // ─── backupTarget (internal) ───────────────────────────────────────────────
    async function backupTarget(target, destDir) {
        // Determine if target is a Docker volume or a filesystem path (compose file)
        if (await isDockerVolume(target)) {
            // Backup Docker volume via docker cp using a temporary container
            await backupDockerVolume(target, destDir);
        }
        else {
            // Backup filesystem path (compose file or config)
            backupFilesystemPath(target, destDir);
        }
    }
    async function isDockerVolume(target) {
        try {
            await execAsync(`docker volume inspect "${target}" 2>/dev/null`);
            return true;
        }
        catch {
            return false;
        }
    }
    async function backupDockerVolume(volumeName, destDir) {
        const volumeDir = node_path_1.default.join(destDir, 'volumes', volumeName);
        if (!node_fs_1.default.existsSync(volumeDir)) {
            node_fs_1.default.mkdirSync(volumeDir, { recursive: true });
        }
        // Use a temporary alpine container to copy volume data out
        const containerName = `backup-helper-${(0, uuid_1.v4)().slice(0, 8)}`;
        try {
            await execAsync(`docker run --rm --name "${containerName}" -v "${volumeName}:/source:ro" -v "${volumeDir}:/dest" alpine sh -c "cp -a /source/. /dest/"`);
        }
        catch (error) {
            throw new Error(`Failed to backup Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    function backupFilesystemPath(targetPath, destDir) {
        const resolvedPath = node_path_1.default.resolve(targetPath);
        if (!node_fs_1.default.existsSync(resolvedPath)) {
            throw new Error(`Backup target path does not exist: ${resolvedPath}`);
        }
        const stat = node_fs_1.default.statSync(resolvedPath);
        const relativeName = node_path_1.default.basename(resolvedPath);
        const destPath = node_path_1.default.join(destDir, 'files', relativeName);
        if (stat.isDirectory()) {
            copyDirectorySync(resolvedPath, destPath);
        }
        else {
            const destFileDir = node_path_1.default.dirname(destPath);
            if (!node_fs_1.default.existsSync(destFileDir)) {
                node_fs_1.default.mkdirSync(destFileDir, { recursive: true });
            }
            node_fs_1.default.copyFileSync(resolvedPath, destPath);
        }
    }
    // ─── S3 Upload ────────────────────────────────────────────────────────────
    async function uploadToS3(filePath, fileName, s3Config) {
        // TODO: S3 storage support is work-in-progress. Install @aws-sdk/client-s3 to enable.
        // Currently marked as optionalDependency — will gracefully fail if not installed.
        let S3Client;
        let PutObjectCommand;
        try {
            const s3Module = await import('@aws-sdk/client-s3');
            S3Client = s3Module.S3Client;
            PutObjectCommand = s3Module.PutObjectCommand;
        }
        catch {
            throw new Error('S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3');
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
        const fileContent = node_fs_1.default.readFileSync(filePath);
        const key = s3Config.prefix ? `${s3Config.prefix}/${fileName}` : fileName;
        await client.send(new PutObjectCommand({
            Bucket: s3Config.bucket,
            Key: key,
            Body: fileContent,
            ContentType: 'application/gzip',
        }));
        // Clean up local temp file after upload
        node_fs_1.default.unlinkSync(filePath);
        return `s3://${s3Config.bucket}/${key}`;
    }
    // ─── Local Storage ─────────────────────────────────────────────────────────
    function moveToLocalStorage(archivePath, archiveName, localConfig) {
        const destDir = node_path_1.default.resolve(localConfig.path);
        if (!node_fs_1.default.existsSync(destDir)) {
            node_fs_1.default.mkdirSync(destDir, { recursive: true });
        }
        const destPath = node_path_1.default.join(destDir, archiveName);
        node_fs_1.default.renameSync(archivePath, destPath);
        return destPath;
    }
    // ─── Retention Policy ──────────────────────────────────────────────────────
    function enforceRetention(scheduleId, retentionCount, storageType) {
        // Get all completed backups for this schedule, ordered by timestamp desc
        let completedBackups;
        if (scheduleId) {
            completedBackups = db
                .prepare(`SELECT * FROM backups WHERE schedule_id = ? AND status = 'completed' ORDER BY timestamp DESC`)
                .all(scheduleId);
        }
        else {
            completedBackups = db
                .prepare(`SELECT * FROM backups WHERE status = 'completed' ORDER BY timestamp DESC`)
                .all();
        }
        // Delete excess backups (those beyond retention count)
        if (completedBackups.length > retentionCount) {
            const excessBackups = completedBackups.slice(retentionCount);
            for (const backup of excessBackups) {
                // Delete the archive file if local
                if (backup.storage_type === 'local' && backup.storage_path) {
                    try {
                        if (node_fs_1.default.existsSync(backup.storage_path)) {
                            node_fs_1.default.unlinkSync(backup.storage_path);
                        }
                    }
                    catch {
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
    async function restoreBackup(backupId) {
        const backup = getBackupStmt.get(backupId);
        if (!backup) {
            throw new Error(`Backup not found: ${backupId}`);
        }
        if (backup.status !== 'completed') {
            throw new Error(`Cannot restore backup with status: ${backup.status}`);
        }
        const restoreJobId = (0, uuid_1.v4)();
        const targets = JSON.parse(backup.targets);
        // Execute restore asynchronously
        executeRestore(restoreJobId, backup, targets).catch(() => {
            // Error handling is done inside executeRestore
        });
        return restoreJobId;
    }
    async function executeRestore(jobId, backup, targets) {
        const tempDir = node_path_1.default.join(workDir, `restore-${jobId}`);
        try {
            if (!node_fs_1.default.existsSync(tempDir)) {
                node_fs_1.default.mkdirSync(tempDir, { recursive: true });
            }
            // Step 1: Get the archive to the temp directory
            const archivePath = node_path_1.default.join(tempDir, 'archive.tar.gz');
            if (backup.storage_type === 's3') {
                await downloadFromS3(backup.storage_path, archivePath, backup);
            }
            else {
                // Local: copy the archive to temp
                if (!node_fs_1.default.existsSync(backup.storage_path)) {
                    throw new Error(`Backup archive not found at: ${backup.storage_path}`);
                }
                node_fs_1.default.copyFileSync(backup.storage_path, archivePath);
            }
            // Step 2: Extract the archive
            const extractDir = node_path_1.default.join(tempDir, 'extracted');
            node_fs_1.default.mkdirSync(extractDir, { recursive: true });
            await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);
            // Step 3: Restore each target (abort on failure, preserve current state)
            for (const target of targets) {
                await restoreTarget(target, extractDir);
            }
            // Step 4: Clean up
            cleanupTempDir(tempDir);
        }
        catch (error) {
            // Abort restore on failure, preserve current state
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Clean up temp files
            try {
                cleanupTempDir(tempDir);
            }
            catch {
                // Ignore cleanup errors
            }
            // Alert on restore failure
            if (alertCallback) {
                alertCallback.onBackupFailure(backup.id, `Restore failed: ${errorMessage}`, targets);
            }
            throw new Error(`Restore aborted: ${errorMessage}. Current state preserved.`);
        }
    }
    async function downloadFromS3(s3Path, destPath, backup) {
        // Parse s3://bucket/key format
        const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) {
            throw new Error(`Invalid S3 path: ${s3Path}`);
        }
        const bucket = match[1];
        const key = match[2];
        // Get S3 config from the backup's schedule
        const schedule = backup.schedule_id
            ? getScheduleStmt.get(backup.schedule_id)
            : undefined;
        if (!schedule?.storage_config) {
            throw new Error('S3 configuration not found for this backup');
        }
        const s3Config = JSON.parse(schedule.storage_config);
        // TODO: S3 storage support is work-in-progress
        let S3Client;
        let GetObjectCommand;
        try {
            const s3Module = await import('@aws-sdk/client-s3');
            S3Client = s3Module.S3Client;
            GetObjectCommand = s3Module.GetObjectCommand;
        }
        catch {
            throw new Error('S3 storage is not available. Install @aws-sdk/client-s3 to enable S3 backup support: npm install @aws-sdk/client-s3');
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
        const response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        if (!response.Body) {
            throw new Error(`Empty response body for S3 object: ${s3Path}`);
        }
        // Write the stream to disk
        const bodyBytes = await response.Body.transformToByteArray();
        node_fs_1.default.writeFileSync(destPath, Buffer.from(bodyBytes));
    }
    async function restoreTarget(target, extractDir) {
        if (await isDockerVolume(target)) {
            await restoreDockerVolume(target, extractDir);
        }
        else {
            restoreFilesystemPath(target, extractDir);
        }
    }
    async function restoreDockerVolume(volumeName, extractDir) {
        const volumeDataDir = node_path_1.default.join(extractDir, 'volumes', volumeName);
        if (!node_fs_1.default.existsSync(volumeDataDir)) {
            throw new Error(`Volume data not found in backup for: ${volumeName}`);
        }
        const containerName = `restore-helper-${(0, uuid_1.v4)().slice(0, 8)}`;
        try {
            await execAsync(`docker run --rm --name "${containerName}" -v "${volumeName}:/dest" -v "${volumeDataDir}:/source:ro" alpine sh -c "rm -rf /dest/* && cp -a /source/. /dest/"`);
        }
        catch (error) {
            throw new Error(`Failed to restore Docker volume "${volumeName}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    function restoreFilesystemPath(targetPath, extractDir) {
        const relativeName = node_path_1.default.basename(targetPath);
        const sourcePath = node_path_1.default.join(extractDir, 'files', relativeName);
        if (!node_fs_1.default.existsSync(sourcePath)) {
            throw new Error(`File/directory not found in backup for: ${targetPath}`);
        }
        const resolvedTarget = node_path_1.default.resolve(targetPath);
        const stat = node_fs_1.default.statSync(sourcePath);
        if (stat.isDirectory()) {
            // Remove existing directory and copy from backup
            if (node_fs_1.default.existsSync(resolvedTarget)) {
                node_fs_1.default.rmSync(resolvedTarget, { recursive: true, force: true });
            }
            copyDirectorySync(sourcePath, resolvedTarget);
        }
        else {
            // Copy file from backup
            const destDir = node_path_1.default.dirname(resolvedTarget);
            if (!node_fs_1.default.existsSync(destDir)) {
                node_fs_1.default.mkdirSync(destDir, { recursive: true });
            }
            node_fs_1.default.copyFileSync(sourcePath, resolvedTarget);
        }
    }
    // ─── listBackups ──────────────────────────────────────────────────────────
    async function listBackups() {
        const rows = listBackupsStmt.all();
        return rows.map(rowToBackupEntry);
    }
    // ─── deleteBackup ─────────────────────────────────────────────────────────
    async function deleteBackup(backupId) {
        const backup = getBackupStmt.get(backupId);
        if (!backup) {
            throw new Error(`Backup not found: ${backupId}`);
        }
        // Delete the archive file if local
        if (backup.storage_type === 'local' && backup.storage_path) {
            try {
                if (node_fs_1.default.existsSync(backup.storage_path)) {
                    node_fs_1.default.unlinkSync(backup.storage_path);
                }
            }
            catch {
                // Continue even if file deletion fails
            }
        }
        // For S3 storage, delete from S3
        if (backup.storage_type === 's3' && backup.storage_path) {
            try {
                await deleteFromS3(backup);
            }
            catch {
                // Continue even if S3 deletion fails
            }
        }
        // Remove from database
        deleteBackupStmt.run(backupId);
    }
    async function deleteFromS3(backup) {
        const match = backup.storage_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match)
            return;
        const bucket = match[1];
        const key = match[2];
        const schedule = backup.schedule_id
            ? getScheduleStmt.get(backup.schedule_id)
            : undefined;
        if (!schedule?.storage_config)
            return;
        const s3Config = JSON.parse(schedule.storage_config);
        // TODO: S3 storage support is work-in-progress
        let S3Client;
        let DeleteObjectCommand;
        try {
            const s3Module = await import('@aws-sdk/client-s3');
            S3Client = s3Module.S3Client;
            DeleteObjectCommand = s3Module.DeleteObjectCommand;
        }
        catch {
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
        await client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    }
    // ─── Scheduler ─────────────────────────────────────────────────────────────
    function startScheduler() {
        if (schedulerTimer)
            return;
        // Check every minute if any schedule should run
        schedulerTimer = setInterval(() => {
            checkSchedules();
        }, 60_000);
        // Don't prevent Node.js from exiting
        if (schedulerTimer.unref) {
            schedulerTimer.unref();
        }
    }
    function stopScheduler() {
        if (schedulerTimer) {
            clearInterval(schedulerTimer);
            schedulerTimer = null;
        }
    }
    function checkSchedules() {
        const schedules = getSchedulesStmt.all();
        const now = new Date();
        for (const schedule of schedules) {
            if (shouldRunSchedule(schedule.frequency, now)) {
                const targets = JSON.parse(schedule.targets);
                const storageType = schedule.storage_type;
                const storageConfig = JSON.parse(schedule.storage_config ?? '{}');
                const backupId = (0, uuid_1.v4)();
                const timestamp = now.toISOString();
                insertBackupStmt.run(backupId, schedule.id, timestamp, 0, schedule.targets, storageType, '', 'in-progress');
                executeBackup(backupId, targets, storageType, storageConfig, schedule.retention_count, schedule.id).catch(() => {
                    // Error handling done inside executeBackup
                });
            }
        }
    }
    function shouldRunSchedule(cronExpression, now) {
        // Simple cron matching: check if the current minute matches the schedule
        // Format: minute hour day-of-month month day-of-week
        try {
            const parts = cronExpression.trim().split(/\s+/);
            if (parts.length !== 5)
                return false;
            const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;
            return (matchesCronField(minuteExpr, now.getMinutes()) &&
                matchesCronField(hourExpr, now.getHours()) &&
                matchesCronField(dayExpr, now.getDate()) &&
                matchesCronField(monthExpr, now.getMonth() + 1) &&
                matchesCronField(dowExpr, now.getDay()));
        }
        catch {
            return false;
        }
    }
    function matchesCronField(expression, value) {
        if (expression === '*')
            return true;
        // Handle */N (every N)
        if (expression.startsWith('*/')) {
            const interval = parseInt(expression.slice(2), 10);
            if (isNaN(interval) || interval <= 0)
                return false;
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
    function rowToBackupEntry(row) {
        return {
            id: row.id,
            scheduleId: row.schedule_id ?? undefined,
            timestamp: new Date(row.timestamp),
            size: row.size ?? 0,
            targets: JSON.parse(row.targets),
            storage: row.storage_type,
            storagePath: row.storage_path,
            status: row.status,
        };
    }
    function copyDirectorySync(src, dest) {
        if (!node_fs_1.default.existsSync(dest)) {
            node_fs_1.default.mkdirSync(dest, { recursive: true });
        }
        const entries = node_fs_1.default.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = node_path_1.default.join(src, entry.name);
            const destPath = node_path_1.default.join(dest, entry.name);
            if (entry.isDirectory()) {
                copyDirectorySync(srcPath, destPath);
            }
            else {
                node_fs_1.default.copyFileSync(srcPath, destPath);
            }
        }
    }
    function cleanupTempDir(dirPath) {
        if (node_fs_1.default.existsSync(dirPath)) {
            node_fs_1.default.rmSync(dirPath, { recursive: true, force: true });
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
//# sourceMappingURL=backup-manager.js.map