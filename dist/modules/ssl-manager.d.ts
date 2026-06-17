export type RenewalStatus = 'auto-managed' | 'manual';
export interface CertificateInfo {
    domain: string;
    issuer: string;
    expiryDate: Date;
    daysUntilExpiry: number;
    renewalStatus: RenewalStatus;
    isValid: boolean;
}
export interface CertificateRecord {
    id: string;
    domain: string;
    issuer: string;
    expiryDate: string;
    renewalStatus: RenewalStatus;
    certPath: string;
    keyPath: string;
    createdAt: string;
}
export interface SSLManager {
    provisionCertificate(domain: string): Promise<string>;
    uploadCertificate(domain: string, cert: Buffer, key: Buffer): Promise<void>;
    getCertificateStatus(domain: string): Promise<CertificateInfo>;
    listCertificates(): Promise<CertificateInfo[]>;
    scheduleRenewal(domain: string): void;
    /** Start the daily renewal check cron */
    startRenewalCron(): void;
    /** Stop the daily renewal check cron */
    stopRenewalCron(): void;
    /** Run a single renewal check cycle (for testing) */
    checkRenewals(): Promise<void>;
}
export interface SSLManagerConfig {
    /** Base directory for storing certificates. Default: /etc/ssl/vps-panel/ */
    certStorePath?: string;
    /** Database instance for certificate records */
    db: DatabaseAdapter;
    /** ACME directory URL. Default: Let's Encrypt production */
    acmeDirectoryUrl?: string;
    /** Contact email for ACME account */
    acmeEmail?: string;
    /** Webroot path for HTTP-01 challenge. Default: /var/www/acme-challenge/ */
    acmeWebrootPath?: string;
    /** Nginx reload function */
    reloadNginx?: () => Promise<void>;
    /** Nginx config directory. Default: /etc/nginx/sites-enabled/ */
    nginxConfigDir?: string;
    /** Renewal check interval in ms. Default: 86400000 (24 hours) */
    renewalCheckIntervalMs?: number;
    /** Retry delay in ms for failed provisioning. Default: 300000 (5 minutes) */
    retryDelayMs?: number;
    /** Function to create ACME client (injectable for testing) */
    createAcmeClient?: (config: AcmeClientCreateConfig) => AcmeClientAdapter;
    /** File system adapter (injectable for testing) */
    fsAdapter?: FileSystemAdapter;
    /** Job submission callback */
    onJobSubmit?: (jobId: string, domain: string, action: string) => void;
    /** Logger */
    logger?: Logger;
}
export interface AcmeClientCreateConfig {
    directoryUrl: string;
    accountKey: Buffer;
}
export interface AcmeClientAdapter {
    createAccount(opts: {
        termsOfServiceAgreed: boolean;
        contact: string[];
    }): Promise<any>;
    createOrder(opts: {
        identifiers: Array<{
            type: string;
            value: string;
        }>;
    }): Promise<any>;
    getAuthorizations(order: any): Promise<any[]>;
    getChallengeKeyAuthorization(challenge: any): Promise<string>;
    verifyChallenge(authorization: any, challenge: any): Promise<any>;
    completeChallenge(challenge: any): Promise<any>;
    waitForValidStatus(challenge: any): Promise<any>;
    finalizeOrder(order: any, csr: Buffer): Promise<any>;
    getCertificate(order: any): Promise<string>;
    createCsr(opts: {
        commonName: string;
    }): Promise<[Buffer, Buffer]>;
}
export interface DatabaseAdapter {
    getCertificate(domain: string): CertificateRecord | undefined;
    listCertificates(): CertificateRecord[];
    upsertCertificate(record: Omit<CertificateRecord, 'createdAt'>): void;
    deleteCertificate(domain: string): void;
    getDomainConfig(domain: string): {
        id: string;
        domain: string;
        sslEnabled: number;
    } | undefined;
    updateDomainSsl(domain: string, enabled: boolean): void;
}
export interface FileSystemAdapter {
    writeFile(filePath: string, data: Buffer | string): void;
    readFile(filePath: string): Buffer;
    existsSync(filePath: string): boolean;
    mkdirSync(dirPath: string, opts?: {
        recursive: boolean;
    }): void;
    unlinkSync(filePath: string): void;
}
export interface Logger {
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
/**
 * Validate that a certificate and key form a matching pair.
 * Uses crypto.createPublicKey to extract public keys from both and compare.
 */
export declare function validateCertKeyPair(cert: Buffer, key: Buffer): {
    valid: boolean;
    error?: string;
};
/**
 * Parse a PEM certificate and extract metadata.
 */
export declare function parseCertificate(cert: Buffer): {
    issuer: string;
    expiryDate: Date;
    subject: string;
};
/**
 * Calculate days until expiry.
 */
export declare function daysUntilExpiry(expiryDate: Date): number;
/**
 * Generate Nginx HTTPS redirect config snippet.
 */
export declare function generateHttpsRedirectConfig(domain: string): string;
/**
 * Generate Nginx SSL server block snippet.
 */
export declare function generateSslConfig(domain: string, certPath: string, keyPath: string): string;
export declare function createSSLManager(config: SSLManagerConfig): SSLManager;
//# sourceMappingURL=ssl-manager.d.ts.map