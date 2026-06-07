import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface Session {
  id: string;
  username: string;
  createdAt: string;
  lastActivity: string;
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(null);
  const token = ref<string | null>(localStorage.getItem('vps_token'));
  const loginError = ref<string | null>(null);
  const isLoading = ref(false);
  const isLocked = ref(false);
  const lockRemainingMinutes = ref(0);

  const isAuthenticated = computed(() => !!token.value);
  const username = computed(() => session.value?.username ?? null);

  async function login(user: string, password: string): Promise<boolean> {
    isLoading.value = true;
    loginError.value = null;
    isLocked.value = false;
    lockRemainingMinutes.value = 0;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (data.locked) {
          isLocked.value = true;
          lockRemainingMinutes.value = data.remainingMinutes ?? 15;
          loginError.value = null;
        } else {
          loginError.value = data.message ?? 'Invalid credentials';
        }
        return false;
      }

      const data = await response.json();
      token.value = data.token;
      session.value = data.session;
      localStorage.setItem('vps_token', data.token);
      return true;
    } catch (err) {
      loginError.value = 'Network error. Please try again.';
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.value}` },
      });
    } finally {
      token.value = null;
      session.value = null;
      localStorage.removeItem('vps_token');
    }
  }

  async function checkSession(): Promise<void> {
    if (!token.value) return;

    try {
      const response = await fetch('/api/auth/session', {
        headers: { Authorization: `Bearer ${token.value}` },
      });

      if (!response.ok) {
        token.value = null;
        session.value = null;
        localStorage.removeItem('vps_token');
        return;
      }

      const data = await response.json();
      session.value = data.session;
    } catch {
      // Network error — keep current state
    }
  }

  return {
    session,
    token,
    loginError,
    isLoading,
    isLocked,
    lockRemainingMinutes,
    isAuthenticated,
    username,
    login,
    logout,
    checkSession,
  };
});
