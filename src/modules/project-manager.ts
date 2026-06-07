/**
 * Project Manager Module
 *
 * Provides multi-project management: CRUD operations, resource association,
 * aggregate health status computation, bulk operations (deploy, stop, restart),
 * and per-project resource usage aggregation.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8
 */
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export type ResourceType = 'container' | 'compose' | 'domain' | 'database';

export type ProjectHealthStatus =
  | 'all services up'
  | 'partially degraded'
  | 'all services down'
  | 'empty';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRef {
  resourceType: ResourceType;
  resourceId: string;
}

export interface ProjectResource {
  id: string;
  projectId: string;
  resourceType: ResourceType;
  resourceId: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  health: ProjectHealthStatus;
  containerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends Project {
  resources: ProjectResource[];
  health: ProjectHealthStatus;
}

export interface ProjectResources {
  totalCpuPercent: number;
  totalMemoryMB: number;
}

export interface ContainerStatus {
  id: string;
  health: 'healthy' | 'unhealthy' | 'unknown';
  status: 'running' | 'stopped' | 'exited' | 'restarting';
}

export interface ContainerMetricsInfo {
  id: string;
  cpuPercent: number;
  memoryMB: number;
}

/**
 * Dependencies injected into the Project Manager for container interactions.
 */
export interface ProjectManagerDeps {
  /** Get the health/status of a container by ID */
  getContainerStatus: (containerId: string) => Promise<ContainerStatus | null>;
  /** Get resource metrics (CPU, memory) for a container */
  getContainerMetrics: (containerId: string) => Promise<ContainerMetricsInfo | null>;
  /** Start a container by ID */
  startContainer: (containerId: string) => Promise<void>;
  /** Stop a container by ID */
  stopContainer: (containerId: string) => Promise<void>;
  /** Restart a container by ID */
  restartContainer: (containerId: string) => Promise<void>;
  /** Run compose-up for a compose file */
  composeUp: (filePath: string) => Promise<{ success: boolean; error?: string }>;
}

export interface ProjectManager {
  createProject(name: string): Project;
  updateProject(id: string, updates: Partial<Pick<Project, 'name'>>): void;
  deleteProject(id: string): void;
  listProjects(): ProjectSummary[];
  getProject(id: string): ProjectDetail;
  associateResource(projectId: string, resource: ResourceRef): void;
  disassociateResource(projectId: string, resource: ResourceRef): void;
  deployProject(id: string): Promise<string>;
  stopProject(id: string): Promise<void>;
  restartProject(id: string): Promise<void>;
  getAggregateHealth(id: string): Promise<ProjectHealthStatus>;
  getAggregateResources(id: string): Promise<ProjectResources>;
}

export interface ProjectManagerConfig {
  /** The SQLite database instance */
  db: Database.Database;
  /** Dependencies for container/compose operations */
  deps: ProjectManagerDeps;
  /** Callback when a job is submitted (for bulk deploy). Returns a job ID. */
  onJobSubmit?: (projectId: string, operation: string) => string;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createProjectManager(config: ProjectManagerConfig): ProjectManager {
  const { db, deps, onJobSubmit } = config;

  // ─── Prepared Statements ─────────────────────────────────────────────────

  const insertProjectStmt = db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
  );

  const updateProjectStmt = db.prepare(
    `UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`
  );

  const deleteProjectStmt = db.prepare(
    `DELETE FROM projects WHERE id = ?`
  );

  const getProjectByIdStmt = db.prepare(
    `SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects WHERE id = ?`
  );

  const getProjectByNameStmt = db.prepare(
    `SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects WHERE name = ?`
  );

  const listProjectsStmt = db.prepare(
    `SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects ORDER BY created_at DESC`
  );

  const insertResourceStmt = db.prepare(
    `INSERT INTO project_resources (id, project_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)`
  );

  const deleteResourceStmt = db.prepare(
    `DELETE FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ?`
  );

  const getResourcesByProjectStmt = db.prepare(
    `SELECT id, project_id as projectId, resource_type as resourceType, resource_id as resourceId, created_at as createdAt FROM project_resources WHERE project_id = ?`
  );

