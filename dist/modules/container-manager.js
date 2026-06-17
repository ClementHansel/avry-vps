"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContainerManager = createContainerManager;
/**
 * Container Manager Module
 *
 * Provides Docker container lifecycle management, health monitoring,
 * stats collection, and pull-and-redeploy functionality.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */
const dockerode_1 = __importDefault(require("dockerode"));
const uuid_1 = require("uuid");
class CircuitBreaker {
    state = 'closed';
    failures = 0;
    lastFailureTime = null;
    threshold;
    resetMs;
    constructor(threshold, resetMs) {
        this.threshold = threshold;
        this.resetMs = resetMs;
    }
    getState() {
        // Check if we should transition from open to half-open
        if (this.state === 'open' && this.lastFailureTime !== null) {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.resetMs) {
                this.state = 'half-open';
            }
        }
        return {
            state: this.state,
            failures: this.failures,
            lastFailureTime: this.lastFailureTime,
            nextRetryTime: this.state === 'open' && this.lastFailureTime !== null
                ? this.lastFailureTime + this.resetMs
                : null,
        };
    }
    isOpen() {
        if (this.state === 'open') {
            const elapsed = Date.now() - (this.lastFailureTime ?? 0);
            if (elapsed >= this.resetMs) {
                this.state = 'half-open';
                return false;
            }
            return true;
        }
        return false;
    }
    recordSuccess() {
        this.failures = 0;
        this.state = 'closed';
        this.lastFailureTime = null;
    }
    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.failures >= this.threshold) {
            this.state = 'open';
        }
    }
}
// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 15_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 30_000;
// ─── Implementation ────────────────────────────────────────────────────────────
function createContainerManager(config) {
    const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
    const healthPollIntervalMs = config?.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
    const healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    const circuitBreakerThreshold = config?.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    const circuitBreakerResetMs = config?.circuitBreakerResetMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_MS;
    // Initialize Docker client
    const dockerOpts = dockerHost.startsWith('/')
        ? { socketPath: dockerHost }
        : { host: dockerHost };
    const docker = new dockerode_1.default(dockerOpts);
    // Circuit breaker for Docker daemon communication
    const circuitBreaker = new CircuitBreaker(circuitBreakerThreshold, circuitBreakerResetMs);
    // Health status cache
    const healthCache = new Map();
    // Health polling timer
    let healthPollTimer = null;
    // ─── Docker API wrapper with circuit breaker ─────────────────────────────
    async function withCircuitBreaker(operation) {
        if (circuitBreaker.isOpen()) {
            throw new Error('Circuit breaker is open: Docker daemon communication suspended');
        }
        try {
            const result = await operation();
            circuitBreaker.recordSuccess();
            return result;
        }
        catch (error) {
            circuitBreaker.recordFailure();
            throw error;
        }
    }
    // ─── Helpers ─────────────────────────────────────────────────────────────
    function parseContainerStatus(state) {
        switch (state.toLowerCase()) {
            case 'running':
                return 'running';
            case 'exited':
            case 'dead':
                return 'exited';
            case 'restarting':
                return 'restarting';
            case 'created':
            case 'paused':
            case 'removing':
            default:
                return 'stopped';
        }
    }
    function parseHealthStatus(health) {
        if (!health || !health.Status)
            return 'unknown';
        switch (health.Status.toLowerCase()) {
            case 'healthy':
                return 'healthy';
            case 'unhealthy':
                return 'unhealthy';
            default:
                return 'unknown';
        }
    }
    function getContainerName(names) {
        // Docker container names start with /
        const name = names[0] ?? '';
        return name.startsWith('/') ? name.slice(1) : name;
    }
    function getFirstPublicPort(ports) {
        for (const port of ports) {
            if (port.PublicPort)
                return port.PublicPort;
        }
        return 0;
    }
    function calculateUptime(startedAt) {
        if (!startedAt)
            return 0;
        const started = new Date(startedAt).getTime();
        if (isNaN(started))
            return 0;
        return Math.floor((Date.now() - started) / 1000);
    }
    // ─── listContainers ──────────────────────────────────────────────────────
    async function listContainers() {
        const containers = await withCircuitBreaker(() => docker.listContainers({ all: true }));
        return containers.map((c) => {
            const id = c.Id;
            const name = getContainerName(c.Names);
            const image = c.Image;
            const port = getFirstPublicPort(c.Ports ?? []);
            const status = parseContainerStatus(c.State ?? '');
            const health = healthCache.get(id) ?? parseHealthStatus(undefined);
            const uptime = status === 'running' ? Math.floor((Date.now() / 1000) - c.Created) : 0;
            return { id, name, image, port, status, health, uptime };
        });
    }
    // ─── getContainer ────────────────────────────────────────────────────────
    async function getContainer(id) {
        const containerRef = docker.getContainer(id);
        const inspection = await withCircuitBreaker(() => containerRef.inspect());
        const name = (inspection.Name ?? '').replace(/^\//, '');
        const image = inspection.Config?.Image ?? '';
        const imageTag = inspection.Image ?? '';
        const state = inspection.State;
        const status = parseContainerStatus(state?.Status ?? '');
        const health = healthCache.get(id) ?? parseHealthStatus(state?.Health);
        const uptime = calculateUptime(state?.StartedAt);
        const restartCount = state?.RestartCount ?? inspection.RestartCount ?? 0;
        // Parse port mappings
        const portBindings = inspection.HostConfig?.PortBindings ?? {};
        const ports = [];
        for (const [containerPortKey, bindings] of Object.entries(portBindings)) {
            if (!bindings || !Array.isArray(bindings))
                continue;
            const [portStr, protocol] = containerPortKey.split('/');
            const containerPort = parseInt(portStr ?? '0', 10);
            for (const binding of bindings) {
                ports.push({
                    hostPort: parseInt(binding.HostPort ?? '0', 10),
                    containerPort,
                    protocol: protocol ?? 'tcp',
                });
            }
        }
        // Get first public port for the ContainerInfo port field
        const primaryPort = ports.length > 0 ? ports[0].hostPort : 0;
        // Parse volumes
        const mounts = inspection.Mounts ?? [];
        const volumes = mounts.map((m) => ({
            source: m.Source ?? '',
            destination: m.Destination ?? '',
            mode: m.Mode ?? 'rw',
        }));
        // Parse networks
        const networkSettings = inspection.NetworkSettings?.Networks ?? {};
        const networks = Object.keys(networkSettings);
        // Restart policy
        const rp = inspection.HostConfig?.RestartPolicy ?? { Name: '', MaximumRetryCount: 0 };
        const restartPolicy = {
            name: rp.Name ?? '',
            maximumRetryCount: rp.MaximumRetryCount ?? 0,
        };
        // Environment variables
        const env = inspection.Config?.Env ?? [];
        // CPU and memory stats (basic from inspection, stats gives more detail)
        let cpuUsagePercent = 0;
        let memoryUsageMB = 0;
        if (status === 'running') {
            try {
                const stats = await getContainerStatsInternal(id);
                cpuUsagePercent = stats.cpuUsagePercent;
                memoryUsageMB = stats.memoryUsageMB;
            }
            catch {
                // Stats may not be available
            }
        }
        return {
            id,
            containerId: id,
            name,
            image,
            imageTag,
            port: primaryPort,
            status,
            health,
            uptime,
            restartCount,
            cpuUsagePercent,
            memoryUsageMB,
            env,
            ports,
            volumes,
            networks,
            restartPolicy,
        };
    }
    // ─── startContainer ──────────────────────────────────────────────────────
    async function startContainer(id) {
        const container = docker.getContainer(id);
        const inspection = await withCircuitBreaker(() => container.inspect());
        if (inspection.State?.Running) {
            throw new Error('Container is already running');
        }
        await withCircuitBreaker(() => container.start());
    }
    // ─── stopContainer ───────────────────────────────────────────────────────
    async function stopContainer(id) {
        const container = docker.getContainer(id);
        await withCircuitBreaker(() => container.stop());
    }
    // ─── restartContainer ────────────────────────────────────────────────────
    async function restartContainer(id) {
        const container = docker.getContainer(id);
        await withCircuitBreaker(() => container.restart());
    }
    // ─── pullAndRedeploy ─────────────────────────────────────────────────────
    async function pullAndRedeploy(id) {
        const jobId = (0, uuid_1.v4)();
        // Get current container configuration before pulling
        const container = docker.getContainer(id);
        const inspection = await withCircuitBreaker(() => container.inspect());
        const image = inspection.Config?.Image ?? '';
        if (!image) {
            throw new Error('Container has no image configured');
        }
        // Notify job submission
        config?.onJobSubmit?.(jobId, id);
        // Execute the pull and redeploy asynchronously
        executePullAndRedeploy(jobId, id, inspection).catch(() => {
            // Error is logged but not thrown since this is async
        });
        return jobId;
    }
    async function executePullAndRedeploy(jobId, containerId, inspection) {
        const image = inspection.Config?.Image ?? '';
        // Step 1: Pull the latest image
        await withCircuitBreaker(async () => {
            const stream = await docker.pull(image);
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err) => {
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
            });
        });
        // Step 2: Stop the existing container
        const container = docker.getContainer(containerId);
        try {
            await withCircuitBreaker(() => container.stop());
        }
        catch (error) {
            // Container may already be stopped
            if (!error.message?.includes('not running') && error.statusCode !== 304) {
                throw error;
            }
        }
        // Step 3: Remove the existing container
        await withCircuitBreaker(() => container.remove());
        // Step 4: Recreate the container preserving configuration
        const createOptions = buildCreateOptions(inspection);
        const newContainer = await withCircuitBreaker(() => docker.createContainer(createOptions));
        // Step 5: Reconnect to networks (beyond the default)
        const networks = inspection.NetworkSettings?.Networks ?? {};
        for (const [networkName, networkConfig] of Object.entries(networks)) {
            if (networkName === 'bridge')
                continue; // Skip default bridge
            try {
                const network = docker.getNetwork(networkName);
                await withCircuitBreaker(() => network.connect({
                    Container: newContainer.id,
                    EndpointConfig: networkConfig,
                }));
            }
            catch {
                // Network may not exist anymore, skip
            }
        }
        // Step 6: Start the new container
        await withCircuitBreaker(() => newContainer.start());
    }
    function buildCreateOptions(inspection) {
        const config = inspection.Config;
        const hostConfig = inspection.HostConfig;
        const name = (inspection.Name ?? '').replace(/^\//, '');
        const options = {
            name,
            Image: config?.Image ?? '',
            Env: config?.Env ?? [],
            Cmd: config?.Cmd ?? undefined,
            Entrypoint: config?.Entrypoint,
            WorkingDir: config?.WorkingDir ?? undefined,
            ExposedPorts: config?.ExposedPorts ?? undefined,
            Labels: config?.Labels ?? undefined,
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
        return options;
    }
    // ─── getContainerStats ───────────────────────────────────────────────────
    async function getContainerStatsInternal(id) {
        const container = docker.getContainer(id);
        const stats = await withCircuitBreaker(() => container.stats({ stream: false }));
        // Calculate CPU usage percentage
        const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
            (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) -
            (stats.precpu_stats?.system_cpu_usage ?? 0);
        const numCpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
        let cpuUsagePercent = 0;
        if (systemDelta > 0 && cpuDelta > 0) {
            cpuUsagePercent = (cpuDelta / systemDelta) * numCpus * 100;
        }
        // Memory
        const memoryUsage = stats.memory_stats?.usage ?? 0;
        const memoryCache = stats.memory_stats?.stats?.cache ?? 0;
        const memoryUsageMB = (memoryUsage - memoryCache) / (1024 * 1024);
        const memoryLimitMB = (stats.memory_stats?.limit ?? 0) / (1024 * 1024);
        // Network
        let networkRxBytes = 0;
        let networkTxBytes = 0;
        const networks = stats.networks ?? {};
        for (const netStats of Object.values(networks)) {
            networkRxBytes += netStats.rx_bytes ?? 0;
            networkTxBytes += netStats.tx_bytes ?? 0;
        }
        // Block I/O
        let blockReadBytes = 0;
        let blockWriteBytes = 0;
        const blkioStats = stats.blkio_stats?.io_service_bytes_recursive ?? [];
        for (const entry of blkioStats) {
            if (entry.op === 'read' || entry.op === 'Read')
                blockReadBytes += entry.value ?? 0;
            if (entry.op === 'write' || entry.op === 'Write')
                blockWriteBytes += entry.value ?? 0;
        }
        return {
            cpuUsagePercent: Math.round(cpuUsagePercent * 100) / 100,
            memoryUsageMB: Math.round(memoryUsageMB * 100) / 100,
            memoryLimitMB: Math.round(memoryLimitMB * 100) / 100,
            networkRxBytes,
            networkTxBytes,
            blockReadBytes,
            blockWriteBytes,
        };
    }
    async function getContainerStats(id) {
        return getContainerStatsInternal(id);
    }
    // ─── getHealthStatus ─────────────────────────────────────────────────────
    async function getHealthStatus(id) {
        try {
            const container = docker.getContainer(id);
            const inspection = await withCircuitBreaker(() => container.inspect());
            const state = inspection.State;
            if (!state?.Running)
                return 'unknown';
            // Check Docker's native health check if available
            if (state.Health?.Status) {
                const status = parseHealthStatus(state.Health);
                healthCache.set(id, status);
                return status;
            }
            // If no health check is configured, infer from running state
            const status = state.Running ? 'healthy' : 'unhealthy';
            healthCache.set(id, status);
            return status;
        }
        catch {
            const status = 'unknown';
            healthCache.set(id, status);
            return status;
        }
    }
    // ─── Health Polling ──────────────────────────────────────────────────────
    async function pollHealth() {
        if (circuitBreaker.isOpen())
            return;
        try {
            const containers = await docker.listContainers({ all: true });
            circuitBreaker.recordSuccess();
            for (const c of containers) {
                const id = c.Id;
                try {
                    await getHealthStatus(id);
                }
                catch {
                    healthCache.set(id, 'unknown');
                }
            }
        }
        catch {
            circuitBreaker.recordFailure();
        }
    }
    function startHealthPolling() {
        if (healthPollTimer)
            return;
        healthPollTimer = setInterval(() => {
            pollHealth().catch(() => { });
        }, healthPollIntervalMs);
        // Don't prevent Node.js from exiting
        if (healthPollTimer.unref) {
            healthPollTimer.unref();
        }
    }
    function stopHealthPolling() {
        if (healthPollTimer) {
            clearInterval(healthPollTimer);
            healthPollTimer = null;
        }
    }
    function getHealthCacheFn() {
        return healthCache;
    }
    function getCircuitBreakerState() {
        return circuitBreaker.getState();
    }
    // ─── Return the public API ─────────────────────────────────────────────────
    return {
        listContainers,
        getContainer,
        startContainer,
        stopContainer,
        restartContainer,
        pullAndRedeploy,
        getContainerStats,
        getHealthStatus,
        startHealthPolling,
        stopHealthPolling,
        getHealthCache: getHealthCacheFn,
        getCircuitBreakerState,
    };
}
//# sourceMappingURL=container-manager.js.map