/**
 * Webhook Handler Module
 *
 * Receives and validates Git provider webhooks (GitHub, GitLab, Bitbucket),
 * extracts branch information from push event payloads, and triggers build
 * pipelines via the job queue when the branch matches the configured trigger.
 *
 * Features:
 * - Generate webhook URLs in format `/api/webhooks/{project-id}/{token}`
 * - Validate HMAC-SHA256 for GitHub/Bitbucket, token header for GitLab
 * - Extract branch from push event payload
 * - Trigger build pipeline via job queue if branch matches configured trigger
 * - Respond 200 for non-matching branches, 401 for invalid signatures
 * - Log all webhook requests (timestamp, source IP, project, branch, validation result, action)
 * - Display last 50 webhook events
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */
import type Database from 'better-sqlite3';
import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface WebhookConfig {
  id: string;
  projectId: string;
  url: string;
  token: string;
  secret?: string;
  triggerBranch: string;
  enabled: boolean;
  createdAt: string;
}

export type ValidationResult = 'valid' | 'invalid_signature' | 'branch_mismatch';

export interface WebhookEvent {
  id: string;
  webhookId: string;
  timestamp: string;
  sourceIp?: string;
  branch?: string;
  validationResult: ValidationResult;
  triggeredAction?: string;
  responseCode: number;
}

export interface WebhookResult {
  statusCode: number;
  message: string;
  jobId?: string;
}

export interface WebhookHeaders {
  [key: string]: string | undefined;
}

/**
 * Dependencies injected into the Webhook Handler for triggering builds.
 */
export interface WebhookHandlerDeps {
  /** Submit a build job for the given project. Returns the job ID. */
  triggerBuild: (projectId: string) => Promise<string>;
}

export interface WebhookHandler {
  /** Generate a webhook URL and config for a project. Creates a new config in the DB. */
  generateWebhookUrl(projectId: string, options?: { triggerBranch?: string }): WebhookConfig;
  /** Handle an incoming webhook request. Validates signature, extracts branch, triggers build. */
  handleRequest(
    projectId: string,
    token: string,
    headers: WebhookHeaders,
    body: string | Buffer,
    sourceIp?: string
  ): Promise<WebhookResult>;
  /** Get the last 50 webhook events for a project. */
  getWebhookHistory(projectId: string): WebhookEvent[];
  /** Get the webhook config for a project (if exists). */
  getWebhookConfig(projectId: string): WebhookConfig | null;
  /** Delete a webhook config for a project. */
  deleteWebhookConfig(projectId: string): void;
}

export interface WebhookHandlerConfig {
  /** The SQLite database instance */
  db: Database.Database;
  /** Dependencies for triggering builds */
  deps: WebhookHandlerDeps;
  /** Base URL for generating webhook URLs (e.g., "https://panel.aivory.id") */
  baseUrl?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a secure random token string using UUID v4 (no dashes).
 */
function generateToken(): string {
  return uuidv4().replace(/-/g, '');
}

/**
 * Generate a secret for HMAC signing.
 */
function generateSecret(): string {
  return uuidv4() + uuidv4();
}

/**
 * Compute HMAC-SHA256 signature of a payload with a given secret.
 */
function computeHmacSha256(secret: string, payload: string | Buffer): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : payload);
  return hmac.digest('hex');
}

/**
 * Detect the source provider from headers.
 */
function detectProvider(headers: WebhookHeaders): 'github' | 'gitlab' | 'bitbucket' | 'unknown' {
  // GitHub sends x-hub-signature-256 or x-github-event
  if (headers['x-hub-signature-256'] || headers['x-github-event']) {
    return 'github';
  }
  // GitLab sends x-gitlab-token and x-gitlab-event
  if (headers['x-gitlab-token'] || headers['x-gitlab-event']) {
    return 'gitlab';
  }
  // Bitbucket sends x-hub-signature or x-event-key
  if (headers['x-hub-signature'] || headers['x-event-key']) {
    return 'bitbucket';
  }
  return 'unknown';
}

/**
 * Validate the request signature based on provider type.
 * Returns true if signature is valid, false if invalid.
 * Returns true if no secret is configured (open webhook).
 */
