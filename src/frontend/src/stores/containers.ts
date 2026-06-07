import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './auth';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  port: number;
  status: 'running' | 'stopped' | 'exited' | 'restarting';
  health: 'healthy' | 'unhealthy' | 'unknown';
  uptime: number;
  projectId?: string;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageMB: number;
  memoryLimitMB: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export const useContainersStore = defineStore('containers', () => {
  const containers = ref<ContainerInfo[]>([]);
  const selectedContainerId = ref<string | null>(null);
  const containerStats = ref<Record<string, ContainerStats>>({});
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const selectedContainer = computed(() =>
    containers.value.find((c) => c.id === selectedContainerId.value) ?? null
  );

  const runningContainers = computed(() =>
    containers.value.filter((c) => c.status === 'running')
  );

  async function fetchContainers(): Promise<void> {
    const authStore = useAuthStore();
    isLoading.value = true;
    error.value = null;

    try {
      const response = await fetch('/api/containers', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch containers');

      containers.value = await response.json();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      isLoading.value = false;
    }
  }

  async function startContainer(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/containers/${id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchContainers();
  }

  async function stopContainer(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/containers/${id}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchContainers();
  }

  async function restartContainer(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/containers/${id}/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchContainers();
  }

  function selectContainer(id: string | null): void {
    selectedContainerId.value = id;
  }

  return {
    containers,
    selectedContainerId,
    containerStats,
    isLoading,
    error,
    selectedContainer,
    runningContainers,
    fetchContainers,
    startContainer,
    stopContainer,
    restartContainer,
    selectContainer,
  };
});
