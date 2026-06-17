export interface DomainConfig {
    id: string;
    domain: string;
    proxyTarget: string;
    sslEnabled: boolean;
    headers: Record<string, string>;
    websocketUpgrade: boolean;
    active: boolean;
    projectId?: string;
    createdAt?: string;
    updatedAt?: string;
}
export interface DomainInput {
    domain: string;
    proxyTarget: string;
    sslEnabled?: boolean;
    headers?: Record<string, string>;
    websocketUpgrade?: boolean;
    active?: boolean;
    projectId?: string;
}
export interface DnsValidationResult {
    valid: boolean;
    resolvedIps: string[];
    serverIp?: string;
    warning?: string;
}
export interface DomainManager {
    listDomains(): Promise<DomainConfig[]>;
    addDomain(config: DomainInput): Promise<DomainConfig>;
    updateDomain(id: string, config: Partial<DomainInput>): Promise<DomainConfig>;
    deleteDomain(id: string): Promise<void>;
    validateDns(domain: string): Promise<DnsValidationResult>;
    generateNginxConfig(config: DomainConfig): string;
    reloadNginx(): Promise<void>;
}
export interface DomainManagerConfig {
    /** Path to nginx sites-enabled directory. Default: /etc/nginx/sites-enabled */
    sitesEnabledPath?: string;
    /** Custom exec function for running commands (useful for testing) */
    execCommand?: (command: string) => Promise<ExecResult>;
    /** Custom DNS resolve function (useful for testing) */
    dnsResolve?: (domain: string) => Promise<string[]>;
    /** Custom filesystem operations (useful for testing) */
    fs?: FileSystemOps;
    /** Database instance for domain persistence */
    db?: DatabaseOps;
    /** Server IP for DNS validation comparison */
    serverIp?: string;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface FileSystemOps {
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
}
export interface DatabaseOps {
    getAllDomains(): DomainConfig[];
    getDomain(id: string): DomainConfig | undefined;
    getDomainByName(domain: string): DomainConfig | undefined;
    insertDomain(config: DomainConfig): void;
    updateDomain(id: string, config: Partial<DomainConfig>): void;
    deleteDomain(id: string): void;
}
/**
 * Generate an Nginx server block configuration for a domain.
 */
export declare function generateNginxConfig(config: DomainConfig): string;
export declare function createDomainManager(config?: DomainManagerConfig): DomainManager;
/**
 * Validate proxy target format: host:port
 * Examples: localhost:3000, 127.0.0.1:8080, my-service:4000
 */
export declare function isValidProxyTarget(target: string): boolean;
//# sourceMappingURL=domain-manager.d.ts.map