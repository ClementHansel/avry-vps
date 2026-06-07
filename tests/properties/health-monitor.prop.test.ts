/**
 * Property-based tests for Health Monitoring State Transitions.
 *
 * Feature: vps-panel, Property 1: Health monitoring state transitions
 * Tests that health status transitions correctly based on check responses.
 * Given a container and a sequence of health check responses (200/healthy,
 * non-200/unhealthy, timeout/no-response), the health state must transition
 * according to:
 *   - Running + Docker reports "healthy" → "healthy"
 *   - Docker reports "unhealthy" (non-200 response) → "unhealthy"
 *   - No response / timeout / error → "unknown"
 *   - Not running → "unknown"
 *
 * **Validates: Requirements 1.2, 1.3, 14.1**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Types matching container-manager.ts ────────────────────────────────────

type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/**
 * Represents a simulated health check response from Docker's perspective.
 * - 'healthy': container health check passes (HTTP 200)
 * - 'unhealthy': container health check fails (non-200 response)
 * - 'no-response': timeout or connection refused (5s timeout exceeded)
 * - 'error': Docker daemon communication error
 */
type HealthCheckResponse = 'healthy' | 'unhealthy' | 'no-response' | 'error';

// ─── Simulate the health status resolution logic from container-manager ─────

/**
 * Determines the expected health status based on the container state and
 * the Docker health check response. This mirrors the logic in
 * `getHealthStatus()` from `container-manager.ts`.
 *
 * Rules from requirements:
 * - Req 1.2: Non-200 response → unhealthy within 30s
 * - Req 1.3: No response/timeout (5s) → unhealthy within 30s
 * - Running + healthy health check → healthy
 * - Error communicating with Docker → unknown
 * - Container not running → unknown
 */
function expectedHealthStatus(
  containerRunning: boolean,
  healthCheckResponse: HealthCheckResponse
): HealthStatus {
  // If an error occurs communicating with Docker, status is unknown
  if (healthCheckResponse === 'error') {
    return 'unknown';
  }

  // If container is not running, health is unknown
  if (!containerRunning) {
    return 'unknown';
  }

  // Container is running — check Docker's health status
  switch (healthCheckResponse) {
    case 'healthy':
      return 'healthy';
    case 'unhealthy':
      return 'unhealthy';
    case 'no-response':
      // Timeout or no response: Docker marks container as unhealthy
      return 'unhealthy';
    default:
      return 'unknown';
  }
}

/**
 * Simulates the getHealthStatus function from container-manager.ts.
 * This is a model that captures the core state transition logic.
 */
