"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebhookHandler = createWebhookHandler;
const crypto_1 = require("crypto");
const uuid_1 = require("uuid");
// ─── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Generate a secure random token string using UUID v4 (no dashes).
 */
function generateToken() {
    return (0, uuid_1.v4)().replace(/-/g, '');
}
/**
 * Generate a secret for HMAC signing.
 */
function generateSecret() {
    return (0, uuid_1.v4)() + (0, uuid_1.v4)();
}
/**
 * Compute HMAC-SHA256 signature of a payload with a given secret.
 */
function computeHmacSha256(secret, payload) {
    const hmac = (0, crypto_1.createHmac)('sha256', secret);
    hmac.update(typeof payload === 'string' ? payload : payload);
    return hmac.digest('hex');
}
/**
 * Detect the source provider from headers.
 */
function detectProvider(headers) {
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
function validateSignature(provider, headers, body, secret, token) {
    // If no secret is configured, accept all requests (token-only auth via URL)
    if (!secret) {
        return true;
    }
    switch (provider) {
        case 'github': {
            // GitHub: validate x-hub-signature-256 header using HMAC-SHA256
            const signature = headers['x-hub-signature-256'];
            if (!signature)
                return false;
            const expected = 'sha256=' + computeHmacSha256(secret, body);
            return timingSafeEqual(signature, expected);
        }
        case 'bitbucket': {
            // Bitbucket: validate x-hub-signature header using HMAC-SHA256
            const signature = headers['x-hub-signature'];
            if (!signature)
                return false;
            const expected = 'sha256=' + computeHmacSha256(secret, body);
            return timingSafeEqual(signature, expected);
        }
        case 'gitlab': {
            // GitLab: validate x-gitlab-token header matches stored token/secret
            const headerToken = headers['x-gitlab-token'];
            if (!headerToken)
                return false;
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
function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
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
function extractBranch(body, provider) {
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
    }
    catch {
        return null;
    }
}
// ─── Implementation ────────────────────────────────────────────────────────────
function createWebhookHandler(config) {
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
    function parseConfigRow(row) {
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
    function parseEventRow(row) {
        return {
            id: row.id,
            webhookId: row.webhook_id,
            timestamp: row.timestamp,
            sourceIp: row.source_ip ?? undefined,
            branch: row.branch ?? undefined,
            validationResult: row.validation_result ?? 'valid',
            triggeredAction: row.triggered_action ?? undefined,
            responseCode: row.response_code ?? 200,
        };
    }
    function logEvent(webhookId, sourceIp, branch, validationResult, triggeredAction, responseCode) {
        const id = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        insertEventStmt.run(id, webhookId, timestamp, sourceIp ?? null, branch ?? null, validationResult, triggeredAction ?? null, responseCode);
    }
    // ─── Public Methods ──────────────────────────────────────────────────────
    function generateWebhookUrl(projectId, options) {
        // Check if a config already exists for this project
        const existing = getConfigByProjectStmt.get(projectId);
        if (existing) {
            return parseConfigRow(existing);
        }
        const id = (0, uuid_1.v4)();
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
    async function handleRequest(projectId, token, headers, body, sourceIp) {
        // Look up webhook config by project and token
        const configRow = getConfigByTokenStmt.get(token, projectId);
        if (!configRow) {
            // No matching config found — return 401
            return { statusCode: 401, message: 'Webhook configuration not found' };
        }
        if (!configRow.enabled) {
            return { statusCode: 200, message: 'Webhook is disabled' };
        }
        const webhookConfig = parseConfigRow(configRow);
        // Normalize headers to lowercase keys
        const normalizedHeaders = {};
        for (const [key, value] of Object.entries(headers)) {
            normalizedHeaders[key.toLowerCase()] = value;
        }
        // Detect provider
        const provider = detectProvider(normalizedHeaders);
        // Validate signature
        const isValid = validateSignature(provider, normalizedHeaders, body, webhookConfig.secret, webhookConfig.token);
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
        let jobId;
        let triggeredAction = 'build_triggered';
        try {
            jobId = await deps.triggerBuild(projectId);
            triggeredAction = `build_triggered:${jobId}`;
        }
        catch (error) {
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
    function getWebhookHistory(projectId) {
        // Get the config for this project to get the webhook ID
        const configRow = getConfigByProjectStmt.get(projectId);
        if (!configRow) {
            return [];
        }
        const rows = getEventsByWebhookStmt.all(configRow.id);
        return rows.map(parseEventRow);
    }
    function getWebhookConfig(projectId) {
        const row = getConfigByProjectStmt.get(projectId);
        if (!row)
            return null;
        return parseConfigRow(row);
    }
    function deleteWebhookConfig(projectId) {
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
//# sourceMappingURL=webhook-handler.js.map