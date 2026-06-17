/**
 * Socket.IO Job Progress Event Handlers
 *
 * Handles job output stream subscriptions:
 * - job:subscribe — Subscribe to real-time job output (logs, status changes)
 * - job:unsubscribe — Stop receiving job output
 *
 * Uses Socket.IO rooms (`job:{jobId}`) for scoped job output broadcasting.
 * The Job Queue module emits events to these rooms during execution.
 *
 * Requirements: 20.3
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { JobQueue } from '../modules/job-queue.js';
/**
 * Register job progress Socket.IO event handlers for a connected socket.
 */
export declare function registerJobsHandlers(io: SocketIOServer, socket: Socket, jobQueue: JobQueue): void;
//# sourceMappingURL=jobs.d.ts.map