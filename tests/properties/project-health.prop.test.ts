/**
 * Property-based tests for Project Aggregate Health Status.
 *
 * Feature: vps-panel, Property 13: Project aggregate health status
 * Tests that aggregate health returns correct status for all combinations
 * of container states.
 *
 * Rules:
 * - No containers associated → "empty"
 * - ALL containers are healthy + running → "all services up"
 * - ALL containers are NOT (healthy + running) → "all services down"
 * - SOME healthy+running AND some not → "partially degraded"
 *
 * **Validates: Requirements 18.3, 18.7**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createProjectManager,
  type ProjectManager,
  type ProjectManagerDeps,
  type ContainerStatus,
  type ContainerMetricsInfo,
  type ProjectHealthStatus,
} from '../../src/modules/project-manager.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

type ContainerHealth = 'healthy' | 'unhealthy' | 'unknown';
type ContainerState = 'running' | 'stopped' | 'exited' | 'restarting';

interface SimulatedContainer {
  id: string;
  health: ContainerHealth;
  status: ContainerState;
}

/**
 * Model function that computes expected aggregate health
 * based on the specification logic:
 * - No containers → "empty"
 * - All healthy+running → "all services up"
 * - None healthy+running → "all services down"
 * - Mixed → "partially degraded"
 */
function expectedAggregateHealth(containers: SimulatedContainer[]): ProjectHealthStatus {
  if (containers.length === 0) {
    return 'empty';
  }

  const healthyRunningCount = containers.filter(
    (c) => c.health === 'healthy' && c.status === 'running'
  ).length;

  if (healthyRunningCount === containers.length) {
    return 'all services up';
  } else if (healthyRunningCount === 0) {
    return 'all services down';
  } else {
    return 'partially degraded';
  }
}

/**
 * Creates an in-memory SQLite database with the required schema for project manager.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, resource_type, resource_id)
    );
  `);

  return db;
}

/**
 * Creates mock dependencies that return container statuses from the provided map.
 */
