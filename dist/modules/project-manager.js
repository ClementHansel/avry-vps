"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProjectManager = createProjectManager;
const uuid_1 = require("uuid");
// ─── Implementation ────────────────────────────────────────────────────────────
function createProjectManager(config) {
    const { db, deps, onJobSubmit } = config;
    // ─── Prepared Statements ─────────────────────────────────────────────────
    const insertProjectStmt = db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`);
    const updateProjectStmt = db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`);
    const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`);
    const getProjectByIdStmt = db.prepare(`SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects WHERE id = ?`);
    const getProjectByNameStmt = db.prepare(`SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects WHERE name = ?`);
    const listProjectsStmt = db.prepare(`SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM projects ORDER BY created_at DESC`);
    const insertResourceStmt = db.prepare(`INSERT INTO project_resources (id, project_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)`);
    const deleteResourceStmt = db.prepare(`DELETE FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ?`);
    const getResourcesByProjectStmt = db.prepare(`SELECT id, project_id as projectId, resource_type as resourceType, resource_id as resourceId, created_at as createdAt FROM project_resources WHERE project_id = ?`);
    const getContainerResourcesStmt = db.prepare(`SELECT resource_id as resourceId FROM project_resources WHERE project_id = ? AND resource_type = 'container'`);
    const getComposeResourcesStmt = db.prepare(`SELECT resource_id as resourceId FROM project_resources WHERE project_id = ? AND resource_type = 'compose'`);
    const countContainersStmt = db.prepare(`SELECT COUNT(*) as count FROM project_resources WHERE project_id = ? AND resource_type = 'container'`);
    const checkDuplicateResourceStmt = db.prepare(`SELECT id FROM project_resources WHERE project_id = ? AND resource_type = ? AND resource_id = ?`);
    // ─── Helpers ─────────────────────────────────────────────────────────────
    function nowISO() {
        return new Date().toISOString();
    }
    function getProjectOrThrow(id) {
        const project = getProjectByIdStmt.get(id);
        if (!project) {
            throw new Error(`Project not found: ${id}`);
        }
        return project;
    }
    function getContainerIds(projectId) {
        const rows = getContainerResourcesStmt.all(projectId);
        return rows.map((r) => r.resourceId);
    }
    function getComposeFilePaths(projectId) {
        const rows = getComposeResourcesStmt.all(projectId);
        return rows.map((r) => r.resourceId);
    }
    // ─── CRUD Operations ─────────────────────────────────────────────────────
    function createProject(name) {
        if (!name || name.trim().length === 0) {
            throw new Error('Project name cannot be empty');
        }
        const trimmedName = name.trim();
        // Check unique name
        const existing = getProjectByNameStmt.get(trimmedName);
        if (existing) {
            throw new Error(`Project with name "${trimmedName}" already exists`);
        }
        const id = (0, uuid_1.v4)();
        const now = nowISO();
        insertProjectStmt.run(id, trimmedName, now, now);
        return {
            id,
            name: trimmedName,
            createdAt: now,
            updatedAt: now,
        };
    }
    function updateProject(id, updates) {
        getProjectOrThrow(id);
        if (updates.name !== undefined) {
            const trimmedName = updates.name.trim();
            if (trimmedName.length === 0) {
                throw new Error('Project name cannot be empty');
            }
            // Check unique name (excluding current project)
            const existing = getProjectByNameStmt.get(trimmedName);
            if (existing && existing.id !== id) {
                throw new Error(`Project with name "${trimmedName}" already exists`);
            }
            const now = nowISO();
            updateProjectStmt.run(trimmedName, now, id);
        }
    }
    function deleteProject(id) {
        getProjectOrThrow(id);
        // ON DELETE CASCADE handles project_resources cleanup
        deleteProjectStmt.run(id);
    }
    function listProjects() {
        const projects = listProjectsStmt.all();
        return projects.map((project) => {
            const containerCount = countContainersStmt.get(project.id).count;
            return {
                id: project.id,
                name: project.name,
                health: 'empty', // Synchronous listing returns 'empty' placeholder
                containerCount,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
            };
        });
    }
    function getProject(id) {
        const project = getProjectOrThrow(id);
        const resources = getResourcesByProjectStmt.all(id);
        return {
            ...project,
            resources,
            health: 'empty', // Synchronous; use getAggregateHealth for real status
        };
    }
    // ─── Resource Association ────────────────────────────────────────────────
    function associateResource(projectId, resource) {
        getProjectOrThrow(projectId);
        if (!resource.resourceType || !resource.resourceId) {
            throw new Error('Resource type and resource ID are required');
        }
        const validTypes = ['container', 'compose', 'domain', 'database'];
        if (!validTypes.includes(resource.resourceType)) {
            throw new Error(`Invalid resource type: ${resource.resourceType}. Must be one of: ${validTypes.join(', ')}`);
        }
        // Check for duplicate association
        const existing = checkDuplicateResourceStmt.get(projectId, resource.resourceType, resource.resourceId);
        if (existing) {
            throw new Error(`Resource ${resource.resourceType}:${resource.resourceId} is already associated with this project`);
        }
        const id = (0, uuid_1.v4)();
        const now = nowISO();
        insertResourceStmt.run(id, projectId, resource.resourceType, resource.resourceId, now);
    }
    function disassociateResource(projectId, resource) {
        getProjectOrThrow(projectId);
        deleteResourceStmt.run(projectId, resource.resourceType, resource.resourceId);
    }
    // ─── Aggregate Health Status ─────────────────────────────────────────────
    async function getAggregateHealth(id) {
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
            }
            else {
                unhealthyOrStoppedCount++;
            }
        }
        // Requirement 18.3:
        // "all services up" - all associated containers are healthy
        // "partially degraded" - at least one but not all are unhealthy or stopped
        // "all services down" - all associated containers are unhealthy or stopped
        if (unhealthyOrStoppedCount === 0) {
            return 'all services up';
        }
        else if (healthyCount === 0) {
            return 'all services down';
        }
        else {
            return 'partially degraded';
        }
    }
    // ─── Aggregate Resources ─────────────────────────────────────────────────
    async function getAggregateResources(id) {
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
    async function deployProject(id) {
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
            }
            catch {
                // Container might already be running - continue with others
            }
        }
        return `deploy-${id}-${Date.now()}`;
    }
    async function stopProject(id) {
        getProjectOrThrow(id);
        const containerIds = getContainerIds(id);
        for (const containerId of containerIds) {
            try {
                await deps.stopContainer(containerId);
            }
            catch {
                // Continue stopping other containers even if one fails
            }
        }
    }
    async function restartProject(id) {
        getProjectOrThrow(id);
        const containerIds = getContainerIds(id);
        for (const containerId of containerIds) {
            try {
                await deps.restartContainer(containerId);
            }
            catch {
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
//# sourceMappingURL=project-manager.js.map