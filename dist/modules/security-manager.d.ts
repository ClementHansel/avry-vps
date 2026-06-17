/**
 * Security Manager Module
 *
 * VPS security hardening including firewall management (iptables/UFW),
 * Fail2Ban integration, security scanning, security score computation,
 * and one-click hardening with rollback on partial failure.
 *
 * Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11
 */
import type Database from 'better-sqlite3';
export type FirewallAction = 'allow' | 'deny';
export type FirewallProtocol = 'tcp' | 'udp';
export type ScanSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface FirewallRule {
    id: string;
    port: number;
    protocol: FirewallProtocol;
    source: string;
    action: FirewallAction;
    description?: string;
    createdAt?: string;
}
export interface FirewallRuleInput {
    port: number;
    protocol?: FirewallProtocol;
    source?: string;
    action: FirewallAction;
    description?: string;
}
export interface RuleValidation {
    valid: boolean;
    warnings: string[];
    errors: string[];
}
export interface BannedIP {
    ip: string;
    jail: string;
    banTime: number;
    reason?: string;
}
export interface ScanFinding {
    severity: ScanSeverity;
    description: string;
    affectedResource: string;
    remediation: string;
}
export interface ScanResult {
    id: string;
    timestamp: string;
    score: number;
    findingCount: number;
    findings: ScanFinding[];
}
export interface SecurityScore {
    overall: number;
    firewallScore: number;
    ipsScore: number;
    scanScore: number;
    lastScanDate?: string;
}
export interface HardeningStep {
    name: string;
    description: string;
    apply: () => void;
    rollback: () => void;
}
export interface SecurityManager {
    /** Compute overall security score (0-100) based on scan, firewall, and IPS status */
    getSecurityScore(): Promise<SecurityScore>;
    /** List all configured firewall rules */
    listFirewallRules(): Promise<FirewallRule[]>;
    /** Add a new firewall rule (validated for conflicts and lockout) */
    addFirewallRule(rule: FirewallRuleInput): Promise<FirewallRule>;
    /** Edit an existing firewall rule */
    editFirewallRule(id: string, rule: Partial<FirewallRuleInput>): Promise<FirewallRule>;
    /** Delete a firewall rule by ID */
    deleteFirewallRule(id: string): Promise<void>;
    /** Validate a firewall rule for conflicts, duplicates, and lockout prevention */
    validateFirewallRule(rule: FirewallRuleInput): RuleValidation;
    /** Get currently banned IPs from Fail2Ban */
    getBannedIPs(): Promise<BannedIP[]>;
    /** Manually ban an IP address */
    banIP(ip: string, duration: number): Promise<void>;
    /** Manually unban an IP address */
    unbanIP(ip: string): Promise<void>;
    /** Trigger a security scan (returns scan ID) */
    triggerScan(): Promise<string>;
    /** Get scan history (90-day retention) */
    getScanHistory(): Promise<ScanResult[]>;
    /** Apply one-click hardening with rollback on partial failure */
    applyHardening(): Promise<string>;
}
export interface SecurityManagerConfig {
    /** Panel port to protect from lockout. Default: from PORT env or 3000 */
    panelPort?: number;
    /** Admin IP(s) to protect from lockout */
    adminIPs?: string[];
    /** Scan retention in days. Default: 90 */
    scanRetentionDays?: number;
    /** Auto-ban threshold: failed attempts before ban. Default: 5 */
    autoBanThreshold?: number;
    /** Auto-ban window in minutes. Default: 10 */
    autoBanWindowMinutes?: number;
    /** Auto-ban duration in seconds. Default: 3600 (1 hour) */
    autoBanDurationSeconds?: number;
    /** Scheduled scan frequency (cron expression). Default: weekly (0 3 * * 0) */
    scanSchedule?: string;
    /** Command executor for testing/mocking. Default: execSync */
    execCommand?: (cmd: string) => string;
    /** Whether to use UFW (true) or raw iptables (false). Default: auto-detect */
    useUfw?: boolean;
}
export declare function createSecurityManager(db: Database.Database, config?: SecurityManagerConfig): SecurityManager;
//# sourceMappingURL=security-manager.d.ts.map