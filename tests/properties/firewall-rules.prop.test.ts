/**
 * Property 18: Firewall rule validation
 *
 * Test that rules blocking admin IP or panel port are rejected, and conflicts are detected.
 * - Deny rules that would block traffic to the panel port from 0.0.0.0/0 are rejected (valid: false)
 * - Deny rules that would block configured admin IPs are rejected (valid: false)
 * - Duplicate rules (same port/protocol/source/action) generate warnings
 * - Contradicting rules (same port/protocol/source but different action) generate warnings
 * - Valid rules that don't cause lockout pass validation (valid: true)
 *
 * **Validates: Requirements 26.3, 26.10**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  createSecurityManager,
  type SecurityManager,
  type FirewallRuleInput,
  type FirewallProtocol,
  type FirewallAction,
} from '../../src/modules/security-manager.ts';
import { SCHEMA_SQL } from '../../src/database/index.ts';

// --- Test Helpers ---

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/** No-op command executor for tests (prevents actual system calls) */
function noopExec(_cmd: string): string {
  return '';
}

const TEST_PANEL_PORT = 3000;
const TEST_ADMIN_IPS = ['192.168.1.100', '10.0.0.50'];

// --- Arbitraries ---

/** Arbitrary for a valid port number (1-65535) */
const portArb = fc.integer({ min: 1, max: 65535 });

/** Arbitrary for a port that is NOT the panel port */
const nonPanelPortArb = fc.integer({ min: 1, max: 65535 }).filter(p => p !== TEST_PANEL_PORT);

/** Arbitrary for protocol */
const protocolArb = fc.constantFrom<FirewallProtocol>('tcp', 'udp');

/** Arbitrary for action */
const actionArb = fc.constantFrom<FirewallAction>('allow', 'deny');

/** Arbitrary for a valid IPv4 octet */
const octetArb = fc.integer({ min: 0, max: 255 });

/** Arbitrary for a valid IPv4 address */
const ipArb = fc.tuple(octetArb, octetArb, octetArb, octetArb)
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Arbitrary for a valid CIDR prefix length */
const prefixArb = fc.integer({ min: 0, max: 32 });

/** Arbitrary for a valid IP or CIDR notation */
const sourceArb = fc.oneof(
  ipArb,
  fc.tuple(ipArb, prefixArb).map(([ip, prefix]) => `${ip}/${prefix}`),
  fc.constant('0.0.0.0/0')
);

/**
 * Arbitrary for a source that does NOT overlap with admin IPs or 0.0.0.0/0.
 * We use a distinct /32 IP not matching any admin IP.
 */
