<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-overlay" @click.self="emit('cancel')">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
        <h3 class="dialog-title">{{ title }}</h3>
        <p class="dialog-message">{{ message }}</p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" @click="emit('cancel')">Cancel</button>
          <button
            :class="['btn', danger ? 'btn-danger' : 'btn-primary']"
            @click="emit('confirm')"
          >
            {{ confirmLabel || 'Confirm' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.5rem;
  width: 100%;
  max-width: 420px;
}

.dialog-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.dialog-message {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin-bottom: 1.25rem;
  line-height: 1.5;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-secondary:hover {
  background: var(--color-border);
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover {
  background: var(--color-primary-hover);
}

.btn-danger {
  background: var(--color-danger);
  color: white;
}

.btn-danger:hover {
  background: #dc2626;
}
</style>
