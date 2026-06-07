import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnvSafe, getConfigSummary } from '../../src/config/env.js';
import type { EnvConfig } from '../../src/config/env.js';

describe('Environment Configuration Module', () => {
  describe('validateEnvSafe', () => {
    it('should return no errors when all required vars are present', () => {
      const env = {
        PORT: '3000',
        SUPABASE_JWT_SECRET: 'test-secret',
        DOCKER_HOST: '/var/run/docker.sock',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toEqual([]);
    });

    it('should report missing PORT', () => {
      const env = {
        SUPABASE_JWT_SECRET: 'test-secret',
        DOCKER_HOST: '/var/run/docker.sock',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Missing required environment variable: PORT');
    });

    it('should report missing SUPABASE_JWT_SECRET', () => {
      const env = {
        PORT: '3000',
        DOCKER_HOST: '/var/run/docker.sock',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Missing required environment variable: SUPABASE_JWT_SECRET');
    });

    it('should report missing ENVIRONMENT', () => {
      const env = {
        PORT: '3000',
        SUPABASE_JWT_SECRET: 'secret',
        DOCKER_HOST: '/var/run/docker.sock',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Missing required environment variable: ENVIRONMENT');
    });

    it('should report multiple missing vars at once', () => {
      const env: Record<string, string | undefined> = {};
      const errors = validateEnvSafe(env);
      expect(errors.length).toBe(3); // PORT, SUPABASE_JWT_SECRET, ENVIRONMENT
    });

    it('should not require DOCKER_HOST (has default)', () => {
      const env = {
        PORT: '3000',
        SUPABASE_JWT_SECRET: 'secret',
        ENVIRONMENT: 'development',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toEqual([]);
    });

    it('should report invalid PORT (not a number)', () => {
      const env = {
        PORT: 'abc',
        SUPABASE_JWT_SECRET: 'secret',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Invalid PORT value "abc". Must be a number between 1 and 65535.');
    });

    it('should report invalid PORT (out of range)', () => {
      const env = {
        PORT: '99999',
        SUPABASE_JWT_SECRET: 'secret',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Invalid PORT value "99999". Must be a number between 1 and 65535.');
    });

    it('should report invalid PORT (zero)', () => {
      const env = {
        PORT: '0',
        SUPABASE_JWT_SECRET: 'secret',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Invalid PORT value "0". Must be a number between 1 and 65535.');
    });

    it('should treat empty string as missing', () => {
      const env = {
        PORT: '3000',
        SUPABASE_JWT_SECRET: '',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Missing required environment variable: SUPABASE_JWT_SECRET');
    });

    it('should treat whitespace-only as missing', () => {
      const env = {
        PORT: '3000',
        SUPABASE_JWT_SECRET: '   ',
        ENVIRONMENT: 'production',
      };
      const errors = validateEnvSafe(env);
      expect(errors).toContain('Missing required environment variable: SUPABASE_JWT_SECRET');
    });
  });

  describe('getConfigSummary', () => {
    const baseConfig: EnvConfig = {
      PORT: 3000,
      SUPABASE_JWT_SECRET: 'my-super-secret',
      DOCKER_HOST: '/var/run/docker.sock',
      ENVIRONMENT: 'production',
      CORS_ORIGINS: ['https://panel.aivory.id'],
      DB_PATH: '/app/data/panel.db',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'secret123',
      TLS_ENABLED: true,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      ALERT_WEBHOOK_URL: 'https://hooks.slack.com/test',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com',
      BACKUP_S3_BUCKET: 'backups',
      BACKUP_S3_ACCESS_KEY: 'AKID',
      BACKUP_S3_SECRET_KEY: 'secret',
      PANEL_DOMAIN: 'panel.aivory.id',
    };

    it('should mask SUPABASE_JWT_SECRET', () => {
      const summary = getConfigSummary(baseConfig);
      expect(summary.SUPABASE_JWT_SECRET).toBe('***masked***');
    });

    it('should indicate password is set without revealing it', () => {
      const summary = getConfigSummary(baseConfig);
      expect(summary.ADMIN_PASSWORD).toBe('***set***');
    });

    it('should indicate password is not set when empty', () => {
      const summary = getConfigSummary({ ...baseConfig, ADMIN_PASSWORD: '' });
      expect(summary.ADMIN_PASSWORD).toBe('***not set***');
    });

    it('should include PORT as string', () => {
      const summary = getConfigSummary(baseConfig);
      expect(summary.PORT).toBe('3000');
    });

    it('should include ENVIRONMENT', () => {
      const summary = getConfigSummary(baseConfig);
      expect(summary.ENVIRONMENT).toBe('production');
    });

    it('should include TLS_ENABLED as string', () => {
      const summary = getConfigSummary(baseConfig);
      expect(summary.TLS_ENABLED).toBe('true');
    });

    it('should show (not configured) for empty optional fields', () => {
      const config = { ...baseConfig, SMTP_HOST: '', ALERT_WEBHOOK_URL: '', BACKUP_S3_ENDPOINT: '' };
      const summary = getConfigSummary(config);
      expect(summary.SMTP_HOST).toBe('(not configured)');
      expect(summary.ALERT_WEBHOOK_URL).toBe('(not configured)');
      expect(summary.BACKUP_S3_ENDPOINT).toBe('(not configured)');
    });
  });
});
