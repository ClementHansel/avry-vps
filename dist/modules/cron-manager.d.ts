/**
 * Cron Manager Module
 *
 * Provides viewing, creating, editing, and deleting of cron jobs on the VPS.
 * Validates cron expressions using cron-parser, generates human-readable
 * descriptions, and tracks execution history.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */
import type Database from 'better-sqlite3';
export interface CronJob {
    id: string;
    expression: string;
    command: string;
    user: string;
    enabled: boolean;
    description: string;
    lastExecution?: CronExecution;
    createdAt: Date;
}
export interface CronJobInput {
    expression: string;
    command: string;
    user?: string;
    enabled?: boolean;
}
export interface CronExecution {
    id: string;
    jobId: string;
    timestamp: Date;
    exitCode: number | null;
    output: string;
}
export interface ValidationResult {
    valid: boolean;
    error?: string;
    nextRun?: Date;
}
export interface CronManager {
    listJobs(): Promise<CronJob[]>;
    createJob(job: CronJobInput): Promise<CronJob>;
    updateJob(id: string, job: Partial<CronJobInput>): Promise<CronJob>;
    deleteJob(id: string): Promise<void>;
    validateExpression(expr: string): ValidationResult;
    describeExpression(expr: string): string;
    getJobHistory(id: string, limit?: number): Promise<CronExecution[]>;
    recordExecution(jobId: string, exitCode: number | null, output: string): Promise<CronExecution>;
}
export interface CronManagerConfig {
    /** Function to execute shell commands. Defaults to child_process.exec. */
    execCommand?: (command: string) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    /** Maximum output length to store per execution. Default: 1000 */
    maxOutputLength?: number;
}
export declare function createCronManager(db: Database.Database, config?: CronManagerConfig): CronManager;
/**
 * Validate a cron expression using cron-parser.
 * Returns whether the expression is valid and optionally the next run time.
 */
export declare function validateExpression(expr: string): ValidationResult;
/**
 * Generate a human-readable description from a cron expression.
 * Uses pattern matching on the 5 cron fields to produce descriptions like:
 * - "Every minute"
 * - "Every day at 3:00 AM"
 * - "Every hour at minute 30"
 */
export declare function describeExpression(expr: string): string;
/**
 * Sync the database jobs for a specific user to the system crontab.
 * Reads all enabled jobs for the user from DB, writes them to crontab.
 */
export declare function syncCrontab(db: Database.Database, user: string, execCommand: (command: string) => Promise<{
    stdout: string;
    stderr: string;
}>): Promise<void>;
//# sourceMappingURL=cron-manager.d.ts.map