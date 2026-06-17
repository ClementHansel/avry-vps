"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNginxConfig = generateNginxConfig;
exports.createDomainManager = createDomainManager;
exports.isValidProxyTarget = isValidProxyTarget;
/**
 * Domain Manager Module
 *
 * Manages Nginx virtual host configurations, DNS validation, and config rollback.
 * Generates Nginx server block configs per domain in /etc/nginx/sites-enabled/.
 * Validates with `nginx -t` before reload, rolls back on failure.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */
const uuid_1 = require("uuid");
// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_SITES_ENABLED_PATH = '/etc/nginx/sites-enabled';
const DEFAULT_PROXY_HEADERS = {
    'X-Forwarded-For': '$proxy_add_x_forwarded_for',
    'X-Real-IP': '$remote_addr',
    'Host': '$host',
    'X-Forwarded-Proto': '$scheme',
};
// ─── Default implementations ───────────────────────────────────────────────────
async function defaultExecCommand(command) {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    try {
        const { stdout, stderr } = await execAsync(command, { timeout: 10_000 });
        return { stdout, stderr, exitCode: 0 };
    }
    catch (error) {
        return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message ?? '',
            exitCode: error.code ?? 1,
        };
    }
}
async function defaultDnsResolve(domain) {
    const dns = await import('node:dns');
    const { promisify } = await import('node:util');
    const resolve4 = promisify(dns.resolve4);
    try {
        return await resolve4(domain);
    }
    catch {
        return [];
    }
}
function createDefaultFs() {
    return {
        async writeFile(filePath, content) {
            const fs = await import('node:fs/promises');
            await fs.writeFile(filePath, content, 'utf-8');
        },
        async readFile(filePath) {
            const fs = await import('node:fs/promises');
            return await fs.readFile(filePath, 'utf-8');
        },
        async unlink(filePath) {
            const fs = await import('node:fs/promises');
            await fs.unlink(filePath);
        },
        async exists(filePath) {
            const fs = await import('node:fs/promises');
            try {
                await fs.access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
// ─── Nginx Config Generation ───────────────────────────────────────────────────
/**
 * Generate an Nginx server block configuration for a domain.
 */
function generateNginxConfig(config) {
    const { domain, proxyTarget, sslEnabled, headers, websocketUpgrade } = config;
    // Merge default headers with custom headers
    const allHeaders = { ...DEFAULT_PROXY_HEADERS, ...headers };
    const lines = [];
    // HTTP server block (redirect to HTTPS if SSL enabled, otherwise proxy)
    if (sslEnabled) {
        lines.push('server {');
        lines.push('    listen 80;');
        lines.push('    listen [::]:80;');
        lines.push(`    server_name ${domain};`);
        lines.push('');
        lines.push('    return 301 https://$host$request_uri;');
        lines.push('}');
        lines.push('');
    }
    // Main server block
    lines.push('server {');
    if (sslEnabled) {
        lines.push('    listen 443 ssl http2;');
        lines.push('    listen [::]:443 ssl http2;');
        lines.push(`    server_name ${domain};`);
        lines.push('');
        lines.push(`    ssl_certificate /etc/ssl/vps-panel/${domain}/fullchain.pem;`);
        lines.push(`    ssl_certificate_key /etc/ssl/vps-panel/${domain}/privkey.pem;`);
        lines.push('    ssl_protocols TLSv1.2 TLSv1.3;');
        lines.push('    ssl_ciphers HIGH:!aNULL:!MD5;');
        lines.push('    ssl_prefer_server_ciphers on;');
    }
    else {
        lines.push('    listen 80;');
        lines.push('    listen [::]:80;');
        lines.push(`    server_name ${domain};`);
    }
    lines.push('');
    lines.push('    location / {');
    lines.push(`        proxy_pass http://${proxyTarget};`);
    lines.push('');
    // Proxy headers
    for (const [headerName, headerValue] of Object.entries(allHeaders)) {
        lines.push(`        proxy_set_header ${headerName} ${headerValue};`);
    }
    // WebSocket upgrade support
    if (websocketUpgrade) {
        lines.push('');
        lines.push('        proxy_http_version 1.1;');
        lines.push('        proxy_set_header Upgrade $http_upgrade;');
        lines.push('        proxy_set_header Connection "upgrade";');
        lines.push('        proxy_read_timeout 86400;');
    }
    lines.push('    }');
    lines.push('}');
    return lines.join('\n');
}
// ─── Implementation ────────────────────────────────────────────────────────────
function createDomainManager(config) {
    const sitesEnabledPath = config?.sitesEnabledPath ?? DEFAULT_SITES_ENABLED_PATH;
    const execCommand = config?.execCommand ?? defaultExecCommand;
    const dnsResolve = config?.dnsResolve ?? defaultDnsResolve;
    const fs = config?.fs ?? createDefaultFs();
    const db = config?.db;
    const serverIp = config?.serverIp;
    // ─── Helpers ─────────────────────────────────────────────────────────────
    function getConfigFilePath(domain) {
        return `${sitesEnabledPath}/${domain}.conf`;
    }
    async function testNginxConfig() {
        const result = await execCommand('nginx -t');
        if (result.exitCode === 0) {
            return { valid: true };
        }
        return { valid: false, error: result.stderr || result.stdout };
    }
    async function reloadNginxService() {
        const result = await execCommand('nginx -s reload');
        if (result.exitCode !== 0) {
            throw new Error(`Nginx reload failed: ${result.stderr || result.stdout}`);
        }
    }
    async function writeConfigAndReload(domain, content) {
        const configPath = getConfigFilePath(domain);
        // Read previous config for potential rollback
        let previousConfig = null;
        const configExists = await fs.exists(configPath);
        if (configExists) {
            previousConfig = await fs.readFile(configPath);
        }
        // Write new config
        await fs.writeFile(configPath, content);
        // Validate with nginx -t
        const validation = await testNginxConfig();
        if (!validation.valid) {
            // Rollback: restore previous config or remove the new file
            if (previousConfig !== null) {
                await fs.writeFile(configPath, previousConfig);
            }
            else {
                await fs.unlink(configPath);
            }
            // Ensure nginx still works after rollback
            await testNginxConfig();
            throw new Error(`Nginx configuration validation failed: ${validation.error}`);
        }
        // Reload nginx to apply changes
        await reloadNginxService();
    }
    async function removeConfigAndReload(domain) {
        const configPath = getConfigFilePath(domain);
        // Read current config for potential rollback
        let previousConfig = null;
        const configExists = await fs.exists(configPath);
        if (configExists) {
            previousConfig = await fs.readFile(configPath);
        }
        // Remove the config file
        if (configExists) {
            await fs.unlink(configPath);
        }
        // Validate nginx config after removal
        const validation = await testNginxConfig();
        if (!validation.valid) {
            // Rollback: restore the config file
            if (previousConfig !== null) {
                await fs.writeFile(configPath, previousConfig);
            }
            throw new Error(`Nginx configuration validation failed after removal: ${validation.error}`);
        }
        // Reload nginx to apply changes
        await reloadNginxService();
    }
    // ─── Public API ──────────────────────────────────────────────────────────
    async function listDomains() {
        if (!db) {
            return [];
        }
        return db.getAllDomains();
    }
    async function addDomain(input) {
        // Validate domain name
        if (!input.domain || !input.domain.trim()) {
            throw new Error('Domain name is required');
        }
        // Validate proxy target format (host:port)
        if (!input.proxyTarget || !isValidProxyTarget(input.proxyTarget)) {
            throw new Error('Invalid proxy target format. Expected host:port (e.g., localhost:3000)');
        }
        // Check for duplicate domain
        if (db) {
            const existing = db.getDomainByName(input.domain);
            if (existing) {
                throw new Error(`Domain "${input.domain}" already exists`);
            }
        }
        const domainConfig = {
            id: (0, uuid_1.v4)(),
            domain: input.domain.trim(),
            proxyTarget: input.proxyTarget.trim(),
            sslEnabled: input.sslEnabled ?? false,
            headers: input.headers ?? {},
            websocketUpgrade: input.websocketUpgrade ?? false,
            active: input.active ?? true,
            projectId: input.projectId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        // Generate and write nginx config
        const nginxConfig = generateNginxConfig(domainConfig);
        await writeConfigAndReload(domainConfig.domain, nginxConfig);
        // Persist to database
        if (db) {
            db.insertDomain(domainConfig);
        }
        return domainConfig;
    }
    async function updateDomain(id, input) {
        if (!db) {
            throw new Error('Database not configured');
        }
        const existing = db.getDomain(id);
        if (!existing) {
            throw new Error(`Domain with id "${id}" not found`);
        }
        // Validate proxy target if provided
        if (input.proxyTarget !== undefined && !isValidProxyTarget(input.proxyTarget)) {
            throw new Error('Invalid proxy target format. Expected host:port (e.g., localhost:3000)');
        }
        // Check for duplicate domain name if changing
        if (input.domain && input.domain !== existing.domain) {
            const duplicate = db.getDomainByName(input.domain);
            if (duplicate) {
                throw new Error(`Domain "${input.domain}" already exists`);
            }
        }
        // Build updated config
        const updatedConfig = {
            ...existing,
            domain: input.domain ?? existing.domain,
            proxyTarget: input.proxyTarget ?? existing.proxyTarget,
            sslEnabled: input.sslEnabled ?? existing.sslEnabled,
            headers: input.headers ?? existing.headers,
            websocketUpgrade: input.websocketUpgrade ?? existing.websocketUpgrade,
            active: input.active ?? existing.active,
            projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
            updatedAt: new Date().toISOString(),
        };
        // If domain name changed, remove old config file
        if (input.domain && input.domain !== existing.domain) {
            const oldConfigPath = getConfigFilePath(existing.domain);
            const oldConfigExists = await fs.exists(oldConfigPath);
            if (oldConfigExists) {
                await fs.unlink(oldConfigPath);
            }
        }
        // Generate and write nginx config
        const nginxConfig = generateNginxConfig(updatedConfig);
        await writeConfigAndReload(updatedConfig.domain, nginxConfig);
        // Persist to database
        db.updateDomain(id, updatedConfig);
        return updatedConfig;
    }
    async function deleteDomain(id) {
        if (!db) {
            throw new Error('Database not configured');
        }
        const existing = db.getDomain(id);
        if (!existing) {
            throw new Error(`Domain with id "${id}" not found`);
        }
        // Remove nginx config and reload
        await removeConfigAndReload(existing.domain);
        // Remove from database
        db.deleteDomain(id);
    }
    async function validateDns(domain) {
        const resolvedIps = await dnsResolve(domain);
        if (resolvedIps.length === 0) {
            return {
                valid: false,
                resolvedIps: [],
                serverIp,
                warning: `DNS lookup failed: domain "${domain}" does not resolve to any IP address`,
            };
        }
        // If we have a server IP, check if the domain resolves to it
        if (serverIp) {
            const matchesServer = resolvedIps.includes(serverIp);
            if (!matchesServer) {
                return {
                    valid: false,
                    resolvedIps,
                    serverIp,
                    warning: `Domain "${domain}" resolves to [${resolvedIps.join(', ')}] but server IP is ${serverIp}`,
                };
            }
        }
        return {
            valid: true,
            resolvedIps,
            serverIp,
        };
    }
    async function reloadNginx() {
        const validation = await testNginxConfig();
        if (!validation.valid) {
            throw new Error(`Nginx configuration is invalid: ${validation.error}`);
        }
        await reloadNginxService();
    }
    // ─── Return the public API ───────────────────────────────────────────────
    return {
        listDomains,
        addDomain,
        updateDomain,
        deleteDomain,
        validateDns,
        generateNginxConfig,
        reloadNginx,
    };
}
// ─── Utility functions ─────────────────────────────────────────────────────────
/**
 * Validate proxy target format: host:port
 * Examples: localhost:3000, 127.0.0.1:8080, my-service:4000
 */
function isValidProxyTarget(target) {
    if (!target)
        return false;
    const parts = target.split(':');
    if (parts.length !== 2)
        return false;
    const [host, portStr] = parts;
    if (!host || !portStr)
        return false;
    // Validate host (simple: not empty, no spaces, allows alphanumeric, dots, hyphens)
    if (!/^[a-zA-Z0-9._-]+$/.test(host))
        return false;
    // Validate port
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535)
        return false;
    return true;
}
//# sourceMappingURL=domain-manager.js.map