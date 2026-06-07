/**
 * SSL Manager Module
 *
 * Provides Let's Encrypt ACME provisioning via HTTP-01 challenges,
 * custom certificate upload with validation, renewal scheduling,
 * and HTTPS redirect configuration for Nginx.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// ─── Interfaces ────────────────────────────────────────────────────────────────

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
  createAccount(opts: { termsOfServiceAgreed: boolean; contact: string[] }): Promise<any>;
  createOrder(opts: { identifiers: Array<{ type: string; value: string }> }): Promise<any>;
  getAuthorizations(order: any): Promise<any[]>;
  getChallengeKeyAuthorization(challenge: any): Promise<string>;
  verifyChallenge(authorization: any, challenge: any): Promise<any>;
  completeChallenge(challenge: any): Promise<any>;
  waitForValidStatus(challenge: any): Promise<any>;
  finalizeOrder(order: any, csr: Buffer): Promise<any>;
  getCertificate(order: any): Promise<string>;
  createCsr(opts: { commonName: string }): Promise<[Buffer, Buffer]>;
}

export interface DatabaseAdapter {
  getCertificate(domain: string): CertificateRecord | undefined;
  listCertificates(): CertificateRecord[];
  upsertCertificate(record: Omit<CertificateRecord, 'createdAt'>): void;
  deleteCertificate(domain: string): void;
  getDomainConfig(domain: string): { id: string; domain: string; sslEnabled: number } | undefined;
  updateDomainSsl(domain: string, enabled: boolean): void;
}

export interface FileSystemAdapter {
  writeFile(filePath: string, data: Buffer | string): void;
  readFile(filePath: string): Buffer;
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, opts?: { recursive: boolean }): void;
  unlinkSync(filePath: string): void;
}

export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CERT_STORE_PATH = '/etc/ssl/vps-panel/';
const DEFAULT_ACME_DIRECTORY_URL = 'https://acme-v02.api.letsencrypt.org/directory';
const DEFAULT_ACME_WEBROOT_PATH = '/var/www/acme-challenge/';
const DEFAULT_NGINX_CONFIG_DIR = '/etc/nginx/sites-enabled/';
const DEFAULT_RENEWAL_CHECK_INTERVAL_MS = 86_400_000; // 24 hours
const DEFAULT_RETRY_DELAY_MS = 300_000; // 5 minutes
const RENEWAL_THRESHOLD_DAYS = 30;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate that a certificate and key form a matching pair.
 * Uses crypto.createPublicKey to extract public keys from both and compare.
 */
export function validateCertKeyPair(cert: Buffer, key: Buffer): { valid: boolean; error?: string } {
  try {
    // Parse the certificate to extract its public key
    const x509 = new crypto.X509Certificate(cert);
    const certPublicKey = x509.publicKey;

    // Parse the private key
    const privateKey = crypto.createPrivateKey(key);
    const keyPublicKey = crypto.createPublicKey(privateKey);

    // Compare the public key from cert with public key derived from private key
    const certPubKeyDer = certPublicKey.export({ type: 'spki', format: 'der' });
    const keyPubKeyDer = keyPublicKey.export({ type: 'spki', format: 'der' });

    if (!certPubKeyDer.equals(keyPubKeyDer)) {
      return { valid: false, error: 'Certificate and private key do not match' };
    }

    // Check if certificate is expired
    const now = new Date();
    const notAfter = new Date(x509.validTo);
    if (notAfter < now) {
      return { valid: false, error: 'Certificate has expired' };
    }

    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('key')) {
      return { valid: false, error: `Invalid private key: ${message}` };
    }
    return { valid: false, error: `Invalid certificate: ${message}` };
  }
}

/**
 * Parse a PEM certificate and extract metadata.
 */
export function parseCertificate(cert: Buffer): {
  issuer: string;
  expiryDate: Date;
  subject: string;
} {
  const x509 = new crypto.X509Certificate(cert);
  return {
    issuer: x509.issuer,
    expiryDate: new Date(x509.validTo),
    subject: x509.subject,
  };
}

/**
 * Calculate days until expiry.
 */
