/**
 * Property 16: Webhook signature validation
 *
 * Test that webhook handler accepts request if and only if HMAC-SHA256 matches.
 * For any HTTP request body, secret string, and HMAC-SHA256 signature, the webhook
 * handler SHALL accept the request if and only if the computed HMAC-SHA256 of the
 * body using the secret matches the provided signature.
 *
 * **Validates: Requirements 21.4**
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import { createWebhookHandler, type WebhookHandler, type WebhookHandlerDeps } from '../../src/modules/webhook-handler.ts';
import { SCHEMA_SQL } from '../../src/database/index.ts';

// --- Test Helpers ---

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function computeHmacSha256(secret: string, payload: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

/**
 * Create a valid push event payload for GitHub format.
 */
function makeGitHubPayload(branch: string): string {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    repository: { full_name: 'user/repo' },
    pusher: { name: 'test-user' },
  });
}

/**
 * Arbitrary for non-empty payload strings (simulating webhook body content).
 */
const payloadArb = fc.json().filter(s => s.length > 0);

/**
 * Arbitrary for a secret string (non-empty, printable ASCII).
 */
const secretArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '_', '.', '!', '@', '#', '$', '%', '^', '&', '*'
  ),
  { minLength: 8, maxLength: 64 }
);

/**
 * Arbitrary for an incorrect signature (hex string that won't match the correct HMAC).
 */
const wrongSignatureArb = fc.hexaString({ minLength: 64, maxLength: 64 });

// --- Property Tests ---

describe('Property 16: Webhook signature validation', () => {
  let db: Database.Database;
  let handler: WebhookHandler;
  let deps: WebhookHandlerDeps;

  beforeEach(() => {
    db = createTestDb();
    // Insert a project for the webhook config to reference
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('test-project', 'Test Project');

    deps = {
      triggerBuild: async (_projectId: string) => 'job-123',
    };

    handler = createWebhookHandler({
      db,
      deps,
      baseUrl: 'https://panel.example.com',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('GitHub: accepts request when HMAC-SHA256 signature is correct', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        // Generate a webhook config for the project
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });

        // The handler generates a secret, use it to compute the correct signature
        const secret = config.secret!;
        const correctSignature = 'sha256=' + computeHmacSha256(secret, payload);

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature-256': correctSignature,
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        // Should be accepted (200) - not rejected with 401
        if (result.statusCode === 401) {
          throw new Error(
            `Expected request to be accepted (200) with correct signature, got 401: ${result.message}`
          );
        }

        // Clean up for next iteration (delete webhook config)
        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('GitHub: rejects request when HMAC-SHA256 signature is incorrect', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, wrongSignatureArb, async (payload, wrongHex) => {
        // Generate a webhook config
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;

        // Compute the correct signature to ensure wrong one differs
        const correctHex = computeHmacSha256(secret, payload);
        // If by chance the random hex matches, skip this iteration
        if (wrongHex === correctHex) return;

        const wrongSignature = 'sha256=' + wrongHex;

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature-256': wrongSignature,
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode !== 401) {
          throw new Error(
            `Expected request to be rejected (401) with incorrect signature, got ${result.statusCode}: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('GitHub: rejects request when signature header is missing', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });

        // Send request with GitHub event header but no signature header
        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode !== 401) {
          throw new Error(
            `Expected request to be rejected (401) with missing signature, got ${result.statusCode}: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('Bitbucket: accepts request when HMAC-SHA256 signature is correct', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;
        const correctSignature = 'sha256=' + computeHmacSha256(secret, payload);

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature': correctSignature,
            'x-event-key': 'repo:push',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode === 401) {
          throw new Error(
            `Expected Bitbucket request to be accepted with correct signature, got 401: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('Bitbucket: rejects request when HMAC-SHA256 signature is incorrect', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, wrongSignatureArb, async (payload, wrongHex) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;
        const correctHex = computeHmacSha256(secret, payload);
        if (wrongHex === correctHex) return;

        const wrongSignature = 'sha256=' + wrongHex;

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature': wrongSignature,
            'x-event-key': 'repo:push',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode !== 401) {
          throw new Error(
            `Expected Bitbucket request to be rejected (401) with incorrect signature, got ${result.statusCode}: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('GitLab: accepts request when token header matches secret', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-gitlab-token': secret,
            'x-gitlab-event': 'Push Hook',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode === 401) {
          throw new Error(
            `Expected GitLab request to be accepted with correct token, got 401: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('GitLab: rejects request when token header does not match secret', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, secretArb, async (payload, wrongToken) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;

        // Ensure wrong token actually differs from the real secret
        if (wrongToken === secret) return;

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-gitlab-token': wrongToken,
            'x-gitlab-event': 'Push Hook',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode !== 401) {
          throw new Error(
            `Expected GitLab request to be rejected (401) with wrong token, got ${result.statusCode}: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('GitLab: rejects request when token header is missing', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });

        const result = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-gitlab-event': 'Push Hook',
            'content-type': 'application/json',
          },
          payload,
          '127.0.0.1'
        );

        if (result.statusCode !== 401) {
          throw new Error(
            `Expected GitLab request to be rejected (401) with missing token header, got ${result.statusCode}: ${result.message}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 50 }
    );
  });

  it('validation is consistent regardless of payload content', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, payloadArb, async (payload1, payload2) => {
        const config = handler.generateWebhookUrl('test-project', { triggerBranch: 'main' });
        const secret = config.secret!;

        // Both payloads with correct signatures should be accepted
        const sig1 = 'sha256=' + computeHmacSha256(secret, payload1);
        const sig2 = 'sha256=' + computeHmacSha256(secret, payload2);

        const result1 = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature-256': sig1,
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload1,
          '127.0.0.1'
        );

        const result2 = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature-256': sig2,
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload2,
          '127.0.0.1'
        );

        // Both should be accepted (not 401)
        if (result1.statusCode === 401) {
          throw new Error(
            `Payload 1 with correct signature was rejected (401): ${result1.message}`
          );
        }
        if (result2.statusCode === 401) {
          throw new Error(
            `Payload 2 with correct signature was rejected (401): ${result2.message}`
          );
        }

        // Now test with swapped signatures — both should be rejected
        const result1WithWrongSig = await handler.handleRequest(
          'test-project',
          config.token,
          {
            'x-hub-signature-256': sig2,
            'x-github-event': 'push',
            'content-type': 'application/json',
          },
          payload1,
          '127.0.0.1'
        );

        // If the payloads are different, the swapped signature should fail
        if (payload1 !== payload2 && result1WithWrongSig.statusCode !== 401) {
          throw new Error(
            `Payload 1 with payload 2's signature should be rejected when payloads differ, got ${result1WithWrongSig.statusCode}`
          );
        }

        handler.deleteWebhookConfig('test-project');
      }),
      { numRuns: 30 }
    );
  });
});
