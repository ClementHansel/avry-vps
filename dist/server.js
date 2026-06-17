"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigSummary = exports.validateEnvSafe = exports.validateEnv = exports.isPtyAvailable = exports.isProcAvailable = exports.isDockerSocketReachable = exports.createApp = void 0;
exports.bootstrap = bootstrap;
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
require("dotenv/config");
const app_js_1 = require("./app.js");
// Re-export for backward compatibility with tests and external usage
var app_js_2 = require("./app.js");
Object.defineProperty(exports, "createApp", { enumerable: true, get: function () { return app_js_2.createApp; } });
Object.defineProperty(exports, "isDockerSocketReachable", { enumerable: true, get: function () { return app_js_2.isDockerSocketReachable; } });
Object.defineProperty(exports, "isProcAvailable", { enumerable: true, get: function () { return app_js_2.isProcAvailable; } });
Object.defineProperty(exports, "isPtyAvailable", { enumerable: true, get: function () { return app_js_2.isPtyAvailable; } });
var env_js_1 = require("./config/env.js");
Object.defineProperty(exports, "validateEnv", { enumerable: true, get: function () { return env_js_1.validateEnv; } });
Object.defineProperty(exports, "validateEnvSafe", { enumerable: true, get: function () { return env_js_1.validateEnvSafe; } });
Object.defineProperty(exports, "getConfigSummary", { enumerable: true, get: function () { return env_js_1.getConfigSummary; } });
// --- Legacy bootstrap wrapper (for backward compat with existing tests) ---
/**
 * Bootstrap the application.
 * @deprecated Use `createApp` directly for better type safety.
 */
function bootstrap(envConfig) {
    const instance = (0, app_js_1.createApp)(envConfig);
    return {
        app: instance.app,
        io: instance.io,
        httpServer: instance.httpServer,
        config: instance.config,
        db: instance.db,
        startBackgroundServices: instance.startBackgroundServices,
        shutdown: instance.shutdown,
    };
}
// --- Auto-start when run directly ---
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('server') ?? false;
if (isDirectRun && !process.env.VITEST) {
    const instance = (0, app_js_1.createApp)();
    // Start background services
    instance.startBackgroundServices();
    // Listen
    instance.httpServer.listen(instance.config.PORT, () => {
        console.log(`[VPS Panel] Server listening on port ${instance.config.PORT} (${instance.config.ENVIRONMENT})`);
        console.log(`[VPS Panel] Docker host: ${instance.config.DOCKER_HOST}`);
        console.log(`[VPS Panel] Degradation status:`, instance.degradation);
    });
    // Graceful shutdown on signals
    process.on('SIGTERM', () => {
        instance.shutdown();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        instance.shutdown();
        process.exit(0);
    });
}
//# sourceMappingURL=server.js.map