  const getContainerResourcesStmt = db.prepare(
    `SELECT resource_id as resourceId FROM project_resources WHERE project_id = ? AND resource_type = 'container'`
  );

  const getComposeResourcesStmt = db.prepare(
    `SELECT resource_id as resourceId FROM project_resources WHERE project_id = ? AND resource_type = 'compose'`
  );

  const countContainersStmt = db.prepare(
    `SELECT COUNT(*) as count FROM project_resources WHERE project_id = ? AND resource_type = 'container'`
  );

  const checkDuplicateResourceStmt = db.prepare(
    `SELECT id FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ?`
  );

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function nowISO(): string {
    return new Date().toISOString();
  }

  function getProjectOrThrow(id: string): Project {
    const project = getProjectByIdStmt.get(id) as Project | undefined;
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    return project;
  }

  function getContainerIds(projectId: string): string[] {
    const rows = getContainerResourcesStmt.all(projectId) as { resourceId: string }[];
    return rows.map((r) => r.resourceId);
  }

  function getComposeFilePaths(projectId: string): string[] {
    const rows = getComposeResourcesStmt.all(projectId) as { resourceId: string }[];
    return rows.map((r) => r.resourceId);
  }

  // ─── CRUD Operations ─────────────────────────────────────────────────────

  function createProject(name: string): Project {
    if (!name || name.trim().length === 0) {
      throw new Error('Project name cannot be empty');
    }

    const trimmedName = name.trim();

    // Check unique name
    const existing = getProjectByNameStmt.get(trimmedName) as Project | undefined;
    if (existing) {
      throw new Error(`Project with name "${trimmedName}" already exists`);
    }

    const id = uuidv4();
    const now = nowISO();

    insertProjectStmt.run(id, trimmedName, now, now);

    return {
      id,
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
    };
  }

  function updateProject(id: string, updates: Partial<Pick<Project, 'name'>>): void {
    getProjectOrThrow(id);

    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (trimmedName.length === 0) {
        throw new Error('Project name cannot be empty');
      }

      // Check unique name (excluding current project)
      const existing = getProjectByNameStmt.get(trimmedName) as Project | undefined;
      if (existing && existing.id !== id) {
        throw new Error(`Project with name "${trimmedName}" already exists`);
      }

      const now = nowISO();
      updateProjectStmt.run(trimmedName, now, id);
    }
  }

  function deleteProject(id: string): void {
    getProjectOrThrow(id);
    // ON DELETE CASCADE handles project_resources cleanup
    deleteProjectStmt.run(id);
  }

