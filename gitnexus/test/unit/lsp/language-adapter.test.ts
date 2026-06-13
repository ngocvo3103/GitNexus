/**
 * Unit tests: language-adapter.ts — adapter selection + TS adapter literals.
 *
 * Technique: EP (TS repo / Java repo / mixed / unsupported) + equivalence
 * (TS literals byte-identical to `lsp-client.ts` originals).
 *
 * Isolation: `fs.readdirSync` is mocked via `vi.mock`/`vi.hoisted` so
 * no actual filesystem walk occurs. Each test specifies only the
 * extension counts it cares about; everything else returns [].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsModule from 'node:fs';
import * as pathModule from 'node:path';

// ─── Hoisted mock state ────────────────────────────────────────────────

const { mockDirEntries } = vi.hoisted(() => ({
  /**
   * Map from directory path → array of Dirent-like objects.
   * Keys are path segments relative to the mocked repo root.
   * The walk starts at the repoPath; add nested dirs as needed.
   */
  mockDirEntries: new Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>(),
}));

// Mock `node:fs` so the census walk never touches the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    readdirSync: (dir: string, _opts?: unknown) => {
      return mockDirEntries.get(dir) ?? [];
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────

const REPO = '/fake/repo';

/** Build a mock file Dirent. */
function file(name: string): { name: string; isDirectory(): boolean; isFile(): boolean } {
  return { name, isDirectory: () => false, isFile: () => true };
}

/** Build a mock directory Dirent. */
function dir(name: string): { name: string; isDirectory(): boolean; isFile(): boolean } {
  return { name, isDirectory: () => true, isFile: () => false };
}

/**
 * Populate `mockDirEntries` so the root dir contains `entries`.
 * Clears previous state first (used in each test that needs entries).
 */
function setRootEntries(entries: ReturnType<typeof file | typeof dir>[]): void {
  mockDirEntries.clear();
  mockDirEntries.set(REPO, entries);
}

// ─── Imports (after vi.mock) ───────────────────────────────────────────

// Dynamically import after mocks are set up (standard vitest pattern
// for hoisted mocks with ES module resolution).
import {
  TYPESCRIPT_ADAPTER,
  JAVA_ADAPTER,
  selectAdapter,
  type LanguageAdapter,
  type LanguageCanaryStrategy,
  type AdapterReadyCtx,
} from '../../../src/core/ingestion/lsp/language-adapter.js';

// ─── Suite: TYPESCRIPT_ADAPTER literal fidelity ───────────────────────

