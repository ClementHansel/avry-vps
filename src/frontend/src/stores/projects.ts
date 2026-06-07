import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './auth';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  containerCount: number;
  healthStatus: 'all services up' | 'partially degraded' | 'all services down' | 'empty';
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<ProjectSummary[]>([]);
  const selectedProjectId = ref<string | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const selectedProject = computed(() =>
    projects.value.find((p) => p.id === selectedProjectId.value) ?? null
  );

  async function fetchProjects(): Promise<void> {
    const authStore = useAuthStore();
    isLoading.value = true;
    error.value = null;

    try {
      const response = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch projects');

      projects.value = await response.json();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      isLoading.value = false;
    }
  }

  async function createProject(name: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.token}`,
      },
      body: JSON.stringify({ name }),
    });
    await fetchProjects();
  }

  async function deleteProject(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/projects/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchProjects();
  }

  function selectProject(id: string | null): void {
    selectedProjectId.value = id;
  }

  return {
    projects,
    selectedProjectId,
    isLoading,
    error,
    selectedProject,
    fetchProjects,
    createProject,
    deleteProject,
    selectProject,
  };
});
