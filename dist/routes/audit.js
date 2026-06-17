"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditRouter = createAuditRouter;
/**
 * Audit Routes
 *
 * Endpoints for audit log access:
 * query, search, export.
 */
const express_1 = require("express");
function createAuditRouter(auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/audit
     * Query audit log with filters.
     * Query params: startDate, endDate, actor, actionType, targetResource, projectId, result, page
     */
    router.get('/', async (req, res) => {
        try {
            const filter = {};
            if (req.query.startDate) {
                filter.startDate = new Date(req.query.startDate);
            }
            if (req.query.endDate) {
                filter.endDate = new Date(req.query.endDate);
            }
            if (req.query.actor) {
                filter.actor = req.query.actor;
            }
            if (req.query.actionType) {
                filter.actionType = req.query.actionType;
            }
            if (req.query.targetResource) {
                filter.targetResource = req.query.targetResource;
            }
            if (req.query.projectId) {
                filter.projectId = req.query.projectId;
            }
            if (req.query.result) {
                filter.result = req.query.result;
            }
            if (req.query.page) {
                filter.page = parseInt(req.query.page, 10);
            }
            const result = await auditLogger.query(filter);
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/audit/search?term=...
     * Full-text search audit logs.
     */
    router.get('/search', async (req, res) => {
        try {
            const term = req.query.term;
            if (!term) {
                res.status(400).json({ error: 'Search term is required' });
                return;
            }
            const filter = {};
            if (req.query.page) {
                filter.page = parseInt(req.query.page, 10);
            }
            if (req.query.startDate) {
                filter.startDate = new Date(req.query.startDate);
            }
            if (req.query.endDate) {
                filter.endDate = new Date(req.query.endDate);
            }
            const result = await auditLogger.search(term, filter);
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    /**
     * GET /api/audit/export?format=json|csv
     * Export audit logs in specified format.
     */
    router.get('/export', async (req, res) => {
        try {
            const format = req.query.format ?? 'json';
            if (format !== 'json' && format !== 'csv') {
                res.status(400).json({ error: 'Format must be "json" or "csv"' });
                return;
            }
            const filter = {};
            if (req.query.startDate) {
                filter.startDate = new Date(req.query.startDate);
            }
            if (req.query.endDate) {
                filter.endDate = new Date(req.query.endDate);
            }
            if (req.query.actor) {
                filter.actor = req.query.actor;
            }
            if (req.query.actionType) {
                filter.actionType = req.query.actionType;
            }
            const data = await auditLogger.export(filter, format);
            const contentType = format === 'json' ? 'application/json' : 'text/csv';
            const extension = format === 'json' ? 'json' : 'csv';
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename="audit-log.${extension}"`);
            res.send(data);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=audit.js.map