function createMockDeps(
  containerStatuses: Map<string, ContainerStatus>
): ProjectManagerDeps {
  return {
    getContainerStatus: async (containerId: string) => {
      return containerStatuses.get(containerId) ?? null;
    },
    getContainerMetrics: async (_containerId: string) => {
      return { id: _containerId, cpuPercent: 0, memoryMB: 0 } as ContainerMetricsInfo;
    },
    startContainer: async () => {},
    stopContainer: async () => {},
    restartContainer: async () => {},
    composeUp: async () => ({ success: true }),
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const containerHealthArb: fc.Arbitrary<ContainerHealth> = fc.constantFrom(
  'healthy',
  'unhealthy',
  'unknown'
);

const containerStateArb: fc.Arbitrary<ContainerState> = fc.constantFrom(
  'running',
  'stopped',
  'exited',
  'restarting'
);

const containerIdArb = fc.hexaString({ minLength: 12, maxLength: 12 });

const simulatedContainerArb: fc.Arbitrary<SimulatedContainer> = fc.record({
  id: containerIdArb,
  health: containerHealthArb,
  status: containerStateArb,
});

/**
 * Generates a list of simulated containers with unique IDs.
 */
const containerListArb = fc
  .array(simulatedContainerArb, { minLength: 0, maxLength: 10 })
  .map((containers) => {
    // Ensure unique IDs
    const seen = new Set<string>();
    return containers.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  });

/**
 * Generates a non-empty list of containers all healthy+running.
 */
const allHealthyContainersArb = fc
  .array(containerIdArb, { minLength: 1, maxLength: 10 })
  .map((ids) => {
    const unique = [...new Set(ids)];
    return unique.length > 0
      ? unique.map((id) => ({ id, health: 'healthy' as ContainerHealth, status: 'running' as ContainerState }))
      : [{ id: 'fallback0001', health: 'healthy' as ContainerHealth, status: 'running' as ContainerState }];
  });

/**
 * Generates a non-empty list of containers all NOT healthy+running.
 */
const allUnhealthyContainersArb = fc
  .array(
    fc.record({
      id: containerIdArb,
      health: containerHealthArb,
      status: containerStateArb,
    }),
    { minLength: 1, maxLength: 10 }
  )
  .map((containers) => {
    const unique = [...new Map(containers.map((c) => [c.id, c])).values()];
    // Filter out any that are healthy+running, and if all were, flip one
    const nonHealthy = unique.map((c) => {
      if (c.health === 'healthy' && c.status === 'running') {
        // Make it not-healthy-running
        return { ...c, health: 'unhealthy' as ContainerHealth };
      }
      return c;
    });
    return nonHealthy.length > 0
      ? nonHealthy
      : [{ id: 'fallback0001', health: 'unhealthy' as ContainerHealth, status: 'stopped' as ContainerState }];
  });

/**
 * Generates a mixed list: at least one healthy+running and at least one not.
 */
const mixedContainersArb = fc
  .tuple(
    fc.array(containerIdArb, { minLength: 1, maxLength: 5 }),
    fc.array(
      fc.record({ id: containerIdArb, health: containerHealthArb, status: containerStateArb }),
      { minLength: 1, maxLength: 5 }
    )
  )
  .map(([healthyIds, unhealthyContainers]) => {
    const healthy: SimulatedContainer[] = [...new Set(healthyIds)].map((id) => ({
      id,
      health: 'healthy' as ContainerHealth,
      status: 'running' as ContainerState,
    }));

    const unhealthy: SimulatedContainer[] = [...new Map(unhealthyContainers.map((c) => [c.id, c])).values()]
      .map((c) => {
        if (c.health === 'healthy' && c.status === 'running') {
          return { ...c, health: 'unhealthy' as ContainerHealth };
        }
        return c;
      });

    // Combine and deduplicate by ID (unhealthy takes priority to maintain mix)
    const allIds = new Set<string>();
    const result: SimulatedContainer[] = [];

    // Add at least one healthy
    for (const c of healthy) {
      if (!allIds.has(c.id)) {
        allIds.add(c.id);
        result.push(c);
        break; // ensure at least one
      }
    }

    // Add at least one unhealthy
    for (const c of unhealthy) {
      if (!allIds.has(c.id)) {
        allIds.add(c.id);
        result.push(c);
        break; // ensure at least one
      }
    }

    // Add remaining healthy
    for (const c of healthy) {
      if (!allIds.has(c.id)) {
        allIds.add(c.id);
        result.push(c);
      }
    }

    // Add remaining unhealthy
    for (const c of unhealthy) {
      if (!allIds.has(c.id)) {
        allIds.add(c.id);
        result.push(c);
      }
    }

    return result;
  })
  .filter((containers) => {
    const healthyCount = containers.filter(
      (c) => c.health === 'healthy' && c.status === 'running'
    ).length;
    return healthyCount > 0 && healthyCount < containers.length;
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Project Aggregate Health Property Tests', () => {

  it('Property 13.1: No containers associated returns "empty" status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        async (projectName) => {
          const localDb = createTestDb();
          const containerStatuses = new Map<string, ContainerStatus>();
          const deps = createMockDeps(containerStatuses);
          const pm = createProjectManager({ db: localDb, deps });

          const project = pm.createProject(projectName);
          // No containers associated

          const health = await pm.getAggregateHealth(project.id);
          expect(health).toBe('empty');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 13.2: All containers healthy+running returns "all services up"', async () => {
    await fc.assert(
      fc.asyncProperty(allHealthyContainersArb, async (containers) => {
        const localDb = createTestDb();
        const containerStatuses = new Map<string, ContainerStatus>();

        for (const c of containers) {
          containerStatuses.set(c.id, { id: c.id, health: c.health, status: c.status });
        }

        const deps = createMockDeps(containerStatuses);
        const pm = createProjectManager({ db: localDb, deps });

        const project = pm.createProject('test-project');

        for (const c of containers) {
          pm.associateResource(project.id, {
            resourceType: 'container',
            resourceId: c.id,
          });
        }

        const health = await pm.getAggregateHealth(project.id);
        expect(health).toBe('all services up');
      }),
      { numRuns: 100 }
    );
  });

  it('Property 13.3: All containers NOT healthy+running returns "all services down"', async () => {
    await fc.assert(
      fc.asyncProperty(allUnhealthyContainersArb, async (containers) => {
        const localDb = createTestDb();
        const containerStatuses = new Map<string, ContainerStatus>();

        for (const c of containers) {
          containerStatuses.set(c.id, { id: c.id, health: c.health, status: c.status });
        }

        const deps = createMockDeps(containerStatuses);
        const pm = createProjectManager({ db: localDb, deps });

        const project = pm.createProject('test-project');

        for (const c of containers) {
          pm.associateResource(project.id, {
            resourceType: 'container',
            resourceId: c.id,
          });
        }

        const health = await pm.getAggregateHealth(project.id);
        expect(health).toBe('all services down');
      }),
      { numRuns: 100 }
    );
  });

  it('Property 13.4: Mixed healthy and unhealthy containers returns "partially degraded"', async () => {
    await fc.assert(
      fc.asyncProperty(mixedContainersArb, async (containers) => {
        const localDb = createTestDb();
        const containerStatuses = new Map<string, ContainerStatus>();

        for (const c of containers) {
          containerStatuses.set(c.id, { id: c.id, health: c.health, status: c.status });
        }

        const deps = createMockDeps(containerStatuses);
        const pm = createProjectManager({ db: localDb, deps });

        const project = pm.createProject('test-project');

        for (const c of containers) {
          pm.associateResource(project.id, {
            resourceType: 'container',
            resourceId: c.id,
          });
        }

        const health = await pm.getAggregateHealth(project.id);
        expect(health).toBe('partially degraded');
      }),
      { numRuns: 100 }
    );
  });

  it('Property 13.5: Aggregate health is consistent with model for any combination of container states', async () => {
    await fc.assert(
      fc.asyncProperty(containerListArb, async (containers) => {
        const localDb = createTestDb();
        const containerStatuses = new Map<string, ContainerStatus>();

        for (const c of containers) {
          containerStatuses.set(c.id, { id: c.id, health: c.health, status: c.status });
        }

        const deps = createMockDeps(containerStatuses);
        const pm = createProjectManager({ db: localDb, deps });

        const project = pm.createProject('test-project');

        for (const c of containers) {
          pm.associateResource(project.id, {
            resourceType: 'container',
            resourceId: c.id,
          });
        }

        const health = await pm.getAggregateHealth(project.id);
        const expected = expectedAggregateHealth(containers);

        expect(health).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });

  it('Property 13.6: Container not found by deps is treated as unhealthy/stopped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(containerIdArb, { minLength: 1, maxLength: 5 }).map((ids) => [...new Set(ids)]).filter((ids) => ids.length > 0),
        async (containerIds) => {
          const localDb = createTestDb();
          // Empty map — getContainerStatus returns null for all
          const containerStatuses = new Map<string, ContainerStatus>();
          const deps = createMockDeps(containerStatuses);
          const pm = createProjectManager({ db: localDb, deps });

          const project = pm.createProject('test-project');

          for (const id of containerIds) {
            pm.associateResource(project.id, {
              resourceType: 'container',
              resourceId: id,
            });
          }

          const health = await pm.getAggregateHealth(project.id);
          // All containers not found → treated as unhealthy → "all services down"
          expect(health).toBe('all services down');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 13.7: Only container resources affect health; other resource types are ignored', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('compose', 'domain', 'database') as fc.Arbitrary<'compose' | 'domain' | 'database'>,
        fc.hexaString({ minLength: 6, maxLength: 12 }),
        async (resourceType, resourceId) => {
          const localDb = createTestDb();
          const containerStatuses = new Map<string, ContainerStatus>();
          const deps = createMockDeps(containerStatuses);
          const pm = createProjectManager({ db: localDb, deps });

          const project = pm.createProject('test-project');

          // Associate only non-container resources
          pm.associateResource(project.id, {
            resourceType,
            resourceId,
          });

          const health = await pm.getAggregateHealth(project.id);
          // No container resources → "empty"
          expect(health).toBe('empty');
        }
      ),
      { numRuns: 50 }
    );
  });
});
