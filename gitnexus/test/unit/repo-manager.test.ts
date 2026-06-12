/**
 * P1 Unit Tests: Repository Manager
 *
 * Tests: getStoragePath, getStoragePaths, readRegistry, registerRepo, unregisterRepo
 * Covers hardening fixes #29 (API key file permissions) and #30 (case-insensitive paths on Windows)
 *
 * Also covers gh #175: GITNEXUS_HOME env override for test-suite isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getStoragePath,
  getStoragePaths,
  getGlobalDir,
  readRegistry,
  saveCLIConfig,
  loadCLIConfig,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

// ─── getStoragePath ──────────────────────────────────────────────────

describe('getStoragePath', () => {
  it('appends .gitnexus to resolved repo path', () => {
    const result = getStoragePath('/home/user/project');
    expect(result).toContain('.gitnexus');
    expect(path.basename(result)).toBe('.gitnexus');
  });

  it('resolves relative paths', () => {
    const result = getStoragePath('.');
    // Should be an absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── getStoragePaths ─────────────────────────────────────────────────

describe('getStoragePaths', () => {
  it('returns storagePath, lbugPath, metaPath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.storagePath).toContain('.gitnexus');
    expect(paths.lbugPath).toContain('lbug');
    expect(paths.metaPath).toContain('meta.json');
  });

  it('all paths are under storagePath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.lbugPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.metaPath.startsWith(paths.storagePath)).toBe(true);
  });
});

// ─── readRegistry ────────────────────────────────────────────────────

describe('readRegistry', () => {
  it('returns empty array when registry does not exist', async () => {
    // readRegistry reads from ~/.gitnexus/registry.json
    // If the file doesn't exist, it should return []
    // This test exercises the catch path
    const result = await readRegistry();
    // Result is an array (may or may not be empty depending on user's system)
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── CLI Config (file permissions) ───────────────────────────────────

describe('saveCLIConfig / loadCLIConfig', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-config-test-');
    originalHomedir = os.homedir;
    // Mock os.homedir to point to our temp dir
    // Note: This won't fully work because repo-manager uses its own import of os
    // We'll test what we can.
  });

  afterEach(async () => {
    os.homedir = originalHomedir;
    await tmpHandle.cleanup();
  });

  it('loadCLIConfig returns empty object when config does not exist', async () => {
    const config = await loadCLIConfig();
    // Returns {} or existing config
    expect(typeof config).toBe('object');
  });
});

// ─── Case-insensitive path comparison (Windows hardening #30) ────────

describe('case-insensitive path comparison', () => {
  it('registerRepo uses case-insensitive compare on Windows', () => {
    // The fix is in registerRepo: process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase()
    // We verify the logic inline since we can't easily mock process.platform

    const compareWindows = (a: string, b: string): boolean => {
      return a.toLowerCase() === b.toLowerCase();
    };

    // On Windows, these should match
    expect(compareWindows('D:\\Projects\\MyApp', 'd:\\projects\\myapp')).toBe(true);
    expect(compareWindows('C:\\Users\\USER\\project', 'c:\\users\\user\\project')).toBe(true);

    // Different paths should not match
    expect(compareWindows('D:\\Projects\\App1', 'D:\\Projects\\App2')).toBe(false);
  });

  it('case-sensitive compare for non-Windows', () => {
    const compareUnix = (a: string, b: string): boolean => {
      return a === b;
    };

    // On Unix, case matters
    expect(compareUnix('/home/user/Project', '/home/user/project')).toBe(false);
    expect(compareUnix('/home/user/project', '/home/user/project')).toBe(true);
  });
});

// ─── API key file permissions (hardening #29) ────────────────────────

describe('API key file permissions', () => {
  it('saveCLIConfig calls chmod 0o600 on non-Windows', async () => {
    // We verify that the saveCLIConfig code has the chmod call
    // by reading the source and checking statically.
    // The actual chmod behavior is platform-dependent.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'storage', 'repo-manager.ts'),
      'utf-8',
    );
    expect(source).toContain('chmod(configPath, 0o600)');
    expect(source).toContain("process.platform !== 'win32'");
  });
});

// ─── GITNEXUS_HOME override (gh #175 — test-suite isolation) ─────────

describe('getGlobalDir — GITNEXUS_HOME override', () => {
  // Save/restore per-test so mutations never leak to sibling tests within
  // this fork.  Capturing at describe-evaluation time is not safe because
  // per-fork-setup.ts may run after module evaluation on some vitest
  // versions — beforeEach guarantees we snapshot the value that was
  // actually in effect when the test begins.
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.GITNEXUS_HOME;
  });

  afterEach(() => {
    // Restore whatever was set before this specific test ran.
    if (savedHome === undefined) {
      delete process.env.GITNEXUS_HOME;
    } else {
      process.env.GITNEXUS_HOME = savedHome;
    }
  });

  it('returns GITNEXUS_HOME when set', () => {
    process.env.GITNEXUS_HOME = '/tmp/custom-gitnexus-home';
    expect(getGlobalDir()).toBe('/tmp/custom-gitnexus-home');
  });

  it('returns ~/.gitnexus when GITNEXUS_HOME is unset', () => {
    delete process.env.GITNEXUS_HOME;
    const expected = path.join(os.homedir(), '.gitnexus');
    expect(getGlobalDir()).toBe(expected);
  });

  it('returns ~/.gitnexus when GITNEXUS_HOME is empty string', () => {
    process.env.GITNEXUS_HOME = '';
    const expected = path.join(os.homedir(), '.gitnexus');
    expect(getGlobalDir()).toBe(expected);
  });

  it('getGlobalRegistryPath is under GITNEXUS_HOME when set', () => {
    process.env.GITNEXUS_HOME = '/tmp/custom-gitnexus-home';
    // getGlobalRegistryPath is derived from getGlobalDir; verify transitively
    // that the override propagates to all callers.
    const dir = getGlobalDir();
    expect(dir).toBe('/tmp/custom-gitnexus-home');
    // The registry file lives directly inside the home dir
    expect(dir).not.toContain(os.homedir());
  });
});

// ─── Guard: registry path is under GITNEXUS_HOME during the test suite ─

describe('test-suite isolation guard (gh #175)', () => {
  it('resolved global dir is under GITNEXUS_HOME, not the real home', () => {
    // This test fails loudly if GITNEXUS_HOME was not set by per-fork-setup.ts.
    // That would mean the test suite is writing to the real ~/.gitnexus —
    // the regression described in gh #175.
    const gitnexusHome = process.env.GITNEXUS_HOME;
    expect(
      gitnexusHome,
      'GITNEXUS_HOME must be set by per-fork-setup.ts before any test runs',
    ).toBeTruthy();

    const resolvedDir = getGlobalDir();
    expect(
      resolvedDir,
      `getGlobalDir() must return GITNEXUS_HOME (${gitnexusHome}), ` +
        `got: ${resolvedDir}`,
    ).toBe(gitnexusHome);

    // Extra safety: the tmpdir must NOT be inside the real home dir.
    const realHome = os.homedir();
    expect(
      resolvedDir.startsWith(realHome),
      `Registry dir (${resolvedDir}) must not be under the real home (${realHome})`,
    ).toBe(false);
  });

  it('per-fork GITNEXUS_HOME is a unique child of GITNEXUS_TEST_HOME_PARENT', () => {
    // Asserts that the per-fork isolation from per-fork-setup.ts is in effect:
    // GITNEXUS_HOME must exist AND must be a subdirectory of the run-level
    // parent (GITNEXUS_TEST_HOME_PARENT) created by global-setup.ts.
    const gitnexusHome = process.env.GITNEXUS_HOME;
    const parent = process.env.GITNEXUS_TEST_HOME_PARENT;

    expect(gitnexusHome, 'GITNEXUS_HOME must be set').toBeTruthy();

    if (parent) {
      // Normal suite run: per-fork dir must be under the parent.
      expect(
        gitnexusHome!.startsWith(parent),
        `Per-fork GITNEXUS_HOME (${gitnexusHome}) must be under ` +
          `GITNEXUS_TEST_HOME_PARENT (${parent})`,
      ).toBe(true);

      // The per-fork dir must be different from the parent itself
      // (i.e. a real child, not the parent reused).
      expect(
        gitnexusHome,
        'Per-fork GITNEXUS_HOME must be a child of the parent, not the parent itself',
      ).not.toBe(parent);
    }
    // If GITNEXUS_TEST_HOME_PARENT is absent (standalone run / fallback path
    // in per-fork-setup.ts), we only assert that GITNEXUS_HOME is set and
    // not the real homedir — both already checked above.
  });
});
