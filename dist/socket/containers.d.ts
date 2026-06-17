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
/**
 * Register container status Socket.IO event handlers for a connected socket.
 */
export declare function registerContainersHandlers(io: SocketIOServer, socket: Socket, containerManager: ContainerManager): void;
/**
 * Broadcast a container status change to all subscribers.
 * Call this from the ContainerManager health polling callback.
 *
 * @param io - Socket.IO server instance
 * @param containerId - The container that changed status
 * @param health - The new health status
 * @param status - The container running status
 */
export declare function broadcastContainerStatus(io: SocketIOServer, containerId: string, health: string, status?: string): void;
//# sourceMappingURL=containers.d.ts.map