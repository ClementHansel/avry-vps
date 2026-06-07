/**
 * Property-based tests for Nginx configuration generation validity.
 *
 * Feature: vps-panel, Property 9: Nginx configuration generation validity
 * For any valid DomainConfig input, the generateNginxConfig function SHALL produce
 * a syntactically valid Nginx server block configuration containing the required
 * directives for proxying, headers, and optional SSL/WebSocket support.
 *
 * **Validates: Requirements 12.2, 12.3, 12.6**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateNginxConfig, DomainConfig } from '../../src/modules/domain-manager.js';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Arbitrary for valid domain names (simplified but representative).
 */
const domainArb = fc.tuple(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 20 }),
  fc.constantFrom('.com', '.org', '.net', '.io', '.dev', '.app', '.co.uk')
).map(([name, tld]) => `${name}${tld}`);

/**
 * Arbitrary for valid proxy targets (host:port).
 */
const proxyTargetArb = fc.tuple(
  fc.constantFrom('localhost', '127.0.0.1', '172.17.0.2', 'app', 'backend', 'web-service'),
  fc.integer({ min: 1, max: 65535 })
).map(([host, port]) => `${host}:${port}`);

/**
 * Arbitrary for valid HTTP header names (simplified alphanumeric + hyphens).
 */
const headerNameArb = fc.tuple(
  fc.constantFrom('X-Custom', 'X-Request-Id', 'X-Forwarded-Port', 'X-App-Version', 'Authorization'),
  fc.integer({ min: 0, max: 99 })
).map(([base, n]) => n === 0 ? base : `${base}-${n}`);

/**
 * Arbitrary for valid header values (no newlines or control characters).
 */
const headerValueArb = fc.constantFrom(
  '$remote_addr', '$host', '$scheme', '$request_uri',
  'custom-value', 'true', '1', 'application/json'
);

/**
 * Arbitrary for a Record<string, string> of custom headers (0 to 5 entries).
 */
const headersArb = fc.array(
  fc.tuple(headerNameArb, headerValueArb),
  { minLength: 0, maxLength: 5 }
).map((pairs) => Object.fromEntries(pairs));


/**
 * Arbitrary for a valid DomainConfig object.
 */
const domainConfigArb: fc.Arbitrary<DomainConfig> = fc.record({
  id: fc.uuid(),
  domain: domainArb,
  proxyTarget: proxyTargetArb,
  sslEnabled: fc.boolean(),
  headers: headersArb,
  websocketUpgrade: fc.boolean(),
  active: fc.boolean(),
});

// ─── Helper functions ──────────────────────────────────────────────────────────

/**
 * Checks that braces are balanced in the generated config.
 */
