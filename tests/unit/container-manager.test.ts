/**
 * Container Manager Unit Tests
 *
 * Tests for Docker container lifecycle management, health polling,
 * circuit breaker pattern, and pull-and-redeploy functionality.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createContainerManager } from '../../src/modules/container-manager.js';
import type { ContainerManager } from '../../src/modules/container-manager.js';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockContainer = {
  inspect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  stats: vi.fn(),
};

const mockNetwork = {
  connect: vi.fn(),
};

const mockNewContainer = {
  id: 'new-container-id-123',
  start: vi.fn(),
};

const mockModem = {
  followProgress: vi.fn((stream: any, callback: (err: Error | null, output?: any) => void) => {
    callback(null);
  }),
};

const mockDocker = {
  listContainers: vi.fn(),
  getContainer: vi.fn(() => mockContainer),
  getNetwork: vi.fn(() => mockNetwork),
  createContainer: vi.fn(() => mockNewContainer),
  pull: vi.fn(),
  modem: mockModem,
};

vi.mock('dockerode', () => {
  return {
    default: vi.fn(() => mockDocker),
  };
});

// ─── Test Data ─────────────────────────────────────────────────────────────────

const MOCK_CONTAINER_LIST = [
  {
    Id: 'abc123def456',
    Names: ['/avry-backend'],
    Image: 'avry-backend:latest',
    Ports: [{ PublicPort: 3000, PrivatePort: 3000, Type: 'tcp' }],
    State: 'running',
    Status: 'Up 2 hours',
    Created: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
  },
  {
    Id: 'def456ghi789',
    Names: ['/avry-console'],
    Image: 'avry-console:latest',
    Ports: [{ PublicPort: 8080, PrivatePort: 80, Type: 'tcp' }],
    State: 'exited',
    Status: 'Exited (0) 10 minutes ago',
    Created: Math.floor(Date.now() / 1000) - 86400, // 1 day ago
  },
];

const MOCK_INSPECT_RESULT = {
  Id: 'abc123def456',
  Name: '/avry-backend',
  Image: 'sha256:abcdef123456',
  Config: {
    Image: 'avry-backend:latest',
    Env: ['NODE_ENV=production', 'PORT=3000'],
    Cmd: ['node', 'dist/server.js'],
    Entrypoint: null,
    WorkingDir: '/app',
    ExposedPorts: { '3000/tcp': {} },
    Labels: { 'com.docker.compose.service': 'backend' },
  },
  State: {
    Status: 'running',
    Running: true,
    StartedAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    RestartCount: 2,
    Health: {
      Status: 'healthy',
    },
  },
  HostConfig: {
    PortBindings: {
      '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }],
    },
    Binds: ['/data/backend:/app/data:rw'],
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    NetworkMode: 'aivery-network',
    VolumesFrom: null,
    Memory: 0,
    MemorySwap: 0,
    CpuShares: 0,
    CpuQuota: 0,
    CpuPeriod: 0,
  },
  Mounts: [
    { Source: '/data/backend', Destination: '/app/data', Mode: 'rw' },
  ],
  NetworkSettings: {
    Networks: {
      'aivery-network': {
        IPAddress: '172.18.0.5',
        Gateway: '172.18.0.1',
      },
    },
  },
};

const MOCK_STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 2000000000 },
    system_cpu_usage: 100000000000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1000000000 },
    system_cpu_usage: 99000000000,
  },
  memory_stats: {
    usage: 256 * 1024 * 1024, // 256MB
    limit: 1024 * 1024 * 1024, // 1GB
    stats: { cache: 64 * 1024 * 1024 }, // 64MB cache
  },
  networks: {
    eth0: { rx_bytes: 1024000, tx_bytes: 512000 },
  },
  blkio_stats: {
    io_service_bytes_recursive: [
      { op: 'Read', value: 2048000 },
      { op: 'Write', value: 1024000 },
    ],
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Container Manager', () => {
  let manager: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocker.listContainers.mockResolvedValue(MOCK_CONTAINER_LIST);
    mockContainer.inspect.mockResolvedValue(MOCK_INSPECT_RESULT);
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.stop.mockResolvedValue(undefined);
    mockContainer.restart.mockResolvedValue(undefined);
    mockContainer.remove.mockResolvedValue(undefined);
    mockContainer.stats.mockResolvedValue(MOCK_STATS);
    mockNewContainer.start.mockResolvedValue(undefined);
    mockDocker.createContainer.mockResolvedValue(mockNewContainer);
    mockDocker.pull.mockResolvedValue('mock-stream');
    mockNetwork.connect.mockResolvedValue(undefined);

    manager = createContainerManager({
      dockerHost: '/var/run/docker.sock',
      healthPollIntervalMs: 15000,
      healthCheckTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    manager.stopHealthPolling();
  });

  // ─── listContainers ────────────────────────────────────────────────────

  describe('listContainers', () => {
    it('should return a list of all containers with correct info', async () => {
      const containers = await manager.listContainers();

      expect(containers).toHaveLength(2);
      expect(containers[0]).toMatchObject({
        id: 'abc123def456',
        name: 'avry-backend',
        image: 'avry-backend:latest',
        port: 3000,
        status: 'running',
      });
      expect(containers[1]).toMatchObject({
        id: 'def456ghi789',
        name: 'avry-console',
        image: 'avry-console:latest',
        port: 8080,
        status: 'exited',
      });
    });

    it('should list containers with all: true to include stopped ones', async () => {
      await manager.listContainers();

      expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
    });

    it('should handle empty container list', async () => {
      mockDocker.listContainers.mockResolvedValue([]);

      const containers = await manager.listContainers();

      expect(containers).toHaveLength(0);
    });

    it('should handle containers with no ports', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'no-port-container',
          Names: ['/worker'],
          Image: 'worker:latest',
          Ports: [],
          State: 'running',
          Created: Math.floor(Date.now() / 1000) - 3600,
        },
      ]);

      const containers = await manager.listContainers();

      expect(containers[0].port).toBe(0);
    });

    it('should calculate uptime for running containers', async () => {
      const containers = await manager.listContainers();

      // Running container should have uptime > 0
      expect(containers[0].uptime).toBeGreaterThan(0);
      // Exited container should have uptime of 0
      expect(containers[1].uptime).toBe(0);
    });
  });

  // ─── getContainer ──────────────────────────────────────────────────────

  describe('getContainer', () => {
    it('should return detailed container information', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.id).toBe('abc123def456');
      expect(detail.name).toBe('avry-backend');
      expect(detail.image).toBe('avry-backend:latest');
      expect(detail.imageTag).toBe('sha256:abcdef123456');
      expect(detail.status).toBe('running');
      expect(detail.restartCount).toBe(2);
    });

    it('should parse port mappings correctly', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.ports).toEqual([
        { hostPort: 3000, containerPort: 3000, protocol: 'tcp' },
      ]);
    });

    it('should parse volume mounts correctly', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.volumes).toEqual([
        { source: '/data/backend', destination: '/app/data', mode: 'rw' },
      ]);
    });

    it('should return network connections', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.networks).toContain('aivery-network');
    });

    it('should return restart policy', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.restartPolicy).toEqual({
        name: 'unless-stopped',
        maximumRetryCount: 0,
      });
    });

    it('should return environment variables', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.env).toContain('NODE_ENV=production');
      expect(detail.env).toContain('PORT=3000');
    });

    it('should include CPU and memory stats for running containers', async () => {
      const detail = await manager.getContainer('abc123def456');

      expect(detail.cpuUsagePercent).toBeGreaterThanOrEqual(0);
      expect(detail.memoryUsageMB).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── startContainer ────────────────────────────────────────────────────

  describe('startContainer', () => {
    it('should start a stopped container', async () => {
      mockContainer.inspect.mockResolvedValue({
        ...MOCK_INSPECT_RESULT,
        State: { ...MOCK_INSPECT_RESULT.State, Running: false, Status: 'exited' },
      });

      await manager.startContainer('abc123def456');

      expect(mockContainer.start).toHaveBeenCalled();
    });

    it('should throw if container is already running', async () => {
      await expect(manager.startContainer('abc123def456')).rejects.toThrow(
        'Container is already running'
      );
    });
  });

  // ─── stopContainer ─────────────────────────────────────────────────────

  describe('stopContainer', () => {
    it('should stop a running container', async () => {
      await manager.stopContainer('abc123def456');

      expect(mockContainer.stop).toHaveBeenCalled();
    });

    it('should throw if Docker daemon errors', async () => {
      mockContainer.stop.mockRejectedValue(new Error('container not found'));

      await expect(manager.stopContainer('abc123def456')).rejects.toThrow(
        'container not found'
      );
    });
  });

  // ─── restartContainer ──────────────────────────────────────────────────

  describe('restartContainer', () => {
    it('should restart a container', async () => {
      await manager.restartContainer('abc123def456');

      expect(mockContainer.restart).toHaveBeenCalled();
    });
  });

  // ─── pullAndRedeploy ───────────────────────────────────────────────────

  describe('pullAndRedeploy', () => {
    it('should return a job ID immediately', async () => {
      const jobId = await manager.pullAndRedeploy('abc123def456');

      expect(jobId).toBeTruthy();
      expect(typeof jobId).toBe('string');
      // UUID format check
      expect(jobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should pull the image from the container config', async () => {
      await manager.pullAndRedeploy('abc123def456');

      // Wait for async operations
      await vi.waitFor(() => {
        expect(mockDocker.pull).toHaveBeenCalledWith('avry-backend:latest');
      });
    });

    it('should call onJobSubmit callback with job ID and container ID', async () => {
      const onJobSubmit = vi.fn();
      const mgr = createContainerManager({
        dockerHost: '/var/run/docker.sock',
        onJobSubmit,
      });

      const jobId = await mgr.pullAndRedeploy('abc123def456');

      expect(onJobSubmit).toHaveBeenCalledWith(jobId, 'abc123def456');
      mgr.stopHealthPolling();
    });

    it('should throw if container has no image', async () => {
      mockContainer.inspect.mockResolvedValue({
        ...MOCK_INSPECT_RESULT,
        Config: { ...MOCK_INSPECT_RESULT.Config, Image: '' },
      });

      await expect(manager.pullAndRedeploy('abc123def456')).rejects.toThrow(
        'Container has no image configured'
      );
    });

    it('should stop, remove, recreate, and start the container', async () => {
      await manager.pullAndRedeploy('abc123def456');

      // Wait for async operations to complete
      await vi.waitFor(() => {
        expect(mockContainer.stop).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockContainer.remove).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockDocker.createContainer).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockNewContainer.start).toHaveBeenCalled();
      });
    });

    it('should preserve env vars, ports, volumes, and restart policy in recreated container', async () => {
      await manager.pullAndRedeploy('abc123def456');

      await vi.waitFor(() => {
        expect(mockDocker.createContainer).toHaveBeenCalled();
      });

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.Env).toEqual(['NODE_ENV=production', 'PORT=3000']);
      expect(createCall.HostConfig.PortBindings).toEqual({
        '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }],
      });
      expect(createCall.HostConfig.Binds).toEqual(['/data/backend:/app/data:rw']);
      expect(createCall.HostConfig.RestartPolicy).toEqual({
        Name: 'unless-stopped',
        MaximumRetryCount: 0,
      });
    });

    it('should reconnect to non-default networks after recreation', async () => {
      await manager.pullAndRedeploy('abc123def456');

      await vi.waitFor(() => {
        expect(mockDocker.getNetwork).toHaveBeenCalledWith('aivery-network');
      });
      await vi.waitFor(() => {
        expect(mockNetwork.connect).toHaveBeenCalledWith(
          expect.objectContaining({
            Container: 'new-container-id-123',
          })
        );
      });
    });
  });

  // ─── getContainerStats ─────────────────────────────────────────────────

  describe('getContainerStats', () => {
    it('should return CPU usage percentage', async () => {
      const stats = await manager.getContainerStats('abc123def456');

      // (2B - 1B) / (100B - 99B) * 4 * 100 = 400%... with 4 CPUs
      // cpuDelta=1000000000, systemDelta=1000000000, numCpus=4
      // => (1/1) * 4 * 100 = 400
      expect(stats.cpuUsagePercent).toBe(400);
    });

    it('should return memory usage in MB', async () => {
      const stats = await manager.getContainerStats('abc123def456');

      // (256MB - 64MB cache) = 192MB
      expect(stats.memoryUsageMB).toBe(192);
    });

    it('should return memory limit in MB', async () => {
      const stats = await manager.getContainerStats('abc123def456');

      expect(stats.memoryLimitMB).toBe(1024);
    });

    it('should return network I/O bytes', async () => {
      const stats = await manager.getContainerStats('abc123def456');

      expect(stats.networkRxBytes).toBe(1024000);
      expect(stats.networkTxBytes).toBe(512000);
    });

    it('should return block I/O bytes', async () => {
      const stats = await manager.getContainerStats('abc123def456');

      expect(stats.blockReadBytes).toBe(2048000);
      expect(stats.blockWriteBytes).toBe(1024000);
    });
  });

  // ─── getHealthStatus ───────────────────────────────────────────────────

  describe('getHealthStatus', () => {
    it('should return healthy for a running container with healthy health check', async () => {
      const status = await manager.getHealthStatus('abc123def456');

      expect(status).toBe('healthy');
    });

    it('should return unhealthy for a container with unhealthy health check', async () => {
      mockContainer.inspect.mockResolvedValue({
        ...MOCK_INSPECT_RESULT,
        State: {
          ...MOCK_INSPECT_RESULT.State,
          Health: { Status: 'unhealthy' },
        },
      });

      const status = await manager.getHealthStatus('abc123def456');

      expect(status).toBe('unhealthy');
    });

    it('should return unknown for a non-running container', async () => {
      mockContainer.inspect.mockResolvedValue({
        ...MOCK_INSPECT_RESULT,
        State: { ...MOCK_INSPECT_RESULT.State, Running: false },
      });

      const status = await manager.getHealthStatus('abc123def456');

      expect(status).toBe('unknown');
    });

    it('should return healthy for running container with no health check', async () => {
      mockContainer.inspect.mockResolvedValue({
        ...MOCK_INSPECT_RESULT,
        State: {
          ...MOCK_INSPECT_RESULT.State,
          Health: undefined,
          Running: true,
        },
      });

      const status = await manager.getHealthStatus('abc123def456');

      expect(status).toBe('healthy');
    });

    it('should return unknown on inspection error', async () => {
      mockContainer.inspect.mockRejectedValue(new Error('container not found'));

      const status = await manager.getHealthStatus('abc123def456');

      expect(status).toBe('unknown');
    });

    it('should cache health status', async () => {
      await manager.getHealthStatus('abc123def456');

      const cache = manager.getHealthCache();
      expect(cache.get('abc123def456')).toBe('healthy');
    });
  });

  // ─── Health Polling ────────────────────────────────────────────────────

  describe('Health Polling', () => {
    it('should start and stop health polling', () => {
      manager.startHealthPolling();
      // Calling start again should be a no-op
      manager.startHealthPolling();
      manager.stopHealthPolling();
    });

    it('should poll health on interval', async () => {
      vi.useFakeTimers();

      const mgr = createContainerManager({
        dockerHost: '/var/run/docker.sock',
        healthPollIntervalMs: 100,
      });
      mgr.startHealthPolling();

      // Advance time to trigger polling
      await vi.advanceTimersByTimeAsync(150);

      expect(mockDocker.listContainers).toHaveBeenCalled();

      mgr.stopHealthPolling();
      vi.useRealTimers();
    });
  });

  // ─── Circuit Breaker ───────────────────────────────────────────────────

  describe('Circuit Breaker', () => {
    it('should start in closed state', () => {
      const state = manager.getCircuitBreakerState();

      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);
    });

    it('should open after 5 consecutive failures', async () => {
      // Simulate 5 consecutive failures
      mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

      for (let i = 0; i < 5; i++) {
        try {
          await manager.listContainers();
        } catch {
          // Expected
        }
      }

      const state = manager.getCircuitBreakerState();
      expect(state.state).toBe('open');
      expect(state.failures).toBe(5);
    });

    it('should reject requests when circuit is open', async () => {
      mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await manager.listContainers();
        } catch {
          // Expected
        }
      }

      // Next call should be immediately rejected
      await expect(manager.listContainers()).rejects.toThrow(
        'Circuit breaker is open'
      );
    });

    it('should transition to half-open after reset timeout', async () => {
      vi.useFakeTimers();
      mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await manager.listContainers();
        } catch {
          // Expected
        }
      }

      // Advance time past the reset timeout (30s)
      vi.advanceTimersByTime(31000);

      const state = manager.getCircuitBreakerState();
      expect(state.state).toBe('half-open');

      vi.useRealTimers();
    });

    it('should reset to closed on success after half-open', async () => {
      vi.useFakeTimers();
      mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await manager.listContainers();
        } catch {
          // Expected
        }
      }

      // Advance time past the reset timeout
      vi.advanceTimersByTime(31000);

      // Now make a successful call
      mockDocker.listContainers.mockResolvedValue(MOCK_CONTAINER_LIST);
      await manager.listContainers();

      const state = manager.getCircuitBreakerState();
      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);

      vi.useRealTimers();
    });

    it('should reset failure count on successful call', async () => {
      mockDocker.listContainers.mockRejectedValue(new Error('fail'));

      // 3 failures (not enough to trip)
      for (let i = 0; i < 3; i++) {
        try {
          await manager.listContainers();
        } catch {
          // Expected
        }
      }

      // Successful call resets
      mockDocker.listContainers.mockResolvedValue(MOCK_CONTAINER_LIST);
      await manager.listContainers();

      const state = manager.getCircuitBreakerState();
      expect(state.failures).toBe(0);
    });
  });

  // ─── DOCKER_HOST configuration ────────────────────────────────────────

  describe('Configuration', () => {
    it('should default to /var/run/docker.sock when no config or env', () => {
      const originalDockerHost = process.env.DOCKER_HOST;
      delete process.env.DOCKER_HOST;

      const mgr = createContainerManager();
      // Module was created without error
      expect(mgr).toBeDefined();
      mgr.stopHealthPolling();

      process.env.DOCKER_HOST = originalDockerHost;
    });

    it('should use DOCKER_HOST from environment', () => {
      process.env.DOCKER_HOST = 'tcp://localhost:2375';

      const mgr = createContainerManager();
      expect(mgr).toBeDefined();
      mgr.stopHealthPolling();

      delete process.env.DOCKER_HOST;
    });

    it('should use dockerHost from config over env', () => {
      process.env.DOCKER_HOST = 'tcp://wrong-host:2375';

      const mgr = createContainerManager({
        dockerHost: '/custom/docker.sock',
      });
      expect(mgr).toBeDefined();
      mgr.stopHealthPolling();

      delete process.env.DOCKER_HOST;
    });
  });

  // ─── Container status parsing ──────────────────────────────────────────

  describe('Status Parsing', () => {
    it('should parse "running" state correctly', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { ...MOCK_CONTAINER_LIST[0], State: 'running' },
      ]);

      const containers = await manager.listContainers();
      expect(containers[0].status).toBe('running');
    });

    it('should parse "exited" state correctly', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { ...MOCK_CONTAINER_LIST[0], State: 'exited' },
      ]);

      const containers = await manager.listContainers();
      expect(containers[0].status).toBe('exited');
    });

    it('should parse "restarting" state correctly', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { ...MOCK_CONTAINER_LIST[0], State: 'restarting' },
      ]);

      const containers = await manager.listContainers();
      expect(containers[0].status).toBe('restarting');
    });

    it('should parse "created" state as stopped', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { ...MOCK_CONTAINER_LIST[0], State: 'created' },
      ]);

      const containers = await manager.listContainers();
      expect(containers[0].status).toBe('stopped');
    });

    it('should parse "dead" state as exited', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { ...MOCK_CONTAINER_LIST[0], State: 'dead' },
      ]);

      const containers = await manager.listContainers();
      expect(containers[0].status).toBe('exited');
    });
  });
});
