/**
 * Project Manager Unit Tests
 *
 * Tests for project CRUD, resource association, aggregate health status,
 * bulk operations, and per-project resource usage.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createProjectManager } from '../../src/modules/project-manager.js';
import type {
  ProjectManager,
  ProjectManagerDeps,
  ContainerStatus,
  ContainerMetricsInfo,
} from '../../src/modules/project-manager.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createTempDb(): { db: Database.Database; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-panel-pm-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);

  // Enable WAL mode
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create required tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, resource_type, resource_id)
    );
  `);

  return { db, dbPath };
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockDeps(overrides?: Partial<ProjectManagerDeps>): ProjectManagerDeps {
  return {
    getContainerStatus: vi.fn().mockResolvedValue({
      id: 'container-1',
      health: 'healthy',
      status: 'running',
    } satisfies ContainerStatus),
    getContainerMetrics: vi.fn().mockResolvedValue({
      id: 'container-1',
      cpuPercent: 10.5,
      memoryMB: 256,
    } satisfies ContainerMetricsInfo),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    composeUp: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Project Manager Module', () => {
  let db: Database.Database;
  let dbPath: string;
  let deps: ProjectManagerDeps;
  let pm: ProjectManager;

  beforeEach(() => {
    const result = createTempDb();
    db = result.db;
    dbPath = result.dbPath;
    deps = createMockDeps();
    pm = createProjectManager({ db, deps });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  // ─── CRUD Operations ─────────────────────────────────────────────────────

  describe('createProject', () => {
    it('should create a project with unique name', () => {
      const project = pm.createProject('My App');
      expect(project).toBeDefined();
      expect(project.id).toBeTruthy();
      expect(project.name).toBe('My App');
      expect(project.createdAt).toBeTruthy();
      expect(project.updatedAt).toBeTruthy();
    });

    it('should reject duplicate project names', () => {
      pm.createProject('My App');
      expect(() => pm.createProject('My App')).toThrow('already exists');
    });

    it('should reject empty names', () => {
      expect(() => pm.createProject('')).toThrow('cannot be empty');
      expect(() => pm.createProject('   ')).toThrow('cannot be empty');
    });

    it('should trim whitespace from names', () => {
      const project = pm.createProject('  Trimmed Name  ');
      expect(project.name).toBe('Trimmed Name');
    });
  });

  describe('updateProject', () => {
    it('should update project name', () => {
      const project = pm.createProject('Old Name');
      pm.updateProject(project.id, { name: 'New Name' });

      const updated = pm.getProject(project.id);
      expect(updated.name).toBe('New Name');
    });

    it('should reject update to existing name', () => {
      pm.createProject('Name A');
      const projectB = pm.createProject('Name B');

      expect(() => pm.updateProject(projectB.id, { name: 'Name A' })).toThrow('already exists');
    });

    it('should throw for non-existent project', () => {
      expect(() => pm.updateProject('non-existent-id', { name: 'X' })).toThrow('not found');
    });

    it('should allow updating to the same name', () => {
      const project = pm.createProject('Same Name');
      // Should not throw
      pm.updateProject(project.id, { name: 'Same Name' });
    });
  });

  describe('deleteProject', () => {
    it('should delete a project', () => {
      const project = pm.createProject('To Delete');
      pm.deleteProject(project.id);

      expect(() => pm.getProject(project.id)).toThrow('not found');
    });

    it('should cascade delete associated resources', () => {
      const project = pm.createProject('With Resources');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });

      pm.deleteProject(project.id);

      // Recreate project with same name should work
      const newProject = pm.createProject('With Resources');
      const detail = pm.getProject(newProject.id);
      expect(detail.resources).toHaveLength(0);
    });

    it('should throw for non-existent project', () => {
      expect(() => pm.deleteProject('non-existent')).toThrow('not found');
    });
  });

  describe('listProjects', () => {
    it('should return all projects with summary info', () => {
      pm.createProject('Project A');
      pm.createProject('Project B');

      const projects = pm.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBeDefined();
      expect(projects[0].containerCount).toBeDefined();
    });

    it('should return empty array when no projects exist', () => {
      const projects = pm.listProjects();
      expect(projects).toHaveLength(0);
    });

    it('should include container count', () => {
      const project = pm.createProject('With Containers');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });
      pm.associateResource(project.id, { resourceType: 'domain', resourceId: 'd1' });

      const projects = pm.listProjects();
      const summary = projects.find((p) => p.id === project.id);
      expect(summary?.containerCount).toBe(2);
    });
  });

  describe('getProject', () => {
    it('should return full project detail with resources', () => {
      const project = pm.createProject('Detailed');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'domain', resourceId: 'd1' });

      const detail = pm.getProject(project.id);
      expect(detail.id).toBe(project.id);
      expect(detail.name).toBe('Detailed');
      expect(detail.resources).toHaveLength(2);
      expect(detail.resources[0].resourceType).toBeDefined();
    });

    it('should throw for non-existent project', () => {
      expect(() => pm.getProject('non-existent')).toThrow('not found');
    });
  });

  // ─── Resource Association ────────────────────────────────────────────────

  describe('associateResource', () => {
    it('should associate containers, compose, domains, databases', () => {
      const project = pm.createProject('Multi-Resource');

      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'compose', resourceId: '/path/compose.yml' });
      pm.associateResource(project.id, { resourceType: 'domain', resourceId: 'example.com' });
      pm.associateResource(project.id, { resourceType: 'database', resourceId: 'db-1' });

      const detail = pm.getProject(project.id);
      expect(detail.resources).toHaveLength(4);
    });

    it('should reject duplicate associations', () => {
      const project = pm.createProject('Dup Resource');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });

      expect(() =>
        pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' })
      ).toThrow('already associated');
    });

    it('should reject invalid resource types', () => {
      const project = pm.createProject('Invalid Type');
      expect(() =>
        pm.associateResource(project.id, { resourceType: 'invalid' as any, resourceId: 'x' })
      ).toThrow('Invalid resource type');
    });

    it('should throw for non-existent project', () => {
      expect(() =>
        pm.associateResource('no-exist', { resourceType: 'container', resourceId: 'c1' })
      ).toThrow('not found');
    });
  });

  describe('disassociateResource', () => {
    it('should remove a resource association', () => {
      const project = pm.createProject('Disassociate');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      pm.disassociateResource(project.id, { resourceType: 'container', resourceId: 'c1' });

      const detail = pm.getProject(project.id);
      expect(detail.resources).toHaveLength(1);
      expect(detail.resources[0].resourceId).toBe('c2');
    });
  });

  // ─── Aggregate Health Status ─────────────────────────────────────────────

  describe('getAggregateHealth', () => {
    it('should return "empty" when no containers associated', async () => {
      const project = pm.createProject('Empty Project');
      const health = await pm.getAggregateHealth(project.id);
      expect(health).toBe('empty');
    });

    it('should return "all services up" when all containers are healthy and running', async () => {
      const project = pm.createProject('Healthy');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      deps.getContainerStatus = vi.fn().mockResolvedValue({
        id: 'c1',
        health: 'healthy',
        status: 'running',
      } satisfies ContainerStatus);

      const health = await pm.getAggregateHealth(project.id);
      expect(health).toBe('all services up');
    });

    it('should return "all services down" when all containers are unhealthy or stopped', async () => {
      const project = pm.createProject('Down');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      deps.getContainerStatus = vi.fn().mockResolvedValue({
        id: 'c1',
        health: 'unhealthy',
        status: 'stopped',
      } satisfies ContainerStatus);

      const health = await pm.getAggregateHealth(project.id);
      expect(health).toBe('all services down');
    });

    it('should return "partially degraded" when some containers are healthy and some are not', async () => {
      const project = pm.createProject('Partial');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      let callCount = 0;
      deps.getContainerStatus = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { id: 'c1', health: 'healthy', status: 'running' };
        }
        return { id: 'c2', health: 'unhealthy', status: 'stopped' };
      });

      const health = await pm.getAggregateHealth(project.id);
      expect(health).toBe('partially degraded');
    });

    it('should treat not-found containers as unhealthy', async () => {
      const project = pm.createProject('Missing');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });

      deps.getContainerStatus = vi.fn().mockResolvedValue(null);

      const health = await pm.getAggregateHealth(project.id);
      expect(health).toBe('all services down');
    });

    it('should throw for non-existent project', async () => {
      await expect(pm.getAggregateHealth('no-exist')).rejects.toThrow('not found');
    });
  });

  // ─── Aggregate Resources ─────────────────────────────────────────────────

  describe('getAggregateResources', () => {
    it('should compute total CPU and memory across project containers', async () => {
      const project = pm.createProject('Resources');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      let callCount = 0;
      deps.getContainerMetrics = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { id: 'c1', cpuPercent: 25.5, memoryMB: 512 };
        }
        return { id: 'c2', cpuPercent: 10.3, memoryMB: 256 };
      });

      const resources = await pm.getAggregateResources(project.id);
      expect(resources.totalCpuPercent).toBe(35.8);
      expect(resources.totalMemoryMB).toBe(768);
    });

    it('should return zero when no containers are associated', async () => {
      const project = pm.createProject('No Containers');
      const resources = await pm.getAggregateResources(project.id);
      expect(resources.totalCpuPercent).toBe(0);
      expect(resources.totalMemoryMB).toBe(0);
    });

    it('should skip containers with no metrics available', async () => {
      const project = pm.createProject('Partial Metrics');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      let callCount = 0;
      deps.getContainerMetrics = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { id: 'c1', cpuPercent: 20, memoryMB: 128 };
        }
        return null; // Container c2 metrics unavailable
      });

      const resources = await pm.getAggregateResources(project.id);
      expect(resources.totalCpuPercent).toBe(20);
      expect(resources.totalMemoryMB).toBe(128);
    });
  });

  // ─── Bulk Operations ─────────────────────────────────────────────────────

  describe('deployProject', () => {
    it('should start all containers and compose-up all compose files', async () => {
      const project = pm.createProject('Deploy');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });
      pm.associateResource(project.id, { resourceType: 'compose', resourceId: '/path/compose.yml' });

      const jobId = await pm.deployProject(project.id);
      expect(jobId).toBeTruthy();
      expect(deps.composeUp).toHaveBeenCalledWith('/path/compose.yml');
      expect(deps.startContainer).toHaveBeenCalledWith('c1');
      expect(deps.startContainer).toHaveBeenCalledWith('c2');
    });

    it('should use job submit callback when provided', async () => {
      const onJobSubmit = vi.fn().mockReturnValue('job-123');
      const pmWithJob = createProjectManager({ db, deps, onJobSubmit });

      const project = pmWithJob.createProject('Deploy Job');
      const jobId = await pmWithJob.deployProject(project.id);

      expect(jobId).toBe('job-123');
      expect(onJobSubmit).toHaveBeenCalledWith(project.id, 'deploy');
    });

    it('should throw on compose-up failure', async () => {
      const project = pm.createProject('Fail Deploy');
      pm.associateResource(project.id, { resourceType: 'compose', resourceId: '/bad.yml' });

      deps.composeUp = vi.fn().mockResolvedValue({ success: false, error: 'File not found' });

      await expect(pm.deployProject(project.id)).rejects.toThrow('Failed to deploy compose file');
    });
  });

  describe('stopProject', () => {
    it('should stop all associated containers', async () => {
      const project = pm.createProject('Stop');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      await pm.stopProject(project.id);
      expect(deps.stopContainer).toHaveBeenCalledWith('c1');
      expect(deps.stopContainer).toHaveBeenCalledWith('c2');
    });

    it('should continue stopping even if one container fails', async () => {
      const project = pm.createProject('Stop Resilient');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      let callCount = 0;
      deps.stopContainer = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Container busy');
      });

      // Should not throw
      await pm.stopProject(project.id);
      expect(deps.stopContainer).toHaveBeenCalledTimes(2);
    });
  });

  describe('restartProject', () => {
    it('should restart all associated containers', async () => {
      const project = pm.createProject('Restart');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      await pm.restartProject(project.id);
      expect(deps.restartContainer).toHaveBeenCalledWith('c1');
      expect(deps.restartContainer).toHaveBeenCalledWith('c2');
    });

    it('should continue restarting even if one container fails', async () => {
      const project = pm.createProject('Restart Resilient');
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c1' });
      pm.associateResource(project.id, { resourceType: 'container', resourceId: 'c2' });

      let callCount = 0;
      deps.restartContainer = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Container busy');
      });

      await pm.restartProject(project.id);
      expect(deps.restartContainer).toHaveBeenCalledTimes(2);
    });
  });
});
