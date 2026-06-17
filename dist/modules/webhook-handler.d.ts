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
    generateWebhookUrl(projectId: string, options?: {
        triggerBranch?: string;
    }): WebhookConfig;
    /** Handle an incoming webhook request. Validates signature, extracts branch, triggers build. */
    handleRequest(projectId: string, token: string, headers: WebhookHeaders, body: string | Buffer, sourceIp?: string): Promise<WebhookResult>;
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
export declare function createWebhookHandler(config: WebhookHandlerConfig): WebhookHandler;
//# sourceMappingURL=webhook-handler.d.ts.map