function areBracesBalanced(config: string): boolean {
  let depth = 0;
  for (const char of config) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Checks that the config contains at least one complete server block.
 */
function hasServerBlock(config: string): boolean {
  return /^server\s*\{/m.test(config);
}

/**
 * Checks that every server block contains a server_name directive.
 */
function hasServerName(config: string, domain: string): boolean {
  return config.includes(`server_name ${domain};`);
}

/**
 * Checks that the config contains a proxy_pass directive with the correct target.
 */
function hasProxyPass(config: string, target: string): boolean {
  return config.includes(`proxy_pass http://${target};`);
}

/**
 * Checks for listen directives in the config.
 */
function hasListenDirective(config: string): boolean {
  return /listen\s+\d+/.test(config);
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Nginx Configuration Generation Validity Property Tests', () => {
  it('Property 9.1: Generated config always has balanced braces', () => {
    fc.assert(
      fc.property(domainConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);
        expect(areBracesBalanced(nginxConfig)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  it('Property 9.2: Generated config always contains a valid server block structure', () => {
    fc.assert(
      fc.property(domainConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Must contain at least one server block
        expect(hasServerBlock(nginxConfig)).toBe(true);

        // Must contain server_name with the configured domain
        expect(hasServerName(nginxConfig, config.domain)).toBe(true);

        // Must contain a listen directive
        expect(hasListenDirective(nginxConfig)).toBe(true);

        // Must contain a proxy_pass directive to the target
        expect(hasProxyPass(nginxConfig, config.proxyTarget)).toBe(true);

        // Must contain a location block
        expect(nginxConfig).toContain('location / {');
      }),
      { numRuns: 500 }
    );
  });

  it('Property 9.3: SSL-enabled configs contain SSL directives and HTTP redirect block', () => {
    const sslEnabledConfigArb = domainConfigArb.map((config) => ({
      ...config,
      sslEnabled: true,
    }));

    fc.assert(
      fc.property(sslEnabledConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Must listen on 443 with ssl
        expect(nginxConfig).toContain('listen 443 ssl');

        // Must contain ssl_certificate directives
        expect(nginxConfig).toContain('ssl_certificate ');
        expect(nginxConfig).toContain('ssl_certificate_key ');

        // Must contain ssl_protocols
        expect(nginxConfig).toContain('ssl_protocols');

        // Must contain HTTP to HTTPS redirect
        expect(nginxConfig).toContain('return 301 https://');

        // Redirect block must listen on port 80
        expect(nginxConfig).toContain('listen 80;');
      }),
      { numRuns: 300 }
    );
  });

  it('Property 9.4: Non-SSL configs listen on port 80 without SSL directives', () => {
    const nonSslConfigArb = domainConfigArb.map((config) => ({
      ...config,
      sslEnabled: false,
    }));

    fc.assert(
      fc.property(nonSslConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Must listen on port 80
        expect(nginxConfig).toContain('listen 80;');

        // Must NOT contain ssl_certificate directives
        expect(nginxConfig).not.toContain('ssl_certificate ');
        expect(nginxConfig).not.toContain('ssl_certificate_key ');

        // Must NOT contain HTTPS redirect
        expect(nginxConfig).not.toContain('return 301 https://');
      }),
      { numRuns: 300 }
    );
  });

  it('Property 9.5: WebSocket upgrade configs include required upgrade directives', () => {
    const wsConfigArb = domainConfigArb.map((config) => ({
      ...config,
      websocketUpgrade: true,
    }));

    fc.assert(
      fc.property(wsConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Must contain WebSocket upgrade directives
        expect(nginxConfig).toContain('proxy_http_version 1.1;');
        expect(nginxConfig).toContain('proxy_set_header Upgrade $http_upgrade;');
        expect(nginxConfig).toContain('proxy_set_header Connection "upgrade";');
        expect(nginxConfig).toContain('proxy_read_timeout 86400;');
      }),
      { numRuns: 300 }
    );
  });

  it('Property 9.6: Non-WebSocket configs do not include upgrade directives', () => {
    const noWsConfigArb = domainConfigArb.map((config) => ({
      ...config,
      websocketUpgrade: false,
    }));

    fc.assert(
      fc.property(noWsConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Must NOT contain WebSocket-specific directives
        expect(nginxConfig).not.toContain('proxy_http_version 1.1;');
        expect(nginxConfig).not.toContain('proxy_set_header Upgrade $http_upgrade;');
        expect(nginxConfig).not.toContain('proxy_set_header Connection "upgrade";');
      }),
      { numRuns: 300 }
    );
  });

  it('Property 9.7: Default proxy headers are always present in generated config', () => {
    fc.assert(
      fc.property(domainConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Default headers must always be set
        expect(nginxConfig).toContain('proxy_set_header X-Forwarded-For');
        expect(nginxConfig).toContain('proxy_set_header X-Real-IP');
        expect(nginxConfig).toContain('proxy_set_header Host');
        expect(nginxConfig).toContain('proxy_set_header X-Forwarded-Proto');
      }),
      { numRuns: 500 }
    );
  });

  it('Property 9.8: Custom headers are included in generated config', () => {
    const configWithHeadersArb = fc.record({
      id: fc.uuid(),
      domain: domainArb,
      proxyTarget: proxyTargetArb,
      sslEnabled: fc.boolean(),
      headers: fc.array(
        fc.tuple(headerNameArb, headerValueArb),
        { minLength: 1, maxLength: 5 }
      ).map((pairs) => Object.fromEntries(pairs)),
      websocketUpgrade: fc.boolean(),
      active: fc.boolean(),
    });

    fc.assert(
      fc.property(configWithHeadersArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Each custom header must appear in the generated config
        for (const [headerName, headerValue] of Object.entries(config.headers)) {
          expect(nginxConfig).toContain(`proxy_set_header ${headerName} ${headerValue};`);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('Property 9.9: Generated config never contains empty lines inside directive blocks improperly', () => {
    fc.assert(
      fc.property(domainConfigArb, (config) => {
        const nginxConfig = generateNginxConfig(config);

        // Every line should be either:
        // - empty (blank separator)
        // - a directive (ending with ; or {)
        // - a closing brace }
        // - a comment starting with #
        const lines = nginxConfig.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') continue; // blank lines are OK as separators
          // Valid Nginx config lines
          const isValid =
            trimmed.endsWith(';') ||
            trimmed.endsWith('{') ||
            trimmed === '}' ||
            trimmed.startsWith('#');
          expect(isValid).toBe(true);
        }
      }),
      { numRuns: 500 }
    );
  });
});
