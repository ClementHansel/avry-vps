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
exports.createBuildPipeline = createBuildPipeline;
const simple_git_1 = __importStar(require("simple-git"));
const dockerode_1 = __importDefault(require("dockerode"));
const uuid_1 = require("uuid");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatTimestampTag() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}
function generateImageTags(projectName, tagFormat) {
    const timestamp = formatTimestampTag();
    const tags = [];
    // Default behavior: generate both latest and timestamp tags
    if (!tagFormat || tagFormat === '{project}:latest') {
        tags.push(`${projectName}:latest`);
        tags.push(`${projectName}:${timestamp}`);
    }
    else {
        // Custom format: replace placeholders
        const customTag = tagFormat
            .replace(/\{project\}/g, projectName)
            .replace(/\{timestamp\}/g, timestamp);
        tags.push(customTag);
        // Always add latest as well
        tags.push(`${projectName}:latest`);
    }
    return tags;
}
function parseBuildRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        jobId: row.job_id,
        status: row.status,
        imageTag: row.image_tag,
        branch: row.branch,
        commitSha: row.commit_sha ?? undefined,
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
        duration: row.started_at && row.completed_at
            ? Math.floor((new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) / 1000)
            : undefined,
        error: row.error ?? undefined,
    };
}
function parsePipelineConfigRow(row) {
    return {
        repoUrl: row.repo_url,
        authMethod: row.auth_method,
        authCredential: row.auth_credential_encrypted,
        branch: row.branch,
        dockerfilePath: row.dockerfile_path,
        buildContext: row.build_context,
        buildArgs: row.build_args ? JSON.parse(row.build_args) : {},
        tagFormat: row.tag_format,
        targetContainer: row.target_container ?? '',
    };
}
// ─── Factory ───────────────────────────────────────────────────────────────────
function createBuildPipeline(db, config) {
    const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
    const workDir = config?.workDir ?? '/tmp/vps-panel-builds';
    const jobQueue = config?.jobQueue;
    // Initialize Docker client
    const dockerOpts = dockerHost.startsWith('/')
        ? { socketPath: dockerHost }
        : { host: dockerHost };
    const docker = new dockerode_1.default(dockerOpts);
    // Ensure build tables exist
    ensureTables(db);
    // Ensure work directory exists
    if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
    }
    // ─── configurePipeline ─────────────────────────────────────────────────
    async function configurePipeline(projectId, pipelineConfig) {
        const existing = db
            .prepare('SELECT id FROM pipeline_configs WHERE project_id = ?')
            .get(projectId);
        if (existing) {
            db.prepare(`
        UPDATE pipeline_configs SET
          repo_url = ?,
          auth_method = ?,
          auth_credential_encrypted = ?,
          branch = ?,
          dockerfile_path = ?,
          build_context = ?,
          build_args = ?,
          tag_format = ?,
          target_container = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
      `).run(pipelineConfig.repoUrl, pipelineConfig.authMethod, pipelineConfig.authCredential, pipelineConfig.branch, pipelineConfig.dockerfilePath, pipelineConfig.buildContext, JSON.stringify(pipelineConfig.buildArgs), pipelineConfig.tagFormat, pipelineConfig.targetContainer, projectId);
        }
        else {
            const id = (0, uuid_1.v4)();
            db.prepare(`
        INSERT INTO pipeline_configs (id, project_id, repo_url, auth_method, auth_credential_encrypted, branch, dockerfile_path, build_context, build_args, tag_format, target_container)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, pipelineConfig.repoUrl, pipelineConfig.authMethod, pipelineConfig.authCredential, pipelineConfig.branch, pipelineConfig.dockerfilePath, pipelineConfig.buildContext, JSON.stringify(pipelineConfig.buildArgs), pipelineConfig.tagFormat, pipelineConfig.targetContainer);
        }
    }
    // ─── triggerBuild ──────────────────────────────────────────────────────
    async function triggerBuild(projectId) {
        // Get pipeline config
        const row = db
            .prepare('SELECT * FROM pipeline_configs WHERE project_id = ?')
            .get(projectId);
        if (!row) {
            throw new Error(`No pipeline configured for project ${projectId}`);
        }
        const pipelineConfig = parsePipelineConfigRow(row);
        const buildId = (0, uuid_1.v4)();
        const jobId = (0, uuid_1.v4)();
        // Determine project name for tagging
        const projectRow = db
            .prepare('SELECT name FROM projects WHERE id = ?')
            .get(projectId);
        const projectName = projectRow?.name ?? projectId;
        // Generate image tags
        const tags = generateImageTags(projectName, pipelineConfig.tagFormat);
        const primaryTag = tags[0];
        // Record build in history
        db.prepare(`
      INSERT INTO build_history (id, project_id, job_id, status, image_tag, branch)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(buildId, projectId, jobId, primaryTag, pipelineConfig.branch);
        // Create the build execution generator
        const execute = createBuildExecutor(buildId, projectId, projectName, pipelineConfig, tags);
        // Submit to job queue if available
        if (jobQueue) {
            const submittedJobId = await jobQueue.submit({
                type: 'build',
                projectId,
                execute,
                metadata: { buildId, tags, branch: pipelineConfig.branch },
                onComplete: (result) => {
                    const status = result.status === 'completed' ? 'completed' : 'failed';
                    db.prepare(`
            UPDATE build_history SET status = ?, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(status, buildId);
                },
            });
            // Update the job ID in build history
            db.prepare('UPDATE build_history SET job_id = ? WHERE id = ?').run(submittedJobId, buildId);
            return submittedJobId;
        }
        // If no job queue, execute directly (for testing or standalone use)
        executeDirectly(buildId, execute);
        return jobId;
    }
    // ─── getBuildHistory ───────────────────────────────────────────────────
    async function getBuildHistory(projectId) {
        const rows = db
            .prepare('SELECT * FROM build_history WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 50')
            .all(projectId);
        return rows.map(parseBuildRow);
    }
    // ─── getPipelineConfig ─────────────────────────────────────────────────
    async function getPipelineConfig(projectId) {
        const row = db
            .prepare('SELECT * FROM pipeline_configs WHERE project_id = ?')
            .get(projectId);
        if (!row)
            return null;
        return parsePipelineConfigRow(row);
    }
    // ─── Build Executor (AsyncGenerator) ───────────────────────────────────
    function createBuildExecutor(buildId, projectId, projectName, pipelineConfig, tags) {
        return async function* () {
            const repoDir = path.join(workDir, projectId);
            // Update build status to running
            db.prepare('UPDATE build_history SET status = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?').run('running', buildId);
            // ─── Step 1: Clone or Pull ─────────────────────────────────────────
            yield `[build] Starting build for project "${projectName}" (branch: ${pipelineConfig.branch})`;
            yield `[git] Repository: ${pipelineConfig.repoUrl}`;
            let git;
            let commitSha;
            try {
                // Construct auth URL if using HTTPS token
                const repoUrl = buildAuthenticatedUrl(pipelineConfig.repoUrl, pipelineConfig.authMethod, pipelineConfig.authCredential);
                if (fs.existsSync(path.join(repoDir, '.git'))) {
                    // Pull existing repo
                    yield `[git] Pulling latest changes...`;
                    git = (0, simple_git_1.default)(repoDir);
                    // Configure SSH key if needed
                    if (pipelineConfig.authMethod === 'ssh-key') {
                        configureSshKey(git, pipelineConfig.authCredential);
                    }
                    await git.fetch('origin', pipelineConfig.branch);
                    await git.checkout(pipelineConfig.branch);
                    await git.pull('origin', pipelineConfig.branch);
                }
                else {
                    // Clone fresh
                    yield `[git] Cloning repository...`;
                    fs.mkdirSync(repoDir, { recursive: true });
                    git = (0, simple_git_1.default)();
                    // Configure SSH key if needed
                    if (pipelineConfig.authMethod === 'ssh-key') {
                        configureSshKey(git, pipelineConfig.authCredential);
                    }
                    await git.clone(repoUrl, repoDir, ['--branch', pipelineConfig.branch, '--single-branch']);
                    git = (0, simple_git_1.default)(repoDir);
                }
                // Get commit SHA
                const log = await git.log({ maxCount: 1 });
                commitSha = log.latest?.hash;
                yield `[git] Checked out ${pipelineConfig.branch} at ${commitSha?.substring(0, 8) ?? 'unknown'}`;
                // Update commit SHA in build record
                if (commitSha) {
                    db.prepare('UPDATE build_history SET commit_sha = ? WHERE id = ?').run(commitSha, buildId);
                }
            }
            catch (error) {
                const errorMessage = error instanceof simple_git_1.GitError
                    ? error.message
                    : (error?.message ?? 'Unknown git error');
                yield `[git] ERROR: ${errorMessage}`;
                // Mark build as failed
                db.prepare('UPDATE build_history SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', errorMessage, buildId);
                throw new Error(`Git operation failed: ${errorMessage}`);
            }
            // ─── Step 2: Docker Build ──────────────────────────────────────────
            yield `[docker] Building image with Dockerfile: ${pipelineConfig.dockerfilePath}`;
            yield `[docker] Build context: ${pipelineConfig.buildContext}`;
            const buildContextPath = path.resolve(repoDir, pipelineConfig.buildContext);
            const dockerfilePath = path.resolve(repoDir, pipelineConfig.dockerfilePath);
            // Validate paths exist
            if (!fs.existsSync(dockerfilePath)) {
                const errMsg = `Dockerfile not found at ${pipelineConfig.dockerfilePath}`;
                yield `[docker] ERROR: ${errMsg}`;
                db.prepare('UPDATE build_history SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', errMsg, buildId);
                throw new Error(errMsg);
            }
            if (!fs.existsSync(buildContextPath)) {
                const errMsg = `Build context directory not found at ${pipelineConfig.buildContext}`;
                yield `[docker] ERROR: ${errMsg}`;
                db.prepare('UPDATE build_history SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', errMsg, buildId);
                throw new Error(errMsg);
            }
            // Build args
            const buildArgs = pipelineConfig.buildArgs ?? {};
            if (Object.keys(buildArgs).length > 0) {
                yield `[docker] Build arguments: ${Object.keys(buildArgs).join(', ')}`;
            }
            try {
                // Build the image using dockerode
                const relativeDf = path.relative(buildContextPath, dockerfilePath);
                const stream = await docker.buildImage({
                    context: buildContextPath,
                    src: ['.'],
                }, {
                    t: tags[0],
                    dockerfile: relativeDf || 'Dockerfile',
                    buildargs: buildArgs,
                });
                // Stream build output
                yield* streamDockerBuildOutput(stream);
                // Tag with additional tags
                const image = docker.getImage(tags[0]);
                for (let i = 1; i < tags.length; i++) {
                    const [repo, tag] = splitImageTag(tags[i]);
                    await image.tag({ repo, tag });
                    yield `[docker] Tagged: ${tags[i]}`;
                }
                yield `[docker] Build completed successfully`;
            }
            catch (error) {
                const errorMessage = error?.message ?? 'Docker build failed';
                yield `[docker] ERROR: ${errorMessage}`;
                db.prepare('UPDATE build_history SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', errorMessage, buildId);
                throw new Error(`Docker build failed: ${errorMessage}`);
            }
            // ─── Step 3: Deploy (Recreate Container) ──────────────────────────
            if (pipelineConfig.targetContainer) {
                yield `[deploy] Deploying to container: ${pipelineConfig.targetContainer}`;
                try {
                    await deployContainer(pipelineConfig.targetContainer, tags[0]);
                    yield `[deploy] Container recreated successfully with image ${tags[0]}`;
                }
                catch (error) {
                    const errorMessage = error?.message ?? 'Deploy failed';
                    yield `[deploy] ERROR: ${errorMessage}`;
                    db.prepare('UPDATE build_history SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('failed', errorMessage, buildId);
                    throw new Error(`Deploy failed: ${errorMessage}`);
                }
            }
            else {
                yield `[deploy] No target container configured, skipping deployment`;
            }
            // ─── Complete ──────────────────────────────────────────────────────
            db.prepare('UPDATE build_history SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', buildId);
            yield `[build] Build completed successfully. Image: ${tags.join(', ')}`;
        };
    }
    // ─── Deploy Container (Preserve Config) ────────────────────────────────
    async function deployContainer(containerNameOrId, newImage) {
        // Find the container
        const containers = await docker.listContainers({ all: true });
        const target = containers.find((c) => c.Id === containerNameOrId ||
            c.Id.startsWith(containerNameOrId) ||
            c.Names.some((n) => n.replace(/^\//, '') === containerNameOrId));
        if (!target) {
            throw new Error(`Target container "${containerNameOrId}" not found`);
        }
        const container = docker.getContainer(target.Id);
        const inspection = await container.inspect();
        // Stop existing container
        if (inspection.State?.Running) {
            await container.stop();
        }
        // Remove existing container
        await container.remove();
        // Recreate with preserved config but new image
        const createOptions = buildCreateOptions(inspection, newImage);
        const newContainer = await docker.createContainer(createOptions);
        // Reconnect to networks (beyond default)
        const networks = inspection.NetworkSettings?.Networks ?? {};
        for (const [networkName, networkConfig] of Object.entries(networks)) {
            if (networkName === 'bridge')
                continue;
            try {
                const network = docker.getNetwork(networkName);
                await network.connect({
                    Container: newContainer.id,
                    EndpointConfig: networkConfig,
                });
            }
            catch {
                // Network may not exist anymore, skip
            }
        }
        // Start the new container
        await newContainer.start();
    }
    function buildCreateOptions(inspection, newImage) {
        const containerConfig = inspection.Config;
        const hostConfig = inspection.HostConfig;
        const name = (inspection.Name ?? '').replace(/^\//, '');
        return {
            name,
            Image: newImage,
            Env: containerConfig?.Env ?? [],
            Cmd: containerConfig?.Cmd ?? undefined,
            Entrypoint: containerConfig?.Entrypoint,
            WorkingDir: containerConfig?.WorkingDir ?? undefined,
            ExposedPorts: containerConfig?.ExposedPorts ?? undefined,
            Labels: containerConfig?.Labels ?? undefined,
            HostConfig: {
                PortBindings: hostConfig?.PortBindings ?? undefined,
                Binds: hostConfig?.Binds ?? undefined,
                RestartPolicy: hostConfig?.RestartPolicy ?? undefined,
                NetworkMode: hostConfig?.NetworkMode ?? undefined,
                VolumesFrom: hostConfig?.VolumesFrom ?? undefined,
                Memory: hostConfig?.Memory ?? undefined,
                MemorySwap: hostConfig?.MemorySwap ?? undefined,
                CpuShares: hostConfig?.CpuShares ?? undefined,
                CpuQuota: hostConfig?.CpuQuota ?? undefined,
                CpuPeriod: hostConfig?.CpuPeriod ?? undefined,
            },
            NetworkingConfig: undefined,
        };
    }
    // ─── Docker Build Output Streaming ─────────────────────────────────────
    async function* streamDockerBuildOutput(stream) {
        const lines = await new Promise((resolve, reject) => {
            const output = [];
            let errorOutput = '';
            docker.modem.followProgress(stream, (err, result) => {
                if (err) {
                    reject(new Error(errorOutput || err.message));
                }
                else {
                    // Check for error in the final result
                    const lastEntry = result?.[result.length - 1];
                    if (lastEntry?.error) {
                        reject(new Error(lastEntry.error));
                    }
                    else {
                        resolve(output);
                    }
                }
            }, (event) => {
                if (event.stream) {
                    const line = event.stream.replace(/\n$/, '');
                    if (line)
                        output.push(line);
                }
                if (event.error) {
                    errorOutput = event.error;
                    output.push(`ERROR: ${event.error}`);
                }
                if (event.status) {
                    output.push(`${event.status}${event.progress ? ' ' + event.progress : ''}`);
                }
            });
        });
        for (const line of lines) {
            yield `[docker] ${line}`;
        }
    }
    // ─── Auth Helpers ──────────────────────────────────────────────────────
    function buildAuthenticatedUrl(repoUrl, authMethod, credential) {
        if (authMethod === 'https-token') {
            // Inject token into HTTPS URL
            // https://github.com/user/repo.git → https://token@github.com/user/repo.git
            try {
                const url = new URL(repoUrl);
                url.username = credential;
                return url.toString();
            }
            catch {
                // If URL parsing fails, try string manipulation
                return repoUrl.replace('https://', `https://${credential}@`);
            }
        }
        // SSH key auth: URL is used as-is, key is configured via GIT_SSH_COMMAND
        return repoUrl;
    }
    function configureSshKey(git, sshKeyPath) {
        // Set GIT_SSH_COMMAND to use the specified SSH key
        const sshCommand = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no`;
        git.env('GIT_SSH_COMMAND', sshCommand);
    }
    // ─── Image Tag Helpers ─────────────────────────────────────────────────
    function splitImageTag(imageTag) {
        const lastColon = imageTag.lastIndexOf(':');
        if (lastColon === -1) {
            return [imageTag, 'latest'];
        }
        return [imageTag.substring(0, lastColon), imageTag.substring(lastColon + 1)];
    }
    // ─── Direct Execution (when no job queue) ──────────────────────────────
    async function executeDirectly(buildId, execute) {
        try {
            const generator = execute();
            for await (const _line of generator) {
                // Output is discarded in direct mode (no streaming target)
            }
        }
        catch {
            // Error already recorded in build history by the executor
        }
    }
    // ─── Table Setup ───────────────────────────────────────────────────────
    function ensureTables(database) {
        database.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_configs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        auth_credential_encrypted TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        dockerfile_path TEXT NOT NULL DEFAULT './Dockerfile',
        build_context TEXT NOT NULL DEFAULT '.',
        build_args TEXT,
        tag_format TEXT DEFAULT '{project}:latest',
        target_container TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS build_history (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        image_tag TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_sha TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_configs_project ON pipeline_configs(project_id);
      CREATE INDEX IF NOT EXISTS idx_build_history_project ON build_history(project_id);
      CREATE INDEX IF NOT EXISTS idx_build_history_status ON build_history(status);
    `);
    }
    // ─── Return Public Interface ───────────────────────────────────────────
    return {
        configurePipeline,
        triggerBuild,
        getBuildHistory,
        getPipelineConfig,
    };
}
//# sourceMappingURL=build-pipeline.js.map