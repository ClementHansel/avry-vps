<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import MainLayout from '@/layouts/MainLayout.vue';

const route = useRoute();

/**
 * Load custom CSS override file if available.
 * The custom theme is loaded last to ensure cascade precedence.
 */
function loadCustomTheme() {
  const customThemePath = '/custom-theme.css';
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = customThemePath;
  link.id = 'custom-theme-override';
  link.onerror = () => {
    // Custom theme file not found — this is expected if no override is provided
    link.remove();
  };
  document.head.appendChild(link);
}

onMounted(() => {
  loadCustomTheme();
});
</script>

<template>
  <!-- Login route renders without the main layout -->
  <template v-if="route.name === 'login'">
    <RouterView />
  </template>
  <!-- All other routes use the MainLayout with sidebar navigation -->
  <template v-else>
    <MainLayout />
  </template>
</template>
