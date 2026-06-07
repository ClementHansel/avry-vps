/**
 * Socket.IO Container Status Event Handlers
 *
 * Handles live container health status updates:
 * - container:subscribe — Subscribe to live status updates for a container
 * - container:unsubscribe — Stop receiving updates for a container
 * - container:subscribe-all — Subscribe to all container status changes
 * - container:unsubscribe-all — Stop receiving all container status changes
 *
 * Uses Socket.IO rooms (`container:{containerId}`) for per-container scoping.
 * Health status updates are pushed when the ContainerManager detects changes.
 *
 * Requirements: 1.6
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ContainerManager } from '../modules/container-manager.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const CONTAINERS_ALL_ROOM = 'containers:all';

// ─── Event Payload Types ───────────────────────────────────────────────────────

interface ContainerSubscribePayload {
  containerId: string;
}

interface ContainerUnsubscribePayload {
  containerId: string;
}

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register container status Socket.IO event handlers for a connected socket.
 */
export function registerContainersHandlers(
  io: SocketIOServer,
  socket: Socket,
  containerManager: ContainerManager
): void {
  // Track subscriptions for this socket
  const subscribedContainers = new Set<string>();

  // ─── container:subscribe ─────────────────────────────────────────────────

  socket.on('container:subscribe', async (payload: ContainerSubscribePayload) => {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get container status';
      socket.emit('container:error', { containerId, message });
    }

    socket.emit('container:subscribed', { containerId });
  });

  // ─── container:unsubscribe ───────────────────────────────────────────────

  socket.on('container:unsubscribe', (payload: ContainerUnsubscribePayload) => {
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
    } catch (err) {
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
export function broadcastContainerStatus(
  io: SocketIOServer,
  containerId: string,
  health: string,
  status?: string
): void {
  const payload = { containerId, health, status };

  // Emit to per-container subscribers
  io.to(`container:${containerId}`).emit('container:status', payload);

  // Emit to all-containers subscribers
  io.to(CONTAINERS_ALL_ROOM).emit('container:status', payload);
}
