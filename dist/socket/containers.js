"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerContainersHandlers = registerContainersHandlers;
exports.broadcastContainerStatus = broadcastContainerStatus;
// ─── Constants ─────────────────────────────────────────────────────────────────
const CONTAINERS_ALL_ROOM = 'containers:all';
// ─── Handler Registration ──────────────────────────────────────────────────────
/**
 * Register container status Socket.IO event handlers for a connected socket.
 */
function registerContainersHandlers(io, socket, containerManager) {
    // Track subscriptions for this socket
    const subscribedContainers = new Set();
    // ─── container:subscribe ─────────────────────────────────────────────────
    socket.on('container:subscribe', async (payload) => {
        if (!payload?.containerId) {
            socket.emit('container:error', { message: 'Invalid container:subscribe payload: containerId required' });
            return;
        }
        const { containerId } = payload;
        const room = `container:${containerId}`;
        socket.join(room);
        subscribedContainers.add(containerId);
        // Send current health status immediately
        try {
            const health = await containerManager.getHealthStatus(containerId);
            socket.emit('container:status', { containerId, health });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to get container status';
            socket.emit('container:error', { containerId, message });
        }
        socket.emit('container:subscribed', { containerId });
    });
    // ─── container:unsubscribe ───────────────────────────────────────────────
    socket.on('container:unsubscribe', (payload) => {
        if (!payload?.containerId) {
            socket.emit('container:error', { message: 'Invalid container:unsubscribe payload: containerId required' });
            return;
        }
        const { containerId } = payload;
        socket.leave(`container:${containerId}`);
        subscribedContainers.delete(containerId);
        socket.emit('container:unsubscribed', { containerId });
    });
    // ─── container:subscribe-all ─────────────────────────────────────────────
    socket.on('container:subscribe-all', async () => {
        socket.join(CONTAINERS_ALL_ROOM);
        // Send current list with health statuses
        try {
            const containers = await containerManager.listContainers();
            socket.emit('container:list', {
                containers: containers.map((c) => ({
                    id: c.id,
                    name: c.name,
                    status: c.status,
                    health: c.health,
                    image: c.image,
                    port: c.port,
                    uptime: c.uptime,
                })),
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to list containers';
            socket.emit('container:error', { message });
        }
        socket.emit('container:subscribed-all', {});
    });
    // ─── container:unsubscribe-all ───────────────────────────────────────────
    socket.on('container:unsubscribe-all', () => {
        socket.leave(CONTAINERS_ALL_ROOM);
        socket.emit('container:unsubscribed-all', {});
    });
    // ─── Cleanup on disconnect ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        subscribedContainers.clear();
    });
}
// ─── Utility: Broadcast container status changes ───────────────────────────────
/**
 * Broadcast a container status change to all subscribers.
 * Call this from the ContainerManager health polling callback.
 *
 * @param io - Socket.IO server instance
 * @param containerId - The container that changed status
 * @param health - The new health status
 * @param status - The container running status
 */
function broadcastContainerStatus(io, containerId, health, status) {
    const payload = { containerId, health, status };
    // Emit to per-container subscribers
    io.to(`container:${containerId}`).emit('container:status', payload);
    // Emit to all-containers subscribers
    io.to(CONTAINERS_ALL_ROOM).emit('container:status', payload);
}
//# sourceMappingURL=containers.js.map