const safeSourceArb = fc.tuple(
  fc.integer({ min: 172, max: 172 }),
  fc.integer({ min: 16, max: 31 }),
  octetArb,
  fc.integer({ min: 1, max: 254 })
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`).filter(ip => {
  // Ensure it doesn't match any admin IP
  return !TEST_ADMIN_IPS.includes(ip);
});

/**
 * Arbitrary for a source CIDR that would encompass an admin IP.
 * Uses broad CIDRs like 192.168.0.0/16 or 10.0.0.0/8 or 0.0.0.0/0.
 */
const adminOverlapSourceArb = fc.oneof(
  fc.constant('0.0.0.0/0'),
  fc.constant('192.168.1.100'),
  fc.constant('192.168.1.0/24'),
  fc.constant('192.168.0.0/16'),
  fc.constant('10.0.0.50'),
  fc.constant('10.0.0.0/24'),
  fc.constant('10.0.0.0/8')
);

// --- Property Tests ---

describe('Property 18: Firewall rule validation', () => {
  let db: Database.Database;
  let securityManager: SecurityManager;

  beforeEach(() => {
    db = createTestDb();
    securityManager = createSecurityManager(db, {
      panelPort: TEST_PANEL_PORT,
      adminIPs: TEST_ADMIN_IPS,
      execCommand: noopExec,
      useUfw: false,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('deny rules targeting panel port from 0.0.0.0/0 are always rejected', () => {
    fc.assert(
      fc.property(protocolArb, (protocol) => {
        const rule: FirewallRuleInput = {
          port: TEST_PANEL_PORT,
          protocol,
          source: '0.0.0.0/0',
          action: 'deny',
        };

        const result = securityManager.validateFirewallRule(rule);

        if (result.valid) {
          throw new Error(
            `Expected deny rule for panel port ${TEST_PANEL_PORT} from 0.0.0.0/0 to be rejected, but it was valid`
          );
        }
        if (result.errors.length === 0) {
          throw new Error(
            `Expected errors to be present for deny rule targeting panel port, but errors array was empty`
          );
        }
      }),
      { numRuns: 20 }
    );
  });

  it('deny rules targeting panel port from admin IP sources are rejected', () => {
    fc.assert(
      fc.property(
        protocolArb,
        fc.constantFrom(...TEST_ADMIN_IPS),
        (protocol, adminIP) => {
          const rule: FirewallRuleInput = {
            port: TEST_PANEL_PORT,
            protocol,
            source: adminIP,
            action: 'deny',
          };

          const result = securityManager.validateFirewallRule(rule);

          if (result.valid) {
            throw new Error(
              `Expected deny rule for panel port from admin IP ${adminIP} to be rejected, but it was valid`
            );
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('deny rules blocking admin IPs on any port are rejected', () => {
    fc.assert(
      fc.property(
        portArb,
        protocolArb,
        adminOverlapSourceArb,
        (port, protocol, source) => {
          const rule: FirewallRuleInput = {
            port,
            protocol,
            source,
            action: 'deny',
          };

          const result = securityManager.validateFirewallRule(rule);

          // If source overlaps with an admin IP, the rule should be rejected
          // because it would block an admin
          if (result.valid) {
            throw new Error(
              `Expected deny rule blocking admin IP (source: ${source}, port: ${port}) to be rejected, but it was valid`
            );
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('duplicate rules generate warnings', () => {
    fc.assert(
      fc.property(
        nonPanelPortArb,
        protocolArb,
        safeSourceArb,
        actionArb,
        (port, protocol, source, action) => {
          // First, insert an existing rule into the database
          const id = `rule-${Date.now()}-${Math.random()}`;
          db.prepare(
            'INSERT INTO firewall_rules (id, port, protocol, source, action) VALUES (?, ?, ?, ?, ?)'
          ).run(id, port, protocol, source, action);

          // Now validate the same rule (duplicate)
          const rule: FirewallRuleInput = {
            port,
            protocol,
            source,
            action,
          };

          const result = securityManager.validateFirewallRule(rule);

          // Should have a warning about duplicate rule
          const hasDuplicateWarning = result.warnings.some(w =>
            w.toLowerCase().includes('duplicate')
          );
          if (!hasDuplicateWarning) {
            throw new Error(
              `Expected duplicate warning for rule (port: ${port}, protocol: ${protocol}, ` +
              `source: ${source}, action: ${action}), but got warnings: ${JSON.stringify(result.warnings)}`
            );
          }

          // Clean up
          db.prepare('DELETE FROM firewall_rules WHERE id = ?').run(id);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('contradicting rules generate warnings', () => {
    fc.assert(
      fc.property(
        nonPanelPortArb,
        protocolArb,
        safeSourceArb,
        (port, protocol, source) => {
          // Insert an existing rule with 'allow' action
          const id = `rule-${Date.now()}-${Math.random()}`;
          db.prepare(
            'INSERT INTO firewall_rules (id, port, protocol, source, action) VALUES (?, ?, ?, ?, ?)'
          ).run(id, port, protocol, source, 'allow');

          // Now validate a 'deny' rule for the same port/protocol/source (contradiction)
          const rule: FirewallRuleInput = {
            port,
            protocol,
            source,
            action: 'deny',
          };

          const result = securityManager.validateFirewallRule(rule);

          // Should have a warning about contradicting rule
          const hasContradictWarning = result.warnings.some(w =>
            w.toLowerCase().includes('contradict')
          );
          if (!hasContradictWarning) {
            throw new Error(
              `Expected contradiction warning for rule (port: ${port}, protocol: ${protocol}, ` +
              `source: ${source}, action: deny vs existing allow), but got warnings: ${JSON.stringify(result.warnings)}`
            );
          }

          // Clean up
          db.prepare('DELETE FROM firewall_rules WHERE id = ?').run(id);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('valid rules that do not cause lockout pass validation', () => {
    fc.assert(
      fc.property(
        nonPanelPortArb,
        protocolArb,
        safeSourceArb,
        actionArb,
        (port, protocol, source, action) => {
          // A rule on a non-panel port with a safe source should be valid
          const rule: FirewallRuleInput = {
            port,
            protocol,
            source,
            action,
          };

          const result = securityManager.validateFirewallRule(rule);

          if (!result.valid) {
            throw new Error(
              `Expected rule (port: ${port}, protocol: ${protocol}, source: ${source}, ` +
              `action: ${action}) to be valid, but got errors: ${JSON.stringify(result.errors)}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