describe('TYPESCRIPT_ADAPTER', () => {
  it('has id === "typescript"', () => {
    expect(TYPESCRIPT_ADAPTER.id).toBe('typescript');
  });

  it('serverBinary === "typescript-language-server"', () => {
    expect(TYPESCRIPT_ADAPTER.serverBinary).toBe('typescript-language-server');
  });

  it('languageId === "typescript"', () => {
    expect(TYPESCRIPT_ADAPTER.languageId).toBe('typescript');
  });

  it('spawnArgs() === ["--stdio"] (byte-identical to lsp-client.ts line 612)', () => {
    const args = TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    expect(args).toEqual(['--stdio']);
  });

  it('spawnArgs() result is a new array on each call (no shared reference)', () => {
    const a = TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    const b = TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    // Each call returns a fresh array (not the same reference)
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('initializationOptions matches lsp-client.ts TS_INITIALIZATION_OPTIONS', () => {
    const opts = TYPESCRIPT_ADAPTER.initializationOptions as Record<string, unknown>;
    expect(opts).toEqual({
      hostInfo: 'gitnexus-lsp-client',
      tsserver: { path: '' },
    });
  });

  it('awaitReady() resolves true immediately (no-op)', async () => {
    const ctx: AdapterReadyCtx = {
      connection: {},
      workspaceRoot: '/any/path',
    };
    const result = await TYPESCRIPT_ADAPTER.awaitReady(ctx);
    expect(result).toBe(true);
  });

  describe('classifyUri', () => {
    it('file:// URI → "workspace"', () => {
      expect(TYPESCRIPT_ADAPTER.classifyUri('file:///abs/path/to/file.ts')).toBe('workspace');
    });

    it('file:// URI (short form) → "workspace"', () => {
      expect(TYPESCRIPT_ADAPTER.classifyUri('file://localhost/abs/path/to/file.ts')).toBe('workspace');
    });

    it('jdt:// URI → "unmappable" (TS adapter never issues jdt://)', () => {
      // TS adapter does not know about jdt:// — it maps it to unmappable.
      // The Java adapter maps jdt:// to 'external'. This is the correct
      // behavior: TS files never receive jdt:// definitions.
      expect(TYPESCRIPT_ADAPTER.classifyUri('jdt://contents/java/util/List.class?params')).toBe('unmappable');
    });

    it('https:// URI → "unmappable"', () => {
      expect(TYPESCRIPT_ADAPTER.classifyUri('https://example.com/file.ts')).toBe('unmappable');
    });

    it('empty string → "unmappable"', () => {
      expect(TYPESCRIPT_ADAPTER.classifyUri('')).toBe('unmappable');
    });
  });
});

// ─── Suite: JAVA_ADAPTER stub ─────────────────────────────────────────

describe('JAVA_ADAPTER', () => {
  it('has id === "java"', () => {
    expect(JAVA_ADAPTER.id).toBe('java');
  });

  it('serverBinary === "jdtls"', () => {
    expect(JAVA_ADAPTER.serverBinary).toBe('jdtls');
  });

  it('languageId === "java"', () => {
    expect(JAVA_ADAPTER.languageId).toBe('java');
  });

  describe('classifyUri', () => {
    it('file:// URI → "workspace"', () => {
      expect(JAVA_ADAPTER.classifyUri('file:///src/main/java/com/example/Foo.java')).toBe('workspace');
    });

    it('jdt:// URI → "external" (decompiled stdlib/jar def)', () => {
      expect(JAVA_ADAPTER.classifyUri('jdt://contents/java/util/List.class?params')).toBe('external');
    });

    it('jdt:// URI (various forms) → "external"', () => {
      expect(JAVA_ADAPTER.classifyUri('jdt://jar/java.base/java/lang/String.class')).toBe('external');
    });

    it('other URI schemes → "unmappable"', () => {
      expect(JAVA_ADAPTER.classifyUri('https://example.com/foo')).toBe('unmappable');
    });
  });
});

// ─── Suite: selectAdapter — extension census (KD-4) ──────────────────

describe('selectAdapter', () => {
  beforeEach(() => {
    mockDirEntries.clear();
  });

  afterEach(() => {
    mockDirEntries.clear();
  });

  it('returns TYPESCRIPT_ADAPTER for a pure .ts repo', () => {
    setRootEntries([
      file('index.ts'),
      file('utils.ts'),
      file('README.md'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('typescript');
  });

  it('returns TYPESCRIPT_ADAPTER for a .tsx repo', () => {
    setRootEntries([
      file('App.tsx'),
      file('index.tsx'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
  });

  it('returns TYPESCRIPT_ADAPTER for a .mts / .cts repo', () => {
    setRootEntries([
      file('module.mts'),
      file('legacy.cts'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
  });

  it('returns JAVA_ADAPTER for a pure .java repo', () => {
    setRootEntries([
      file('Foo.java'),
      file('Bar.java'),
      file('pom.xml'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('java');
  });

  it('returns TYPESCRIPT_ADAPTER for a mixed repo where TS dominates', () => {
    setRootEntries([
      file('a.ts'),
      file('b.ts'),
      file('c.ts'),
      file('Main.java'), // only 1 Java file; TS wins
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
  });

  it('returns JAVA_ADAPTER for a mixed repo where Java dominates', () => {
    setRootEntries([
      file('Foo.java'),
      file('Bar.java'),
      file('Baz.java'),
      file('index.ts'), // only 1 TS file; Java wins
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('java');
  });

  it('returns TYPESCRIPT_ADAPTER on an exact tie (TS is the safe default)', () => {
    setRootEntries([
      file('a.ts'),
      file('Foo.java'),
    ]);

    // Tie: 1 TS, 1 Java — TS wins as the proven stable path.
    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
  });

  it('returns null for a repo with no supported files (unsupported repo)', () => {
    setRootEntries([
      file('README.md'),
      file('config.yaml'),
      file('script.sh'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  it('returns null for an empty repo', () => {
    setRootEntries([]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  it('skips node_modules during census', () => {
    // The root has no TS files, but node_modules has many.
    // The census should not count node_modules — result: null.
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('node_modules'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'node_modules'), [
      file('some-dep.ts'),
      file('another-dep.ts'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  it('skips target/ (Maven build output) during census', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('target'),
      file('pom.xml'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'target'), [
      file('Foo.class'), // compiled, not .java
      // Simulate target containing java files (shouldn't count)
      file('generated.java'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull(); // target skipped, no .java in root
  });

  it('walks subdirectories for the census', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('src'),
      file('build.gradle'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'src'), [
      file('Main.java'),
      file('Helper.java'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('java');
  });

  it('returns the exact TYPESCRIPT_ADAPTER constant (same reference)', () => {
    setRootEntries([file('index.ts')]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  it('returns the exact JAVA_ADAPTER constant (same reference)', () => {
    setRootEntries([file('Main.java')]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(JAVA_ADAPTER);
  });
});

// ─── Suite: interface shape conformance ───────────────────────────────

describe('LanguageAdapter interface compliance', () => {
  const adapters: LanguageAdapter[] = [TYPESCRIPT_ADAPTER, JAVA_ADAPTER];

  for (const adapter of adapters) {
    describe(`${adapter.id} adapter`, () => {
      it('has all required fields', () => {
        expect(typeof adapter.id).toBe('string');
        expect(typeof adapter.serverBinary).toBe('string');
        expect(typeof adapter.languageId).toBe('string');
        expect(typeof adapter.spawnArgs).toBe('function');
        expect(typeof adapter.awaitReady).toBe('function');
        expect(typeof adapter.classifyUri).toBe('function');
        // canary may be null at this WI; checked separately
      });

      it('classifyUri returns a valid tier for known URI schemes', () => {
        const validTiers = new Set(['workspace', 'external', 'unmappable']);
        expect(validTiers.has(adapter.classifyUri('file:///foo/bar.ts'))).toBe(true);
        expect(validTiers.has(adapter.classifyUri('jdt://contents/bar.class'))).toBe(true);
        expect(validTiers.has(adapter.classifyUri('https://example.com'))).toBe(true);
      });
    });
  }
});
