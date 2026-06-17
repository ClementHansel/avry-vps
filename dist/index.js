"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigSummary = exports.validateEnvSafe = exports.validateEnv = exports.isDockerSocketReachable = exports.bootstrap = exports.VERSION = void 0;
/**
 * Aivory VPS Panel
 * Self-hosted Docker and server management dashboard built on Dockge (MIT)
 */
exports.VERSION = '1.0.0';
var server_js_1 = require("./server.js");
Object.defineProperty(exports, "bootstrap", { enumerable: true, get: function () { return server_js_1.bootstrap; } });
Object.defineProperty(exports, "isDockerSocketReachable", { enumerable: true, get: function () { return server_js_1.isDockerSocketReachable; } });
var env_js_1 = require("./config/env.js");
Object.defineProperty(exports, "validateEnv", { enumerable: true, get: function () { return env_js_1.validateEnv; } });
Object.defineProperty(exports, "validateEnvSafe", { enumerable: true, get: function () { return env_js_1.validateEnvSafe; } });
Object.defineProperty(exports, "getConfigSummary", { enumerable: true, get: function () { return env_js_1.getConfigSummary; } });
//# sourceMappingURL=index.js.map