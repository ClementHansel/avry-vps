/**
 * VPS Panel - Main Server Entry Point
 *
 * Bootstraps the application via createApp(), starts the HTTP server,
 * registers signal handlers for graceful shutdown.
 *
 * The full module wiring and initialization logic lives in ./app.ts.
 *
 * Requirements: 8.4, 8.5, 8.6
 */
import 'dotenv/config';
import type { EnvConfig } from './config/env.js';
export { createApp, isDockerSocketReachable, isProcAvailable, isPtyAvailable } from './app.js';
export { validateEnv, validateEnvSafe, getConfigSummary } from './config/env.js';
/**
 * Bootstrap the application.
 * @deprecated Use `createApp` directly for better type safety.
 */
export declare function bootstrap(envConfig?: EnvConfig): any;
export type BootstrapReturnType = ReturnType<typeof bootstrap>;
//# sourceMappingURL=server.d.ts.map