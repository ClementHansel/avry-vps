"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProjectsRouter = createProjectsRouter;
/**
 * Project Routes
 *
 * Endpoints for multi-project management:
 * CRUD, associate resources, deploy, stop, restart, health.
 */
const express_1 = require("express");
function createProjectsRouter(projectManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/projects
     * List all projects with summary info.
     */
    router.get('/', async (req, res) => {
        try {
            const projects = projectManager.listProjects();
            res.json(projects);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/projects/:id
     * Get detailed project info including resources.
     */
    router.get('/:id', async (req, res) => {
        try {
            const project = projectManager.getProject(req.params.id);
            res.json(project);
        }
        catch (error) {
            res.status(404).json({ error: error.message });
        }
    });
    /**
     * POST /api/projects
     * Create a new project.
     */
    router.post('/', async (req, res) => {
        try {
            const { name } = req.body;
            if (!name) {
                res.status(400).json({ error: 'Project name is required' });
                return;
            }
            const project = projectManager.createProject(name);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.create',
                targetResource: `project:${project.id}`,
                details: { name },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.status(201).json(project);
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.create',
                targetResource: 'project',
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * PUT /api/projects/:id
     * Update a project.
     */
    router.put('/:id', async (req, res) => {
        try {
            projectManager.updateProject(req.params.id, req.body);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.update',
                targetResource: `project:${req.params.id}`,
                details: req.body,
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Project updated' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.update',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * DELETE /api/projects/:id
     * Delete a project.
     */
    router.delete('/:id', async (req, res) => {
        try {
            projectManager.deleteProject(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.delete',
                targetResource: `project:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'Project deleted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.delete',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/projects/:id/resources
     * Associate a resource with a project.
     */
    router.post('/:id/resources', async (req, res) => {
        try {
            const { resourceType, resourceId } = req.body;
            if (!resourceType || !resourceId) {
                res.status(400).json({ error: 'resourceType and resourceId are required' });
                return;
            }
            projectManager.associateResource(req.params.id, { resourceType, resourceId });
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.associate-resource',
                targetResource: `project:${req.params.id}`,
                details: { resourceType, resourceId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'success',
            });
            res.json({ message: 'Resource associated' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.associate-resource',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'failure',
            });
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * POST /api/projects/:id/deploy
     * Deploy all containers/compose files in the project.
     */
    router.post('/:id/deploy', async (req, res) => {
        try {
            const jobId = await projectManager.deployProject(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.deploy',
                targetResource: `project:${req.params.id}`,
                details: { jobId },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'success',
            });
            res.json({ jobId, message: 'Deploy initiated' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.deploy',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/projects/:id/stop
     * Stop all containers in the project.
     */
    router.post('/:id/stop', async (req, res) => {
        try {
            await projectManager.stopProject(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.stop',
                targetResource: `project:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'success',
            });
            res.json({ message: 'Project stopped' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.stop',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * POST /api/projects/:id/restart
     * Restart all containers in the project.
     */
    router.post('/:id/restart', async (req, res) => {
        try {
            await projectManager.restartProject(req.params.id);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.restart',
                targetResource: `project:${req.params.id}`,
                details: {},
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'success',
            });
            res.json({ message: 'Project restarted' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'project.restart',
                targetResource: `project:${req.params.id}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                projectId: req.params.id,
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/projects/:id/health
     * Get aggregate health status for the project.
     */
    router.get('/:id/health', async (req, res) => {
        try {
            const health = await projectManager.getAggregateHealth(req.params.id);
            res.json({ health });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=projects.js.map