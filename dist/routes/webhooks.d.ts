/**
 * Webhook Routes
 *
 * Endpoints for webhook management:
 * generate URL, receive events, history.
 *
 * Note: The receive endpoint (/api/webhooks/:projectId/:token) is excluded
 * from auth middleware as it must be publicly accessible for Git providers.
 */
import { Router } from 'express';
import type { WebhookHandler } from '../modules/webhook-handler.js';
import type { AuditLogger } from '../modules/audit-logger.js';
export declare function createWebhooksRouter(webhookHandler: WebhookHandler, auditLogger: AuditLogger): Router;
//# sourceMappingURL=webhooks.d.ts.map