function validateSignature(
  provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  headers: WebhookHeaders,
  body: string | Buffer,
  secret: string | undefined,
  token: string
): boolean {
  // If no secret is configured, accept all requests (token-only auth via URL)
  if (!secret) {
    return true;
  }

  switch (provider) {
    case 'github': {
      // GitHub: validate x-hub-signature-256 header using HMAC-SHA256
      const signature = headers['x-hub-signature-256'];
      if (!signature) return false;
      const expected = 'sha256=' + computeHmacSha256(secret, body);
      return timingSafeEqual(signature, expected);
    }
    case 'bitbucket': {
      // Bitbucket: validate x-hub-signature header using HMAC-SHA256
      const signature = headers['x-hub-signature'];
      if (!signature) return false;
      const expected = 'sha256=' + computeHmacSha256(secret, body);
      return timingSafeEqual(signature, expected);
    }
    case 'gitlab': {
      // GitLab: validate x-gitlab-token header matches stored token/secret
      const headerToken = headers['x-gitlab-token'];
      if (!headerToken) return false;
      return timingSafeEqual(headerToken, secret);
    }
    default: {
      // Unknown provider with a secret configured — try HMAC with common headers
      const sig = headers['x-hub-signature-256'] || headers['x-hub-signature'];
      if (sig) {
        const expected = 'sha256=' + computeHmacSha256(secret, body);
        return timingSafeEqual(sig, expected);
      }
      // No recognizable signature header — reject
      return false;
    }
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Extract branch name from a push event payload.
 * Supports GitHub, GitLab, and Bitbucket payload formats.
 */
function extractBranch(body: any, provider: 'github' | 'gitlab' | 'bitbucket' | 'unknown'): string | null {
  try {
    const payload = typeof body === 'string' ? JSON.parse(body) : body;

    switch (provider) {
      case 'github': {
        // GitHub: "ref" field is "refs/heads/branch-name"
        const ref = payload.ref;
        if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
          return ref.replace('refs/heads/', '');
        }
        return null;
      }
      case 'gitlab': {
        // GitLab: "ref" field is "refs/heads/branch-name"
        const ref = payload.ref;
        if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
          return ref.replace('refs/heads/', '');
        }
        // GitLab can also have just "branch-name" as ref in some event types
        if (typeof ref === 'string' && !ref.includes('/')) {
          return ref;
        }
        return null;
      }
      case 'bitbucket': {
        // Bitbucket: push events have changes[0].new.name
        if (payload.push?.changes?.[0]?.new?.name) {
          return payload.push.changes[0].new.name;
        }
        // Alternative Bitbucket format
        if (payload.changes?.[0]?.ref?.displayId) {
          return payload.changes[0].ref.displayId;
        }
        return null;
      }
      default: {
        // Try common patterns
        const ref = payload.ref;
        if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
          return ref.replace('refs/heads/', '');
        }
        if (typeof ref === 'string') {
          return ref;
        }
        return null;
      }
    }
  } catch {
    return null;
  }
}

// ─── Raw DB Row Type ───────────────────────────────────────────────────────────

interface RawWebhookConfigRow {
  id: string;
  project_id: string;
  token: string;
  secret: string | null;
  trigger_branch: string;
  enabled: number;
  created_at: string;
}

