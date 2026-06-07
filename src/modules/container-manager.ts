/**
 * Container Manager Module
 *
 * Provides Docker container lifecycle management, health monitoring,
 * stats collection, and pull-and-redeploy functionality.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */
import Dockerode from 'dockerode';
import { v4 as uuidv4 } from 'uuid';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export type ContainerStatus = 'running' | 'stopped' | 'exited' | 'restarting';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  port: number;
  status: ContainerStatus;
  health: HealthStatus;
  uptime: number; // seconds
  projectId?: string;
}

export interface ContainerDetail extends ContainerInfo {
  containerId: string;
  imageTag: string;
  restartCount: number;
  cpuUsagePercent: number;
  memoryUsageMB: number;
  env: string[];
  ports: PortMapping[];
  volumes: VolumeMount[];
  networks: string[];
  restartPolicy: RestartPolicy;
}

export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface VolumeMount {
  source: string;
  destination: string;
  mode: string;
}

export interface RestartPolicy {
  name: string;
  maximumRetryCount: number;
}

export interface ContainerStats {
  cpuUsagePercent: number;
  memoryUsageMB: number;
  memoryLimitMB: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export interface ContainerManager {
  listContainers(): Promise<ContainerInfo[]>;
  getContainer(id: string): Promise<ContainerDetail>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  restartContainer(id: string): Promise<void>;
  pullAndRedeploy(id: string): Promise<string>;
  getContainerStats(id: string): Promise<ContainerStats>;
  getHealthStatus(id: string): Promise<HealthStatus>;
  /** Start the health polling interval */
  startHealthPolling(): void;
  /** Stop the health polling interval */
  stopHealthPolling(): void;
  /** Get the cached health statuses */
  getHealthCache(): Map<string, HealthStatus>;
  /** Get the circuit breaker state */
  getCircuitBreakerState(): CircuitBreakerState;
}

export interface ContainerManagerConfig {
  /** Docker host URI. Defaults to DOCKER_HOST env or /var/run/docker.sock */
  dockerHost?: string;
  /** Health poll interval in ms. Default: 15000 (15 seconds) */
  healthPollIntervalMs?: number;
  /** Health check timeout in ms. Default: 5000 (5 seconds) */
  healthCheckTimeoutMs?: number;
  /** Circuit breaker failure threshold. Default: 5 */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms. Default: 30000 (30 seconds) */
  circuitBreakerResetMs?: number;
  /** Callback when a job is submitted (for pullAndRedeploy) */
  onJobSubmit?: (jobId: string, containerId: string) => void;
}

// ─── Circuit Breaker ───────────────────────────────────────────────────────────

export type CircuitBreakerStateType = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState {
  state: CircuitBreakerStateType;
  failures: number;
  lastFailureTime: number | null;
  nextRetryTime: number | null;
}

class CircuitBreaker {
  private state: CircuitBreakerStateType = 'closed';
  private failures: number = 0;
  private lastFailureTime: number | null = null;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold: number, resetMs: number) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  getState(): CircuitBreakerState {
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
      nextRetryTime:
        this.state === 'open' && this.lastFailureTime !== null
          ? this.lastFailureTime + this.resetMs
          : null,
    };
  }

  isOpen(): boolean {
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

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.lastFailureTime = null;
  }

  recordFailure(): void {
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

export function createContainerManager(
  config?: ContainerManagerConfig
): ContainerManager {
  const dockerHost = config?.dockerHost ?? process.env.DOCKER_HOST ?? '/var/run/docker.sock';
  const healthPollIntervalMs = config?.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const circuitBreakerThreshold = config?.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  const circuitBreakerResetMs = config?.circuitBreakerResetMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_MS;

  // Initialize Docker client
  const dockerOpts = dockerHost.startsWith('/')
    ? { socketPath: dockerHost }
    : { host: dockerHost };
  const docker = new Dockerode(dockerOpts);

  // Circuit breaker for Docker daemon communication
  const circuitBreaker = new CircuitBreaker(circuitBreakerThreshold, circuitBreakerResetMs);

  // Health status cache
  const healthCache = new Map<string, HealthStatus>();

  // Health polling timer
  let healthPollTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Docker API wrapper with circuit breaker ─────────────────────────────

  async function withCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
    if (circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker is open: Docker daemon communication suspended');
    }

    try {
      const result = await operation();
      circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      circuitBreaker.recordFailure();
      throw error;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function parseContainerStatus(state: string): ContainerStatus {
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

  function parseHealthStatus(health?: { Status?: string }): HealthStatus {
    if (!health || !health.Status) return 'unknown';
    switch (health.Status.toLowerCase()) {
      case 'healthy':
        return 'healthy';
      case 'unhealthy':
        return 'unhealthy';
      default:
        return 'unknown';
    }
  }

  function getContainerName(names: string[]): string {
    // Docker container names start with /
    const name = names[0] ?? '';
    return name.startsWith('/') ? name.slice(1) : name;
  }

  function getFirstPublicPort(ports: Dockerode.Port[]): number {
    for (const port of ports) {
      if (port.PublicPort) return port.PublicPort;
    }
    return 0;
  }

  function calculateUptime(startedAt: string | undefined): number {
    if (!startedAt) return 0;
    const started = new Date(startedAt).getTime();
    if (isNaN(started)) return 0;
    return Math.floor((Date.now() - started) / 1000);
  }

  // ─── listContainers ──────────────────────────────────────────────────────

  async function listContainers(): Promise<ContainerInfo[]> {
    const containers = await withCircuitBreaker(() =>
      docker.listContainers({ all: true })
    );

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

  async function getContainer(id: string): Promise<ContainerDetail> {
    const containerRef = docker.getContainer(id);
    const inspection = await withCircuitBreaker(() => containerRef.inspect());

    const name = (inspection.Name ?? '').replace(/^\//, '');
    const image = inspection.Config?.Image ?? '';
    const imageTag = inspection.Image ?? '';
    const state = inspection.State;
    const status = parseContainerStatus(state?.Status ?? '');
    const health = healthCache.get(id) ?? parseHealthStatus(state?.Health);
    const uptime = calculateUptime(state?.StartedAt);
    const restartCount = (state as any)?.RestartCount ?? (inspection as any).RestartCount ?? 0;

    // Parse port mappings
    const portBindings = inspection.HostConfig?.PortBindings ?? {};
    const ports: PortMapping[] = [];
    for (const [containerPortKey, bindings] of Object.entries(portBindings)) {
      if (!bindings || !Array.isArray(bindings)) continue;
      const [portStr, protocol] = containerPortKey.split('/');
      const containerPort = parseInt(portStr ?? '0', 10);
      for (const binding of bindings as Array<{ HostIp?: string; HostPort?: string }>) {
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
    const volumes: VolumeMount[] = mounts.map((m: any) => ({
      source: m.Source ?? '',
      destination: m.Destination ?? '',
      mode: m.Mode ?? 'rw',
    }));

    // Parse networks
    const networkSettings = inspection.NetworkSettings?.Networks ?? {};
    const networks = Object.keys(networkSettings);

    // Restart policy
    const rp = inspection.HostConfig?.RestartPolicy ?? { Name: '', MaximumRetryCount: 0 };
    const restartPolicy: RestartPolicy = {
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
      } catch {
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

  async function startContainer(id: string): Promise<void> {
    const container = docker.getContainer(id);
    const inspection = await withCircuitBreaker(() => container.inspect());

    if (inspection.State?.Running) {
      throw new Error('Container is already running');
    }

    await withCircuitBreaker(() => container.start());
  }

  // ─── stopContainer ───────────────────────────────────────────────────────

  async function stopContainer(id: string): Promise<void> {
    const container = docker.getContainer(id);
    await withCircuitBreaker(() => container.stop());
  }

  // ─── restartContainer ────────────────────────────────────────────────────

  async function restartContainer(id: string): Promise<void> {
    const container = docker.getContainer(id);
    await withCircuitBreaker(() => container.restart());
  }

  // ─── pullAndRedeploy ─────────────────────────────────────────────────────

  async function pullAndRedeploy(id: string): Promise<string> {
    const jobId = uuidv4();

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

  async function executePullAndRedeploy(
    jobId: string,
    containerId: string,
    inspection: Dockerode.ContainerInspectInfo
  ): Promise<void> {
    const image = inspection.Config?.Image ?? '';

    // Step 1: Pull the latest image
    await withCircuitBreaker(async () => {
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    // Step 2: Stop the existing container
    const container = docker.getContainer(containerId);
    try {
      await withCircuitBreaker(() => container.stop());
    } catch (error: any) {
      // Container may already be stopped
      if (!error.message?.includes('not running') && error.statusCode !== 304) {
        throw error;
      }
    }

    // Step 3: Remove the existing container
    await withCircuitBreaker(() => container.remove());

    // Step 4: Recreate the container preserving configuration
    const createOptions = buildCreateOptions(inspection);

    const newContainer = await withCircuitBreaker(() =>
      docker.createContainer(createOptions)
    );

    // Step 5: Reconnect to networks (beyond the default)
    const networks = inspection.NetworkSettings?.Networks ?? {};
    for (const [networkName, networkConfig] of Object.entries(networks)) {
      if (networkName === 'bridge') continue; // Skip default bridge
      try {
        const network = docker.getNetwork(networkName);
        await withCircuitBreaker(() =>
          network.connect({
            Container: newContainer.id,
            EndpointConfig: networkConfig as any,
          })
        );
      } catch {
        // Network may not exist anymore, skip
      }
    }

    // Step 6: Start the new container
    await withCircuitBreaker(() => newContainer.start());
  }

  function buildCreateOptions(
    inspection: Dockerode.ContainerInspectInfo
  ): Dockerode.ContainerCreateOptions {
    const config = inspection.Config;
    const hostConfig = inspection.HostConfig;
    const name = (inspection.Name ?? '').replace(/^\//, '');

    const options: Dockerode.ContainerCreateOptions = {
      name,
      Image: config?.Image ?? '',
      Env: config?.Env ?? [],
      Cmd: config?.Cmd ?? undefined,
      Entrypoint: config?.Entrypoint as any,
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

  async function getContainerStatsInternal(id: string): Promise<ContainerStats> {
    const container = docker.getContainer(id);
    const stats = await withCircuitBreaker(() =>
      container.stats({ stream: false }) as Promise<any>
    );

    // Calculate CPU usage percentage
    const cpuDelta =
      (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (stats.cpu_stats?.system_cpu_usage ?? 0) -
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
    for (const netStats of Object.values(networks) as any[]) {
      networkRxBytes += netStats.rx_bytes ?? 0;
      networkTxBytes += netStats.tx_bytes ?? 0;
    }

    // Block I/O
    let blockReadBytes = 0;
    let blockWriteBytes = 0;
    const blkioStats = stats.blkio_stats?.io_service_bytes_recursive ?? [];
    for (const entry of blkioStats) {
      if (entry.op === 'read' || entry.op === 'Read') blockReadBytes += entry.value ?? 0;
      if (entry.op === 'write' || entry.op === 'Write') blockWriteBytes += entry.value ?? 0;
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

  async function getContainerStats(id: string): Promise<ContainerStats> {
    return getContainerStatsInternal(id);
  }

  // ─── getHealthStatus ─────────────────────────────────────────────────────

  async function getHealthStatus(id: string): Promise<HealthStatus> {
    try {
      const container = docker.getContainer(id);
      const inspection = await withCircuitBreaker(() => container.inspect());

      const state = inspection.State;
      if (!state?.Running) return 'unknown';

      // Check Docker's native health check if available
      if (state.Health?.Status) {
        const status = parseHealthStatus(state.Health);
        healthCache.set(id, status);
        return status;
      }

      // If no health check is configured, infer from running state
      const status: HealthStatus = state.Running ? 'healthy' : 'unhealthy';
      healthCache.set(id, status);
      return status;
    } catch {
      const status: HealthStatus = 'unknown';
      healthCache.set(id, status);
      return status;
    }
  }

  // ─── Health Polling ──────────────────────────────────────────────────────

  async function pollHealth(): Promise<void> {
    if (circuitBreaker.isOpen()) return;

    try {
      const containers = await docker.listContainers({ all: true });
      circuitBreaker.recordSuccess();

      for (const c of containers) {
        const id = c.Id;
        try {
          await getHealthStatus(id);
        } catch {
          healthCache.set(id, 'unknown');
        }
      }
    } catch {
      circuitBreaker.recordFailure();
    }
  }

  function startHealthPolling(): void {
    if (healthPollTimer) return;
    healthPollTimer = setInterval(() => {
      pollHealth().catch(() => { /* swallow polling errors */ });
    }, healthPollIntervalMs);

    // Don't prevent Node.js from exiting
    if (healthPollTimer.unref) {
      healthPollTimer.unref();
    }
  }

  function stopHealthPolling(): void {
    if (healthPollTimer) {
      clearInterval(healthPollTimer);
      healthPollTimer = null;
    }
  }

  function getHealthCacheFn(): Map<string, HealthStatus> {
    return healthCache;
  }

  function getCircuitBreakerState(): CircuitBreakerState {
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
