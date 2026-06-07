<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useContainersStore, type ContainerInfo } from '@/stores/containers';
import LogViewer from '@/components/LogViewer.vue';

const containersStore = useContainersStore();
const selectedContainer = ref<ContainerInfo | null>(null);

function selectContainer(container: ContainerInfo): void {
  selectedContainer.value = container;
}

onMounted(() => {
  containersStore.fetchContainers();
});
</script>

<template>
  <div class="logs-view">
    <h2>Container Logs</h2>

    <div class="logs-layout">
      <!-- Container selector -->
      <div class="container-selector">
        <h3>Containers</h3>
        <div v-if="containersStore.isLoading" class="loading-state">Loading...</div>
        <div v-else-if="containersStore.containers.length === 0" class="empty-state">
          No containers found
        </div>
        <div v-else class="container-list">
          <div
            v-for="container in containersStore.containers"
            :key="container.id"
            class="container-item"
            :class="{ active: selectedContainer?.id === container.id }"
            @click="selectContainer(container)"
          >
            <span class="status-dot" :class="container.status"></span>
            <span class="container-name">{{ container.name }}</span>
            <span class="container-status-label">{{ container.status }}</span>
          </div>
        </div>
      </div>

      <!-- Log viewer -->
      <div class="log-panel">
        <LogViewer
          v-if="selectedContainer"
          :container-id="selectedContainer.id"
          :container-name="selectedContainer.name"
          :container-status="selectedContainer.status"
        />
        <div v-else class="no-selection">
          <p>Select a container to view its logs</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 130px);
}

.logs-view h2 {
  margin-bottom: 1rem;
  flex-shrink: 0;
}

.logs-layout {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

.container-selector {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.container-selector h3 {
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.9rem;
  font-weight: 500;
}

.container-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem;
}

.container-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.container-item:hover {
  background: var(--color-surface-hover);
}

.container-item.active {
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid var(--color-primary);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.running { background: var(--color-success); }
.status-dot.stopped { background: var(--color-text-muted); }
.status-dot.exited { background: var(--color-danger); }
.status-dot.restarting { background: var(--color-warning); }

.container-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.container-status-label {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.log-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.no-selection {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text-muted);
}

.loading-state,
.empty-state {
  padding: 1rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}
</style>
