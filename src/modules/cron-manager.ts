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
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import cronParser from 'cron-parser';

const execAsync = promisify(exec);

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  expression: string;
  command: string;
  user: string;
  enabled: boolean;
  description: string; // human-readable schedule description
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
  output: string; // limited to 1000 chars
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
  execCommand?: (command: string) => Promise<{ stdout: string; stderr: string }>;
  /** Maximum output length to store per execution. Default: 1000 */
  maxOutputLength?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_LENGTH = 1000;
const DEFAULT_USER = 'root';

// ─── Implementation ────────────────────────────────────────────────────────────

export function createCronManager(
  db: Database.Database,
  config?: CronManagerConfig
): CronManager {
  const execCommand = config?.execCommand ?? defaultExecCommand;
  const maxOutputLength = config?.maxOutputLength ?? MAX_OUTPUT_LENGTH;

  // Prepared statements
  const insertJobStmt = db.prepare(`
    INSERT INTO cron_jobs (id, expression, command, user, enabled, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const updateJobStmt = db.prepare(`
    UPDATE cron_jobs SET expression = ?, command = ?, user = ?, enabled = ?, description = ?, created_at = created_at
    WHERE id = ?
  `);

  const deleteJobStmt = db.prepare(`DELETE FROM cron_jobs WHERE id = ?`);

  const getJobStmt = db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`);

  const listJobsStmt = db.prepare(`SELECT * FROM cron_jobs ORDER BY created_at DESC`);

  const insertExecutionStmt = db.prepare(`
    INSERT INTO cron_executions (id, job_id, timestamp, exit_code, output)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getHistoryStmt = db.prepare(`
    SELECT * FROM cron_executions WHERE job_id = ? ORDER BY timestamp DESC LIMIT ?
  `);

  const getLastExecutionStmt = db.prepare(`
    SELECT * FROM cron_executions WHERE job_id = ? ORDER BY timestamp DESC LIMIT 1
  `);

  // ─── listJobs ──────────────────────────────────────────────────────────────

  async function listJobs(): Promise<CronJob[]> {
    const rows = listJobsStmt.all() as RawCronJobRow[];
    return rows.map((row) => {
      const lastExec = getLastExecutionStmt.get(row.id) as RawCronExecutionRow | undefined;
      return rowToJob(row, lastExec);
    });
  }

  // ─── createJob ─────────────────────────────────────────────────────────────

  async function createJob(input: CronJobInput): Promise<CronJob> {
    // Validate expression
    const validation = validateExpression(input.expression);
    if (!validation.valid) {
      throw new Error(`Invalid cron expression: ${validation.error}`);
    }

    const id = uuidv4();
    const user = input.user ?? DEFAULT_USER;
    const enabled = input.enabled !== false;
    const description = describeExpression(input.expression);
    const createdAt = new Date().toISOString();

    insertJobStmt.run(id, input.expression, input.command, user, enabled ? 1 : 0, description, createdAt);

    // Sync to system crontab
    await syncCrontab(db, user, execCommand);

    const row = getJobStmt.get(id) as RawCronJobRow;
    return rowToJob(row);
  }

  // ─── updateJob ─────────────────────────────────────────────────────────────

  async function updateJob(id: string, input: Partial<CronJobInput>): Promise<CronJob> {
    const existing = getJobStmt.get(id) as RawCronJobRow | undefined;
    if (!existing) {
      throw new Error(`Cron job not found: ${id}`);
    }

    const expression = input.expression ?? existing.expression;
    const command = input.command ?? existing.command;
    const user = input.user ?? existing.user;
    const enabled = input.enabled !== undefined ? input.enabled : existing.enabled === 1;

    // Validate expression if changed
    if (input.expression) {
      const validation = validateExpression(input.expression);
      if (!validation.valid) {
        throw new Error(`Invalid cron expression: ${validation.error}`);
      }
    }

    const description = describeExpression(expression);

    updateJobStmt.run(expression, command, user, enabled ? 1 : 0, description, id);

    // Sync to system crontab for old and new user
    const oldUser = existing.user;
    await syncCrontab(db, user, execCommand);
    if (oldUser !== user) {
      await syncCrontab(db, oldUser, execCommand);
    }

    const row = getJobStmt.get(id) as RawCronJobRow;
    const lastExec = getLastExecutionStmt.get(id) as RawCronExecutionRow | undefined;
    return rowToJob(row, lastExec);
  }

  // ─── deleteJob ─────────────────────────────────────────────────────────────

  async function deleteJob(id: string): Promise<void> {
    const existing = getJobStmt.get(id) as RawCronJobRow | undefined;
    if (!existing) {
      throw new Error(`Cron job not found: ${id}`);
    }

    deleteJobStmt.run(id);

    // Sync crontab for the user
    await syncCrontab(db, existing.user, execCommand);
  }

  // ─── getJobHistory ─────────────────────────────────────────────────────────

  async function getJobHistory(id: string, limit: number = 50): Promise<CronExecution[]> {
    const rows = getHistoryStmt.all(id, limit) as RawCronExecutionRow[];
    return rows.map(rowToExecution);
  }

  // ─── recordExecution ───────────────────────────────────────────────────────

  async function recordExecution(
    jobId: string,
    exitCode: number | null,
    output: string
  ): Promise<CronExecution> {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const truncatedOutput = output.length > maxOutputLength
      ? output.slice(0, maxOutputLength)
      : output;

    insertExecutionStmt.run(id, jobId, timestamp, exitCode, truncatedOutput);

    return {
      id,
      jobId,
      timestamp: new Date(timestamp),
      exitCode,
      output: truncatedOutput,
    };
  }

  // ─── Return the public API ─────────────────────────────────────────────────

  return {
    listJobs,
    createJob,
    updateJob,
    deleteJob,
    validateExpression,
    describeExpression,
    getJobHistory,
    recordExecution,
  };
}

// ─── Exported Pure Functions ───────────────────────────────────────────────────

/**
 * Validate a cron expression using cron-parser.
 * Returns whether the expression is valid and optionally the next run time.
 */
export function validateExpression(expr: string): ValidationResult {
  // Empty or whitespace-only strings are invalid
  if (!expr || !expr.trim()) {
    return { valid: false, error: 'Expression cannot be empty' };
  }

  try {
    const interval = cronParser.parseExpression(expr);
    const nextRun = interval.next().toDate();
    return { valid: true, nextRun };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: message };
  }
}

/**
 * Generate a human-readable description from a cron expression.
 * Uses pattern matching on the 5 cron fields to produce descriptions like:
 * - "Every minute"
 * - "Every day at 3:00 AM"
 * - "Every hour at minute 30"
 */
export function describeExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) {
    return expr; // Not a valid expression, return as-is
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every minute';
  }

  // Step patterns: */N
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const step = minute.slice(2);
    return `Every ${step} minutes`;
  }

  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const step = hour.slice(2);
    return `Every ${step} hours`;
  }

  // At the top of every hour (0 * * * *)
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every hour';
  }

  // Specific minute every hour
  if (minute !== '*' && !minute.includes('/') && !minute.includes(',') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every hour at minute ${minute}`;
  }

  // Specific time every day
  if (!minute.includes('*') && !minute.includes('/') && !minute.includes(',') && !hour.includes('*') && !hour.includes('/') && !hour.includes(',') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const timeStr = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    return `Every day at ${timeStr}`;
  }

  // Specific time on specific weekdays
  if (!minute.includes('*') && !minute.includes('/') && !minute.includes(',') && !hour.includes('*') && !hour.includes('/') && !hour.includes(',') && dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    const timeStr = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    const days = parseWeekdays(dayOfWeek);
    if (days === 'weekdays') {
      return `Weekdays at ${timeStr}`;
    }
    if (days === 'weekends') {
      return `Weekends at ${timeStr}`;
    }
    return `${days} at ${timeStr}`;
  }

  // Specific time on specific days of month
  if (!minute.includes('*') && !minute.includes('/') && !minute.includes(',') && !hour.includes('*') && !hour.includes('/') && !hour.includes(',') && dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    const timeStr = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    return `Day ${dayOfMonth} of every month at ${timeStr}`;
  }

  // Specific time on specific month and day
  if (!minute.includes('*') && !minute.includes('/') && !minute.includes(',') && !hour.includes('*') && !hour.includes('/') && !hour.includes(',') && dayOfMonth !== '*' && month !== '*' && dayOfWeek === '*') {
    const timeStr = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    const monthName = getMonthName(month);
    return `${monthName} ${dayOfMonth} at ${timeStr}`;
  }

  // At the top of every hour (duplicate guard removed, handled above)

  // Fallback: return a generic description
  return `Custom schedule (${expr})`;
}

