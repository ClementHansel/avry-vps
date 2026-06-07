<script setup lang="ts">
defineProps<{
  status: 'healthy' | 'unhealthy' | 'unknown' | 'running' | 'stopped' | 'exited' | 'restarting';
}>();
</script>

<template>
  <span :class="['status-badge', status]">
    <span class="dot"></span>
    {{ status }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: capitalize;
  padding: 0.25rem 0.625rem;
  border-radius: 9999px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.healthy,
.running {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.healthy .dot,
.running .dot {
  background: var(--color-success);
}

.unhealthy,
.stopped,
.exited {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.unhealthy .dot,
.stopped .dot,
.exited .dot {
  background: var(--color-danger);
}

.unknown,
.restarting {
  background: rgba(148, 163, 184, 0.15);
  color: var(--color-text-muted);
}

.unknown .dot,
.restarting .dot {
  background: var(--color-text-muted);
}
</style>
