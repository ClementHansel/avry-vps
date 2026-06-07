import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './auth';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertChannelType = 'email' | 'webhook' | 'in-app';

export interface AlertRecord {
  id: string;
  timestamp: string;
  eventType: string;
  affectedResource: string;
  severity: AlertSeverity;
  deliveryStatus: Record<string, string>;
  message: string;
}

export interface AlertRule {
  id: string;
  resourceType: 'cpu' | 'memory' | 'disk' | 'container-health';
  threshold?: number;
  consecutiveChecks?: number;
  enabled: boolean;
}

export interface AlertChannel {
  id: string;
  type: AlertChannelType;
  config: Record<string, string>;
  enabled: boolean;
}

export const useAlertsStore = defineStore('alerts', () => {
  const alerts = ref<AlertRecord[]>([]);
  const rules = ref<AlertRule[]>([]);
  const channels = ref<AlertChannel[]>([]);
  const unreadCount = ref(0);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const criticalAlerts = computed(() =>
    alerts.value.filter((a) => a.severity === 'critical')
  );

  async function fetchAlerts(): Promise<void> {
    const authStore = useAuthStore();
    isLoading.value = true;
    error.value = null;

    try {
      const response = await fetch('/api/alerts', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch alerts');

      const data = await response.json();
      alerts.value = data.alerts;
      unreadCount.value = data.unreadCount ?? 0;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchRules(): Promise<void> {
    const authStore = useAuthStore();
    try {
      const response = await fetch('/api/alerts/rules', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch alert rules');

      rules.value = await response.json();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    }
  }

  async function fetchChannels(): Promise<void> {
    const authStore = useAuthStore();
    try {
      const response = await fetch('/api/alerts/channels', {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });

      if (!response.ok) throw new Error('Failed to fetch alert channels');

      channels.value = await response.json();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Unknown error';
    }
  }

  async function saveChannel(channel: Omit<AlertChannel, 'id'> & { id?: string }): Promise<void> {
    const authStore = useAuthStore();
    const method = channel.id ? 'PUT' : 'POST';
    const url = channel.id ? `/api/alerts/channels/${channel.id}` : '/api/alerts/channels';

    await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.token}`,
      },
      body: JSON.stringify(channel),
    });
    await fetchChannels();
  }

  async function deleteChannel(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/alerts/channels/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchChannels();
  }

  async function saveRule(rule: Omit<AlertRule, 'id'> & { id?: string }): Promise<void> {
    const authStore = useAuthStore();
    const method = rule.id ? 'PUT' : 'POST';
    const url = rule.id ? `/api/alerts/rules/${rule.id}` : '/api/alerts/rules';

    await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.token}`,
      },
      body: JSON.stringify(rule),
    });
    await fetchRules();
  }

  async function deleteRule(id: string): Promise<void> {
    const authStore = useAuthStore();
    await fetch(`/api/alerts/rules/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    await fetchRules();
  }

  function markAllRead(): void {
    unreadCount.value = 0;
  }

  return {
    alerts,
    rules,
    channels,
    unreadCount,
    isLoading,
    error,
    criticalAlerts,
    fetchAlerts,
    fetchRules,
    fetchChannels,
    saveChannel,
    deleteChannel,
    saveRule,
    deleteRule,
    markAllRead,
  };
});