// ─── Crontab Sync ──────────────────────────────────────────────────────────────

/**
 * Sync the database jobs for a specific user to the system crontab.
 * Reads all enabled jobs for the user from DB, writes them to crontab.
 */
export async function syncCrontab(
  db: Database.Database,
  user: string,
  execCommand: (command: string) => Promise<{ stdout: string; stderr: string }>
): Promise<void> {
  // Get all enabled jobs for this user
  const jobs = db.prepare(
    `SELECT * FROM cron_jobs WHERE user = ? AND enabled = 1 ORDER BY created_at ASC`
  ).all(user) as RawCronJobRow[];

  // Read existing crontab for the user (preserving non-panel entries)
  let existingCrontab = '';
  try {
    const result = await execCommand(`crontab -l -u ${user}`);
    existingCrontab = result.stdout;
  } catch {
    // Empty crontab or user doesn't exist — start fresh
    existingCrontab = '';
  }

  // Parse existing crontab: keep lines not managed by this panel
  const BEGIN_MARKER = '# BEGIN VPS-PANEL MANAGED CRON JOBS';
  const END_MARKER = '# END VPS-PANEL MANAGED CRON JOBS';

  const lines = existingCrontab.split('\n');
  const beforePanel: string[] = [];
  const afterPanel: string[] = [];
  let inPanelBlock = false;
  let afterPanelBlock = false;

  for (const line of lines) {
    if (line.trim() === BEGIN_MARKER) {
      inPanelBlock = true;
      continue;
    }
    if (line.trim() === END_MARKER) {
      inPanelBlock = false;
      afterPanelBlock = true;
      continue;
    }
    if (!inPanelBlock && !afterPanelBlock) {
      beforePanel.push(line);
    } else if (afterPanelBlock) {
      afterPanel.push(line);
    }
  }

  // Build the new crontab content
  const panelLines: string[] = [];
  if (jobs.length > 0) {
    panelLines.push(BEGIN_MARKER);
    for (const job of jobs) {
      panelLines.push(`# Job ID: ${job.id}`);
      panelLines.push(`${job.expression} ${job.command}`);
    }
    panelLines.push(END_MARKER);
  }

  const newCrontab = [...beforePanel, ...panelLines, ...afterPanel]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse multiple blank lines
    .trim();

  // Write the new crontab
  if (newCrontab) {
    // Use printf to pipe content to crontab - (stdin)
    const escapedContent = newCrontab.replace(/'/g, "'\\''");
    await execCommand(`printf '%s\\n' '${escapedContent}' | crontab -u ${user} -`);
  } else {
    // Remove crontab if empty
    try {
      await execCommand(`crontab -r -u ${user}`);
    } catch {
      // Ignore error if crontab doesn't exist
    }
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────────────

interface RawCronJobRow {
  id: string;
  expression: string;
  command: string;
  user: string;
  enabled: number;
  description: string | null;
  created_at: string;
}

interface RawCronExecutionRow {
  id: string;
  job_id: string;
  timestamp: string;
  exit_code: number | null;
  output: string | null;
}

function rowToJob(row: RawCronJobRow, lastExec?: RawCronExecutionRow): CronJob {
  return {
    id: row.id,
    expression: row.expression,
    command: row.command,
    user: row.user,
    enabled: row.enabled === 1,
    description: row.description ?? describeExpression(row.expression),
    lastExecution: lastExec ? rowToExecution(lastExec) : undefined,
    createdAt: new Date(row.created_at),
  };
}

function rowToExecution(row: RawCronExecutionRow): CronExecution {
  return {
    id: row.id,
    jobId: row.job_id,
    timestamp: new Date(row.timestamp),
    exitCode: row.exit_code,
    output: row.output ?? '',
  };
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const displayMinute = minute.toString().padStart(2, '0');
  return `${displayHour}:${displayMinute} ${period}`;
}

function parseWeekdays(field: string): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Handle ranges like 1-5 (Monday to Friday)
  if (field === '1-5') return 'weekdays';
  if (field === '0,6' || field === '6,0') return 'weekends';

  // Handle comma-separated values
  const parts = field.split(',');
  const days = parts.map((p) => {
    const num = parseInt(p.trim(), 10);
    if (!isNaN(num) && num >= 0 && num <= 7) {
      // 0 and 7 are both Sunday
      return shortDayNames[num === 7 ? 0 : num];
    }
    return p.trim();
  });

  return days.join(', ');
}

function getMonthName(field: string): string {
  const monthNames = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const num = parseInt(field, 10);
  if (!isNaN(num) && num >= 1 && num <= 12) {
    return monthNames[num];
  }
  return field;
}

async function defaultExecCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command);
}