  function listProjects(): ProjectSummary[] {
    const projects = listProjectsStmt.all() as Project[];

    return projects.map((project) => {
      const containerCount = (countContainersStmt.get(project.id) as { count: number }).count;

      return {
        id: project.id,
        name: project.name,
        health: 'empty' as ProjectHealthStatus, // Synchronous listing returns 'empty' placeholder
        containerCount,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    });
  }

  function getProject(id: string): ProjectDetail {
    const project = getProjectOrThrow(id);
    const resources = getResourcesByProjectStmt.all(id) as ProjectResource[];

    return {
      ...project,
      resources,
      health: 'empty' as ProjectHealthStatus, // Synchronous; use getAggregateHealth for real status
    };
  }

  // ─── Resource Association ────────────────────────────────────────────────

  function associateResource(projectId: string, resource: ResourceRef): void {
    getProjectOrThrow(projectId);

    if (!resource.resourceType || !resource.resourceId) {
      throw new Error('Resource type and resource ID are required');
    }

    const validTypes: ResourceType[] = ['container', 'compose', 'domain', 'database'];
    if (!validTypes.includes(resource.resourceType)) {
      throw new Error(`Invalid resource type: ${resource.resourceType}. Must be one of: ${validTypes.join(', ')}`);
    }

    // Check for duplicate association
    const existing = checkDuplicateResourceStmt.get(projectId, resource.resourceType, resource.resourceId);
    if (existing) {
      throw new Error(`Resource ${resource.resourceType}:${resource.resourceId} is already associated with this project`);
    }

    const id = uuidv4();
    const now = nowISO();
    insertResourceStmt.run(id, projectId, resource.resourceType, resource.resourceId, now);
  }

  function disassociateResource(projectId: string, resource: ResourceRef): void {
    getProjectOrThrow(projectId);
    deleteResourceStmt.run(projectId, resource.resourceType, resource.resourceId);
  }

  // ─── Aggregate Health Status ─────────────────────────────────────────────

  async function getAggregateHealth(id: string): Promise<ProjectHealthStatus> {
    getProjectOrThrow(id);
    const containerIds = getContainerIds(id);

    // Requirement 18.8: If no containers associated, return "empty"
    if (containerIds.length === 0) {
      return 'empty';
    }

    let healthyCount = 0;
    let unhealthyOrStoppedCount = 0;

    for (const containerId of containerIds) {
      const status = await deps.getContainerStatus(containerId);
      if (!status) {
        // Container not found - treat as unhealthy/stopped
        unhealthyOrStoppedCount++;
        continue;
      }

      if (status.health === 'healthy' && status.status === 'running') {
        healthyCount++;
      } else {
        unhealthyOrStoppedCount++;
      }
    }

    // Requirement 18.3:
    // "all services up" - all associated containers are healthy
    // "partially degraded" - at least one but not all are unhealthy or stopped
    // "all services down" - all associated containers are unhealthy or stopped
    if (unhealthyOrStoppedCount === 0) {
      return 'all services up';
    } else if (healthyCount === 0) {
      return 'all services down';
    } else {
      return 'partially degraded';
    }
  }

  // ─── Aggregate Resources ─────────────────────────────────────────────────

  async function getAggregateResources(id: string): Promise<ProjectResources> {
    getProjectOrThrow(id);
    const containerIds = getContainerIds(id);

    let totalCpuPercent = 0;
    let totalMemoryMB = 0;

    for (const containerId of containerIds) {
      const metrics = await deps.getContainerMetrics(containerId);
      if (metrics) {
        totalCpuPercent += metrics.cpuPercent;
        totalMemoryMB += metrics.memoryMB;
      }
    }

    return {
      totalCpuPercent: Math.round(totalCpuPercent * 100) / 100,
      totalMemoryMB: Math.round(totalMemoryMB * 100) / 100,
    };
  }

  // ─── Bulk Operations ─────────────────────────────────────────────────────

  async function deployProject(id: string): Promise<string> {
    getProjectOrThrow(id);

    // If a job submit callback is provided, submit the deploy as a job
    if (onJobSubmit) {
      return onJobSubmit(id, 'deploy');
    }

    // Otherwise perform inline deploy:
    // 1. Compose-up all associated compose files
    const composeFiles = getComposeFilePaths(id);
    for (const filePath of composeFiles) {
      const result = await deps.composeUp(filePath);
      if (!result.success) {
        throw new Error(`Failed to deploy compose file ${filePath}: ${result.error}`);
      }
    }

    // 2. Start all standalone containers
    const containerIds = getContainerIds(id);
    for (const containerId of containerIds) {
      try {
        await deps.startContainer(containerId);
      } catch {
        // Container might already be running - continue with others
      }
    }

    return `deploy-${id}-${Date.now()}`;
  }

  async function stopProject(id: string): Promise<void> {
    getProjectOrThrow(id);
    const containerIds = getContainerIds(id);

    for (const containerId of containerIds) {
      try {
        await deps.stopContainer(containerId);
      } catch {
        // Continue stopping other containers even if one fails
      }
    }
  }

  async function restartProject(id: string): Promise<void> {
    getProjectOrThrow(id);
    const containerIds = getContainerIds(id);

    for (const containerId of containerIds) {
      try {
        await deps.restartContainer(containerId);
      } catch {
        // Continue restarting other containers even if one fails
      }
    }
  }

  // ─── Return the public API ──────────────────────────────────────────────

  return {
    createProject,
    updateProject,
    deleteProject,
    listProjects,
    getProject,
    associateResource,
    disassociateResource,
    deployProject,
    stopProject,
    restartProject,
    getAggregateHealth,
    getAggregateResources,
  };
}
