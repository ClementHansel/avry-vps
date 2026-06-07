import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFileManager, detectLanguage, formatPermissions } from '../../src/modules/file-manager.js';
import type { FileManager } from '../../src/modules/file-manager.js';

describe('File Manager', () => {
  let tmpDir: string;
  let fileManager: FileManager;

  beforeEach(() => {
    // Create a temporary directory as the root for tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
    fileManager = createFileManager({ rootPath: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── isPathAllowed ─────────────────────────────────────────────────────────

  describe('isPathAllowed', () => {
    it('should allow paths within the root', () => {
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');
      expect(fileManager.isPathAllowed('test.txt')).toBe(true);
    });

    it('should allow the root path itself', () => {
      expect(fileManager.isPathAllowed('.')).toBe(true);
    });

    it('should allow nested paths within the root', () => {
      fs.mkdirSync(path.join(tmpDir, 'sub', 'dir'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'sub', 'dir', 'file.ts'), '');
      expect(fileManager.isPathAllowed('sub/dir/file.ts')).toBe(true);
    });

    it('should reject paths with .. that escape root', () => {
      expect(fileManager.isPathAllowed('../../../etc/passwd')).toBe(false);
    });

    it('should reject paths with null bytes', () => {
      expect(fileManager.isPathAllowed('file\0.txt')).toBe(false);
    });

    it('should reject URL-encoded traversal attempts', () => {
      expect(fileManager.isPathAllowed('%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBe(false);
    });

    it('should reject double URL-encoded traversal', () => {
      expect(fileManager.isPathAllowed('%252e%252e%252f')).toBe(false);
    });

    it('should reject URL-encoded null bytes', () => {
      expect(fileManager.isPathAllowed('file%00.txt')).toBe(false);
    });

    // Symlink tests require elevated permissions on Windows — skip if not available
    it.skipIf(process.platform === 'win32')('should reject symlinks that point outside root', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-outside-'));
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret data');

      try {
        fs.symlinkSync(outsideDir, path.join(tmpDir, 'escape-link'));
        expect(fileManager.isPathAllowed('escape-link')).toBe(false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('should allow symlinks that stay within root', () => {
      fs.mkdirSync(path.join(tmpDir, 'real'));
      fs.writeFileSync(path.join(tmpDir, 'real', 'file.txt'), 'content');
      fs.symlinkSync(path.join(tmpDir, 'real'), path.join(tmpDir, 'link'));
      expect(fileManager.isPathAllowed('link')).toBe(true);
    });

    it('should allow paths that do not exist yet (for write)', () => {
      expect(fileManager.isPathAllowed('nonexistent/new-file.txt')).toBe(true);
    });

    it('should reject absolute paths outside root', () => {
      expect(fileManager.isPathAllowed('/etc/passwd')).toBe(false);
    });
  });

  // ─── listDirectory ─────────────────────────────────────────────────────────

  describe('listDirectory', () => {
    it('should list files and directories', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'content');
      fs.mkdirSync(path.join(tmpDir, 'subdir'));

      const result = await fileManager.listDirectory('.');
      expect(result.entries.length).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.total).toBe(2);

      const names = result.entries.map(e => e.name).sort();
      expect(names).toEqual(['file1.txt', 'subdir']);

      const fileEntry = result.entries.find(e => e.name === 'file1.txt');
      expect(fileEntry?.type).toBe('file');
      expect(fileEntry?.size).toBe(7); // 'content' = 7 bytes

      const dirEntry = result.entries.find(e => e.name === 'subdir');
      expect(dirEntry?.type).toBe('directory');
    });

    it('should include permissions in rwx format', async () => {
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data');

      const result = await fileManager.listDirectory('.');
      const entry = result.entries.find(e => e.name === 'test.txt');
      expect(entry?.permissions).toMatch(/^[-dlbcps][rwx-]{9}$/);
    });

    it('should include lastModified as Date', async () => {
      fs.writeFileSync(path.join(tmpDir, 'dated.txt'), 'data');

      const result = await fileManager.listDirectory('.');
      const entry = result.entries.find(e => e.name === 'dated.txt');
      expect(entry?.lastModified).toBeInstanceOf(Date);
    });

    it('should truncate at max entries and report', async () => {
      const fm = createFileManager({ rootPath: tmpDir, maxEntries: 3 });

      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), '');
      }

      const result = await fm.listDirectory('.');
      expect(result.entries.length).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.total).toBe(5);
    });

    it('should not truncate when entries are at or below max', async () => {
      const fm = createFileManager({ rootPath: tmpDir, maxEntries: 5 });

      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), '');
      }

      const result = await fm.listDirectory('.');
      expect(result.entries.length).toBe(5);
      expect(result.truncated).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('should identify symlinks as symlink type', async () => {
      fs.writeFileSync(path.join(tmpDir, 'target.txt'), 'target content');
      fs.symlinkSync(path.join(tmpDir, 'target.txt'), path.join(tmpDir, 'link.txt'));

      const result = await fileManager.listDirectory('.');
      const linkEntry = result.entries.find(e => e.name === 'link.txt');
      expect(linkEntry?.type).toBe('symlink');
    });

    it('should throw for paths outside root', async () => {
      await expect(fileManager.listDirectory('../')).rejects.toThrow('Access denied');
    });

    it('should throw for non-directory paths', async () => {
      fs.writeFileSync(path.join(tmpDir, 'not-a-dir.txt'), 'content');
      await expect(fileManager.listDirectory('not-a-dir.txt')).rejects.toThrow('Not a directory');
    });
  });

  // ─── readFile ──────────────────────────────────────────────────────────────

  describe('readFile', () => {
    it('should read file content', async () => {
      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello, World!');

      const result = await fileManager.readFile('hello.txt');
      expect(result.content).toBe('Hello, World!');
      expect(result.size).toBe(13);
      expect(result.path).toBe('hello.txt');
    });

    it('should detect language for TypeScript files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'const x = 1;');

      const result = await fileManager.readFile('app.ts');
      expect(result.language).toBe('typescript');
    });

    it('should detect language for JSON files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

      const result = await fileManager.readFile('config.json');
      expect(result.language).toBe('json');
    });

    it('should detect language for Dockerfile', async () => {
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18');

      const result = await fileManager.readFile('Dockerfile');
      expect(result.language).toBe('dockerfile');
    });

    it('should default to plaintext for unknown extensions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.xyz'), 'random');

      const result = await fileManager.readFile('data.xyz');
      expect(result.language).toBe('plaintext');
    });

    it('should throw for files exceeding size limit', async () => {
      const fm = createFileManager({ rootPath: tmpDir, maxFileSize: 100 });
      fs.writeFileSync(path.join(tmpDir, 'large.txt'), 'x'.repeat(200));

      await expect(fm.readFile('large.txt')).rejects.toThrow('File too large');
    });

    it('should throw for directory read attempts', async () => {
      fs.mkdirSync(path.join(tmpDir, 'adir'));

      await expect(fileManager.readFile('adir')).rejects.toThrow('Cannot read a directory');
    });

    it('should throw for paths outside root', async () => {
      await expect(fileManager.readFile('../../etc/passwd')).rejects.toThrow('Access denied');
    });

    it('should read nested files', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');

      const result = await fileManager.readFile('src/index.ts');
      expect(result.content).toBe('export {}');
      expect(result.language).toBe('typescript');
    });
  });

  // ─── writeFile ─────────────────────────────────────────────────────────────

  describe('writeFile', () => {
    it('should write content to a file', async () => {
      await fileManager.writeFile('output.txt', 'new content');

      const written = fs.readFileSync(path.join(tmpDir, 'output.txt'), 'utf-8');
      expect(written).toBe('new content');
    });

    it('should overwrite existing files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'old content');

      await fileManager.writeFile('existing.txt', 'updated content');

      const content = fs.readFileSync(path.join(tmpDir, 'existing.txt'), 'utf-8');
      expect(content).toBe('updated content');
    });

    it('should create parent directories if needed', async () => {
      await fileManager.writeFile('deep/nested/dir/file.txt', 'deep content');

      const content = fs.readFileSync(path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt'), 'utf-8');
      expect(content).toBe('deep content');
    });

    it('should throw for paths outside root', async () => {
      await expect(fileManager.writeFile('../../escape.txt', 'bad')).rejects.toThrow('Access denied');
    });

    it('should throw for paths with null bytes', async () => {
      await expect(fileManager.writeFile('bad\0file.txt', 'content')).rejects.toThrow('Access denied');
    });
  });

  // ─── getFileInfo ───────────────────────────────────────────────────────────

  describe('getFileInfo', () => {
    it('should return metadata for a file', async () => {
      fs.writeFileSync(path.join(tmpDir, 'info.txt'), 'some data');

      const info = await fileManager.getFileInfo('info.txt');
      expect(info.name).toBe('info.txt');
      expect(info.size).toBe(9);
      expect(info.type).toBe('file');
      expect(info.lastModified).toBeInstanceOf(Date);
      expect(info.permissions).toMatch(/^[-dlbcps][rwx-]{9}$/);
    });

    it('should return metadata for a directory', async () => {
      fs.mkdirSync(path.join(tmpDir, 'mydir'));

      const info = await fileManager.getFileInfo('mydir');
      expect(info.name).toBe('mydir');
      expect(info.type).toBe('directory');
    });

    it.skipIf(process.platform === 'win32')('should return metadata for a symlink', async () => {
      fs.writeFileSync(path.join(tmpDir, 'target.txt'), 'target');
      fs.symlinkSync(path.join(tmpDir, 'target.txt'), path.join(tmpDir, 'sym.txt'));

      const info = await fileManager.getFileInfo('sym.txt');
      expect(info.name).toBe('sym.txt');
      expect(info.type).toBe('symlink');
    });

    it('should throw for paths outside root', async () => {
      await expect(fileManager.getFileInfo('../../etc/passwd')).rejects.toThrow('Access denied');
    });
  });
});

