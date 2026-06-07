/**
 * Property 3: Container configuration preservation on redeploy
 *
 * Tests that after pullAndRedeploy, the new container config matches original
 * for all preserved fields: env vars, port mappings, volume mounts, network
 * connections, and restart policy.
 *
 * **Validates: Requirements 2.5**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
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
  id: 'new-container-id-456',
  start: vi.fn(),
};

const mockModem = {
  followProgress: vi.fn((_stream: any, callback: (err: Error | null) => void) => {
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

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generate a valid environment variable (KEY=VALUE format) */
const envVarArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789'.split('')), {
      minLength: 1,
      maxLength: 20,
    }),
    fc.string({ minLength: 0, maxLength: 50 })
  )
  .map(([key, value]) => `${key}=${value}`);

/** Generate a list of environment variables */
const envListArb = fc.array(envVarArb, { minLength: 0, maxLength: 10 });

/** Generate a port number (valid host/container port range) */
const portNumberArb = fc.integer({ min: 1, max: 65535 });

/** Generate a protocol */
const protocolArb = fc.constantFrom('tcp', 'udp');

/** Generate port bindings in Docker's format: { "containerPort/protocol": [{ HostIp, HostPort }] } */
const portBindingsArb = fc
  .array(
    fc.tuple(portNumberArb, portNumberArb, protocolArb),
    { minLength: 0, maxLength: 5 }
  )
  .map((ports) => {
    const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const [hostPort, containerPort, protocol] of ports) {
      const key = `${containerPort}/${protocol}`;
      if (!bindings[key]) {
        bindings[key] = [];
      }
      bindings[key].push({ HostIp: '0.0.0.0', HostPort: String(hostPort) });
    }
    return bindings;
  });

/** Generate volume bind mounts in Docker's format: "/host/path:/container/path:mode" */
const volumeBindArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'/abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 2,
      maxLength: 30,
    }),
    fc.stringOf(fc.constantFrom(...'/abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 2,
      maxLength: 30,
    }),
    fc.constantFrom('rw', 'ro')
  )
  .map(([source, dest, mode]) => `${source}:${dest}:${mode}`);

const volumeBindsArb = fc.array(volumeBindArb, { minLength: 0, maxLength: 5 });

/** Generate a restart policy */
const restartPolicyArb = fc
  .tuple(
    fc.constantFrom('no', 'always', 'unless-stopped', 'on-failure'),
    fc.integer({ min: 0, max: 10 })
  )
  .map(([name, maxRetry]) => ({
    Name: name,
    MaximumRetryCount: name === 'on-failure' ? maxRetry : 0,
  }));

/** Generate network names */
const networkNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 3, maxLength: 20 }
);

const networksArb = fc
  .array(networkNameArb, { minLength: 0, maxLength: 3 })
  .map((names) => {
    const networks: Record<string, { IPAddress: string; Gateway: string }> = {};
    for (const name of names) {
      networks[name] = {
        IPAddress: '172.18.0.' + Math.floor(Math.random() * 254 + 1),
        Gateway: '172.18.0.1',
      };
    }
    return networks;
  });

/** Generate the network mode */
const networkModeArb = fc.constantFrom('bridge', 'host', 'none', 'aivery-network');

/** Full container configuration arbitrary */
const containerConfigArb = fc.record({
  env: envListArb,
  portBindings: portBindingsArb,
  binds: volumeBindsArb,
  restartPolicy: restartPolicyArb,
  networks: networksArb,
  networkMode: networkModeArb,
  image: fc.constantFrom(
    'nginx:latest',
    'node:18-alpine',
    'postgres:15',
    'redis:7',
    'avry-backend:latest'
  ),
  containerName: fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 3, maxLength: 20 }
  ),
});

// ─── Helper to build mock inspection from config ───────────────────────────────

