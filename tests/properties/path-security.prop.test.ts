/**
 * Property-based tests for path traversal prevention.
 *
 * Feature: vps-panel, Property 4: Path traversal prevention
 * For any generated path, isPathAllowed returns true if and only if the resolved,
 * decoded path is within the configured root directory. This includes protection
 * against .. sequences, URL-encoded traversals, double-encoded traversals,
 * null bytes, and absolute paths outside the root.
 *
 * **Validates: Requirements 3.4**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createFileManager, type FileManager } from '../../src/modules/file-manager.js';

let tempRoot: string;
let fileManager: FileManager;

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vps-path-security-'));
}

function cleanupTempRoot(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fully decode a path by iteratively applying decodeURIComponent until stable.
 * Returns null if decoding fails.
 */
function fullyDecode(input: string): string | null {
  try {
    let decoded = input;
    let prev = decoded;
    decoded = decodeURIComponent(decoded);
    while (decoded !== prev) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Determine if a path should be allowed based on path resolution logic.
 * This is our oracle/model for the property test.
 */
function shouldBeAllowed(targetPath: string, rootPath: string): boolean {
  // Null bytes in raw path → reject
  if (targetPath.includes('\0')) {
    return false;
  }

  // Decode iteratively
  const decoded = fullyDecode(targetPath);
  if (decoded === null) {
    return false;
  }

  // Null bytes in decoded path → reject
  if (decoded.includes('\0')) {
    return false;
  }

  // Resolve the path
  const resolved = path.resolve(rootPath, decoded);

  // Must be within root
  if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) {
    return false;
  }

  return true;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generate safe filenames (no path separators or special chars).
 */
const safeFilenameArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '_', '.'
  ),
  { minLength: 1, maxLength: 12 }
).filter((s) => s !== '.' && s !== '..' && !s.startsWith('.'));

/**
 * Generate legitimate paths within the root directory.
 */
const legitimatePathArb = fc.array(safeFilenameArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));

/**
 * Generate paths with .. traversal sequences (varying depth).
 */
const dotDotTraversalArb = fc.tuple(
  fc.integer({ min: 1, max: 8 }),  // number of .. segments
  fc.array(safeFilenameArb, { minLength: 0, maxLength: 2 })
).map(([depth, tail]) => {
  const dots = Array(depth).fill('..').join('/');
  return tail.length > 0 ? `${dots}/${tail.join('/')}` : dots;
});

/**
 * Generate URL-encoded traversal paths (%2e%2e%2f encoding).
 */
const urlEncodedTraversalArb = fc.tuple(
  fc.integer({ min: 1, max: 5 }),
  fc.array(safeFilenameArb, { minLength: 0, maxLength: 2 })
).map(([depth, tail]) => {
  // %2e = '.', %2f = '/'
  const encoded = Array(depth).fill('%2e%2e%2f').join('');
  return tail.length > 0 ? `${encoded}${tail.join('/')}` : encoded;
});

/**
 * Generate double-encoded traversal paths (%252e%252e%252f).
 */
const doubleEncodedTraversalArb = fc.tuple(
  fc.integer({ min: 1, max: 4 }),
  fc.array(safeFilenameArb, { minLength: 0, maxLength: 2 })
).map(([depth, tail]) => {
  // %252e = '%2e' (which decodes to '.'), %252f = '%2f' (which decodes to '/')
  const encoded = Array(depth).fill('%252e%252e%252f').join('');
  return tail.length > 0 ? `${encoded}${tail.join('/')}` : encoded;
});

/**
 * Generate paths containing null bytes.
 */
const nullBytePathArb = fc.tuple(
  safeFilenameArb,
  fc.constantFrom('\0', '%00', '\0/etc/passwd', 'file\0.txt')
).map(([prefix, nullPart]) => `${prefix}/${nullPart}`);

/**
 * Generate absolute paths outside the root.
 */
const absoluteOutsidePathArb = fc.constantFrom(
  '/etc/passwd',
  '/etc/shadow',
  '/root/.ssh/id_rsa',
  '/var/log/syslog',
  '/tmp/malicious',
  'C:\\Windows\\System32',
  '/home/user/.bashrc'
);

/**
 * Combined arbitrary producing various attack vectors and legitimate paths.
 */
const allPathsArb = fc.oneof(
  { weight: 3, arbitrary: legitimatePathArb },
  { weight: 3, arbitrary: dotDotTraversalArb },
  { weight: 2, arbitrary: urlEncodedTraversalArb },
  { weight: 2, arbitrary: doubleEncodedTraversalArb },
  { weight: 2, arbitrary: nullBytePathArb },
  { weight: 2, arbitrary: absoluteOutsidePathArb }
);

describe('Path Traversal Prevention Property Tests', () => {
  beforeEach(() => {
    tempRoot = createTempRoot();
    // Create some subdirectories to make legitimate paths more interesting
    fs.mkdirSync(path.join(tempRoot, 'subdir'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'subdir', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'file.txt'), 'test');
    fs.writeFileSync(path.join(tempRoot, 'subdir', 'config.json'), '{}');

    fileManager = createFileManager({ rootPath: tempRoot });
  });

  afterEach(() => {
    cleanupTempRoot(tempRoot);
  });

  it('Property 4.1: isPathAllowed returns true iff resolved path is within root for any generated path', () => {
    fc.assert(
      fc.property(
        allPathsArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          const expected = shouldBeAllowed(targetPath, tempRoot);

          expect(result).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.2: All paths with .. sequences escaping the root are rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(safeFilenameArb, { minLength: 0, maxLength: 3 }),
        (depth, prefix) => {
          // Build a path that goes up `depth` directories from within root
          const insidePart = prefix.length > 0 ? prefix.join('/') + '/' : '';
          // Go up more levels than the prefix can account for, ensuring escape
          const escapePath = insidePart + Array(prefix.length + depth + 1).fill('..').join('/') + '/etc/passwd';

          const result = fileManager.isPathAllowed(escapePath);
          // The resolved path for an escape attempt should land outside the root
          const decoded = fullyDecode(escapePath);
          if (decoded !== null && !decoded.includes('\0')) {
            const resolved = path.resolve(tempRoot, decoded);
            if (!resolved.startsWith(tempRoot + path.sep) && resolved !== tempRoot) {
              expect(result).toBe(false);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.3: URL-encoded traversals are properly decoded and blocked when escaping root', () => {
    fc.assert(
      fc.property(
        urlEncodedTraversalArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          const expected = shouldBeAllowed(targetPath, tempRoot);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.4: Double-encoded traversals are properly decoded and blocked when escaping root', () => {
    fc.assert(
      fc.property(
        doubleEncodedTraversalArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          const expected = shouldBeAllowed(targetPath, tempRoot);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.5: Paths with null bytes are always rejected', () => {
    fc.assert(
      fc.property(
        nullBytePathArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          // Any path containing a raw null byte should be rejected
          if (targetPath.includes('\0')) {
            expect(result).toBe(false);
          } else {
            // Paths with %00 get decoded to null byte → also rejected
            const decoded = fullyDecode(targetPath);
            if (decoded !== null && decoded.includes('\0')) {
              expect(result).toBe(false);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.6: Absolute paths outside the root are always rejected', () => {
    fc.assert(
      fc.property(
        absoluteOutsidePathArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          const expected = shouldBeAllowed(targetPath, tempRoot);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 4.7: Legitimate relative paths within root are always allowed', () => {
    fc.assert(
      fc.property(
        legitimatePathArb,
        (targetPath) => {
          const result = fileManager.isPathAllowed(targetPath);
          // A relative path with no .. and no special chars should resolve inside root
          expect(result).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
