<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useJobsStore } from '@/stores/jobs';
import { useProjectsStore } from '@/stores/projects';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';

const jobsStore = useJobsStore();
const projectsStore = useProjectsStore();
const authStore = useAuthStore();

const statusFilter = ref<string>('all');
const selectedJobId = ref<string | null>(null);
const logOutput = ref<string[]>([]);
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let socket: Socket | null = null;

const filteredJobs = computed(() => {
  if (statusFilter.value === 'all') return jobsStore.jobs;
  return jobsStore.jobs.filter((j) => j.status === statusFilter.value);
});

const selectedJob = computed(() => {
  if (!selectedJobId.value) return null;
  return jobsStore.jobs.find((j) => j.id === selectedJobId.value) ?? null;
});

function shortId(id: string): string {
  return id.substring(0, 8);
}

function getProjectName(projectId?: string): string {
  if (!projectId) return '—';
  const project = projectsStore.projects.find((p) => p.id === projectId);
  return project?.name ?? projectId.substring(0, 8);
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function formatDuration(duration?: number): string {
  if (duration == null) return '—';
  if (duration < 60) return `${duration}s`;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  return `${mins}m ${secs}s`;
}

function getQueuePosition(jobId: string): number | null {
  const queuedJobs = jobsStore.queuedJobs;
  const index = queuedJobs.findIndex((j) => j.id === jobId);
  return index >= 0 ? index + 1 : null;
}

function canCancel(status: string): boolean {
  return status === 'queued' || status === 'running';
}

async function handleCancel(jobId: string): Promise<void> {
  await jobsStore.cancelJob(jobId);
}

function selectJob(jobId: string): void {
  const job = jobsStore.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'running') return;

  // Unsubscribe from previous
  if (selectedJobId.value && socket) {
    socket.emit('job:unsubscribe', { jobId: selectedJobId.value });
  }

  selectedJobId.value = jobId;
  logOutput.value = [];

  // Subscribe to new job logs
  if (socket) {
    socket.emit('job:subscribe', { jobId });
  }
}

function closeLogPanel(): void {
  if (selectedJobId.value && socket) {
    socket.emit('job:unsubscribe', { jobId: selectedJobId.value });
  }
  selectedJobId.value = null;
  logOutput.value = [];
}

function getConcurrencyLabel(type: string, running: number, limit: number): string {
  const typeName = type.charAt(0).toUpperCase() + type.slice(1);
  return `${typeName}: ${running}/${limit}`;
}

onMounted(() => {
  jobsStore.fetchJobs();
  jobsStore.fetchConcurrency();
  projectsStore.fetchProjects();

  refreshInterval = setInterval(() => {
    jobsStore.fetchJobs();
    jobsStore.fetchConcurrency();
  }, 5000);

  // Setup Socket.IO for real-time log streaming
  socket = io({ auth: { token: authStore.token } });
  socket.on('job:log', (data: { jobId: string; line: string }) => {
    if (data.jobId === selectedJobId.value) {
      logOutput.value.push(data.line);
      // Keep max 1000 lines in memory
      if (logOutput.value.length > 1000) {
        logOutput.value = logOutput.value.slice(-500);
      }
    }
  });
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
});
</script>

