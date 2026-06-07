import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/properties/**/*.prop.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/frontend/**/*'],
    },
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
