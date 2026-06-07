<script setup lang="ts">
import { onMounted, onUnmounted, computed } from 'vue';
import { useContainersStore } from '@/stores/containers';
import { useProjectsStore } from '@/stores/projects';
import { useJobsStore } from '@/stores/jobs';
import { useAlertsStore } from '@/stores/alerts';
import ResourceWidget from '@/components/ResourceWidget.vue';
import StatusBadge from '@/components/StatusBadge.vue';

const containersStore = useContainersStore();
const projectsStore = useProjectsStore();
const jobsStore = useJobsStore();
const alertsStore = useAlertsStore();

let refreshInterval: ReturnType<typeof setInterval> | null = null;

const concurrencyDisplay = computed(() => {
  const running = jobsStore.runningJobs.length;
  const queued = jobsStore.queuedJobs.length;
  return { running, queued, limit: 2 };
});

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(' ');
}

function refreshAll(): void {
  containersStore.fetchContainers();
  projectsStore.fetchProjects();
  jobsStore.fetchJobs();
  alertsStore.fetchAlerts();
}

onMounted(() => {
  refreshAll();
  refreshInterval = setInterval(refreshAll, 15000);
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="dashboard-view">
    <div class="dashboard-header">
      <h2>Dashboard</h2>
      <span class="auto-refresh-label">Auto-refreshing every 15s</span>
    </div>

    <!-- Summary cards -->
    <div class="summary-grid">
      <section class="card">
        <h3>Containers</h3>
        <p class="stat">{{ containersStore.runningContainers.length }} running</p>
        <p class="muted">{{ containersStore.containers.length }} total</p>
      </section>
      <section class="card">
        <h3>Projects</h3>
        <p class="stat">{{ projectsStore.projects.length }}</p>
      </section>
      <section class="card">
        <h3>Alerts</h3>
        <p class="stat">{{ alertsStore.unreadCount }} unread</p>
      </section>
      <section class="card">
        <h3>Concurrency</h3>
        <p class="stat">
          Builds: {{ concurrencyDisplay.running }}/{{ concurrencyDisplay.limit }}
        </p>
        <p class="muted" v-if="concurrencyDisplay.queued > 0">
          {{ concurrencyDisplay.queued }} queued
        </p>
      </section>
    </div>

    <!-- Service list -->
    <section class="service-section">
      <h3 class="section-title">Services</h3>

      <p v-if="containersStore.isLoading && containersStore.containers.length === 0" class="muted">
        Loading services...
      </p>

      <p v-else-if="containersStore.containers.length === 0" class="empty-state">
        No containers running. Deploy a service to get started.
      </p>

      <div v-else class="service-table">
        <div class="table-header">
          <span class="col-name">Name</span>
          <span class="col-port">Port</span>
          <span class="col-health">Health</span>
          <span class="col-uptime">Uptime</span>
        </div>
        <div
          v-for="container in containersStore.containers"
          :key="container.id"
          class="table-row"
        >
          <span class="col-name">{{ container.name }}</span>
          <span class="col-port">{{ container.port || '—' }}</span>
          <span class="col-health">
            <StatusBadge :status="container.health" />
          </span>
          <span class="col-uptime">{{ formatUptime(container.uptime) }}</span>
        </div>
      </div>
    </section>

    <!-- Projects aggregate view -->
    <section v-if="projectsStore.projects.length > 0" class="projects-section">
      <h3 class="section-title">Projects</h3>
      <div class="projects-grid">
        <div
          v-for="project in projectsStore.projects"
          :key="project.id"
          class="project-card"
        >
          <div class="project-header">
            <span class="project-name">{{ project.name }}</span>
            <span :class="['project-health', project.healthStatus.replace(/ /g, '-')]">
              {{ project.healthStatus }}
            </span>
          </div>
          <p class="project-stat">{{ project.containerCount }} containers</p>
        </div>
      </div>
    </section>

    <!-- Resource Widget -->
    <section class="resource-section">
      <ResourceWidget />
    </section>
  </div>
</template>

<style scoped>
.dashboard-view h2 {
  margin-bottom: 0;
}

.dashboard-header {
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

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.card {
  background: var(--color-surface);
  padding: 1.25rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-border);
}

.card h3 {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin-bottom: 0.5rem;
}

.stat {
  font-size: 1.5rem;
  font-weight: 600;
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

/* Service table */
.service-section {
  margin-bottom: 2rem;
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

.service-table {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

.table-header,
.table-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  padding: 0.75rem 1rem;
  align-items: center;
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
  font-size: 0.875rem;
}

.table-row:hover {
  background: var(--color-surface-hover);
}

.col-port,
.col-uptime {
  color: var(--color-text-muted);
}

/* Projects aggregate */
.projects-section {
  margin-bottom: 2rem;
}

.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.75rem;
}

.project-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1rem;
}

.project-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.375rem;
}

.project-name {
  font-weight: 500;
  font-size: 0.875rem;
}

.project-health {
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  text-transform: capitalize;
}

.project-health.all-services-up {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.project-health.partially-degraded {
  background: rgba(245, 158, 11, 0.15);
  color: var(--color-warning);
}

.project-health.all-services-down {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.project-health.empty {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
}

.project-stat {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

/* Resource section */
.resource-section {
  max-width: 480px;
}
</style>
