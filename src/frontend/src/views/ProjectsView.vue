<script setup lang="ts">
import { onMounted } from 'vue';
import { useProjectsStore } from '@/stores/projects';

const projectsStore = useProjectsStore();

onMounted(() => {
  projectsStore.fetchProjects();
});
</script>

<template>
  <div class="projects-view">
    <h2>Projects</h2>
    <p v-if="projectsStore.isLoading">Loading projects...</p>
    <p v-else-if="projectsStore.projects.length === 0" class="empty">
      No projects configured.
    </p>
    <div v-else class="project-list">
      <div
        v-for="project in projectsStore.projects"
        :key="project.id"
        class="project-card"
      >
        <span class="name">{{ project.name }}</span>
        <span :class="['health', project.healthStatus]">{{ project.healthStatus }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.projects-view h2 {
  margin-bottom: 1.5rem;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.project-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
}

.name {
  font-weight: 500;
}

.health {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
}

.empty {
  color: var(--color-text-muted);
}
</style>