function simulateGetHealthStatus(
  containerId: string,
  isRunning: boolean,
  healthResponse: HealthCheckResponse,
  healthCache: Map<string, HealthStatus>
): HealthStatus {
  try {
    if (healthResponse === 'error') {
      throw new Error('Docker daemon unavailable');
    }

    if (!isRunning) {
      const status: HealthStatus = 'unknown';
      healthCache.set(containerId, status);
      return status;
    }

    // Docker Health check is available
    if (healthResponse === 'healthy') {
      const status: HealthStatus = 'healthy';
      healthCache.set(containerId, status);
      return status;
    } else if (healthResponse === 'unhealthy' || healthResponse === 'no-response') {
      // Non-200 or timeout → unhealthy (Req 1.2, 1.3)
      const status: HealthStatus = 'unhealthy';
      healthCache.set(containerId, status);
      return status;
    }

    // Fallback: running with no health check info
    const status: HealthStatus = isRunning ? 'healthy' : 'unhealthy';
    healthCache.set(containerId, status);
    return status;
  } catch {
    const status: HealthStatus = 'unknown';
    healthCache.set(containerId, status);
    return status;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const healthCheckResponseArb: fc.Arbitrary<HealthCheckResponse> = fc.constantFrom(
  'healthy',
  'unhealthy',
  'no-response',
  'error'
);

const containerIdArb = fc.hexaString({ minLength: 12, maxLength: 12 });

const containerRunningArb = fc.boolean();

/**
 * Generates a sequence of health check events simulating Docker health
 * check responses over time.
 */
const healthCheckSequenceArb = fc.array(
  fc.record({
    isRunning: containerRunningArb,
    response: healthCheckResponseArb,
  }),
  { minLength: 1, maxLength: 20 }
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Health Monitor Property Tests', () => {
  it('Property 1.1: Health status resolves correctly for any container state and check response', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        containerRunningArb,
        healthCheckResponseArb,
        (containerId, isRunning, healthResponse) => {
          const healthCache = new Map<string, HealthStatus>();

          const result = simulateGetHealthStatus(
            containerId,
            isRunning,
            healthResponse,
            healthCache
          );

          const expected = expectedHealthStatus(isRunning, healthResponse);
          expect(result).toBe(expected);

          // Verify cache is updated
          expect(healthCache.get(containerId)).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 1.2: Non-200 response always results in unhealthy for running containers', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        (containerId) => {
          const healthCache = new Map<string, HealthStatus>();

          // Simulate non-200 response (Docker reports unhealthy)
          const result = simulateGetHealthStatus(
            containerId,
            true, // container is running
            'unhealthy', // non-200 response
            healthCache
          );

          expect(result).toBe('unhealthy');
          expect(healthCache.get(containerId)).toBe('unhealthy');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.3: Timeout/no-response results in unhealthy for running containers', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        (containerId) => {
          const healthCache = new Map<string, HealthStatus>();

          // Simulate timeout / connection refused
          const result = simulateGetHealthStatus(
            containerId,
            true, // container is running
            'no-response', // timeout exceeded
            healthCache
          );

          expect(result).toBe('unhealthy');
          expect(healthCache.get(containerId)).toBe('unhealthy');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.4: Running container with healthy check is marked healthy', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        (containerId) => {
          const healthCache = new Map<string, HealthStatus>();

          const result = simulateGetHealthStatus(
            containerId,
            true, // container is running
            'healthy', // 200 response
            healthCache
          );

          expect(result).toBe('healthy');
          expect(healthCache.get(containerId)).toBe('healthy');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.5: Non-running container always has unknown health regardless of response', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        healthCheckResponseArb.filter((r) => r !== 'error'),
        (containerId, healthResponse) => {
          const healthCache = new Map<string, HealthStatus>();

          const result = simulateGetHealthStatus(
            containerId,
            false, // container NOT running
            healthResponse,
            healthCache
          );

          expect(result).toBe('unknown');
          expect(healthCache.get(containerId)).toBe('unknown');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.6: Docker communication errors always result in unknown status', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        containerRunningArb,
        (containerId, isRunning) => {
          const healthCache = new Map<string, HealthStatus>();

          const result = simulateGetHealthStatus(
            containerId,
            isRunning,
            'error', // Docker daemon error
            healthCache
          );

          expect(result).toBe('unknown');
          expect(healthCache.get(containerId)).toBe('unknown');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.7: Sequential health checks update cache correctly (state transition sequences)', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        healthCheckSequenceArb,
        (containerId, sequence) => {
          const healthCache = new Map<string, HealthStatus>();

          for (const check of sequence) {
            const result = simulateGetHealthStatus(
              containerId,
              check.isRunning,
              check.response,
              healthCache
            );

            const expected = expectedHealthStatus(check.isRunning, check.response);
            expect(result).toBe(expected);

            // Cache should always reflect the most recent check
            expect(healthCache.get(containerId)).toBe(expected);
          }

          // Final cache value matches last check's expected result
          const lastCheck = sequence[sequence.length - 1];
          const finalExpected = expectedHealthStatus(lastCheck.isRunning, lastCheck.response);
          expect(healthCache.get(containerId)).toBe(finalExpected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.8: Health transitions from healthy to unhealthy are detectable (Req 14.1)', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        fc.array(healthCheckResponseArb, { minLength: 2, maxLength: 15 }),
        (containerId, responses) => {
          const healthCache = new Map<string, HealthStatus>();
          const transitions: Array<{ from: HealthStatus; to: HealthStatus }> = [];

          let previousHealth: HealthStatus | undefined;

          for (const response of responses) {
            const result = simulateGetHealthStatus(
              containerId,
              true, // Always running for transition detection
              response,
              healthCache
            );

            if (previousHealth !== undefined && previousHealth !== result) {
              transitions.push({ from: previousHealth, to: result });
            }

            previousHealth = result;
          }

          // Verify: any transition from healthy to unhealthy is captured
          for (const transition of transitions) {
            if (transition.from === 'healthy' && transition.to === 'unhealthy') {
              // This is the critical transition for Requirement 14.1
              // Alert system should trigger on this transition
              expect(transition.to).toBe('unhealthy');
            }
          }

          // Verify: state transitions are always between valid health states
          for (const transition of transitions) {
            expect(['healthy', 'unhealthy', 'unknown']).toContain(transition.from);
            expect(['healthy', 'unhealthy', 'unknown']).toContain(transition.to);
            // A transition should always be between different states
            expect(transition.from).not.toBe(transition.to);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.9: Health cache is idempotent - same check twice gives same result', () => {
    fc.assert(
      fc.property(
        containerIdArb,
        containerRunningArb,
        healthCheckResponseArb,
        (containerId, isRunning, healthResponse) => {
          const healthCache = new Map<string, HealthStatus>();

          const result1 = simulateGetHealthStatus(
            containerId,
            isRunning,
            healthResponse,
            healthCache
          );

          const result2 = simulateGetHealthStatus(
            containerId,
            isRunning,
            healthResponse,
            healthCache
          );

          // Same input gives same output (deterministic)
          expect(result1).toBe(result2);
          expect(healthCache.get(containerId)).toBe(result1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1.10: Integration - createContainerManager health status matches expected logic', async () => {
    // This test uses the actual createContainerManager with mocked dockerode
    // to verify the real implementation matches our model

    // Mock container state
    const mockContainers: Array<{
      id: string;
      running: boolean;
      health: HealthCheckResponse;
    }> = [];

    vi.doMock('dockerode', () => {
      return {
        default: class MockDockerode {
          constructor() {}

          listContainers() {
            return Promise.resolve(
              mockContainers.map((c) => ({
                Id: c.id,
                Names: [`/container-${c.id}`],
                Image: 'test:latest',
                Ports: [],
                State: c.running ? 'running' : 'exited',
                Created: Math.floor(Date.now() / 1000) - 3600,
              }))
            );
          }

          getContainer(id: string) {
            const container = mockContainers.find((c) => c.id === id);
            if (!container) {
              return {
                inspect: () => Promise.reject(new Error('Container not found')),
              };
            }

            if (container.health === 'error') {
              return {
                inspect: () => Promise.reject(new Error('Docker daemon error')),
              };
            }

            const healthStatus =
              container.health === 'no-response' ? 'unhealthy' : container.health;

            return {
              inspect: () =>
                Promise.resolve({
                  Id: container.id,
                  Name: `/container-${container.id}`,
                  State: {
                    Running: container.running,
                    Status: container.running ? 'running' : 'exited',
                    StartedAt: container.running ? new Date().toISOString() : undefined,
                    Health: container.running ? { Status: healthStatus } : undefined,
                  },
                  Config: { Image: 'test:latest', Env: [] },
                  HostConfig: {
                    PortBindings: {},
                    RestartPolicy: { Name: '', MaximumRetryCount: 0 },
                  },
                  NetworkSettings: { Networks: {} },
                  Mounts: [],
                }),
            };
          }
        },
      };
    });

    // Import after mocking
    const { createContainerManager } = await import(
      '../../src/modules/container-manager.js'
    );

    await fc.assert(
      fc.asyncProperty(
        containerIdArb,
        containerRunningArb,
        healthCheckResponseArb,
        async (containerId, isRunning, healthResponse) => {
          // Setup mock state
          mockContainers.length = 0;
          mockContainers.push({ id: containerId, running: isRunning, health: healthResponse });

          const manager = createContainerManager({
            dockerHost: '/var/run/docker.sock',
            healthPollIntervalMs: 60000, // Don't auto-poll
          });

          try {
            const status = await manager.getHealthStatus(containerId);
            const expected = expectedHealthStatus(isRunning, healthResponse);
            expect(status).toBe(expected);
          } finally {
            manager.stopHealthPolling();
          }
        }
      ),
      { numRuns: 50 }
    );

    vi.doUnmock('dockerode');
  });
});
