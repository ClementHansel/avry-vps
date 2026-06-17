"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSecurityManager = createSecurityManager;
const uuid_1 = require("uuid");
const node_child_process_1 = require("node:child_process");
// ─── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_PANEL_PORT = 3000;
const DEFAULT_SCAN_RETENTION_DAYS = 90;
const DEFAULT_AUTO_BAN_THRESHOLD = 5;
const DEFAULT_AUTO_BAN_WINDOW_MINUTES = 10;
const DEFAULT_AUTO_BAN_DURATION_SECONDS = 3600;
const DEFAULT_SCAN_SCHEDULE = '0 3 * * 0'; // Weekly, Sunday 3 AM
// ─── Implementation ────────────────────────────────────────────────────────────
function createSecurityManager(db, config) {
    const panelPort = config?.panelPort ?? parseInt(process.env.PORT ?? String(DEFAULT_PANEL_PORT), 10);
    const adminIPs = config?.adminIPs ?? [];
    const scanRetentionDays = config?.scanRetentionDays ?? DEFAULT_SCAN_RETENTION_DAYS;
    const autoBanThreshold = config?.autoBanThreshold ?? DEFAULT_AUTO_BAN_THRESHOLD;
    const autoBanWindowMinutes = config?.autoBanWindowMinutes ?? DEFAULT_AUTO_BAN_WINDOW_MINUTES;
    const autoBanDurationSeconds = config?.autoBanDurationSeconds ?? DEFAULT_AUTO_BAN_DURATION_SECONDS;
    const execCommand = config?.execCommand ?? defaultExecCommand;
    const useUfw = config?.useUfw ?? detectUfw(execCommand);
    // ─── Prepared Statements ───────────────────────────────────────────────
    const insertRule = db.prepare(`INSERT INTO firewall_rules (id, port, protocol, source, action, description) VALUES (?, ?, ?, ?, ?, ?)`);
    const updateRule = db.prepare(`UPDATE firewall_rules SET port = ?, protocol = ?, source = ?, action = ?, description = ? WHERE id = ?`);
    const deleteRuleStmt = db.prepare(`DELETE FROM firewall_rules WHERE id = ?`);
    const getRuleById = db.prepare(`SELECT * FROM firewall_rules WHERE id = ?`);
    const getAllRules = db.prepare(`SELECT * FROM firewall_rules ORDER BY created_at ASC`);
    const insertScan = db.prepare(`INSERT INTO security_scans (id, timestamp, score, finding_count, findings) VALUES (?, ?, ?, ?, ?)`);
    const getScanHistoryStmt = db.prepare(`SELECT * FROM security_scans WHERE timestamp >= datetime('now', ?) ORDER BY timestamp DESC`);
    const getLatestScan = db.prepare(`SELECT * FROM security_scans ORDER BY timestamp DESC LIMIT 1`);
    const pruneOldScans = db.prepare(`DELETE FROM security_scans WHERE timestamp < datetime('now', ?)`);
    // ─── Security Score ─────────────────────────────────────────────────────
    async function getSecurityScore() {
        const firewallScore = computeFirewallScore();
        const ipsScore = computeIPSScore();
        const scanScore = computeScanScore();
        // Weighted average: firewall 30%, IPS 30%, scan 40%
        const overall = Math.round(firewallScore * 0.3 + ipsScore * 0.3 + scanScore * 0.4);
        const latestScan = getLatestScan.get();
        return {
            overall: Math.max(0, Math.min(100, overall)),
            firewallScore,
            ipsScore,
            scanScore,
            lastScanDate: latestScan?.timestamp,
        };
    }
    function computeFirewallScore() {
        const rules = getAllRules.all();
        // Base score starts at 50 if firewall has no rules (not configured)
        if (rules.length === 0)
            return 40;
        let score = 60;
        // Bonus for having deny-all default (deny rule for 0.0.0.0/0)
        const hasDenyAll = rules.some((r) => r.action === 'deny' && r.source === '0.0.0.0/0');
        if (hasDenyAll)
            score += 20;
        // Bonus for restrictive rules (more deny than allow)
        const denyCount = rules.filter((r) => r.action === 'deny').length;
        const allowCount = rules.filter((r) => r.action === 'allow').length;
        if (denyCount >= allowCount)
            score += 10;
        // Penalty for allowing all sources on sensitive ports
        const sensitiveAllowAll = rules.filter((r) => r.action === 'allow' && r.source === '0.0.0.0/0' &&
            [22, 3306, 5432, 6379, 27017].includes(r.port));
        score -= sensitiveAllowAll.length * 5;
        return Math.max(0, Math.min(100, score));
    }
    function computeIPSScore() {
        try {
            // Check if Fail2Ban is running
            const status = execCommand('fail2ban-client status 2>/dev/null || echo "NOT_RUNNING"');
            if (status.includes('NOT_RUNNING'))
                return 20;
            // Fail2Ban is active
            let score = 70;
            // Check how many jails are active
            const jailMatch = status.match(/Number of jail:\s*(\d+)/);
            const jailCount = jailMatch ? parseInt(jailMatch[1], 10) : 0;
            if (jailCount >= 3)
                score += 20;
            else if (jailCount >= 1)
                score += 10;
            // Bonus if sshd jail is active
            if (status.includes('sshd'))
                score += 10;
            return Math.max(0, Math.min(100, score));
        }
        catch {
            return 20; // Fail2Ban not available
        }
    }
    function computeScanScore() {
        const latestScan = getLatestScan.get();
        if (!latestScan)
            return 50; // No scan run yet, neutral score
        return latestScan.score;
    }
    // ─── Firewall Management ────────────────────────────────────────────────
    async function listFirewallRules() {
        const rows = getAllRules.all();
        return rows.map(rowToFirewallRule);
    }
    async function addFirewallRule(rule) {
        const fullRule = {
            port: rule.port,
            protocol: rule.protocol ?? 'tcp',
            source: rule.source ?? '0.0.0.0/0',
            action: rule.action,
            description: rule.description,
        };
        // Validate for conflicts and lockout
        const validation = validateFirewallRule(fullRule);
        if (!validation.valid) {
            throw new Error(`Firewall rule validation failed: ${validation.errors.join('; ')}`);
        }
        const id = (0, uuid_1.v4)();
        insertRule.run(id, fullRule.port, fullRule.protocol, fullRule.source, fullRule.action, fullRule.description ?? null);
        // Apply the rule to the system
        applyFirewallRule({
            id,
            port: fullRule.port,
            protocol: fullRule.protocol,
            source: fullRule.source,
            action: fullRule.action,
        });
        return {
            id,
            port: fullRule.port,
            protocol: fullRule.protocol,
            source: fullRule.source,
            action: fullRule.action,
            description: fullRule.description,
        };
    }
    async function editFirewallRule(id, rule) {
        const existing = getRuleById.get(id);
        if (!existing) {
            throw new Error(`Firewall rule not found: ${id}`);
        }
        const updatedRule = {
            port: rule.port ?? existing.port,
            protocol: (rule.protocol ?? existing.protocol),
            source: rule.source ?? existing.source,
            action: (rule.action ?? existing.action),
            description: rule.description ?? existing.description ?? undefined,
        };
        // Validate the updated rule (exclude current rule from conflict check)
        const validation = validateFirewallRuleExcluding(updatedRule, id);
        if (!validation.valid) {
            throw new Error(`Firewall rule validation failed: ${validation.errors.join('; ')}`);
        }
        // Remove old rule from system
        removeFirewallRuleFromSystem(rowToFirewallRule(existing));
        // Update in database
        updateRule.run(updatedRule.port, updatedRule.protocol, updatedRule.source, updatedRule.action, updatedRule.description ?? null, id);
        // Apply updated rule to system
        const result = {
            id,
            port: updatedRule.port,
            protocol: updatedRule.protocol,
            source: updatedRule.source,
            action: updatedRule.action,
            description: updatedRule.description,
        };
        applyFirewallRule(result);
        return result;
    }
    async function deleteFirewallRule(id) {
        const existing = getRuleById.get(id);
        if (!existing) {
            throw new Error(`Firewall rule not found: ${id}`);
        }
        // Remove from system
        removeFirewallRuleFromSystem(rowToFirewallRule(existing));
        // Remove from database
        deleteRuleStmt.run(id);
    }
    function validateFirewallRule(rule) {
        return validateFirewallRuleExcluding(rule, undefined);
    }
    function validateFirewallRuleExcluding(rule, excludeId) {
        const errors = [];
        const warnings = [];
        const port = rule.port;
        const protocol = rule.protocol ?? 'tcp';
        const source = rule.source ?? '0.0.0.0/0';
        const action = rule.action;
        // Basic validation
        if (port < 1 || port > 65535) {
            errors.push(`Invalid port number: ${port}. Must be between 1 and 65535.`);
        }
        if (!['tcp', 'udp'].includes(protocol)) {
            errors.push(`Invalid protocol: ${protocol}. Must be 'tcp' or 'udp'.`);
        }
        if (!['allow', 'deny'].includes(action)) {
            errors.push(`Invalid action: ${action}. Must be 'allow' or 'deny'.`);
        }
        // Validate source IP/CIDR format
        if (!isValidIPOrCIDR(source)) {
            errors.push(`Invalid source IP/CIDR: ${source}`);
        }
        // Admin lockout prevention (Requirement 26.10)
        if (action === 'deny') {
            // Check if rule would block the panel port
            if (port === panelPort && (source === '0.0.0.0/0' || ipMatchesAnyAdmin(source))) {
                errors.push(`Rule would block access to the VPS Panel port (${panelPort}). ` +
                    `This would lock out the administrator.`);
            }
            // Check if rule would block admin IPs
            for (const adminIP of adminIPs) {
                if (ipMatchesCIDR(adminIP, source)) {
                    errors.push(`Rule would block traffic from admin IP ${adminIP}. ` +
                        `This would lock out the administrator.`);
                }
            }
        }
        // Check for conflicts with existing rules (Requirement 26.3)
        const existingRules = getAllRules.all();
        for (const existing of existingRules) {
            if (excludeId && existing.id === excludeId)
                continue;
            const samePort = existing.port === port;
            const sameProtocol = existing.protocol === protocol;
            const sourcesOverlap = cidrsOverlap(source, existing.source);
            if (samePort && sameProtocol && sourcesOverlap) {
                if (existing.action === action) {
                    // Duplicate rule
                    warnings.push(`Duplicate rule detected: existing rule ${existing.id} already ` +
                        `${existing.action}s ${existing.protocol}/${existing.port} from ${existing.source}`);
                }
                else {
                    // Contradicting rule
                    warnings.push(`Contradicting rule detected: existing rule ${existing.id} ` +
                        `${existing.action}s ${existing.protocol}/${existing.port} from ${existing.source}, ` +
                        `but new rule would ${action} the same traffic`);
                }
            }
        }
        return {
            valid: errors.length === 0,
            warnings,
            errors,
        };
    }
    // ─── Firewall System Commands ───────────────────────────────────────────
    function applyFirewallRule(rule) {
        try {
            if (useUfw) {
                applyUfwRule(rule);
            }
            else {
                applyIptablesRule(rule);
            }
        }
        catch (error) {
            // Log but don't throw — rule is saved to DB for re-application
            console.error(`Failed to apply firewall rule ${rule.id}:`, error);
        }
    }
    function applyUfwRule(rule) {
        const action = rule.action === 'allow' ? 'allow' : 'deny';
        const fromClause = rule.source === '0.0.0.0/0' ? '' : ` from ${rule.source}`;
        const cmd = `ufw ${action}${fromClause} to any port ${rule.port} proto ${rule.protocol}`;
        execCommand(cmd);
    }
    function applyIptablesRule(rule) {
        const target = rule.action === 'allow' ? 'ACCEPT' : 'DROP';
        const source = rule.source === '0.0.0.0/0' ? '' : `-s ${rule.source}`;
        const cmd = `iptables -A INPUT -p ${rule.protocol} --dport ${rule.port} ${source} -j ${target}`.trim();
        execCommand(cmd);
    }
    function removeFirewallRuleFromSystem(rule) {
        try {
            if (useUfw) {
                removeUfwRule(rule);
            }
            else {
                removeIptablesRule(rule);
            }
        }
        catch (error) {
            console.error(`Failed to remove firewall rule ${rule.id}:`, error);
        }
    }
    function removeUfwRule(rule) {
        const action = rule.action === 'allow' ? 'allow' : 'deny';
        const fromClause = rule.source === '0.0.0.0/0' ? '' : ` from ${rule.source}`;
        const cmd = `ufw delete ${action}${fromClause} to any port ${rule.port} proto ${rule.protocol}`;
        execCommand(cmd);
    }
    function removeIptablesRule(rule) {
        const target = rule.action === 'allow' ? 'ACCEPT' : 'DROP';
        const source = rule.source === '0.0.0.0/0' ? '' : `-s ${rule.source}`;
        const cmd = `iptables -D INPUT -p ${rule.protocol} --dport ${rule.port} ${source} -j ${target}`.trim();
        execCommand(cmd);
    }
    // ─── Fail2Ban Integration ───────────────────────────────────────────────
    async function getBannedIPs() {
        try {
            const statusOutput = execCommand('fail2ban-client status');
            const jailListMatch = statusOutput.match(/Jail list:\s*(.*)/);
            if (!jailListMatch)
                return [];
            const jails = jailListMatch[1].split(',').map((j) => j.trim()).filter(Boolean);
            const bannedIPs = [];
            for (const jail of jails) {
                try {
                    const jailStatus = execCommand(`fail2ban-client status ${jail}`);
                    const bannedMatch = jailStatus.match(/Banned IP list:\s*(.*)/);
                    if (bannedMatch && bannedMatch[1].trim()) {
                        const ips = bannedMatch[1].trim().split(/\s+/);
                        for (const ip of ips) {
                            if (ip) {
                                bannedIPs.push({
                                    ip,
                                    jail,
                                    banTime: getBanTimeRemaining(jail, ip),
                                    reason: `Banned by ${jail} jail`,
                                });
                            }
                        }
                    }
                }
                catch {
                    // Skip jails we can't query
                }
            }
            return bannedIPs;
        }
        catch {
            return [];
        }
    }
    function getBanTimeRemaining(jail, ip) {
        try {
            const output = execCommand(`fail2ban-client get ${jail} bantime`);
            const banTime = parseInt(output.trim(), 10);
            return isNaN(banTime) ? autoBanDurationSeconds : banTime;
        }
        catch {
            return autoBanDurationSeconds;
        }
    }
    async function banIP(ip, duration) {
        if (!isValidIP(ip)) {
            throw new Error(`Invalid IP address: ${ip}`);
        }
        try {
            // Use fail2ban-client to ban the IP across all jails (default: sshd)
            execCommand(`fail2ban-client set sshd banip ${ip}`);
        }
        catch {
            // Fallback: use iptables directly
            execCommand(`iptables -A INPUT -s ${ip} -j DROP`);
        }
    }
    async function unbanIP(ip) {
        if (!isValidIP(ip)) {
            throw new Error(`Invalid IP address: ${ip}`);
        }
        try {
            // Try to unban from all jails
            const statusOutput = execCommand('fail2ban-client status');
            const jailListMatch = statusOutput.match(/Jail list:\s*(.*)/);
            if (jailListMatch) {
                const jails = jailListMatch[1].split(',').map((j) => j.trim()).filter(Boolean);
                for (const jail of jails) {
                    try {
                        execCommand(`fail2ban-client set ${jail} unbanip ${ip}`);
                    }
                    catch {
                        // IP might not be banned in this jail
                    }
                }
            }
        }
        catch {
            // Fallback: remove iptables rule
            try {
                execCommand(`iptables -D INPUT -s ${ip} -j DROP`);
            }
            catch {
                // Rule might not exist
            }
        }
    }
    // ─── Security Scanning ──────────────────────────────────────────────────
    async function triggerScan() {
        const findings = [];
        // 1. Scan for open ports not in firewall allow list
        findings.push(...scanOpenPorts());
        // 2. Check for known CVEs (packages with available updates)
        findings.push(...scanCVEs());
        // 3. Check SSH configuration
        findings.push(...scanSSHConfig());
        // 4. Check for world-readable sensitive files
        findings.push(...scanWorldReadableFiles());
        // 5. Check Docker security settings
        findings.push(...scanDockerSecurity());
        // Calculate score based on findings
        const score = calculateScanScore(findings);
        // Store the scan result
        const id = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();
        insertScan.run(id, timestamp, score, findings.length, JSON.stringify(findings));
        // Prune old scans beyond retention
        pruneOldScans.run(`-${scanRetentionDays} days`);
        return id;
    }
    function scanOpenPorts() {
        const findings = [];
        try {
            // Get listening ports
            const output = execCommand('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ""');
            if (!output)
                return findings;
            const allowedPorts = new Set(getAllRules.all()
                .filter((r) => r.action === 'allow')
                .map((r) => r.port));
            // Parse ss/netstat output for listening ports
            const portRegex = /:(\d+)\s/g;
            let match;
            const openPorts = new Set();
            while ((match = portRegex.exec(output)) !== null) {
                const port = parseInt(match[1], 10);
                if (port > 0 && port <= 65535) {
                    openPorts.add(port);
                }
            }
            for (const port of openPorts) {
                if (!allowedPorts.has(port) && port !== panelPort) {
                    findings.push({
                        severity: port === 22 || port === 3306 || port === 5432 ? 'high' : 'medium',
                        description: `Port ${port} is open but not explicitly allowed by firewall rules`,
                        affectedResource: `port:${port}`,
                        remediation: `Add an explicit allow rule for port ${port} or close the service listening on it`,
                    });
                }
            }
        }
        catch {
            // ss/netstat not available
        }
        return findings;
    }
    function scanCVEs() {
        const findings = [];
        try {
            // Check for available security updates
            const output = execCommand('apt list --upgradable 2>/dev/null | grep -i security || echo ""');
            if (output && output.trim()) {
                const lines = output.trim().split('\n').filter(Boolean);
                if (lines.length > 0) {
                    findings.push({
                        severity: 'high',
                        description: `${lines.length} package(s) have available security updates`,
                        affectedResource: 'system:packages',
                        remediation: 'Run "apt update && apt upgrade" to install security patches',
                    });
                }
            }
        }
        catch {
            // apt not available (non-Debian system)
        }
        return findings;
    }
    function scanSSHConfig() {
        const findings = [];
        const sshConfigPath = '/etc/ssh/sshd_config';
        try {
            let sshConfig;
            try {
                sshConfig = execCommand(`cat ${sshConfigPath} 2>/dev/null`);
            }
            catch {
                return findings; // SSH config not accessible
            }
            if (!sshConfig)
                return findings;
            // Check password authentication
            if (/^\s*PasswordAuthentication\s+yes/mi.test(sshConfig)) {
                findings.push({
                    severity: 'high',
                    description: 'SSH password authentication is enabled',
                    affectedResource: sshConfigPath,
                    remediation: 'Set "PasswordAuthentication no" in sshd_config and restart SSH',
                });
            }
            // Check root login
            if (/^\s*PermitRootLogin\s+(yes|without-password)/mi.test(sshConfig)) {
                findings.push({
                    severity: 'high',
                    description: 'SSH root login is enabled',
                    affectedResource: sshConfigPath,
                    remediation: 'Set "PermitRootLogin no" in sshd_config and restart SSH',
                });
            }
            // Check for weak key exchange or ciphers (optional)
            if (/^\s*Protocol\s+1/mi.test(sshConfig)) {
                findings.push({
                    severity: 'critical',
                    description: 'SSH Protocol 1 is enabled (deprecated and insecure)',
                    affectedResource: sshConfigPath,
                    remediation: 'Remove Protocol 1 from sshd_config, ensure only Protocol 2 is used',
                });
            }
        }
        catch {
            // Can't read SSH config
        }
        return findings;
    }
    function scanWorldReadableFiles() {
        const findings = [];
        const sensitivePaths = [
            '/etc/shadow',
            '/etc/gshadow',
            '/etc/ssl/private',
            '/root/.ssh',
            '/home/*/.ssh/id_*',
        ];
        try {
            const output = execCommand(`find /etc /root /home -perm -o=r -type f \\( -name "*.key" -o -name "*.pem" -o -name "id_rsa" -o -name "id_ed25519" -o -name ".env" -o -name "shadow" \\) 2>/dev/null | head -20 || echo ""`);
            if (output && output.trim()) {
                const files = output.trim().split('\n').filter(Boolean);
                for (const file of files) {
                    findings.push({
                        severity: 'medium',
                        description: `Sensitive file is world-readable: ${file}`,
                        affectedResource: file,
                        remediation: `Restrict permissions: chmod 600 ${file}`,
                    });
                }
            }
        }
        catch {
            // find not available or permission denied
        }
        return findings;
    }
    function scanDockerSecurity() {
        const findings = [];
        try {
            // Check if Docker daemon is exposed on TCP
            const dockerOutput = execCommand('cat /etc/docker/daemon.json 2>/dev/null || echo "{}"');
            if (dockerOutput.includes('"hosts"') && dockerOutput.includes('tcp://')) {
                findings.push({
                    severity: 'critical',
                    description: 'Docker daemon is exposed on a TCP port (potential remote code execution)',
                    affectedResource: '/etc/docker/daemon.json',
                    remediation: 'Remove TCP host from Docker daemon configuration and use only the Unix socket',
                });
            }
            // Check if Docker socket is world-readable
            try {
                const socketPerms = execCommand('stat -c "%a" /var/run/docker.sock 2>/dev/null');
                const perms = parseInt(socketPerms.trim(), 8);
                if (perms & 0o006) {
                    findings.push({
                        severity: 'high',
                        description: 'Docker socket is world-readable/writable',
                        affectedResource: '/var/run/docker.sock',
                        remediation: 'Restrict Docker socket permissions: chmod 660 /var/run/docker.sock',
                    });
                }
            }
            catch {
                // stat not available
            }
            // Check for privileged containers
            try {
                const containers = execCommand('docker ps --format "{{.Names}}" 2>/dev/null || echo ""');
                if (containers.trim()) {
                    const names = containers.trim().split('\n').filter(Boolean);
                    for (const name of names.slice(0, 10)) { // Check first 10
                        try {
                            const inspect = execCommand(`docker inspect --format "{{.HostConfig.Privileged}}" ${name} 2>/dev/null`);
                            if (inspect.trim() === 'true') {
                                findings.push({
                                    severity: 'high',
                                    description: `Container "${name}" is running in privileged mode`,
                                    affectedResource: `container:${name}`,
                                    remediation: `Remove --privileged flag and use specific capabilities instead`,
                                });
                            }
                        }
                        catch {
                            // Can't inspect container
                        }
                    }
                }
            }
            catch {
                // Docker CLI not available
            }
        }
        catch {
            // Docker security checks failed
        }
        return findings;
    }
    function calculateScanScore(findings) {
        // Start at 100, deduct based on severity
        let score = 100;
        for (const finding of findings) {
            switch (finding.severity) {
                case 'critical':
                    score -= 20;
                    break;
                case 'high':
                    score -= 10;
                    break;
                case 'medium':
                    score -= 5;
                    break;
                case 'low':
                    score -= 2;
                    break;
            }
        }
        return Math.max(0, Math.min(100, score));
    }
    // ─── Scan History ───────────────────────────────────────────────────────
    async function getScanHistory() {
        const rows = getScanHistoryStmt.all(`-${scanRetentionDays} days`);
        return rows.map((row) => ({
            id: row.id,
            timestamp: row.timestamp,
            score: row.score,
            findingCount: row.finding_count,
            findings: JSON.parse(row.findings),
        }));
    }
    // ─── One-Click Hardening ────────────────────────────────────────────────
    async function applyHardening() {
        const steps = buildHardeningSteps();
        const appliedSteps = [];
        const hardeningId = (0, uuid_1.v4)();
        try {
            for (const step of steps) {
                step.apply();
                appliedSteps.push(step);
            }
            return hardeningId;
        }
        catch (error) {
            // Rollback all applied steps in reverse order (Requirement 26.11)
            const rollbackErrors = [];
            for (let i = appliedSteps.length - 1; i >= 0; i--) {
                try {
                    appliedSteps[i].rollback();
                }
                catch (rollbackError) {
                    rollbackErrors.push(`Failed to rollback "${appliedSteps[i].name}": ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
                }
            }
            const failedStep = steps[appliedSteps.length]?.name ?? 'unknown';
            const errorMsg = error instanceof Error ? error.message : String(error);
            const rollbackInfo = rollbackErrors.length > 0
                ? ` Rollback errors: ${rollbackErrors.join('; ')}`
                : ' All changes successfully rolled back.';
            throw new Error(`Hardening failed at step "${failedStep}": ${errorMsg}.${rollbackInfo}`);
        }
    }
    function buildHardeningSteps() {
        const sshConfigPath = '/etc/ssh/sshd_config';
        return [
            // Step 1: Disable SSH password authentication
            {
                name: 'Disable SSH password authentication',
                description: 'Set PasswordAuthentication to no in sshd_config',
                apply: () => {
                    const backup = backupFile(sshConfigPath);
                    sedReplace(sshConfigPath, 'PasswordAuthentication yes', 'PasswordAuthentication no');
                    sedReplace(sshConfigPath, '#PasswordAuthentication', 'PasswordAuthentication no');
                },
                rollback: () => {
                    restoreFile(sshConfigPath);
                },
            },
            // Step 2: Disable root SSH login
            {
                name: 'Disable root SSH login',
                description: 'Set PermitRootLogin to no in sshd_config',
                apply: () => {
                    sedReplace(sshConfigPath, 'PermitRootLogin yes', 'PermitRootLogin no');
                    sedReplace(sshConfigPath, 'PermitRootLogin without-password', 'PermitRootLogin no');
                    sedReplace(sshConfigPath, '#PermitRootLogin', 'PermitRootLogin no');
                },
                rollback: () => {
                    // Covered by step 1 rollback (file restore)
                },
            },
            // Step 3: Configure automatic security updates
            {
                name: 'Configure automatic security updates',
                description: 'Enable unattended-upgrades for security patches',
                apply: () => {
                    execCommand('apt-get install -y unattended-upgrades 2>/dev/null || true');
                    execCommand('echo \'APT::Periodic::Update-Package-Lists "1";\n' +
                        'APT::Periodic::Unattended-Upgrade "1";\' > /etc/apt/apt.conf.d/20auto-upgrades');
                },
                rollback: () => {
                    try {
                        execCommand('rm -f /etc/apt/apt.conf.d/20auto-upgrades');
                    }
                    catch {
                        // File might not exist
                    }
                },
            },
            // Step 4: Set restrictive default firewall rules
            {
                name: 'Set restrictive firewall defaults',
                description: 'Deny all inbound except configured ports (SSH, panel)',
                apply: () => {
                    if (useUfw) {
                        execCommand('ufw default deny incoming');
                        execCommand('ufw default allow outgoing');
                        execCommand(`ufw allow ${panelPort}/tcp`);
                        execCommand('ufw allow 22/tcp');
                        execCommand('ufw --force enable');
                    }
                    else {
                        // Save current iptables for rollback
                        execCommand('iptables-save > /tmp/iptables-pre-hardening.rules');
                        execCommand('iptables -P INPUT DROP');
                        execCommand('iptables -P FORWARD DROP');
                        execCommand('iptables -P OUTPUT ACCEPT');
                        execCommand('iptables -A INPUT -i lo -j ACCEPT');
                        execCommand('iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
                        execCommand(`iptables -A INPUT -p tcp --dport ${panelPort} -j ACCEPT`);
                        execCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
                    }
                },
                rollback: () => {
                    try {
                        if (useUfw) {
                            execCommand('ufw --force disable');
                        }
                        else {
                            execCommand('iptables-restore < /tmp/iptables-pre-hardening.rules');
                        }
                    }
                    catch {
                        // Best effort rollback
                    }
                },
            },
            // Step 5: Enable Intrusion Prevention System (Fail2Ban)
            {
                name: 'Enable Intrusion Prevention System',
                description: 'Install and configure Fail2Ban',
                apply: () => {
                    execCommand('apt-get install -y fail2ban 2>/dev/null || true');
                    const f2bConfig = [
                        '[DEFAULT]',
                        `bantime = ${autoBanDurationSeconds}`,
                        `findtime = ${autoBanWindowMinutes * 60}`,
                        `maxretry = ${autoBanThreshold}`,
                        '',
                        '[sshd]',
                        'enabled = true',
                        'port = ssh',
                        'filter = sshd',
                        'logpath = /var/log/auth.log',
                        `maxretry = ${autoBanThreshold}`,
                        `findtime = ${autoBanWindowMinutes * 60}`,
                        `bantime = ${autoBanDurationSeconds}`,
                    ].join('\n');
                    execCommand(`echo '${f2bConfig}' > /etc/fail2ban/jail.local`);
                    execCommand('systemctl enable fail2ban 2>/dev/null || true');
                    execCommand('systemctl restart fail2ban 2>/dev/null || true');
                },
                rollback: () => {
                    try {
                        execCommand('systemctl stop fail2ban 2>/dev/null || true');
                        execCommand('rm -f /etc/fail2ban/jail.local');
                    }
                    catch {
                        // Best effort rollback
                    }
                },
            },
            // Step 6: Restart SSH to apply config changes
            {
                name: 'Restart SSH service',
                description: 'Apply SSH configuration changes',
                apply: () => {
                    execCommand('systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || true');
                },
                rollback: () => {
                    // SSH restart with original config is handled by step 1 rollback
                    try {
                        execCommand('systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || true');
                    }
                    catch {
                        // Best effort
                    }
                },
            },
        ];
    }
    // ─── Utility Functions ──────────────────────────────────────────────────
    function backupFile(filePath) {
        try {
            execCommand(`cp ${filePath} ${filePath}.bak.hardening`);
        }
        catch {
            // If we can't backup, we still proceed but note this could affect rollback
        }
    }
    function restoreFile(filePath) {
        try {
            execCommand(`cp ${filePath}.bak.hardening ${filePath}`);
            execCommand(`rm -f ${filePath}.bak.hardening`);
        }
        catch {
            // Best effort
        }
    }
    function sedReplace(filePath, search, replace) {
        // Use sed to replace in-place
        const escapedSearch = search.replace(/[/\\&]/g, '\\$&');
        const escapedReplace = replace.replace(/[/\\&]/g, '\\$&');
        execCommand(`sed -i 's/${escapedSearch}/${escapedReplace}/g' ${filePath}`);
    }
    function rowToFirewallRule(row) {
        return {
            id: row.id,
            port: row.port,
            protocol: row.protocol,
            source: row.source,
            action: row.action,
            description: row.description ?? undefined,
            createdAt: row.created_at,
        };
    }
    // ─── Return Public API ──────────────────────────────────────────────────
    return {
        getSecurityScore,
        listFirewallRules,
        addFirewallRule,
        editFirewallRule,
        deleteFirewallRule,
        validateFirewallRule,
        getBannedIPs,
        banIP,
        unbanIP,
        triggerScan,
        getScanHistory,
        applyHardening,
    };
}
// ─── Shared Utility Functions ───────────────────────────────────────────────
function defaultExecCommand(cmd) {
    return (0, node_child_process_1.execSync)(cmd, { encoding: 'utf-8', timeout: 10_000 });
}
function detectUfw(execCommand) {
    try {
        execCommand('which ufw');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Validate an IP address (IPv4).
 */
function isValidIP(ip) {
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = ip.match(ipv4Regex);
    if (!match)
        return false;
    return match.slice(1).every((octet) => {
        const num = parseInt(octet, 10);
        return num >= 0 && num <= 255;
    });
}
/**
 * Validate an IP address or CIDR notation.
 */
function isValidIPOrCIDR(source) {
    if (source === '0.0.0.0/0')
        return true;
    // CIDR format: IP/prefix
    const cidrMatch = source.match(/^(.+)\/(\d+)$/);
    if (cidrMatch) {
        const ip = cidrMatch[1];
        const prefix = parseInt(cidrMatch[2], 10);
        return isValidIP(ip) && prefix >= 0 && prefix <= 32;
    }
    // Plain IP
    return isValidIP(source);
}
/**
 * Check if a specific IP matches a CIDR range.
 */
function ipMatchesCIDR(ip, cidr) {
    if (cidr === '0.0.0.0/0')
        return true;
    if (cidr === ip)
        return true;
    const cidrMatch = cidr.match(/^(.+)\/(\d+)$/);
    if (!cidrMatch)
        return ip === cidr;
    const cidrIP = cidrMatch[1];
    const prefix = parseInt(cidrMatch[2], 10);
    const ipNum = ipToNumber(ip);
    const cidrNum = ipToNumber(cidrIP);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (cidrNum & mask);
}
/**
 * Check if two CIDR ranges overlap.
 */
function cidrsOverlap(cidr1, cidr2) {
    if (cidr1 === '0.0.0.0/0' || cidr2 === '0.0.0.0/0')
        return true;
    const [ip1, prefix1] = parseCIDR(cidr1);
    const [ip2, prefix2] = parseCIDR(cidr2);
    // Use the shorter (more general) prefix for comparison
    const minPrefix = Math.min(prefix1, prefix2);
    const mask = minPrefix === 0 ? 0 : (~0 << (32 - minPrefix)) >>> 0;
    return (ip1 & mask) === (ip2 & mask);
}
function parseCIDR(cidr) {
    const match = cidr.match(/^(.+)\/(\d+)$/);
    if (match) {
        return [ipToNumber(match[1]), parseInt(match[2], 10)];
    }
    return [ipToNumber(cidr), 32]; // Single IP = /32
}
function ipToNumber(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
/**
 * Check if a source CIDR would match any of the admin IPs.
 */
function ipMatchesAnyAdmin(source) {
    // This is a simplified check — if source is broad enough to include typical admin
    // ranges, we flag it. The detailed check is done per-IP in the main validation.
    return source === '0.0.0.0/0';
}
//# sourceMappingURL=security-manager.js.map