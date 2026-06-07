/**
 * Centralized Configuration Module
 *
 * Re-exports all configuration utilities from a single entry point.
 * Provides typed configuration object for all modules and validates
 * required environment variables on startup.
 *
 * Requirements: 8.3, 8.5, 6.5
 */

export {
  validateEnv,
  validateEnvSafe,
  getConfigSummary,
} from './env.js';

export type { EnvConfig } from './env.js';