// ─── Helper function tests ───────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('should detect TypeScript', () => {
    expect(detectLanguage('/path/to/file.ts')).toBe('typescript');
    expect(detectLanguage('/path/to/file.tsx')).toBe('typescript');
  });

  it('should detect JavaScript', () => {
    expect(detectLanguage('/path/to/file.js')).toBe('javascript');
    expect(detectLanguage('/path/to/file.mjs')).toBe('javascript');
  });

  it('should detect YAML', () => {
    expect(detectLanguage('/path/to/config.yml')).toBe('yaml');
    expect(detectLanguage('/path/to/config.yaml')).toBe('yaml');
  });

  it('should detect Dockerfile by name', () => {
    expect(detectLanguage('/path/to/Dockerfile')).toBe('dockerfile');
  });

  it('should detect Makefile by name', () => {
    expect(detectLanguage('/path/to/Makefile')).toBe('makefile');
  });

  it('should return plaintext for unknown extensions', () => {
    expect(detectLanguage('/path/to/file.xyz')).toBe('plaintext');
    expect(detectLanguage('/path/to/file')).toBe('plaintext');
  });
});

describe('formatPermissions', () => {
  it('should format regular file with rwxr-xr-x', () => {
    // Regular file mode: 0o100755
    const mode = 0o100755;
    expect(formatPermissions(mode)).toBe('-rwxr-xr-x');
  });

  it('should format directory with rwxr-xr-x', () => {
    // Directory mode: 0o040755
    const mode = 0o040755;
    expect(formatPermissions(mode)).toBe('drwxr-xr-x');
  });

  it('should format file with rw-r--r--', () => {
    const mode = 0o100644;
    expect(formatPermissions(mode)).toBe('-rw-r--r--');
  });

  it('should format symlink', () => {
    const mode = 0o120777;
    expect(formatPermissions(mode)).toBe('lrwxrwxrwx');
  });

  it('should format no permissions', () => {
    const mode = 0o100000;
    expect(formatPermissions(mode)).toBe('----------');
  });
});
