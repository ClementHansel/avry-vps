"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFilesRouter = createFilesRouter;
/**
 * File Routes
 *
 * Endpoints for file system operations:
 * list directory, read file, write file.
 */
const express_1 = require("express");
function createFilesRouter(fileManager, auditLogger) {
    const router = (0, express_1.Router)();
    /**
     * GET /api/files/list?path=...
     * List directory contents.
     */
    router.get('/list', async (req, res) => {
        try {
            const dirPath = req.query.path ?? '/';
            const listing = await fileManager.listDirectory(dirPath);
            res.json(listing);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * GET /api/files/read?path=...
     * Read file content with syntax highlighting metadata.
     */
    router.get('/read', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) {
                res.status(400).json({ error: 'Path query parameter is required' });
                return;
            }
            const content = await fileManager.readFile(filePath);
            res.json(content);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    /**
     * PUT /api/files/write
     * Write content to a file.
     */
    router.put('/write', async (req, res) => {
        try {
            const { path: filePath, content } = req.body;
            if (!filePath || content === undefined) {
                res.status(400).json({ error: 'path and content are required' });
                return;
            }
            await fileManager.writeFile(filePath, content);
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'file.write',
                targetResource: `file:${filePath}`,
                details: { size: content.length },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'success',
            });
            res.json({ message: 'File saved successfully' });
        }
        catch (error) {
            await auditLogger.log({
                actor: req.session?.username ?? 'unknown',
                actionType: 'file.write',
                targetResource: `file:${req.body?.path ?? 'unknown'}`,
                details: { error: error.message },
                sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
                result: 'failure',
            });
            res.status(500).json({ error: error.message });
        }
    });
    return router;
}
//# sourceMappingURL=files.js.map