export function daysUntilExpiry(expiryDate: Date): number {
  const now = new Date();
  const diff = expiryDate.getTime() - now.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Generate Nginx HTTPS redirect config snippet.
 */
export function generateHttpsRedirectConfig(domain: string): string {
  return `# HTTP to HTTPS redirect for ${domain}
server {
    listen 80;
    server_name ${domain};
    
    # ACME challenge path (for certificate renewal)
    location /.well-known/acme-challenge/ {
        root /var/www/acme-challenge/;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
`;
}

/**
 * Generate Nginx SSL server block snippet.
 */
export function generateSslConfig(domain: string, certPath: string, keyPath: string): string {
  return `
    # SSL configuration for ${domain}
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
`;
}

// ─── Default File System Adapter ───────────────────────────────────────────────

function createDefaultFsAdapter(): FileSystemAdapter {
  return {
    writeFile(filePath: string, data: Buffer | string): void {
      fs.writeFileSync(filePath, data);
    },
    readFile(filePath: string): Buffer {
      return fs.readFileSync(filePath);
    },
    existsSync(filePath: string): boolean {
      return fs.existsSync(filePath);
    },
    mkdirSync(dirPath: string, opts?: { recursive: boolean }): void {
      fs.mkdirSync(dirPath, opts);
    },
    unlinkSync(filePath: string): void {
      fs.unlinkSync(filePath);
    },
  };
}

// ─── Default Logger ────────────────────────────────────────────────────────────

function createDefaultLogger(): Logger {
  return {
    info(message: string, ...args: any[]): void {
      console.log(`[SSL Manager] ${message}`, ...args);
    },
    warn(message: string, ...args: any[]): void {
      console.warn(`[SSL Manager] ${message}`, ...args);
    },
    error(message: string, ...args: any[]): void {
      console.error(`[SSL Manager] ${message}`, ...args);
    },
  };
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createSSLManager(config: SSLManagerConfig): SSLManager {
  const certStorePath = config.certStorePath ?? DEFAULT_CERT_STORE_PATH;
  const acmeDirectoryUrl = config.acmeDirectoryUrl ?? DEFAULT_ACME_DIRECTORY_URL;
  const acmeEmail = config.acmeEmail ?? process.env.ACME_EMAIL ?? 'admin@example.com';
  const acmeWebrootPath = config.acmeWebrootPath ?? DEFAULT_ACME_WEBROOT_PATH;
  const nginxConfigDir = config.nginxConfigDir ?? DEFAULT_NGINX_CONFIG_DIR;
  const renewalCheckIntervalMs = config.renewalCheckIntervalMs ?? DEFAULT_RENEWAL_CHECK_INTERVAL_MS;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const db = config.db;
  const fsAdapter = config.fsAdapter ?? createDefaultFsAdapter();
  const logger = config.logger ?? createDefaultLogger();
  const reloadNginx = config.reloadNginx ?? defaultReloadNginx;
  const createAcmeClient = config.createAcmeClient;

  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();

  // Ensure cert store directory exists
  if (!fsAdapter.existsSync(certStorePath)) {
    fsAdapter.mkdirSync(certStorePath, { recursive: true });
  }

  // ─── Default Nginx reload ─────────────────────────────────────────────

  async function defaultReloadNginx(): Promise<void> {
    const { execSync } = await import('node:child_process');
    execSync('nginx -t && nginx -s reload', { stdio: 'pipe' });
  }

  // ─── ACME Client factory ─────────────────────────────────────────────

  async function getAcmeClient(): Promise<AcmeClientAdapter> {
    if (createAcmeClient) {
      const accountKey = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const keyBuffer = Buffer.from(
        accountKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
      );
      return createAcmeClient({
        directoryUrl: acmeDirectoryUrl,
        accountKey: keyBuffer,
      });
    }

    // Dynamic import of acme-client for production use
    const acme = await import('acme-client');
    const accountKey = await acme.forge.createPrivateKey();
    const client = new acme.Client({
      directoryUrl: acmeDirectoryUrl,
      accountKey,
    });

    return {
      async createAccount(opts) {
        return client.createAccount(opts);
      },
      async createOrder(opts) {
        return client.createOrder(opts);
      },
      async getAuthorizations(order) {
        return client.getAuthorizations(order);
      },
      async getChallengeKeyAuthorization(challenge) {
        return client.getChallengeKeyAuthorization(challenge);
      },
      async verifyChallenge(authorization, challenge) {
        return client.verifyChallenge(authorization, challenge);
      },
      async completeChallenge(challenge) {
        return client.completeChallenge(challenge);
      },
      async waitForValidStatus(challenge) {
        return client.waitForValidStatus(challenge);
      },
      async finalizeOrder(order, csr) {
        return client.finalizeOrder(order, csr);
      },
      async getCertificate(order) {
        return client.getCertificate(order);
      },
      async createCsr(opts) {
        const [key, csr] = await acme.forge.createCsr(opts);
        return [csr, key];
      },
    } as AcmeClientAdapter;
  }

  // ─── Certificate file paths ──────────────────────────────────────────

  function getCertPath(domain: string): string {
    return path.posix.join(certStorePath, `${domain}.crt`);
  }

  function getKeyPath(domain: string): string {
    return path.posix.join(certStorePath, `${domain}.key`);
  }

  // ─── provisionCertificate ────────────────────────────────────────────

  async function provisionCertificate(domain: string): Promise<string> {
    const jobId = uuidv4();

    config.onJobSubmit?.(jobId, domain, 'provision');

    // Execute provisioning asynchronously
    executeProvisioning(domain, jobId, false).catch((err) => {
      logger.error(`Certificate provisioning failed for ${domain}: ${err.message}`);
    });

    return jobId;
  }

  async function executeProvisioning(
    domain: string,
    jobId: string,
    isRetry: boolean
  ): Promise<void> {
    try {
      logger.info(`Starting certificate provisioning for ${domain} (job: ${jobId}, retry: ${isRetry})`);

      const client = await getAcmeClient();

      // Create ACME account
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${acmeEmail}`],
      });

      // Create order
      const order = await client.createOrder({
        identifiers: [{ type: 'dns', value: domain }],
      });

      // Get authorizations
      const authorizations = await client.getAuthorizations(order);

      // Process HTTP-01 challenge
      for (const authorization of authorizations) {
        const challenge = (authorization as any).challenges?.find(
          (c: any) => c.type === 'http-01'
        );

        if (!challenge) {
          throw new Error('No HTTP-01 challenge found for authorization');
        }

        // Get key authorization
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

        // Write challenge file to webroot
        const challengeDir = path.posix.join(acmeWebrootPath, '.well-known', 'acme-challenge');
        if (!fsAdapter.existsSync(challengeDir)) {
          fsAdapter.mkdirSync(challengeDir, { recursive: true });
        }
        const challengeFilePath = path.posix.join(challengeDir, challenge.token);
        fsAdapter.writeFile(challengeFilePath, keyAuthorization);

        try {
          // Notify ACME server to verify challenge
          await client.completeChallenge(challenge);

          // Wait for challenge validation
          await client.waitForValidStatus(challenge);
        } finally {
          // Clean up challenge file
          try {
            fsAdapter.unlinkSync(challengeFilePath);
          } catch {
            // Challenge file cleanup is best-effort
          }
        }
      }

      // Generate CSR and finalize order
      const [csr, privateKey] = await client.createCsr({ commonName: domain });
      await client.finalizeOrder(order, csr);

      // Get certificate
      const certificate = await client.getCertificate(order);

      // Store certificate and key
      const certPath = getCertPath(domain);
      const keyPath = getKeyPath(domain);

      fsAdapter.writeFile(certPath, certificate);
      fsAdapter.writeFile(keyPath, privateKey);

      // Parse certificate for metadata
      const certBuffer = Buffer.from(certificate);
      const certInfo = parseCertificate(certBuffer);

      // Save to database
      db.upsertCertificate({
        id: uuidv4(),
        domain,
        issuer: certInfo.issuer,
        expiryDate: certInfo.expiryDate.toISOString(),
        renewalStatus: 'auto-managed',
        certPath,
        keyPath,
      });

      // Update domain SSL status
      db.updateDomainSsl(domain, true);

      // Configure HTTPS redirect in Nginx
      await configureHttpsRedirect(domain, certPath, keyPath);

      logger.info(`Certificate provisioned successfully for ${domain}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Certificate provisioning failed for ${domain}: ${message}`);

      if (!isRetry) {
        // Schedule retry after delay (Requirement 13.6)
        logger.info(`Scheduling retry for ${domain} in ${retryDelayMs / 1000} seconds`);
        const retryTimer = setTimeout(() => {
          pendingRetries.delete(domain);
          executeProvisioning(domain, uuidv4(), true).catch((retryErr) => {
            logger.error(`Certificate provisioning retry failed for ${domain}: ${retryErr.message}`);
          });
        }, retryDelayMs);

        if (retryTimer.unref) retryTimer.unref();
        pendingRetries.set(domain, retryTimer);
      }

      throw err;
    }
  }

  // ─── uploadCertificate ───────────────────────────────────────────────

  async function uploadCertificate(domain: string, cert: Buffer, key: Buffer): Promise<void> {
    // Validate cert-key pair (Requirement 13.3, 13.7)
    const validation = validateCertKeyPair(cert, key);
    if (!validation.valid) {
      throw new Error(validation.error ?? 'Certificate validation failed');
    }

    // Parse certificate metadata
    const certInfo = parseCertificate(cert);

    // Store certificate and key files
    const certPath = getCertPath(domain);
    const keyPath = getKeyPath(domain);

    fsAdapter.writeFile(certPath, cert);
    fsAdapter.writeFile(keyPath, key);

    // Save to database
    db.upsertCertificate({
      id: uuidv4(),
      domain,
      issuer: certInfo.issuer,
      expiryDate: certInfo.expiryDate.toISOString(),
      renewalStatus: 'manual',
      certPath,
      keyPath,
    });

    // Update domain SSL status
    db.updateDomainSsl(domain, true);

    // Configure HTTPS redirect (Requirement 13.5)
    await configureHttpsRedirect(domain, certPath, keyPath);

    logger.info(`Custom certificate uploaded for ${domain} (expires: ${certInfo.expiryDate.toISOString()})`);
  }

  // ─── getCertificateStatus ────────────────────────────────────────────

  async function getCertificateStatus(domain: string): Promise<CertificateInfo> {
    const record = db.getCertificate(domain);
    if (!record) {
      throw new Error(`No certificate found for domain: ${domain}`);
    }

    const expiryDate = new Date(record.expiryDate);
    const days = daysUntilExpiry(expiryDate);
    const isValid = days > 0 && fsAdapter.existsSync(record.certPath) && fsAdapter.existsSync(record.keyPath);

    return {
      domain: record.domain,
      issuer: record.issuer,
      expiryDate,
      daysUntilExpiry: days,
      renewalStatus: record.renewalStatus as RenewalStatus,
      isValid,
    };
  }

  // ─── listCertificates ────────────────────────────────────────────────

  async function listCertificates(): Promise<CertificateInfo[]> {
    const records = db.listCertificates();

    return records.map((record) => {
      const expiryDate = new Date(record.expiryDate);
      const days = daysUntilExpiry(expiryDate);
      const isValid = days > 0 && fsAdapter.existsSync(record.certPath) && fsAdapter.existsSync(record.keyPath);

      return {
        domain: record.domain,
        issuer: record.issuer,
        expiryDate,
        daysUntilExpiry: days,
        renewalStatus: record.renewalStatus as RenewalStatus,
        isValid,
      };
    });
  }

  // ─── scheduleRenewal ─────────────────────────────────────────────────

  function scheduleRenewal(domain: string): void {
    // Mark domain as auto-managed so daily cron will handle it
    const record = db.getCertificate(domain);
    if (record) {
      db.upsertCertificate({
        ...record,
        renewalStatus: 'auto-managed',
      });
      logger.info(`Renewal scheduled for ${domain} (auto-managed)`);
    }
  }

  // ─── Renewal Check (daily cron) ──────────────────────────────────────

  async function checkRenewals(): Promise<void> {
    logger.info('Running daily certificate renewal check');

    const records = db.listCertificates();

    for (const record of records) {
      if (record.renewalStatus !== 'auto-managed') continue;

      const expiryDate = new Date(record.expiryDate);
      const days = daysUntilExpiry(expiryDate);

      if (days <= RENEWAL_THRESHOLD_DAYS) {
        logger.info(`Certificate for ${record.domain} expires in ${days} days, initiating renewal`);
        try {
          await executeProvisioning(record.domain, uuidv4(), false);
          logger.info(`Renewal completed for ${record.domain}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Renewal failed for ${record.domain}: ${message}`);
          // Retry is already handled inside executeProvisioning
        }
      }
    }
  }

  function startRenewalCron(): void {
    if (renewalTimer) return;
    renewalTimer = setInterval(() => {
      checkRenewals().catch((err) => {
        logger.error(`Renewal cron error: ${err.message}`);
      });
    }, renewalCheckIntervalMs);

    if (renewalTimer.unref) {
      renewalTimer.unref();
    }

    logger.info(`Renewal cron started (interval: ${renewalCheckIntervalMs}ms)`);
  }

  function stopRenewalCron(): void {
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = null;
    }

    // Clear pending retries
    for (const [domain, timer] of pendingRetries) {
      clearTimeout(timer);
      pendingRetries.delete(domain);
    }

    logger.info('Renewal cron stopped');
  }

  // ─── HTTPS Redirect Configuration ───────────────────────────────────

  async function configureHttpsRedirect(
    domain: string,
    certPath: string,
    keyPath: string
  ): Promise<void> {
    try {
      // Generate redirect config
      const redirectConfig = generateHttpsRedirectConfig(domain);

      // Write the HTTP redirect config
      const redirectConfPath = path.posix.join(nginxConfigDir, `${domain}-redirect.conf`);
      fsAdapter.writeFile(redirectConfPath, redirectConfig);

      // Reload Nginx to apply changes
      await reloadNginx();
      logger.info(`HTTPS redirect configured for ${domain}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to configure HTTPS redirect for ${domain}: ${message}`);
      // Don't throw - the cert is still valid even if redirect fails
    }
  }

  // ─── Return public API ───────────────────────────────────────────────

  return {
    provisionCertificate,
    uploadCertificate,
    getCertificateStatus,
    listCertificates,
    scheduleRenewal,
    startRenewalCron,
    stopRenewalCron,
    checkRenewals,
  };
}
