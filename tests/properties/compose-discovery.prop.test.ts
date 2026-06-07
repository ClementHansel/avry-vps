/**
 * Property-based tests for Docker Compose file discovery.
 *
 * Feature: vps-panel, Property 8: Compose file discovery
 * Test that the scanner returns exactly matching files at depth ≤ 5.
 * For any generated directory tree containing compose files at various depths,
 * discoverComposeFiles() returns exactly the compose files at depth ≤ maxDepth
 * and no others.
 *
 * **Validates: Requirements 7.1**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createComposeManager } from '../../src/modules/compose-manager.js';

let tempRoot: string;

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vps-compose-discovery-'));
}

function cleanupTempRoot(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Compose File Name Patterns ──────────────────────────────────────────────

/** Valid compose file names that should be discovered */
const VALID_COMPOSE_NAMES = [
  'docker-compose.yml',
  'compose.yml',
];

/** Generate a docker-compose.*.yml variant name */
const composeVariantNameArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-'),
  { minLength: 1, maxLength: 8 }
).map((variant) => `docker-compose.${variant}.yml`);

/** Generate any valid compose file name */
const composeFileNameArb = fc.oneof(
  fc.constantFrom(...VALID_COMPOSE_NAMES),
  composeVariantNameArb
);

/** Generate non-compose file names that should NOT be discovered */
const nonComposeFileNameArb = fc.constantFrom(
  'Dockerfile',
  'README.md',
  'package.json',
  'docker-compose.yaml',  // .yaml not .yml
  'compose.yaml',         // .yaml not .yml
  'my-docker-compose.yml', // prefix before docker-compose
  'docker-compose.yml.bak',
  'config.yml',
  '.env',
  'docker-compose',       // no extension
);

// ─── Directory Tree Generation ───────────────────────────────────────────────

/** Safe directory name arbitrary */
const dirNameArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '_'),
  { minLength: 1, maxLength: 8 }
).filter((s) => s !== 'node_modules' && s !== '.git' && s !== '__pycache__');

/**
 * Represents a file to place in the directory tree.
 */
interface PlacedFile {
  /** Path segments from root (directories to traverse) */
  dirSegments: string[];
  /** File name */
  fileName: string;
  /** Whether this is a compose file that should be discovered */
  isCompose: boolean;
}

/**
 * Generate a placed file at a specific depth with either a compose or non-compose name.
 */
const placedFileArb = (maxTestDepth: number): fc.Arbitrary<PlacedFile> =>
  fc.tuple(
    fc.array(dirNameArb, { minLength: 0, maxLength: maxTestDepth }),
    fc.oneof(
      { weight: 3, arbitrary: composeFileNameArb.map((name) => ({ name, isCompose: true })) },
      { weight: 2, arbitrary: nonComposeFileNameArb.map((name) => ({ name, isCompose: false })) }
    )
  ).map(([dirSegments, { name, isCompose }]) => ({
    dirSegments,
    fileName: name,
    isCompose,
  }));

/**
 * Generate a full directory tree specification: a set of placed files
 * at various depths (including depths > 5 to test the boundary).
 */
const directoryTreeArb = fc.array(placedFileArb(8), { minLength: 1, maxLength: 20 });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create the directory tree in the temp root from a set of placed files.
 * Returns the set of expected compose file paths (those at depth ≤ maxDepth).
 */
function buildDirectoryTree(
  root: string,
  files: PlacedFile[],
  maxDepth: number
): Set<string> {
  const expectedPaths = new Set<string>();

  // Deduplicate: if same dir + filename appears multiple times, only create once
  const seen = new Set<string>();

  for (const file of files) {
    const dirPath = path.join(root, ...file.dirSegments);
    const filePath = path.join(dirPath, file.fileName);
    const key = filePath;

    if (seen.has(key)) continue;
    seen.add(key);

    // Create directory structure
    fs.mkdirSync(dirPath, { recursive: true });

    // Write a minimal compose file content
    fs.writeFileSync(filePath, file.isCompose ? 'version: "3"\nservices: {}' : 'content');

    // Depth is the number of directory segments from root
    const depth = file.dirSegments.length;

    if (file.isCompose && depth <= maxDepth) {
      expectedPaths.add(filePath);
    }
  }

  return expectedPaths;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Compose File Discovery Property Tests', () => {
  beforeEach(() => {
    tempRoot = createTempRoot();
  });

  afterEach(() => {
    cleanupTempRoot(tempRoot);
  });

  it('Property 8: Scanner returns exactly the compose files at depth ≤ 5', async () => {
    await fc.assert(
      fc.asyncProperty(
        directoryTreeArb,
        async (files) => {
          // Clean and recreate temp root for each run
          cleanupTempRoot(tempRoot);
          tempRoot = createTempRoot();

          const maxDepth = 5;

          // Build the directory tree and get expected results
          const expectedPaths = buildDirectoryTree(tempRoot, files, maxDepth);

          // Create the compose manager with our temp root
          const manager = createComposeManager({
            rootDir: tempRoot,
            maxDepth,
          });

          // Discover compose files
          const discovered = await manager.discoverComposeFiles();
          const discoveredPaths = new Set(discovered.map((f) => f.filePath));

          // Property: discovered set === expected set
          // All expected files are found
          for (const expected of expectedPaths) {
            expect(discoveredPaths.has(expected)).toBe(true);
          }

          // No unexpected files are found
          for (const found of discoveredPaths) {
            expect(expectedPaths.has(found)).toBe(true);
          }

          // Size equality as a sanity check
          expect(discoveredPaths.size).toBe(expectedPaths.size);

          // Verify depth values are correct
          for (const file of discovered) {
            expect(file.depth).toBeLessThanOrEqual(maxDepth);
            expect(file.depth).toBeGreaterThanOrEqual(0);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
