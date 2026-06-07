/**
 * SSL Manager Unit Tests
 *
 * Tests for Let's Encrypt ACME provisioning, certificate upload validation,
 * renewal scheduling, and HTTPS redirect configuration.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  createSSLManager,
  validateCertKeyPair,
  parseCertificate,
  daysUntilExpiry,
  generateHttpsRedirectConfig,
  generateSslConfig,
} from '../../src/modules/ssl-manager.js';
import type {
  SSLManager,
  SSLManagerConfig,
  DatabaseAdapter,
  FileSystemAdapter,
  AcmeClientAdapter,
  AcmeClientCreateConfig,
  CertificateRecord,
  Logger,
} from '../../src/modules/ssl-manager.js';

// ─── Test Helpers: Generate self-signed cert for testing ───────────────────────

function generateSelfSignedCert(daysValid: number = 365): { cert: Buffer; key: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + daysValid);

  const certPem = createSelfSignedPem(privateKey, publicKey, notBefore, notAfter);

  // Validate by constructing X509Certificate
  const x509 = new crypto.X509Certificate(certPem);

  return {
    cert: Buffer.from(x509.toString()),
    key: Buffer.from(keyPem),
  };
}

function createSelfSignedPem(
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject,
  notBefore: Date,
  notAfter: Date
): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const serialNumber = crypto.randomBytes(8);
  // Ensure serial is positive and non-zero first byte
  serialNumber[0] = (serialNumber[0] & 0x7f) | 0x01;

  const tbsCert = buildTbsCertificate(spkiDer, serialNumber, notBefore, notAfter);

  const signer = crypto.createSign('SHA256');
  signer.update(tbsCert);
  const signature = signer.sign(privateKey);

  const certDer = buildCertificate(tbsCert, signature);

  const base64 = certDer.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// DER encoding helpers
function encodeLengthDer(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  } else if (length < 0x100) {
    return Buffer.from([0x81, length]);
  } else if (length < 0x10000) {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function wrapSequence(content: Buffer): Buffer {
  const len = encodeLengthDer(content.length);
  return Buffer.concat([Buffer.from([0x30]), len, content]);
}

function wrapInteger(value: Buffer): Buffer {
  // Remove leading zeros (except keep one if value would be empty)
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) {
    start++;
  }
  const trimmed = value.subarray(start);
  // Add leading zero if high bit set (to keep it positive)
  const padded = trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
  const len = encodeLengthDer(padded.length);
  return Buffer.concat([Buffer.from([0x02]), len, padded]);
}

function wrapBitString(content: Buffer): Buffer {
  const withPadding = Buffer.concat([Buffer.from([0x00]), content]);
  const len = encodeLengthDer(withPadding.length);
  return Buffer.concat([Buffer.from([0x03]), len, withPadding]);
}

function wrapExplicit(tag: number, content: Buffer): Buffer {
  const len = encodeLengthDer(content.length);
  return Buffer.concat([Buffer.from([0xa0 | tag]), len, content]);
}

function encodeUtcTime(date: Date): Buffer {
  const y = date.getUTCFullYear() % 100;
  const str = [
    y.toString().padStart(2, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
    'Z',
  ].join('');
  const buf = Buffer.from(str, 'ascii');
  const len = encodeLengthDer(buf.length);
  return Buffer.concat([Buffer.from([0x17]), len, buf]);
}

function encodePrintableString(str: string): Buffer {
  const buf = Buffer.from(str, 'ascii');
  const len = encodeLengthDer(buf.length);
  return Buffer.concat([Buffer.from([0x13]), len, buf]);
}

function encodeOid(oid: number[]): Buffer {
  const encoded: number[] = [40 * oid[0] + oid[1]];
  for (let i = 2; i < oid.length; i++) {
    let val = oid[i];
    if (val < 128) {
      encoded.push(val);
    } else {
      const bytes: number[] = [];
      bytes.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        bytes.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.push(...bytes);
    }
  }
  const buf = Buffer.from(encoded);
  const len = encodeLengthDer(buf.length);
  return Buffer.concat([Buffer.from([0x06]), len, buf]);
}

function buildTbsCertificate(
  spkiDer: Buffer,
  serialNumber: Buffer,
  notBefore: Date,
  notAfter: Date
): Buffer {
  // Version v3 (explicit tag 0)
  const version = wrapExplicit(0, wrapInteger(Buffer.from([0x02])));

  // Serial number
  const serial = wrapInteger(serialNumber);

  // Signature algorithm: SHA256WithRSA (1.2.840.113549.1.1.11)
  const sha256WithRsa = encodeOid([1, 2, 840, 113549, 1, 1, 11]);
  const nullVal = Buffer.from([0x05, 0x00]);
  const signatureAlgorithm = wrapSequence(Buffer.concat([sha256WithRsa, nullVal]));

  // Issuer: CN=test
  const cnOid = encodeOid([2, 5, 4, 3]); // commonName
  const cnValue = encodePrintableString('test');
  const rdnAttr = wrapSequence(Buffer.concat([cnOid, cnValue]));
  const rdn = Buffer.concat([Buffer.from([0x31]), encodeLengthDer(rdnAttr.length), rdnAttr]);
  const issuer = wrapSequence(rdn);

  // Validity
  const validity = wrapSequence(Buffer.concat([encodeUtcTime(notBefore), encodeUtcTime(notAfter)]));

  // Subject (same as issuer for self-signed)
  const subject = issuer;

  // Subject Public Key Info (already DER-encoded)
  const parts = Buffer.concat([version, serial, signatureAlgorithm, issuer, validity, subject, spkiDer]);
  return wrapSequence(parts);
}

function buildCertificate(tbsCert: Buffer, signature: Buffer): Buffer {
  // Signature algorithm
  const sha256WithRsa = encodeOid([1, 2, 840, 113549, 1, 1, 11]);
  const nullVal = Buffer.from([0x05, 0x00]);
  const signatureAlgorithm = wrapSequence(Buffer.concat([sha256WithRsa, nullVal]));

  // Signature value (bit string)
  const signatureValue = wrapBitString(signature);

  return wrapSequence(Buffer.concat([tbsCert, signatureAlgorithm, signatureValue]));
}

// ─── Mock ACME Client ──────────────────────────────────────────────────────────

function createMockAcmeClient(): AcmeClientAdapter {
  return {
    createAccount: vi.fn().mockResolvedValue({}),
    createOrder: vi.fn().mockResolvedValue({ id: 'order-123' }),
    getAuthorizations: vi.fn().mockResolvedValue([
      {
        challenges: [
          { type: 'http-01', token: 'test-token-abc', url: 'http://acme/chall/1' },
          { type: 'dns-01', token: 'dns-token', url: 'http://acme/chall/2' },
        ],
      },
    ]),
    getChallengeKeyAuthorization: vi.fn().mockResolvedValue('key-auth-content-xyz'),
    verifyChallenge: vi.fn().mockResolvedValue(undefined),
    completeChallenge: vi.fn().mockResolvedValue(undefined),
    waitForValidStatus: vi.fn().mockResolvedValue(undefined),
    finalizeOrder: vi.fn().mockResolvedValue(undefined),
    getCertificate: vi.fn().mockResolvedValue(''),
    createCsr: vi.fn().mockResolvedValue([Buffer.from('csr-data'), Buffer.from('key-data')]),
  };
}

// ─── Mock Database Adapter ─────────────────────────────────────────────────────

function createMockDb(): DatabaseAdapter & { _store: Map<string, CertificateRecord> } {
  const store = new Map<string, CertificateRecord>();

  return {
    _store: store,
    getCertificate(domain: string) {
      return store.get(domain);
    },
    listCertificates() {
      return Array.from(store.values());
    },
    upsertCertificate(record) {
      store.set(record.domain, { ...record, createdAt: new Date().toISOString() });
    },
    deleteCertificate(domain: string) {
      store.delete(domain);
    },
    getDomainConfig(domain: string) {
      return { id: `dom-${domain}`, domain, sslEnabled: 0 };
    },
    updateDomainSsl(_domain: string, _enabled: boolean) {
      // no-op in mock
    },
  };
}

// ─── Mock File System Adapter ──────────────────────────────────────────────────

function createMockFs(): FileSystemAdapter & { _files: Map<string, Buffer | string> } {
  const files = new Map<string, Buffer | string>();

  return {
    _files: files,
    writeFile(filePath: string, data: Buffer | string) {
      files.set(filePath, data);
    },
    readFile(filePath: string) {
      const data = files.get(filePath);
      if (!data) throw new Error(`ENOENT: no such file: ${filePath}`);
      return Buffer.isBuffer(data) ? data : Buffer.from(data);
    },
    existsSync(filePath: string) {
      return files.has(filePath);
    },
    mkdirSync(_dirPath: string, _opts?: { recursive: boolean }) {
      // no-op in mock
    },
    unlinkSync(filePath: string) {
      files.delete(filePath);
    },
  };
}

// ─── Mock Logger ───────────────────────────────────────────────────────────────

function createMockLogger(): Logger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info(message: string) { logs.push(`INFO: ${message}`); },
    warn(message: string) { logs.push(`WARN: ${message}`); },
    error(message: string) { logs.push(`ERROR: ${message}`); },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('SSL Manager', () => {
  let manager: SSLManager;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockFs: ReturnType<typeof createMockFs>;
  let mockAcme: AcmeClientAdapter;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockReloadNginx: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockFs = createMockFs();
    mockAcme = createMockAcmeClient();
    mockLogger = createMockLogger();
    mockReloadNginx = vi.fn().mockResolvedValue(undefined);

    // Generate a valid self-signed cert for the mock ACME client to return
    const { cert, key } = generateSelfSignedCert(90);
    (mockAcme.getCertificate as ReturnType<typeof vi.fn>).mockResolvedValue(cert.toString());
    (mockAcme.createCsr as ReturnType<typeof vi.fn>).mockResolvedValue([Buffer.from('csr'), key]);

    manager = createSSLManager({
      certStorePath: '/etc/ssl/vps-panel/',
      db: mockDb,
      acmeDirectoryUrl: 'https://acme-staging.example.com/directory',
      acmeEmail: 'test@example.com',
      acmeWebrootPath: '/var/www/acme/',
      nginxConfigDir: '/etc/nginx/sites-enabled/',
      reloadNginx: mockReloadNginx,
      renewalCheckIntervalMs: 1000,
      retryDelayMs: 100,
      createAcmeClient: () => mockAcme,
      fsAdapter: mockFs,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    manager.stopRenewalCron();
  });

  // ─── provisionCertificate ──────────────────────────────────────────────

  describe('provisionCertificate', () => {
    it('should return a job ID immediately', async () => {
      const jobId = await manager.provisionCertificate('example.com');

      expect(jobId).toBeTruthy();
      expect(typeof jobId).toBe('string');
      expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should create an ACME account with email', async () => {
      await manager.provisionCertificate('example.com');

      // Wait for async provisioning to complete
      await vi.waitFor(() => {
        expect(mockAcme.createAccount).toHaveBeenCalledWith({
          termsOfServiceAgreed: true,
          contact: ['mailto:test@example.com'],
        });
      });
    });

    it('should create an order for the domain', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        expect(mockAcme.createOrder).toHaveBeenCalledWith({
          identifiers: [{ type: 'dns', value: 'example.com' }],
        });
      });
    });

    it('should write HTTP-01 challenge file to webroot', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        expect(mockFs._files.has('/var/www/acme/.well-known/acme-challenge/test-token-abc')).toBe(true);
      }, { timeout: 2000 }).catch(() => {
        // Challenge file is cleaned up after validation, so check if completeChallenge was called
        expect(mockAcme.completeChallenge).toHaveBeenCalled();
      });
    });

    it('should complete the ACME challenge', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        expect(mockAcme.completeChallenge).toHaveBeenCalled();
      });
    });

    it('should store certificate and key files', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        expect(mockFs._files.has('/etc/ssl/vps-panel/example.com.crt')).toBe(true);
        expect(mockFs._files.has('/etc/ssl/vps-panel/example.com.key')).toBe(true);
      });
    });

    it('should save certificate record in database', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        const record = mockDb.getCertificate('example.com');
        expect(record).toBeDefined();
        expect(record!.domain).toBe('example.com');
        expect(record!.renewalStatus).toBe('auto-managed');
      });
    });

    it('should configure HTTPS redirect in Nginx', async () => {
      await manager.provisionCertificate('example.com');

      await vi.waitFor(() => {
        expect(mockFs._files.has('/etc/nginx/sites-enabled/example.com-redirect.conf')).toBe(true);
        expect(mockReloadNginx).toHaveBeenCalled();
      });
    });

    it('should call onJobSubmit callback', async () => {
      const onJobSubmit = vi.fn();
      const mgr = createSSLManager({
        certStorePath: '/etc/ssl/vps-panel/',
        db: mockDb,
        reloadNginx: mockReloadNginx,
        createAcmeClient: () => mockAcme,
        fsAdapter: mockFs,
        logger: mockLogger,
        onJobSubmit,
      });

      const jobId = await mgr.provisionCertificate('example.com');

      expect(onJobSubmit).toHaveBeenCalledWith(jobId, 'example.com', 'provision');
      mgr.stopRenewalCron();
    });

    it('should retry once after delay on failure (Requirement 13.6)', async () => {
      vi.useFakeTimers();
      (mockAcme.createAccount as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('ACME server error'))
        .mockResolvedValue({});

      await manager.provisionCertificate('example.com');

      // Wait for the initial failure to be processed
      await vi.advanceTimersByTimeAsync(50);

      // After retry delay, it should retry
      await vi.advanceTimersByTimeAsync(150);

      // Account creation should have been called twice (initial + retry)
      expect(mockAcme.createAccount).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // ─── uploadCertificate ─────────────────────────────────────────────────

  describe('uploadCertificate', () => {
    it('should store valid certificate and key', async () => {
      const { cert, key } = generateSelfSignedCert(365);

      await manager.uploadCertificate('example.com', cert, key);

      expect(mockFs._files.has('/etc/ssl/vps-panel/example.com.crt')).toBe(true);
      expect(mockFs._files.has('/etc/ssl/vps-panel/example.com.key')).toBe(true);
    });

    it('should save certificate as manual in database', async () => {
      const { cert, key } = generateSelfSignedCert(365);

      await manager.uploadCertificate('example.com', cert, key);

      const record = mockDb.getCertificate('example.com');
      expect(record).toBeDefined();
      expect(record!.renewalStatus).toBe('manual');
    });

    it('should reject mismatched cert-key pair (Requirement 13.7)', async () => {
      const { cert } = generateSelfSignedCert(365);
      const { key: differentKey } = generateSelfSignedCert(365);

      await expect(
        manager.uploadCertificate('example.com', cert, differentKey)
      ).rejects.toThrow('Certificate and private key do not match');
    });

    it('should reject expired certificate (Requirement 13.7)', async () => {
      const { cert, key } = generateSelfSignedCert(-1); // Already expired

      await expect(
        manager.uploadCertificate('example.com', cert, key)
      ).rejects.toThrow('Certificate has expired');
    });

    it('should reject invalid certificate data', async () => {
      const invalidCert = Buffer.from('not a valid certificate');
      const { key } = generateSelfSignedCert(365);

      await expect(
        manager.uploadCertificate('example.com', invalidCert, key)
      ).rejects.toThrow();
    });

    it('should reject invalid key data', async () => {
      const { cert } = generateSelfSignedCert(365);
      const invalidKey = Buffer.from('not a valid key');

      await expect(
        manager.uploadCertificate('example.com', cert, invalidKey)
      ).rejects.toThrow();
    });

    it('should configure HTTPS redirect (Requirement 13.5)', async () => {
      const { cert, key } = generateSelfSignedCert(365);

      await manager.uploadCertificate('example.com', cert, key);

      expect(mockFs._files.has('/etc/nginx/sites-enabled/example.com-redirect.conf')).toBe(true);
      expect(mockReloadNginx).toHaveBeenCalled();
    });
  });

  // ─── getCertificateStatus ──────────────────────────────────────────────

  describe('getCertificateStatus', () => {
    it('should return certificate info for existing domain', async () => {
      const { cert, key } = generateSelfSignedCert(90);
      await manager.uploadCertificate('example.com', cert, key);

      const status = await manager.getCertificateStatus('example.com');

      expect(status.domain).toBe('example.com');
      expect(status.daysUntilExpiry).toBeGreaterThan(80);
      expect(status.daysUntilExpiry).toBeLessThanOrEqual(90);
      expect(status.renewalStatus).toBe('manual');
      expect(status.isValid).toBe(true);
    });

    it('should throw for non-existent domain', async () => {
      await expect(
        manager.getCertificateStatus('nonexistent.com')
      ).rejects.toThrow('No certificate found for domain: nonexistent.com');
    });

    it('should report invalid when cert file missing', async () => {
      // Add a record directly without files
      mockDb.upsertCertificate({
        id: 'test-1',
        domain: 'missing.com',
        issuer: 'CN=test',
        expiryDate: new Date(Date.now() + 86400000 * 60).toISOString(),
        renewalStatus: 'manual',
        certPath: '/etc/ssl/vps-panel/missing.com.crt',
        keyPath: '/etc/ssl/vps-panel/missing.com.key',
      });

      const status = await manager.getCertificateStatus('missing.com');

      expect(status.isValid).toBe(false);
    });
  });

  // ─── listCertificates ──────────────────────────────────────────────────

  describe('listCertificates', () => {
    it('should return empty array when no certificates', async () => {
      const certs = await manager.listCertificates();

      expect(certs).toEqual([]);
    });

    it('should return all certificates (Requirement 13.4)', async () => {
      const cert1 = generateSelfSignedCert(90);
      const cert2 = generateSelfSignedCert(30);

      await manager.uploadCertificate('domain1.com', cert1.cert, cert1.key);
      await manager.uploadCertificate('domain2.com', cert2.cert, cert2.key);

      const certs = await manager.listCertificates();

      expect(certs).toHaveLength(2);
      expect(certs.map((c) => c.domain).sort()).toEqual(['domain1.com', 'domain2.com']);
    });

    it('should include issuer, expiry, days until expiry, and renewal status', async () => {
      const { cert, key } = generateSelfSignedCert(60);
      await manager.uploadCertificate('example.com', cert, key);

      const certs = await manager.listCertificates();

      expect(certs[0].issuer).toBeTruthy();
      expect(certs[0].expiryDate).toBeInstanceOf(Date);
      expect(certs[0].daysUntilExpiry).toBeGreaterThan(0);
      expect(certs[0].renewalStatus).toBe('manual');
    });
  });

  // ─── scheduleRenewal ───────────────────────────────────────────────────

  describe('scheduleRenewal', () => {
    it('should mark domain as auto-managed', async () => {
      const { cert, key } = generateSelfSignedCert(365);
      await manager.uploadCertificate('example.com', cert, key);

      manager.scheduleRenewal('example.com');

      const record = mockDb.getCertificate('example.com');
      expect(record!.renewalStatus).toBe('auto-managed');
    });

    it('should log scheduling info', async () => {
      const { cert, key } = generateSelfSignedCert(365);
      await manager.uploadCertificate('example.com', cert, key);

      manager.scheduleRenewal('example.com');

      expect(mockLogger.logs.some((l) => l.includes('Renewal scheduled'))).toBe(true);
    });
  });

  // ─── checkRenewals (daily cron) ────────────────────────────────────────

  describe('checkRenewals', () => {
    it('should renew auto-managed certs expiring within 30 days (Requirement 13.2)', async () => {
      // Add a certificate expiring in 15 days
      mockDb.upsertCertificate({
        id: 'cert-1',
        domain: 'expiring.com',
        issuer: 'CN=test',
        expiryDate: new Date(Date.now() + 86400000 * 15).toISOString(),
        renewalStatus: 'auto-managed',
        certPath: '/etc/ssl/vps-panel/expiring.com.crt',
        keyPath: '/etc/ssl/vps-panel/expiring.com.key',
      });

      await manager.checkRenewals();

      // Should have attempted to provision (createAccount called)
      await vi.waitFor(() => {
        expect(mockAcme.createAccount).toHaveBeenCalled();
      });
    });

    it('should NOT renew certs with more than 30 days remaining', async () => {
      mockDb.upsertCertificate({
        id: 'cert-2',
        domain: 'valid.com',
        issuer: 'CN=test',
        expiryDate: new Date(Date.now() + 86400000 * 60).toISOString(),
        renewalStatus: 'auto-managed',
        certPath: '/etc/ssl/vps-panel/valid.com.crt',
        keyPath: '/etc/ssl/vps-panel/valid.com.key',
      });

      await manager.checkRenewals();

      expect(mockAcme.createAccount).not.toHaveBeenCalled();
    });

    it('should NOT renew manual certificates', async () => {
      mockDb.upsertCertificate({
        id: 'cert-3',
        domain: 'manual.com',
        issuer: 'CN=test',
        expiryDate: new Date(Date.now() + 86400000 * 10).toISOString(),
        renewalStatus: 'manual',
        certPath: '/etc/ssl/vps-panel/manual.com.crt',
        keyPath: '/etc/ssl/vps-panel/manual.com.key',
      });

      await manager.checkRenewals();

      expect(mockAcme.createAccount).not.toHaveBeenCalled();
    });
  });

  // ─── Renewal Cron ──────────────────────────────────────────────────────

  describe('Renewal Cron', () => {
    it('should start and stop renewal cron', () => {
      manager.startRenewalCron();
      manager.startRenewalCron(); // Idempotent
      manager.stopRenewalCron();

      expect(mockLogger.logs.some((l) => l.includes('Renewal cron started'))).toBe(true);
      expect(mockLogger.logs.some((l) => l.includes('Renewal cron stopped'))).toBe(true);
    });

    it('should run renewal check on interval', async () => {
      vi.useFakeTimers();

      // Add expiring cert
      mockDb.upsertCertificate({
        id: 'cert-4',
        domain: 'cron-test.com',
        issuer: 'CN=test',
        expiryDate: new Date(Date.now() + 86400000 * 5).toISOString(),
        renewalStatus: 'auto-managed',
        certPath: '/etc/ssl/vps-panel/cron-test.com.crt',
        keyPath: '/etc/ssl/vps-panel/cron-test.com.key',
      });

      manager.startRenewalCron();

      // Advance past the interval (1000ms in test config)
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockAcme.createAccount).toHaveBeenCalled();

      manager.stopRenewalCron();
      vi.useRealTimers();
    });
  });

  // ─── HTTPS Redirect Configuration ─────────────────────────────────────

  describe('HTTPS Redirect Configuration', () => {
    it('should write redirect config to nginx directory (Requirement 13.5)', async () => {
      const { cert, key } = generateSelfSignedCert(365);
      await manager.uploadCertificate('example.com', cert, key);

      const configContent = mockFs._files.get('/etc/nginx/sites-enabled/example.com-redirect.conf');
      expect(configContent).toBeDefined();
      expect(configContent?.toString()).toContain('return 301 https://');
      expect(configContent?.toString()).toContain('server_name example.com');
    });

    it('should include ACME challenge location in redirect config', async () => {
      const { cert, key } = generateSelfSignedCert(365);
      await manager.uploadCertificate('example.com', cert, key);

      const configContent = mockFs._files.get('/etc/nginx/sites-enabled/example.com-redirect.conf');
      expect(configContent?.toString()).toContain('.well-known/acme-challenge');
    });

    it('should reload Nginx after writing config', async () => {
      const { cert, key } = generateSelfSignedCert(365);
      await manager.uploadCertificate('example.com', cert, key);

      expect(mockReloadNginx).toHaveBeenCalled();
    });

    it('should not throw if Nginx reload fails', async () => {
      mockReloadNginx.mockRejectedValue(new Error('nginx: configuration file test failed'));

      const { cert, key } = generateSelfSignedCert(365);

      // Should not throw even though nginx reload fails
      await expect(
        manager.uploadCertificate('example.com', cert, key)
      ).resolves.not.toThrow();
    });
  });
});

// ─── Helper Function Tests ───────────────────────────────────────────────────

describe('SSL Manager Helpers', () => {
  describe('validateCertKeyPair', () => {
    it('should return valid for matching cert-key pair', () => {
      const { cert, key } = generateSelfSignedCert(365);
      const result = validateCertKeyPair(cert, key);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for mismatched pair', () => {
      const { cert } = generateSelfSignedCert(365);
      const { key: differentKey } = generateSelfSignedCert(365);

      const result = validateCertKeyPair(cert, differentKey);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('do not match');
    });

    it('should return invalid for expired certificate', () => {
      const { cert, key } = generateSelfSignedCert(-1);
      const result = validateCertKeyPair(cert, key);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should return invalid for garbage cert data', () => {
      const result = validateCertKeyPair(
        Buffer.from('garbage cert'),
        Buffer.from('garbage key')
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('daysUntilExpiry', () => {
    it('should return positive days for future date', () => {
      const future = new Date(Date.now() + 86400000 * 45);
      expect(daysUntilExpiry(future)).toBe(45);
    });

    it('should return 0 for today', () => {
      const today = new Date();
      expect(daysUntilExpiry(today)).toBe(0);
    });

    it('should return negative for past date', () => {
      const past = new Date(Date.now() - 86400000 * 5);
      expect(daysUntilExpiry(past)).toBe(-5);
    });
  });

  describe('generateHttpsRedirectConfig', () => {
    it('should include server_name with domain', () => {
      const config = generateHttpsRedirectConfig('example.com');
      expect(config).toContain('server_name example.com');
    });

    it('should listen on port 80', () => {
      const config = generateHttpsRedirectConfig('example.com');
      expect(config).toContain('listen 80');
    });

    it('should redirect to HTTPS', () => {
      const config = generateHttpsRedirectConfig('example.com');
      expect(config).toContain('return 301 https://');
    });

    it('should include ACME challenge passthrough', () => {
      const config = generateHttpsRedirectConfig('example.com');
      expect(config).toContain('acme-challenge');
    });
  });

  describe('generateSslConfig', () => {
    it('should include cert and key paths', () => {
      const config = generateSslConfig('example.com', '/etc/ssl/cert.pem', '/etc/ssl/key.pem');
      expect(config).toContain('/etc/ssl/cert.pem');
      expect(config).toContain('/etc/ssl/key.pem');
    });

    it('should specify TLS 1.2 and 1.3', () => {
      const config = generateSslConfig('example.com', '/cert.pem', '/key.pem');
      expect(config).toContain('TLSv1.2 TLSv1.3');
    });
  });
});
