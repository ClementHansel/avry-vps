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

// ─── Event Payload Types ───────────────────────────────────────────────────────

interface JobSubscribePayload {
  jobId: string;
}

interface JobUnsubscribePayload {
  jobId: string;
}

// ─── Handler Registration ──────────────────────────────────────────────────────

/**
 * Register job progress Socket.IO event handlers for a connected socket.
 */
export function registerJobsHandlers(
  io: SocketIOServer,
  socket: Socket,
  jobQueue: JobQueue
): void {
  // Track which jobs this socket is subscribed to for cleanup
  const subscribedJobs = new Set<string>();

  // ─── job:subscribe ───────────────────────────────────────────────────────

  socket.on('job:subscribe', async (payload: JobSubscribePayload) => {
    if (!payload?.jobId) {
      socket.emit('job:error', { message: 'Invalid job:subscribe payload: jobId required' });
      return;
    }

    const { jobId } = payload;

    // Verify the job exists
    const job = await jobQueue.getStatus(jobId);
    if (!job) {
      socket.emit('job:error', { message: `Job not found: ${jobId}` });
      return;
    }

    // Join the job room to receive output and status events
    socket.join(`job:${jobId}`);
    subscribedJobs.add(jobId);

    // Send current job status to the subscriber
    socket.emit('job:status', {
      jobId,
      status: job.status,
      type: job.type,
      projectId: job.projectId,
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      exitCode: job.exitCode,
      duration: job.duration,
    });

    socket.emit('job:subscribed', { jobId });
  });

  // ─── job:unsubscribe ─────────────────────────────────────────────────────

  socket.on('job:unsubscribe', (payload: JobUnsubscribePayload) => {
    if (!payload?.jobId) {
      socket.emit('job:error', { message: 'Invalid job:unsubscribe payload: jobId required' });
      return;
    }

    const { jobId } = payload;

    socket.leave(`job:${jobId}`);
    subscribedJobs.delete(jobId);

    socket.emit('job:unsubscribed', { jobId });
  });

  // ─── Cleanup on disconnect ───────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Socket rooms are automatically cleaned up on disconnect by Socket.IO
    subscribedJobs.clear();
  });
}
