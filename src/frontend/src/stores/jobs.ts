import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './auth';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type OperationType = 'build' | 'deploy' | 'pull' | 'db-import' | 'db-export' | 'backup' | 'restore' | 'tunnel-transfer';

export interface JobRecord {
  id: string;
  type: OperationType;
  projectId?: string;
  status: JobStatus;
  submittedAt?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  duration?: number;
}

export interface ConcurrencyInfo {
  type: OperationType;
  running: number;
  limit: number;
}

export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<JobRecord[]>([]);
  const concurrency = ref<ConcurrencyInfo[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const runningJobs = computed(() =>
    jobs.value.filter((j) => j.status === 'running')
  );

  const queuedJobs = computed(() =>
    jobs.value.filter((j) => j.status === 'queued')
  );

  async function fetchJobs(): Promise<void> {
    const authStore = useAuthStore();
    isLoading.value = true;
    error.value = null;

    try {
      const response = await fetch('/api/jobs', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch jobs');

      jobs.value = await response.json();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      isLoading.value = false;
    }
  }

  async function cancelJob(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/jobs/${id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchJobs();
  }

  async function fetchConcurrency(): Promise<void> {
    const authStore = useAuthStore();
    try {
      const response = await fetch('/api/jobs/concurrency', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });
      if (response.ok) {
        concurrency.value = await response.json();
      }
    } catch {
      // Non-critical, fail silently
    }
  }

  return {
    jobs,
    concurrency,
    isLoading,
    error,
    runningJobs,
    queuedJobs,
    fetchJobs,
    cancelJob,
    fetchConcurrency,
  };
});
