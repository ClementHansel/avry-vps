<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const router = useRouter();

const username = ref('');
const password = ref('');

async function handleLogin() {
  const success = await authStore.login(username.value, password.value);
  if (success) {
    router.push('/');
  }
}
</script>

<template>
  <div class="login-view">
    <form class="login-form" @submit.prevent="handleLogin">
      <h2>Sign in to Aivory VPS Panel</h2>

      <!-- Lock indicator -->
      <div v-if="authStore.isLocked" class="lock-banner">
        <span class="lock-icon">🔒</span>
        <span class="lock-message">
          Account temporarily locked. Try again in {{ authStore.lockRemainingMinutes }} minute{{ authStore.lockRemainingMinutes !== 1 ? 's' : '' }}.
        </span>
      </div>

      <div class="form-group">
        <label for="username">Username</label>
        <input
          id="username"
          v-model="username"
          type="text"
          autocomplete="username"
          required
          :disabled="authStore.isLocked"
        />
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          :disabled="authStore.isLocked"
        />
      </div>

      <p v-if="authStore.loginError" class="error">{{ authStore.loginError }}</p>

      <button type="submit" :disabled="authStore.isLoading || authStore.isLocked">
        <template v-if="authStore.isLoading">Signing in...</template>
        <template v-else-if="authStore.isLocked">Locked</template>
        <template v-else>Sign in</template>
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-view {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
}

.login-form {
  background: var(--color-surface);
  padding: 2rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-border);
  width: 100%;
  max-width: 400px;
}

.login-form h2 {
  margin-bottom: 1.5rem;
  font-size: 1.25rem;
}

.lock-banner {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1.25rem;
}

.lock-icon {
  font-size: 1.25rem;
  flex-shrink: 0;
}

.lock-message {
  font-size: 0.8125rem;
  color: var(--color-danger);
  line-height: 1.4;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.25rem;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.form-group input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text);
  font-size: 1rem;
}

.form-group input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-group input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.error {
  color: var(--color-danger);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

button {
  width: 100%;
  padding: 0.625rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  font-size: 1rem;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
