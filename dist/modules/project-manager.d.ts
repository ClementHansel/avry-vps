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
export type ResourceType = 'container' | 'compose' | 'domain' | 'database';
export type ProjectHealthStatus = 'all services up' | 'partially degraded' | 'all services down' | 'empty';
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
    composeUp: (filePath: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
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
export declare function createProjectManager(config: ProjectManagerConfig): ProjectManager;
//# sourceMappingURL=project-manager.d.ts.map