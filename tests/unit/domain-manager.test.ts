/**
 * Domain Manager Unit Tests
 *
 * Tests for Nginx virtual host config generation, DNS validation,
 * config rollback on failure, and CRUD operations.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDomainManager,
  generateNginxConfig,
  isValidProxyTarget,
} from '../../src/modules/domain-manager.js';
import type {
  DomainConfig,
  DomainManager,
  ExecResult,
  FileSystemOps,
  DatabaseOps,
} from '../../src/modules/domain-manager.js';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function createMockExec(
  responses?: Record<string, ExecResult>
): (command: string) => Promise<ExecResult> {
  const defaultResponses: Record<string, ExecResult> = {
    'nginx -t': { stdout: 'nginx: configuration file syntax is ok\n', stderr: '', exitCode: 0 },
    'nginx -s reload': { stdout: '', stderr: '', exitCode: 0 },
    ...responses,
  };

  return vi.fn(async (command: string) => {
    return defaultResponses[command] ?? { stdout: '', stderr: 'Unknown command', exitCode: 1 };
  });
}

function createMockFs(): FileSystemOps & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async unlink(path: string) {
      files.delete(path);
    },
    async exists(path: string) {
      return files.has(path);
    },
  };
}

function createMockDb(): DatabaseOps & { domains: Map<string, DomainConfig> } {
  const domains = new Map<string, DomainConfig>();

  return {
    domains,
    getAllDomains() {
      return Array.from(domains.values());
    },
    getDomain(id: string) {
      return domains.get(id);
    },
    getDomainByName(domain: string) {
      for (const d of domains.values()) {
        if (d.domain === domain) return d;
      }
      return undefined;
    },
    insertDomain(config: DomainConfig) {
      domains.set(config.id, config);
    },
    updateDomain(id: string, config: Partial<DomainConfig>) {
      const existing = domains.get(id);
      if (existing) {
        domains.set(id, { ...existing, ...config });
      }
    },
    deleteDomain(id: string) {
      domains.delete(id);
    },
  };
}

function createMockDnsResolve(
  results?: Record<string, string[]>
): (domain: string) => Promise<string[]> {
  return vi.fn(async (domain: string) => {
    return results?.[domain] ?? [];
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Domain Manager', () => {
  let mockExec: ReturnType<typeof createMockExec>;
  let mockFs: ReturnType<typeof createMockFs>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockDnsResolve: ReturnType<typeof createMockDnsResolve>;
  let manager: DomainManager;

  beforeEach(() => {
    mockExec = createMockExec();
    mockFs = createMockFs();
    mockDb = createMockDb();
    mockDnsResolve = createMockDnsResolve({
      'example.com': ['1.2.3.4'],
      'test.example.com': ['1.2.3.4'],
    });

    manager = createDomainManager({
      sitesEnabledPath: '/etc/nginx/sites-enabled',
      execCommand: mockExec,
      fs: mockFs,
      db: mockDb,
      dnsResolve: mockDnsResolve,
      serverIp: '1.2.3.4',
    });
  });

  // ─── generateNginxConfig ─────────────────────────────────────────────────

  describe('generateNginxConfig', () => {
    it('should generate a basic HTTP server block', () => {
      const config: DomainConfig = {
        id: 'test-1',
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
        sslEnabled: false,
        headers: {},
        websocketUpgrade: false,
        active: true,
      };

      const result = generateNginxConfig(config);

      expect(result).toContain('listen 80;');
      expect(result).toContain('server_name example.com;');
      expect(result).toContain('proxy_pass http://localhost:3000;');
      expect(result).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for');
      expect(result).toContain('proxy_set_header X-Real-IP $remote_addr');
      expect(result).toContain('proxy_set_header Host $host');
      expect(result).not.toContain('ssl');
      expect(result).not.toContain('Upgrade');
    });

    it('should generate HTTPS server block with SSL when sslEnabled', () => {
      const config: DomainConfig = {
        id: 'test-2',
        domain: 'secure.example.com',
        proxyTarget: 'localhost:8080',
        sslEnabled: true,
        headers: {},
        websocketUpgrade: false,
        active: true,
      };

      const result = generateNginxConfig(config);

      // Should have HTTP redirect block
      expect(result).toContain('return 301 https://$host$request_uri;');
      // Should have SSL block
      expect(result).toContain('listen 443 ssl http2;');
      expect(result).toContain('server_name secure.example.com;');
      expect(result).toContain('ssl_certificate /etc/ssl/vps-panel/secure.example.com/fullchain.pem;');
      expect(result).toContain('ssl_certificate_key /etc/ssl/vps-panel/secure.example.com/privkey.pem;');
      expect(result).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
      expect(result).toContain('proxy_pass http://localhost:8080;');
    });

    it('should include WebSocket upgrade headers when websocketUpgrade is true', () => {
      const config: DomainConfig = {
        id: 'test-3',
        domain: 'ws.example.com',
        proxyTarget: 'localhost:4000',
        sslEnabled: false,
        headers: {},
        websocketUpgrade: true,
        active: true,
      };

      const result = generateNginxConfig(config);

      expect(result).toContain('proxy_http_version 1.1;');
      expect(result).toContain('proxy_set_header Upgrade $http_upgrade;');
      expect(result).toContain('proxy_set_header Connection "upgrade";');
      expect(result).toContain('proxy_read_timeout 86400;');
    });

    it('should include custom headers merged with defaults', () => {
      const config: DomainConfig = {
        id: 'test-4',
        domain: 'custom.example.com',
        proxyTarget: 'localhost:5000',
        sslEnabled: false,
        headers: { 'X-Custom-Header': 'custom-value' },
        websocketUpgrade: false,
        active: true,
      };

      const result = generateNginxConfig(config);

      // Default headers should still be present
      expect(result).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for');
      expect(result).toContain('proxy_set_header X-Real-IP $remote_addr');
      expect(result).toContain('proxy_set_header Host $host');
      // Custom header should be present
      expect(result).toContain('proxy_set_header X-Custom-Header custom-value');
    });

    it('should allow custom headers to override defaults', () => {
      const config: DomainConfig = {
        id: 'test-5',
        domain: 'override.example.com',
        proxyTarget: 'localhost:6000',
        sslEnabled: false,
        headers: { 'Host': '$http_host' },
        websocketUpgrade: false,
        active: true,
      };

      const result = generateNginxConfig(config);

      // Custom Host header should override
      expect(result).toContain('proxy_set_header Host $http_host');
      // Should NOT contain the default Host header value
      const hostMatches = result.match(/proxy_set_header Host/g);
      expect(hostMatches).toHaveLength(1);
    });
  });

  // ─── addDomain ───────────────────────────────────────────────────────────

  describe('addDomain', () => {
    it('should add a domain and write nginx config', async () => {
      const result = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      expect(result.domain).toBe('example.com');
      expect(result.proxyTarget).toBe('localhost:3000');
      expect(result.id).toBeDefined();
      expect(result.active).toBe(true);
      expect(result.sslEnabled).toBe(false);

      // Config file should be written
      const configContent = mockFs.files.get('/etc/nginx/sites-enabled/example.com.conf');
      expect(configContent).toBeDefined();
      expect(configContent).toContain('server_name example.com');
      expect(configContent).toContain('proxy_pass http://localhost:3000');

      // nginx -t and reload should have been called
      expect(mockExec).toHaveBeenCalledWith('nginx -t');
      expect(mockExec).toHaveBeenCalledWith('nginx -s reload');

      // Domain should be stored in db
      expect(mockDb.domains.size).toBe(1);
    });

    it('should add a domain with SSL and WebSocket enabled', async () => {
      const result = await manager.addDomain({
        domain: 'ws.example.com',
        proxyTarget: 'localhost:4000',
        sslEnabled: true,
        websocketUpgrade: true,
        headers: { 'X-Custom': 'value' },
      });

      expect(result.sslEnabled).toBe(true);
      expect(result.websocketUpgrade).toBe(true);
      expect(result.headers).toEqual({ 'X-Custom': 'value' });

      const configContent = mockFs.files.get('/etc/nginx/sites-enabled/ws.example.com.conf');
      expect(configContent).toContain('listen 443 ssl http2');
      expect(configContent).toContain('proxy_http_version 1.1');
      expect(configContent).toContain('proxy_set_header X-Custom value');
    });

    it('should throw if domain name is empty', async () => {
      await expect(
        manager.addDomain({ domain: '', proxyTarget: 'localhost:3000' })
      ).rejects.toThrow('Domain name is required');
    });

    it('should throw if proxy target is invalid', async () => {
      await expect(
        manager.addDomain({ domain: 'example.com', proxyTarget: 'invalid' })
      ).rejects.toThrow('Invalid proxy target format');
    });

    it('should throw if domain already exists', async () => {
      await manager.addDomain({ domain: 'example.com', proxyTarget: 'localhost:3000' });

      await expect(
        manager.addDomain({ domain: 'example.com', proxyTarget: 'localhost:4000' })
      ).rejects.toThrow('Domain "example.com" already exists');
    });

    it('should rollback config on nginx validation failure', async () => {
      let callCount = 0;
      const failingExec = vi.fn(async (command: string) => {
        if (command === 'nginx -t') {
          callCount++;
          if (callCount === 1) {
            // First nginx -t call fails (after writing new config)
            return { stdout: '', stderr: 'nginx: configuration error', exitCode: 1 };
          }
          // Second nginx -t call succeeds (after rollback)
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const failManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: failingExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: mockDnsResolve,
      });

      await expect(
        failManager.addDomain({ domain: 'bad.example.com', proxyTarget: 'localhost:3000' })
      ).rejects.toThrow('Nginx configuration validation failed');

      // Config file should NOT exist (rolled back = unlinked since no previous config)
      expect(mockFs.files.has('/etc/nginx/sites-enabled/bad.example.com.conf')).toBe(false);

      // Domain should NOT be stored in db
      expect(mockDb.domains.size).toBe(0);
    });
  });

  // ─── updateDomain ────────────────────────────────────────────────────────

  describe('updateDomain', () => {
    it('should update a domain and rewrite nginx config', async () => {
      const added = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      const updated = await manager.updateDomain(added.id, {
        proxyTarget: 'localhost:4000',
      });

      expect(updated.proxyTarget).toBe('localhost:4000');

      const configContent = mockFs.files.get('/etc/nginx/sites-enabled/example.com.conf');
      expect(configContent).toContain('proxy_pass http://localhost:4000');
    });

    it('should update headers and WebSocket settings', async () => {
      const added = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      const updated = await manager.updateDomain(added.id, {
        websocketUpgrade: true,
        headers: { 'X-New': 'header' },
      });

      expect(updated.websocketUpgrade).toBe(true);
      expect(updated.headers).toEqual({ 'X-New': 'header' });

      const configContent = mockFs.files.get('/etc/nginx/sites-enabled/example.com.conf');
      expect(configContent).toContain('proxy_http_version 1.1');
      expect(configContent).toContain('proxy_set_header X-New header');
    });

    it('should handle domain name change by removing old config', async () => {
      const added = await manager.addDomain({
        domain: 'old.example.com',
        proxyTarget: 'localhost:3000',
      });

      await manager.updateDomain(added.id, {
        domain: 'new.example.com',
      });

      // Old config should be removed
      expect(mockFs.files.has('/etc/nginx/sites-enabled/old.example.com.conf')).toBe(false);
      // New config should exist
      expect(mockFs.files.has('/etc/nginx/sites-enabled/new.example.com.conf')).toBe(true);
    });

    it('should throw if domain not found', async () => {
      await expect(
        manager.updateDomain('nonexistent', { proxyTarget: 'localhost:3000' })
      ).rejects.toThrow('Domain with id "nonexistent" not found');
    });

    it('should throw if new domain name conflicts', async () => {
      await manager.addDomain({ domain: 'first.example.com', proxyTarget: 'localhost:3000' });
      const second = await manager.addDomain({ domain: 'second.example.com', proxyTarget: 'localhost:4000' });

      await expect(
        manager.updateDomain(second.id, { domain: 'first.example.com' })
      ).rejects.toThrow('Domain "first.example.com" already exists');
    });

    it('should rollback on nginx validation failure during update', async () => {
      // First, add a domain successfully
      const added = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      const originalConfig = mockFs.files.get('/etc/nginx/sites-enabled/example.com.conf');

      // Now make nginx -t fail on next attempt
      let callCount = 0;
      const failingExec = vi.fn(async (command: string) => {
        if (command === 'nginx -t') {
          callCount++;
          if (callCount === 1) {
            return { stdout: '', stderr: 'syntax error', exitCode: 1 };
          }
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const failManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: failingExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: mockDnsResolve,
      });

      await expect(
        failManager.updateDomain(added.id, { proxyTarget: 'localhost:9999' })
      ).rejects.toThrow('Nginx configuration validation failed');

      // Config should be rolled back to original
      const currentConfig = mockFs.files.get('/etc/nginx/sites-enabled/example.com.conf');
      expect(currentConfig).toBe(originalConfig);
    });
  });

  // ─── deleteDomain ────────────────────────────────────────────────────────

  describe('deleteDomain', () => {
    it('should delete a domain and remove nginx config', async () => {
      const added = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      await manager.deleteDomain(added.id);

      // Config file should be removed
      expect(mockFs.files.has('/etc/nginx/sites-enabled/example.com.conf')).toBe(false);

      // Should have called nginx -t and reload
      expect(mockExec).toHaveBeenCalledWith('nginx -t');
      expect(mockExec).toHaveBeenCalledWith('nginx -s reload');

      // Domain should be removed from db
      expect(mockDb.domains.size).toBe(0);
    });

    it('should throw if domain not found', async () => {
      await expect(manager.deleteDomain('nonexistent')).rejects.toThrow(
        'Domain with id "nonexistent" not found'
      );
    });

    it('should rollback on nginx validation failure during delete', async () => {
      const added = await manager.addDomain({
        domain: 'example.com',
        proxyTarget: 'localhost:3000',
      });

      // Make nginx -t fail after deletion
      let callCount = 0;
      const failingExec = vi.fn(async (command: string) => {
        if (command === 'nginx -t') {
          callCount++;
          // The third call (first two from addDomain succeeded) should fail
          if (callCount === 1) {
            return { stdout: '', stderr: 'error after removal', exitCode: 1 };
          }
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const failManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: failingExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: mockDnsResolve,
      });

      await expect(failManager.deleteDomain(added.id)).rejects.toThrow(
        'Nginx configuration validation failed after removal'
      );

      // Config file should be restored (rollback)
      expect(mockFs.files.has('/etc/nginx/sites-enabled/example.com.conf')).toBe(true);
    });
  });

  // ─── validateDns ─────────────────────────────────────────────────────────

  describe('validateDns', () => {
    it('should return valid when domain resolves to server IP', async () => {
      const result = await manager.validateDns('example.com');

      expect(result.valid).toBe(true);
      expect(result.resolvedIps).toEqual(['1.2.3.4']);
      expect(result.serverIp).toBe('1.2.3.4');
      expect(result.warning).toBeUndefined();
    });

    it('should return invalid when domain does not resolve', async () => {
      const result = await manager.validateDns('nonexistent.example.com');

      expect(result.valid).toBe(false);
      expect(result.resolvedIps).toEqual([]);
      expect(result.warning).toContain('does not resolve to any IP address');
    });

    it('should return invalid when domain resolves to wrong IP', async () => {
      const customDnsResolve = createMockDnsResolve({
        'wrong.example.com': ['9.8.7.6'],
      });

      const customManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: mockExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: customDnsResolve,
        serverIp: '1.2.3.4',
      });

      const result = await customManager.validateDns('wrong.example.com');

      expect(result.valid).toBe(false);
      expect(result.resolvedIps).toEqual(['9.8.7.6']);
      expect(result.warning).toContain('resolves to [9.8.7.6] but server IP is 1.2.3.4');
    });

    it('should return valid without serverIp when domain resolves', async () => {
      const noIpManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: mockExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: mockDnsResolve,
      });

      const result = await noIpManager.validateDns('example.com');

      expect(result.valid).toBe(true);
      expect(result.resolvedIps).toEqual(['1.2.3.4']);
    });
  });

  // ─── reloadNginx ────────────────────────────────────────────────────────

  describe('reloadNginx', () => {
    it('should validate and reload nginx', async () => {
      await manager.reloadNginx();

      expect(mockExec).toHaveBeenCalledWith('nginx -t');
      expect(mockExec).toHaveBeenCalledWith('nginx -s reload');
    });

    it('should throw if nginx config is invalid', async () => {
      const failExec = createMockExec({
        'nginx -t': { stdout: '', stderr: 'syntax error', exitCode: 1 },
      });

      const failManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: failExec,
        fs: mockFs,
        db: mockDb,
        dnsResolve: mockDnsResolve,
      });

      await expect(failManager.reloadNginx()).rejects.toThrow('Nginx configuration is invalid');
    });
  });

  // ─── listDomains ─────────────────────────────────────────────────────────

  describe('listDomains', () => {
    it('should return all domains from the database', async () => {
      await manager.addDomain({ domain: 'first.example.com', proxyTarget: 'localhost:3000' });
      await manager.addDomain({ domain: 'second.example.com', proxyTarget: 'localhost:4000' });

      const domains = await manager.listDomains();

      expect(domains).toHaveLength(2);
      expect(domains.map((d) => d.domain).sort()).toEqual([
        'first.example.com',
        'second.example.com',
      ]);
    });

    it('should return empty array when no domains configured', async () => {
      const domains = await manager.listDomains();
      expect(domains).toHaveLength(0);
    });

    it('should return empty array when no database configured', async () => {
      const noDbManager = createDomainManager({
        sitesEnabledPath: '/etc/nginx/sites-enabled',
        execCommand: mockExec,
        fs: mockFs,
        dnsResolve: mockDnsResolve,
      });

      const domains = await noDbManager.listDomains();
      expect(domains).toHaveLength(0);
    });
  });

  // ─── isValidProxyTarget ──────────────────────────────────────────────────

  describe('isValidProxyTarget', () => {
    it('should accept valid host:port targets', () => {
      expect(isValidProxyTarget('localhost:3000')).toBe(true);
      expect(isValidProxyTarget('127.0.0.1:8080')).toBe(true);
      expect(isValidProxyTarget('my-service:4000')).toBe(true);
      expect(isValidProxyTarget('api.internal:443')).toBe(true);
      expect(isValidProxyTarget('host_name:1')).toBe(true);
      expect(isValidProxyTarget('host:65535')).toBe(true);
    });

    it('should reject invalid targets', () => {
      expect(isValidProxyTarget('')).toBe(false);
      expect(isValidProxyTarget('localhost')).toBe(false);
      expect(isValidProxyTarget(':3000')).toBe(false);
      expect(isValidProxyTarget('localhost:')).toBe(false);
      expect(isValidProxyTarget('localhost:0')).toBe(false);
      expect(isValidProxyTarget('localhost:65536')).toBe(false);
      expect(isValidProxyTarget('localhost:abc')).toBe(false);
      expect(isValidProxyTarget('host name:3000')).toBe(false);
      expect(isValidProxyTarget('host:3000:extra')).toBe(false);
    });
  });
});