interface RawWebhookEventRow {
  id: string;
  webhook_id: string;
  timestamp: string;
  source_ip: string | null;
  branch: string | null;
  validation_result: string | null;
  triggered_action: string | null;
  response_code: number | null;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createWebhookHandler(config: WebhookHandlerConfig): WebhookHandler {
  const { db, deps, baseUrl = '' } = config;

  // ─── Prepared Statements ─────────────────────────────────────────────────

  const insertConfigStmt = db.prepare(`
    INSERT INTO webhook_configs (id, project_id, token, secret, trigger_branch, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);

  const getConfigByProjectStmt = db.prepare(`
    SELECT id, project_id, token, secret, trigger_branch, enabled, created_at
    FROM webhook_configs
    WHERE project_id = ?
  `);

  const getConfigByTokenStmt = db.prepare(`
    SELECT id, project_id, token, secret, trigger_branch, enabled, created_at
    FROM webhook_configs
    WHERE token = ? AND project_id = ?
  `);

  const deleteConfigByProjectStmt = db.prepare(`
    DELETE FROM webhook_configs WHERE project_id = ?
  `);

  const insertEventStmt = db.prepare(`
    INSERT INTO webhook_events (id, webhook_id, timestamp, source_ip, branch, validation_result, triggered_action, response_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getEventsByWebhookStmt = db.prepare(`
    SELECT id, webhook_id, timestamp, source_ip, branch, validation_result, triggered_action, response_code
    FROM webhook_events
    WHERE webhook_id = ?
    ORDER BY timestamp DESC
    LIMIT 50
  `);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function parseConfigRow(row: RawWebhookConfigRow): WebhookConfig {
    return {
      id: row.id,
      projectId: row.project_id,
      url: `${baseUrl}/api/webhooks/${row.project_id}/${row.token}`,
      token: row.token,
      secret: row.secret ?? undefined,
      triggerBranch: row.trigger_branch,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    };
  }

  function parseEventRow(row: RawWebhookEventRow): WebhookEvent {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      timestamp: row.timestamp,
      sourceIp: row.source_ip ?? undefined,
      branch: row.branch ?? undefined,
      validationResult: (row.validation_result as ValidationResult) ?? 'valid',
      triggeredAction: row.triggered_action ?? undefined,
      responseCode: row.response_code ?? 200,
    };
  }

  function logEvent(
    webhookId: string,
    sourceIp: string | undefined,
    branch: string | undefined,
    validationResult: ValidationResult,
    triggeredAction: string | undefined,
    responseCode: number
  ): void {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    insertEventStmt.run(
      id,
      webhookId,
      timestamp,
      sourceIp ?? null,
      branch ?? null,
      validationResult,
      triggeredAction ?? null,
      responseCode
    );
  }

  // ─── Public Methods ──────────────────────────────────────────────────────

  function generateWebhookUrl(projectId: string, options?: { triggerBranch?: string }): WebhookConfig {
    // Check if a config already exists for this project
    const existing = getConfigByProjectStmt.get(projectId) as RawWebhookConfigRow | undefined;
    if (existing) {
      return parseConfigRow(existing);
    }

    const id = uuidv4();
    const token = generateToken();
    const secret = generateSecret();
    const triggerBranch = options?.triggerBranch ?? 'main';
    const now = new Date().toISOString();

    insertConfigStmt.run(id, projectId, token, secret, triggerBranch, now);

    return {
      id,
      projectId,
      url: `${baseUrl}/api/webhooks/${projectId}/${token}`,
      token,
      secret,
      triggerBranch,
      enabled: true,
      createdAt: now,
    };
  }

  async function handleRequest(
    projectId: string,
    token: string,
    headers: WebhookHeaders,
    body: string | Buffer,
    sourceIp?: string
  ): Promise<WebhookResult> {
    // Look up webhook config by project and token
    const configRow = getConfigByTokenStmt.get(token, projectId) as RawWebhookConfigRow | undefined;

    if (!configRow) {
      // No matching config found — return 401
      return { statusCode: 401, message: 'Webhook configuration not found' };
    }

    if (!configRow.enabled) {
      return { statusCode: 200, message: 'Webhook is disabled' };
    }

    const webhookConfig = parseConfigRow(configRow);

    // Normalize headers to lowercase keys
    const normalizedHeaders: WebhookHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }

    // Detect provider
    const provider = detectProvider(normalizedHeaders);

    // Validate signature
    const isValid = validateSignature(
      provider,
      normalizedHeaders,
      body,
      webhookConfig.secret,
      webhookConfig.token
    );

    if (!isValid) {
      // Log the rejected request
      logEvent(webhookConfig.id, sourceIp, undefined, 'invalid_signature', undefined, 401);
      return { statusCode: 401, message: 'Invalid webhook signature' };
    }

    // Parse body for branch extraction
    const parsedBody = typeof body === 'string' ? body : body.toString('utf-8');
    const branch = extractBranch(parsedBody, provider);

    // Check if branch matches trigger
    if (!branch || branch !== webhookConfig.triggerBranch) {
      // Valid signature but non-matching branch — return 200
      logEvent(webhookConfig.id, sourceIp, branch ?? undefined, 'branch_mismatch', undefined, 200);
      return { statusCode: 200, message: `Branch "${branch ?? 'unknown'}" does not match trigger branch "${webhookConfig.triggerBranch}"` };
    }

    // Branch matches — trigger build pipeline
    let jobId: string | undefined;
    let triggeredAction = 'build_triggered';

    try {
      jobId = await deps.triggerBuild(projectId);
      triggeredAction = `build_triggered:${jobId}`;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      triggeredAction = `build_failed:${errorMsg}`;
      logEvent(webhookConfig.id, sourceIp, branch, 'valid', triggeredAction, 200);
      return { statusCode: 200, message: `Build trigger failed: ${errorMsg}` };
    }

    // Log the successful trigger
    logEvent(webhookConfig.id, sourceIp, branch, 'valid', triggeredAction, 200);

    return {
      statusCode: 200,
      message: `Build triggered for branch "${branch}"`,
      jobId,
    };
  }

  function getWebhookHistory(projectId: string): WebhookEvent[] {
    // Get the config for this project to get the webhook ID
    const configRow = getConfigByProjectStmt.get(projectId) as RawWebhookConfigRow | undefined;
    if (!configRow) {
      return [];
    }

    const rows = getEventsByWebhookStmt.all(configRow.id) as RawWebhookEventRow[];
    return rows.map(parseEventRow);
  }

  function getWebhookConfig(projectId: string): WebhookConfig | null {
    const row = getConfigByProjectStmt.get(projectId) as RawWebhookConfigRow | undefined;
    if (!row) return null;
    return parseConfigRow(row);
  }

  function deleteWebhookConfig(projectId: string): void {
    deleteConfigByProjectStmt.run(projectId);
  }

  // ─── Return the public API ──────────────────────────────────────────────

  return {
    generateWebhookUrl,
    handleRequest,
    getWebhookHistory,
    getWebhookConfig,
    deleteWebhookConfig,
  };
}