function buildMockInspection(config: {
  env: string[];
  portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  binds: string[];
  restartPolicy: { Name: string; MaximumRetryCount: number };
  networks: Record<string, { IPAddress: string; Gateway: string }>;
  networkMode: string;
  image: string;
  containerName: string;
}) {
  return {
    Id: 'container-id-original',
    Name: `/${config.containerName}`,
    Image: 'sha256:abc123',
    Config: {
      Image: config.image,
      Env: config.env,
      Cmd: ['node', 'server.js'],
      Entrypoint: null,
      WorkingDir: '/app',
      ExposedPorts: Object.keys(config.portBindings).reduce(
        (acc, key) => ({ ...acc, [key]: {} }),
        {} as Record<string, object>
      ),
      Labels: { 'com.example': 'test' },
    },
    State: {
      Status: 'running',
      Running: true,
      StartedAt: new Date().toISOString(),
      Health: { Status: 'healthy' },
    },
    HostConfig: {
      PortBindings: config.portBindings,
      Binds: config.binds,
      RestartPolicy: config.restartPolicy,
      NetworkMode: config.networkMode,
      VolumesFrom: null,
      Memory: 0,
      MemorySwap: 0,
      CpuShares: 0,
      CpuQuota: 0,
      CpuPeriod: 0,
    },
    Mounts: config.binds.map((b) => {
      const [source, dest, mode] = b.split(':');
      return { Source: source, Destination: dest, Mode: mode || 'rw' };
    }),
    NetworkSettings: {
      Networks: config.networks,
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 3: Container configuration preservation on redeploy', () => {
  let manager: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.stop.mockResolvedValue(undefined);
    mockContainer.restart.mockResolvedValue(undefined);
    mockContainer.remove.mockResolvedValue(undefined);
    mockNewContainer.start.mockResolvedValue(undefined);
    mockDocker.createContainer.mockReturnValue(mockNewContainer);
    mockDocker.pull.mockResolvedValue('mock-stream');
    mockNetwork.connect.mockResolvedValue(undefined);

    manager = createContainerManager({
      dockerHost: '/var/run/docker.sock',
    });
  });

  afterEach(() => {
    manager.stopHealthPolling();
  });

  it('preserves environment variables after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        // Wait for async redeploy to complete
        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        const createCall = mockDocker.createContainer.mock.calls[0][0];

        // Environment variables must be preserved exactly
        expect(createCall.Env).toEqual(config.env);
      }),
      { numRuns: 50 }
    );
  });

  it('preserves port mappings after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        const createCall = mockDocker.createContainer.mock.calls[0][0];

        // Port bindings must be preserved exactly
        expect(createCall.HostConfig.PortBindings).toEqual(config.portBindings);
      }),
      { numRuns: 50 }
    );
  });

  it('preserves volume mounts after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        const createCall = mockDocker.createContainer.mock.calls[0][0];

        // Volume binds must be preserved exactly
        expect(createCall.HostConfig.Binds).toEqual(config.binds);
      }),
      { numRuns: 50 }
    );
  });

  it('preserves restart policy after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        const createCall = mockDocker.createContainer.mock.calls[0][0];

        // Restart policy must be preserved exactly
        expect(createCall.HostConfig.RestartPolicy).toEqual(config.restartPolicy);
      }),
      { numRuns: 50 }
    );
  });

  it('reconnects to network connections after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        // Non-bridge networks should be reconnected
        const nonBridgeNetworks = Object.keys(config.networks).filter(
          (name) => name !== 'bridge'
        );

        await vi.waitFor(() => {
          for (const networkName of nonBridgeNetworks) {
            expect(mockDocker.getNetwork).toHaveBeenCalledWith(networkName);
          }
        });

        // Each non-bridge network should be connected to the new container
        for (const networkName of nonBridgeNetworks) {
          expect(mockNetwork.connect).toHaveBeenCalledWith(
            expect.objectContaining({
              Container: mockNewContainer.id,
            })
          );
        }
      }),
      { numRuns: 50 }
    );
  });

  it('preserves all configuration fields together after pullAndRedeploy', async () => {
    await fc.assert(
      fc.asyncProperty(containerConfigArb, async (config) => {
        vi.clearAllMocks();
        mockContainer.stop.mockResolvedValue(undefined);
        mockContainer.remove.mockResolvedValue(undefined);
        mockNewContainer.start.mockResolvedValue(undefined);
        mockDocker.createContainer.mockReturnValue(mockNewContainer);
        mockDocker.pull.mockResolvedValue('mock-stream');
        mockNetwork.connect.mockResolvedValue(undefined);

        const inspection = buildMockInspection(config);
        mockContainer.inspect.mockResolvedValue(inspection);

        await manager.pullAndRedeploy('container-id-original');

        await vi.waitFor(() => {
          expect(mockDocker.createContainer).toHaveBeenCalled();
        });

        const createCall = mockDocker.createContainer.mock.calls[0][0];

        // All preserved fields must match simultaneously
        expect(createCall.Env).toEqual(config.env);
        expect(createCall.HostConfig.PortBindings).toEqual(config.portBindings);
        expect(createCall.HostConfig.Binds).toEqual(config.binds);
        expect(createCall.HostConfig.RestartPolicy).toEqual(config.restartPolicy);
        expect(createCall.HostConfig.NetworkMode).toEqual(config.networkMode);
        expect(createCall.Image).toEqual(config.image);
        expect(createCall.name).toEqual(config.containerName);
      }),
      { numRuns: 50 }
    );
  });
});