<template>
  <div class="jobs-view">
    <div class="view-header">
      <h2>Job Queue</h2>
      <span class="auto-refresh-label">Auto-refreshing every 5s</span>
    </div>

    <!-- Concurrency utilization -->
    <div v-if="jobsStore.concurrency.length > 0" class="concurrency-bar">
      <span
        v-for="info in jobsStore.concurrency"
        :key="info.type"
        class="concurrency-chip"
        :class="{ full: info.running >= info.limit }"
      >
        {{ getConcurrencyLabel(info.type, info.running, info.limit) }}
      </span>
    </div>

    <!-- Status filter -->
    <div class="filter-bar">
      <label for="status-filter" class="filter-label">Status:</label>
      <select id="status-filter" v-model="statusFilter" class="filter-select">
        <option value="all">All</option>
        <option value="queued">Queued</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>

    <p v-if="jobsStore.isLoading && jobsStore.jobs.length === 0" class="muted">
      Loading jobs...
    </p>

    <p v-else-if="filteredJobs.length === 0" class="empty-state">
      No jobs{{ statusFilter !== 'all' ? ` with status "${statusFilter}"` : '' }}.
    </p>

    <div v-else class="jobs-table">
      <div class="table-header">
        <span class="col-id">ID</span>
        <span class="col-type">Type</span>
        <span class="col-project">Project</span>
        <span class="col-status">Status</span>
        <span class="col-submitted">Submitted</span>
        <span class="col-started">Started</span>
        <span class="col-completed">Completed</span>
        <span class="col-duration">Duration</span>
        <span class="col-actions">Actions</span>
      </div>
      <div
        v-for="job in filteredJobs"
        :key="job.id"
        class="table-row"
        :class="{ selected: job.id === selectedJobId, clickable: job.status === 'running' }"
        @click="selectJob(job.id)"
      >
        <span class="col-id" :title="job.id">{{ shortId(job.id) }}</span>
        <span class="col-type">{{ job.type }}</span>
        <span class="col-project">{{ getProjectName(job.projectId) }}</span>
        <span class="col-status">
          <span :class="['status-badge', job.status]">{{ job.status }}</span>
          <span v-if="job.status === 'queued'" class="queue-position">
            #{{ getQueuePosition(job.id) }}
          </span>
        </span>
        <span class="col-submitted">{{ formatTimestamp(job.submittedAt) }}</span>
        <span class="col-started">{{ formatTimestamp(job.startedAt) }}</span>
        <span class="col-completed">{{ formatTimestamp(job.completedAt) }}</span>
        <span class="col-duration">{{ formatDuration(job.duration) }}</span>
        <span class="col-actions">
          <button
            v-if="canCancel(job.status)"
            class="btn-cancel"
            @click.stop="handleCancel(job.id)"
          >
            Cancel
          </button>
          <span v-else class="no-action">—</span>
        </span>
      </div>
    </div>

    <!-- Real-time log output panel -->
    <div v-if="selectedJob" class="log-panel">
      <div class="log-panel-header">
        <span class="log-panel-title">
          Live Output — Job {{ shortId(selectedJob.id) }} ({{ selectedJob.type }})
        </span>
        <button class="btn-close" @click="closeLogPanel">✕</button>
      </div>
      <div class="log-panel-body">
        <pre v-if="logOutput.length > 0"><code>{{ logOutput.join('\n') }}</code></pre>
        <p v-else class="muted">Waiting for output...</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.jobs-view h2 {
  margin-bottom: 0;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.auto-refresh-label {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  background: var(--color-surface);
  padding: 0.25rem 0.625rem;
  border-radius: 9999px;
  border: 1px solid var(--color-border);
}

.concurrency-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.concurrency-chip {
  display: inline-block;
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  border-radius: 9999px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--color-primary);
  border: 1px solid rgba(99, 102, 241, 0.25);
  font-weight: 500;
}

.concurrency-chip.full {
  background: rgba(245, 158, 11, 0.1);
  color: var(--color-warning);
  border-color: rgba(245, 158, 11, 0.3);
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.filter-label {
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.filter-select {
  padding: 0.375rem 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text);
  font-size: 0.875rem;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  background: var(--color-surface);
  padding: 2rem;
  border-radius: 0.5rem;
  border: 1px dashed var(--color-border);
  text-align: center;
}

.jobs-table {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow-x: auto;
}

.table-header,
.table-row {
  display: grid;
  grid-template-columns: 80px 100px 120px 120px 150px 150px 150px 80px 80px;
  padding: 0.75rem 1rem;
  align-items: center;
  min-width: max-content;
}

.table-header {
  background: var(--color-surface-hover);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}

.table-row {
  border-top: 1px solid var(--color-border);
  font-size: 0.8125rem;
}

.table-row:hover {
  background: var(--color-surface-hover);
}

.table-row.clickable {
  cursor: pointer;
}

.table-row.selected {
  background: rgba(99, 102, 241, 0.05);
  border-left: 3px solid var(--color-primary);
}

.col-id {
  font-family: monospace;
  font-size: 0.75rem;
}

.col-type {
  text-transform: capitalize;
}

.col-submitted,
.col-started,
.col-completed {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.col-duration {
  font-size: 0.8125rem;
  font-family: monospace;
}

.status-badge {
  display: inline-block;
  font-size: 0.6875rem;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-weight: 600;
}

.status-badge.queued {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
}

.status-badge.running {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.status-badge.completed {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.status-badge.failed {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.status-badge.cancelled {
  background: rgba(245, 158, 11, 0.15);
  color: var(--color-warning);
}

.queue-position {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  margin-left: 0.375rem;
}

.btn-cancel {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  background: transparent;
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
  border-radius: 0.25rem;
  cursor: pointer;
}

.btn-cancel:hover {
  background: rgba(239, 68, 68, 0.1);
}

.no-action {
  color: var(--color-text-muted);
}

/* Log panel */
.log-panel {
  margin-top: 1.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

.log-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: var(--color-surface-hover);
  border-bottom: 1px solid var(--color-border);
}

.log-panel-title {
  font-size: 0.8125rem;
  font-weight: 600;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 1rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
}

.btn-close:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.log-panel-body {
  padding: 1rem;
  max-height: 300px;
  overflow-y: auto;
  background: var(--color-bg);
}

.log-panel-body pre {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: monospace;
  color: var(--color-text);
}
</style>
