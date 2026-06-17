"use strict";
/**
 * Centralized Configuration Module
 *
 * Re-exports all configuration utilities from a single entry point.
 * Provides typed configuration object for all modules and validates
 * required environment variables on startup.
 *
 * Requirements: 8.3, 8.5, 6.5
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigSummary = exports.validateEnvSafe = exports.validateEnv = void 0;
var env_js_1 = require("./env.js");
Object.defineProperty(exports, "validateEnv", { enumerable: true, get: function () { return env_js_1.validateEnv; } });
Object.defineProperty(exports, "validateEnvSafe", { enumerable: true, get: function () { return env_js_1.validateEnvSafe; } });
Object.defineProperty(exports, "getConfigSummary", { enumerable: true, get: function () { return env_js_1.getConfigSummary; } });
//# sourceMappingURL=index.js.map