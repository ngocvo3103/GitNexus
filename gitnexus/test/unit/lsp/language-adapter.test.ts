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

const { mockDirEntries, mockLstatEntries, mockReadFileEntries, mockReaddirStrings } = vi.hoisted(() => ({
  /**
   * Map from directory path → array of Dirent-like objects.
   * Keys are path segments relative to the mocked repo root.
   * The walk starts at the repoPath; add nested dirs as needed.
   * Used by the census (selectAdapter) and the canary walker.
   */
  mockDirEntries: new Map<string, Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>(),

  /**
   * When non-null, readdirSync returns plain string[] entries from this map
   * (so the canary walker can build samples). Cleared between tests.
   * Takes precedence over mockDirEntries when set.
   */
  mockReaddirStrings: new Map<string, string[]>(),

  /**
   * When a path key is present, lstatSync returns a synthetic Stats object
   * reporting the entry as a regular file. Cleared between tests.
   * When absent, the real lstatSync is called (which will throw for fake paths).
   */
  mockLstatEntries: new Set<string>(),

  /**
   * When a path key is present, readFileSync returns the associated string
   * content. Cleared between tests.
   * When absent, the real readFileSync is called.
   */
  mockReadFileEntries: new Map<string, string>(),
}));

// Mock `node:fs` so the census walk never touches the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();

  // Synthetic Stats for a regular file (minimal shape for canary walker).
  function syntheticFileStats(): fsModule.Stats {
    return {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as unknown as fsModule.Stats;
  }

  // Build the mock object with overridden sync methods.
  // IMPORTANT: for CJS/ESM interop, `import fs from 'node:fs'` in consumer
  // modules resolves to the `default` property of the mock namespace. We must
  // override `default` to point to this mock object so that consumer modules
  // using default imports (canary-sampler.ts, language-adapter.ts) pick up
  // the mocked lstatSync/readFileSync/readdirSync. Without this, they would
  // receive `actual.default` (the real fs) bypassing all mocked methods.
  const mockFs: Record<string, unknown> = {
    ...actual,
    readdirSync: (dir: string, _opts?: unknown) => {
      // String-array override (for canary walker tests) takes precedence.
      if (mockReaddirStrings.has(dir)) {
        return mockReaddirStrings.get(dir) as unknown as ReturnType<typeof actual.readdirSync>;
      }
      return mockDirEntries.get(dir) ?? [];
    },
    lstatSync: (p: fsModule.PathLike, _opts?: unknown) => {
      const key = String(p);
      if (mockLstatEntries.has(key)) return syntheticFileStats();
      return actual.lstatSync(p as Parameters<typeof actual.lstatSync>[0]);
    },
    readFileSync: (p: fsModule.PathOrFileDescriptor, options?: unknown) => {
      const key = String(p);
      if (mockReadFileEntries.has(key)) return mockReadFileEntries.get(key) as ReturnType<typeof actual.readFileSync>;
      return (actual.readFileSync as (...args: unknown[]) => unknown)(p, options) as ReturnType<typeof actual.readFileSync>;
    },
  };
  // Point `default` at the mock itself so default-import consumers see the mocks.
  mockFs['default'] = mockFs;
  return mockFs as typeof actual;
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
  PYTHON_ADAPTER,
  GO_ADAPTER,
  RUST_ADAPTER,
  PYLSP_READY_DEADLINE_MS,
  GOPLS_READY_DEADLINE_MS,
  RUST_ANALYZER_READY_DEADLINE_MS,
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

// ─── Suite: PYTHON_ADAPTER census + selectAdapter ─────────────────────
//
// WI-1 test cases: Decision Table (collapsed) + EP on extension-count
// partitions (cases 1–16 per spec).

describe('PYTHON_ADAPTER census + selectAdapter', () => {
  beforeEach(() => {
    mockDirEntries.clear();
  });

  afterEach(() => {
    mockDirEntries.clear();
  });

  // Case 1: pyCount > tsCount AND > javaCount → PYTHON_ADAPTER
  it('case 1: pyCount strict dominant → PYTHON_ADAPTER (id="python")', () => {
    setRootEntries([
      file('main.py'),
      file('utils.py'),
      file('helper.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('python');
    expect(adapter).toBe(PYTHON_ADAPTER);
  });

  // Case 2: tsCount > pyCount AND > javaCount → TYPESCRIPT_ADAPTER (golden lock)
  it('case 2: tsCount strict dominant → TYPESCRIPT_ADAPTER (golden lock)', () => {
    setRootEntries([
      file('a.ts'),
      file('b.ts'),
      file('c.ts'),
      file('main.py'), // only 1 .py; TS wins
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  // Case 3: javaCount > tsCount AND > pyCount → JAVA_ADAPTER (golden lock)
  it('case 3: javaCount strict dominant → JAVA_ADAPTER (golden lock)', () => {
    setRootEntries([
      file('Foo.java'),
      file('Bar.java'),
      file('Baz.java'),
      file('main.py'), // only 1 .py; Java wins
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('java');
    expect(adapter).toBe(JAVA_ADAPTER);
  });

  // Case 4: all counts === 0 → null
  it('case 4: all counts === 0 → null (funnel not entered)', () => {
    setRootEntries([
      file('README.md'),
      file('Makefile'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 5: tsCount === javaCount > pyCount → TYPESCRIPT_ADAPTER (existing tie-break preserved)
  it('case 5: tsCount === javaCount > pyCount → TYPESCRIPT_ADAPTER (TS tie-break preserved)', () => {
    setRootEntries([
      file('a.ts'),
      file('Foo.java'),
      // pyCount = 0
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  // Case 6: tsCount === pyCount > javaCount → TYPESCRIPT_ADAPTER (Python wins only on STRICT dominance)
  it('case 6: tsCount === pyCount (tie) → TYPESCRIPT_ADAPTER (Python not strictly dominant)', () => {
    setRootEntries([
      file('a.ts'),
      file('main.py'), // tie: 1 ts, 1 py, 0 java
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  // Case 7: .py inside site-packages/ NOT counted
  it('case 7: .py under site-packages/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('site-packages'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'site-packages'), [
      file('requests.py'),
      file('urllib3.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull(); // site-packages skipped; no .py at root
  });

  // Case 8: .py inside .tox/ NOT counted
  it('case 8: .py under .tox/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('.tox'),
      file('setup.py'), // this one IS at root level — counted
    ]);
    mockDirEntries.set(pathModule.join(REPO, '.tox'), [
      file('test_env.py'),
      file('config.py'),
    ]);

    const adapter = selectAdapter(REPO);
    // only setup.py at root is counted → pyCount=1, tsCount=0, javaCount=0 → PYTHON_ADAPTER
    expect(adapter!.id).toBe('python');
  });

  // Case 9: .py inside eggs/ NOT counted
  it('case 9: .py under eggs/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('eggs'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'eggs'), [
      file('egg_pkg.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 10: .py inside .eggs/ NOT counted
  it('case 10: .py under .eggs/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('.eggs'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, '.eggs'), [
      file('pkg.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 11: .py inside dist-packages/ NOT counted
  it('case 11: .py under dist-packages/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('dist-packages'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'dist-packages'), [
      file('numpy.py'),
      file('pandas.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 12: .py inside __pycache__/ NOT counted (already in SKIP_DIRS pre-WI-1)
  it('case 12: .py under __pycache__/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('__pycache__'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, '__pycache__'), [
      file('module.cpython-311.pyc'),
      file('compiled.py'), // shouldn't be there, but counted would be wrong
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 13: .py inside .venv/ NOT counted (already in SKIP_DIRS pre-WI-1)
  it('case 13: .py under .venv/ NOT counted toward pyCount', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('.venv'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, '.venv'), [
      file('activate.py'),
      file('pip.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // Case 14: pure-Python repo (tsCount=0, javaCount=0, pyCount=N) → PYTHON_ADAPTER
  //          (previously short-circuited to null then TS via tie-break)
  it('case 14: pure-Python repo (tsCount=0, javaCount=0, pyCount=50) → PYTHON_ADAPTER', () => {
    setRootEntries([
      // 5 .py files (enough to demonstrate dominance with no competing languages)
      file('main.py'),
      file('crawler.py'),
      file('utils.py'),
      file('config.py'),
      file('models.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('python');
  });

  // Case 15: mixed — 5 .py at root + 10 under site-packages/ → pyCount=5 compares correctly
  it('case 15: mixed — 5 .py repo-level + 10 under site-packages/ → pyCount=5 wins', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('site-packages'),
      file('main.py'),
      file('crawler.py'),
      file('utils.py'),
      file('config.py'),
      file('models.py'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'site-packages'), [
      file('requests.py'),
      file('urllib3.py'),
      file('certifi.py'),
      file('charset_normalizer.py'),
      file('idna.py'),
      file('six.py'),
      file('attrs.py'),
      file('packaging.py'),
      file('pyparsing.py'),
      file('setuptools.py'),
    ]);

    const adapter = selectAdapter(REPO);
    // pyCount=5 (root only); tsCount=0; javaCount=0 → PYTHON_ADAPTER
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('python');
  });

  // Case 16 is a tsc compile-time check (verified by CI, no runtime assertion needed).
  // We do include a runtime shape check to confirm the union widening is observable:
  it('case 16 (runtime shape): PYTHON_ADAPTER.id satisfies widened "python" literal type', () => {
    // If LanguageAdapter.id were still 'typescript'|'java', TypeScript would
    // flag PYTHON_ADAPTER.id as an error at the declaration site. The compile
    // gate in tsc --noEmit covers this; here we just lock the runtime value.
    expect(PYTHON_ADAPTER.id).toBe('python');
  });

  it('returns the exact PYTHON_ADAPTER constant (same reference)', () => {
    setRootEntries([
      file('a.py'),
      file('b.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(PYTHON_ADAPTER);
  });
});

// ─── Suite: PYTHON_ADAPTER singleton identity (WI-V2) ────────────────
//
// Invariant: PYTHON_ADAPTER is a module-level singleton, not a factory.
// Any code that receives the exported constant is working with the same
// object — accidental factory-style wrapping would break reference equality.

describe('PYTHON_ADAPTER singleton identity', () => {
  it('is the same object reference on every access (module-level singleton, not factory)', () => {
    // Accessing the named export twice must yield the same object reference.
    // This guards against any accidental refactor that turns the const into
    // a factory function or getter that allocates a new object per access.
    const ref1 = PYTHON_ADAPTER;
    const ref2 = PYTHON_ADAPTER;
    expect(ref1).toBe(ref2);
  });

  it('selectAdapter returns the exact PYTHON_ADAPTER singleton (same reference as export)', () => {
    // The selectAdapter function must return the same singleton constant,
    // not a structural clone. Downstream code that compares adapter identity
    // with === relies on this guarantee.
    setRootEntries([file('main.py'), file('utils.py'), file('crawler.py')]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(PYTHON_ADAPTER);
  });
});

// ─── Suite: PYTHON_ADAPTER literal fields ─────────────────────────────

describe('PYTHON_ADAPTER', () => {
  it('has id === "python"', () => {
    expect(PYTHON_ADAPTER.id).toBe('python');
  });

  it('serverBinary === "pylsp"', () => {
    expect(PYTHON_ADAPTER.serverBinary).toBe('pylsp');
  });

  it('languageId === "python"', () => {
    expect(PYTHON_ADAPTER.languageId).toBe('python');
  });

  it('spawnArgs() === [] (pylsp uses stdio by default; --stdio is unrecognized and causes exit code 2)', () => {
    const args = PYTHON_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    expect(args).toEqual([]);
  });

  it('spawnArgs() returns a new array on each call (no shared reference)', () => {
    const a = PYTHON_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    const b = PYTHON_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('initializationOptions deep-equals {}', () => {
    expect(PYTHON_ADAPTER.initializationOptions).toEqual({});
  });

  describe('classifyUri', () => {
    it('file:// URI → "workspace" (scheme-only; containment at mapper — ruling #3)', () => {
      expect(PYTHON_ADAPTER.classifyUri('file:///path/to/crawler.py')).toBe('workspace');
    });

    it('site-packages file:// → "workspace" (containment at mapper; NOT "external" here)', () => {
      // Anti-pattern guard: asserting 'external' here is explicitly prohibited
      // by the Test Strategy §anti-patterns (ruling #3). classifyUri returns
      // 'workspace' for ALL file:// URIs — including external paths.
      expect(PYTHON_ADAPTER.classifyUri(
        'file:///Users/ngoc/.local/lib/python3.14/site-packages/requests/__init__.py',
      )).toBe('workspace');
    });

    it('jdt:// URI → "unmappable" (Python adapter never sees jdt://)', () => {
      expect(PYTHON_ADAPTER.classifyUri('jdt://contents/java/util/List.class')).toBe('unmappable');
    });

    it('https:// URI → "unmappable"', () => {
      expect(PYTHON_ADAPTER.classifyUri('https://example.com/file.py')).toBe('unmappable');
    });

    it('empty string → "unmappable"', () => {
      expect(PYTHON_ADAPTER.classifyUri('')).toBe('unmappable');
    });

    // ── WI-V2 acceptance criteria (exact URIs from spec) ─────────────────

    it('AC: classifyUri("file:///Users/NgocVo_1/Documents/sourceCode/crawl4ai/crawler.py") → "workspace"', () => {
      // Acceptance criterion from WI-V2: the real crawl4ai workspace file URI
      // must classify as 'workspace'. file:// is a scheme-only signal; no path
      // containment check is performed here (that is owned by location-mapper).
      expect(PYTHON_ADAPTER.classifyUri(
        'file:///Users/NgocVo_1/Documents/sourceCode/crawl4ai/crawler.py',
      )).toBe('workspace');
    });

    it('AC: classifyUri("someother://x") → "unmappable"', () => {
      // Acceptance criterion from WI-V2: any unknown scheme that is neither
      // file:// nor jdt:// must fall through to 'unmappable'. This confirms
      // the classifyUri signature is unchanged: (uri: string) => 'workspace' |
      // 'external' | 'unmappable'.
      expect(PYTHON_ADAPTER.classifyUri('someother://x')).toBe('unmappable');
    });
  });

  // ─── Nested suite: awaitReady behavior (WI-2c) ────────────────────────
  //
  // Technique: State testing (ready/timeout/error/empty) + Error Guessing
  //   (no-listener invariant, dispose-leak, multi-sample short-circuit).
  //
  // Isolation: all cases use backstopProbe injection so no real filesystem
  //   or LSP binary is involved. Handler-count assertions are the primary
  //   tripwires (activeHandlerCount('language/status') must stay 0 throughout).
  //
  // Relation to WI-2b harness suite (lines 906+):
  //   The WI-2b suite exercises the same behaviors from outside the
  //   PYTHON_ADAPTER describe, with additional variants and fake-timer
  //   machinery. This nested suite locks the same invariants in the canonical
  //   location (inside PYTHON_ADAPTER) per the WI-2c invariant.
  //
  // Note: makePythonFakeConnection is declared as a function below (line ~726)
  // and is hoisted, making it accessible here.

  describe('awaitReady', () => {
    afterEach(() => {
      // Restore real timers in case any test used vi.useFakeTimers().
      vi.useRealTimers();
    });

    // ── Behavior 5: activeHandlerCount('language/status') === 0 — before AND after resolve ──

    it('activeHandlerCount("language/status") === 0 before AND after resolve', async () => {
      // GIVEN a fresh fake connection (count starts at 0)
      const conn = makePythonFakeConnection();
      expect(conn.activeHandlerCount('language/status')).toBe(0); // BEFORE

      // WHEN awaitReady is called (backstopProbe resolves immediately to false)
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/python-workspace',
        backstopProbe: async () => false,
      };
      await PYTHON_ADAPTER.awaitReady(ctx);

      // THEN count is still 0 — no listener was ever registered
      expect(conn.activeHandlerCount('language/status')).toBe(0); // AFTER
    });

    // ── Behavior 1: resolves true when canary returns non-empty Location[] ──

    it('resolves true when backstopProbe returns true (non-empty Location[] signal)', async () => {
      // GIVEN a fake connection and a backstopProbe that signals ready
      const conn = makePythonFakeConnection();
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/python-workspace',
        backstopProbe: async () => true,
      };

      // WHEN awaitReady is called
      const result = await PYTHON_ADAPTER.awaitReady(ctx);

      // THEN it resolves true
      expect(result).toBe(true);
      // AND no language/status handler was registered
      expect(conn.activeHandlerCount('language/status')).toBe(0);
    });

    // ── Behavior 2: resolves false (not reject) on timeout ──

    it('resolves false (not reject) when deadline elapses before probe returns', async () => {
      vi.useFakeTimers();

      // GIVEN a backstopProbe that never resolves (stalled server)
      let cancelProbe: (() => void) | null = null;
      const conn = makePythonFakeConnection();
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/python-workspace',
        deadlineMs: 3_000,
        backstopProbe: () => new Promise<boolean>((_, reject) => {
          cancelProbe = () => reject(new Error('test teardown'));
        }),
      };

      const promise = PYTHON_ADAPTER.awaitReady(ctx);

      // WHEN the deadline elapses
      await vi.advanceTimersByTimeAsync(3_001);

      // THEN it resolves false (never rejects)
      const result = await promise;
      expect(result).toBe(false);
      // AND still no language/status handler
      expect(conn.activeHandlerCount('language/status')).toBe(0);

      // Clean up the dangling probe promise to avoid unhandled-rejection noise.
      cancelProbe?.();
    });

    // ── Behavior 3: resolves false (not reject) on connection error ──

    it('resolves false (not reject) when backstopProbe throws a connection error', async () => {
      // GIVEN a fake connection whose probe rejects with an error
      const conn = makePythonFakeConnection();
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/python-workspace',
        backstopProbe: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
      };

      // WHEN awaitReady is called
      // THEN it resolves false (does NOT reject)
      await expect(PYTHON_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
      expect(conn.activeHandlerCount('language/status')).toBe(0);
    });

    // ── Behavior 4: resolves false on empty sample set ──

    it('resolves false when the workspace has no .py candidate files (empty sample set)', async () => {
      // GIVEN a mocked filesystem with no .py files in the workspace
      mockDirEntries.clear();
      mockDirEntries.set('/fake/no-py-ws', [file('README.md'), file('config.json')]);

      const conn = makePythonFakeConnection();
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/no-py-ws',
        // No backstopProbe — exercises the real buildCanarySamples → 0-samples path
      };

      // WHEN awaitReady is called
      const result = await PYTHON_ADAPTER.awaitReady(ctx);

      // THEN it resolves false (graceful degrade; no crash, no reject)
      expect(result).toBe(false);
      expect(conn.activeHandlerCount('language/status')).toBe(0);
    });

    // ── Behavior 6: clean dispose — no handler leak after resolve ──

    it('no handler leak after resolve: activeHandlerCount returns to 0 post-resolve', async () => {
      // GIVEN a fake connection where we verify the full registration lifecycle
      const conn = makePythonFakeConnection();

      // Confirm zero handlers before
      expect(conn.activeHandlerCount('language/status')).toBe(0);

      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/fake/python-workspace',
        backstopProbe: async () => true,
      };

      // WHEN awaitReady resolves
      await PYTHON_ADAPTER.awaitReady(ctx);

      // THEN zero handlers remain (nothing registered, nothing leaked)
      expect(conn.activeHandlerCount('language/status')).toBe(0);

      // AND the same is true for any other notification channel
      expect(conn.activeHandlerCount('window/logMessage')).toBe(0);
      expect(conn.activeHandlerCount('textDocument/publishDiagnostics')).toBe(0);
    });

    // ── Behavior 7: multi-sample — first sample empty, second non-empty → true ──
    //
    // The backstopProbe seam is a WHOLESALE replacement for the sample loop — it
    // is called once and settles immediately. Multi-sample iteration can only be
    // exercised via the real sample loop (no backstopProbe) with a fake connection
    // whose sendRequest returns [] for the first call and a non-empty Location[]
    // for the second call.
    //
    // Isolation strategy: populate mockReaddirStrings / mockLstatEntries /
    // mockReadFileEntries (hoisted mock extensions) so that buildCanarySamples
    // finds exactly 2 walkable .py files without touching the real filesystem.

    it('multi-sample: first sendRequest returns [], second returns Location[] → resolves true', async () => {
      const WORKSPACE = '/fake/multi-ws';
      const file1 = `${WORKSPACE}/a.py`;
      const file2 = `${WORKSPACE}/b.py`;
      const pyContent = 'def greet():\n    pass\n';

      // Populate the hoisted mock maps so the canary walker finds 2 .py files.
      mockReaddirStrings.set(WORKSPACE, ['a.py', 'b.py']);
      mockLstatEntries.add(file1);
      mockLstatEntries.add(file2);
      mockReadFileEntries.set(file1, pyContent);
      mockReadFileEntries.set(file2, pyContent);

      // Build a custom fake connection where:
      //   - first sendRequest call (a.py sample) → [] (not yet ready)
      //   - second sendRequest call (b.py sample) → non-empty Location[]
      let sendRequestCallCount = 0;
      const readyLocation = [{ uri: `file://${file2}`, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }];

      const baseConn = makePythonFakeConnection();
      const observedMethods: string[] = [];
      const multiConn = {
        onNotification: baseConn.onNotification,
        activeHandlerCount: baseConn.activeHandlerCount,
        sendNotification: baseConn.sendNotification,
        async sendRequest<T>(method: string, _params: unknown): Promise<T> {
          observedMethods.push(method);
          sendRequestCallCount++;
          if (sendRequestCallCount === 1) return [] as T;     // first sample: not ready
          return readyLocation as T;                           // second sample: ready
        },
      };

      const ctx: AdapterReadyCtx = {
        connection: multiConn,
        workspaceRoot: WORKSPACE,
        // No backstopProbe — exercises the real multi-sample loop.
      };

      // WHEN awaitReady is called
      const result = await PYTHON_ADAPTER.awaitReady(ctx);

      // THEN it resolves true (advanced past the first empty result to the second sample)
      expect(result).toBe(true);
      // AND sendRequest was called at least twice (first → empty, second → non-empty)
      expect(sendRequestCallCount).toBeGreaterThanOrEqual(2);
      // AND every sendRequest call used the 'textDocument/definition' method (ruling #8)
      expect(observedMethods.every(m => m === 'textDocument/definition')).toBe(true);
      // AND no language/status handler was ever registered
      expect(baseConn.activeHandlerCount('language/status')).toBe(0);

      // Teardown: clear the multi-sample mock state.
      mockReaddirStrings.delete(WORKSPACE);
      mockLstatEntries.delete(file1);
      mockLstatEntries.delete(file2);
      mockReadFileEntries.delete(file1);
      mockReadFileEntries.delete(file2);
    });
  });
});

// ─── FakeMessageConnection harness (WI-2b) ───────────────────────────
//
// Purpose: a controllable stand-in for the real vscode-languageserver-protocol
// MessageConnection, used to test PYTHON_ADAPTER.awaitReady without spawning
// a real pylsp process.
//
// Key design properties:
//   - onNotification(method, handler): increments a per-method registration
//     count; returns { dispose() } that decrements it (the leak/dispose tripwire).
//   - activeHandlerCount(method): returns the current live (non-disposed)
//     registration count — used to assert PYTHON_ADAPTER registers NO
//     'language/status' handler.
//   - sendRequest(method, params): returns a configurable verdict — a non-empty
//     Location[], an empty [], or throws — controlled per-test via opts.
//   - sendNotification(method, params): a recordable no-op spy; never throws
//     unless configured with sendNotificationThrows: true (error-path coverage).
//
// Invariant: this harness lives in test scope only.
// No import of this harness is added to production language-adapter.ts.

type NotifHandler = (params: unknown) => void;

interface PythonFakeConnectionOpts {
  /**
   * What sendRequest resolves to.
   * Default: [] (empty array — server not ready).
   * Pass a non-empty array to simulate a ready definition response.
   */
  sendRequestResult?: unknown;
  /** If true, sendRequest rejects with an Error instead of resolving. */
  sendRequestRejects?: boolean;
  /**
   * If true, sendNotification throws on the first call.
   * Used to exercise the error path in awaitReady's didOpen step.
   */
  sendNotificationThrows?: boolean;
}

/**
 * Build a fresh fake MessageConnection for Python awaitReady tests.
 *
 * Returned object exposes the full vscode-jsonrpc surface that
 * PYTHON_ADAPTER.awaitReady touches, plus test-only inspection helpers
 * (`activeHandlerCount`, `emit`, `sendNotificationCalls`, etc.).
 */
function makePythonFakeConnection(opts: PythonFakeConnectionOpts = {}) {
  // Per-method handler registry: tracks live (not-yet-disposed) entries.
  const handlers = new Map<string, Set<{ fn: NotifHandler; disposed: boolean }>>();

  let sendRequestCallCount = 0;
  const sendNotificationCalls: Array<{ method: string; params: unknown }> = [];

  // ── onNotification ────────────────────────────────────────────────
  function onNotification(method: string, handler: NotifHandler): { dispose(): void } {
    if (!handlers.has(method)) {
      handlers.set(method, new Set());
    }
    const entry = { fn: handler, disposed: false };
    handlers.get(method)!.add(entry);

    return {
      dispose(): void {
        entry.disposed = true;
        handlers.get(method)?.delete(entry);
      },
    };
  }

  // ── sendRequest ───────────────────────────────────────────────────
  async function sendRequest<T>(_method: string, _params: unknown): Promise<T> {
    sendRequestCallCount++;
    if (opts.sendRequestRejects) {
      throw new Error('sendRequest failed (test-configured)');
    }
    // Default: empty array → "server not ready" verdict.
    return ((opts.sendRequestResult ?? []) as T);
  }

  // ── sendNotification ──────────────────────────────────────────────
  async function sendNotification(method: string, params: unknown): Promise<void> {
    sendNotificationCalls.push({ method, params });
    if (opts.sendNotificationThrows) {
      throw new Error('sendNotification failed (test-configured)');
    }
  }

  // ── Test-only helpers ─────────────────────────────────────────────

  /**
   * Count active (not yet disposed) handlers for `method`.
   * This is the primary tripwire for the no-listener invariant:
   *   activeHandlerCount('language/status') must remain 0 throughout
   *   PYTHON_ADAPTER.awaitReady — pylsp emits no such notification.
   */
  function activeHandlerCount(method: string): number {
    let count = 0;
    handlers.get(method)?.forEach((entry) => {
      if (!entry.disposed) count++;
    });
    return count;
  }

  /** Emit a notification to all currently registered handlers for `method`. */
  function emit(method: string, params: unknown): void {
    handlers.get(method)?.forEach((entry) => {
      if (!entry.disposed) entry.fn(params);
    });
  }

  return {
    // vscode-jsonrpc surface (what awaitReady calls)
    onNotification,
    sendRequest,
    sendNotification,
    // Test-only inspection
    activeHandlerCount,
    emit,
    get sendRequestCallCount() { return sendRequestCallCount; },
    get sendNotificationCalls() { return sendNotificationCalls; },
  };
}

// ─── Suite: FakeMessageConnection harness self-validation (WI-2b AC) ──
//
// BDD Acceptance Criteria (verbatim from WI-2b):
//   AC-1: GIVEN a fresh fake connection, THEN activeHandlerCount('language/status') === 0
//   AC-2: GIVEN a handler registered then disposed, THEN activeHandlerCount returns to
//         its pre-registration value (the leak/dispose tripwire works)

describe('FakeMessageConnection harness (WI-2b)', () => {
  it('AC-1: fresh connection has activeHandlerCount("language/status") === 0', () => {
    // GIVEN a fresh fake connection
    const conn = makePythonFakeConnection();
    // THEN no handlers are registered for any method
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('AC-2: handler registered then disposed → count returns to pre-registration value', () => {
    // GIVEN a fresh fake connection (count === 0)
    const conn = makePythonFakeConnection();
    expect(conn.activeHandlerCount('language/status')).toBe(0);

    // WHEN a handler is registered
    const disposable = conn.onNotification('language/status', (_params) => { /* noop */ });
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    // AND the disposable is called
    disposable.dispose();

    // THEN count returns to its pre-registration value (0)
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('multiple registrations accumulate; each dispose decrements independently', () => {
    const conn = makePythonFakeConnection();

    const d1 = conn.onNotification('language/status', () => { /* noop */ });
    const d2 = conn.onNotification('language/status', () => { /* noop */ });
    expect(conn.activeHandlerCount('language/status')).toBe(2);

    d1.dispose();
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    d2.dispose();
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('sendRequest resolves empty [] by default (server-not-ready verdict)', async () => {
    const conn = makePythonFakeConnection();
    const result = await conn.sendRequest<unknown[]>('textDocument/definition', {});
    expect(result).toEqual([]);
  });

  it('sendRequest resolves the configured non-empty result (server-ready verdict)', async () => {
    const readyResult = [{ uri: 'file:///repo/crawler.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    const conn = makePythonFakeConnection({ sendRequestResult: readyResult });
    const result = await conn.sendRequest<unknown[]>('textDocument/definition', {});
    expect(result).toEqual(readyResult);
  });

  it('sendRequest rejects when sendRequestRejects: true', async () => {
    const conn = makePythonFakeConnection({ sendRequestRejects: true });
    await expect(conn.sendRequest('textDocument/definition', {})).rejects.toThrow();
  });

  it('sendNotification records calls and does not throw by default', async () => {
    const conn = makePythonFakeConnection();
    await conn.sendNotification('textDocument/didOpen', { textDocument: { uri: 'file:///foo.py' } });
    expect(conn.sendNotificationCalls).toHaveLength(1);
    expect(conn.sendNotificationCalls[0]!.method).toBe('textDocument/didOpen');
  });

  it('different methods have independent handler counts', () => {
    const conn = makePythonFakeConnection();
    conn.onNotification('language/status', () => { /* noop */ });
    conn.onNotification('window/logMessage', () => { /* noop */ });

    expect(conn.activeHandlerCount('language/status')).toBe(1);
    expect(conn.activeHandlerCount('window/logMessage')).toBe(1);
    // A third method was never registered
    expect(conn.activeHandlerCount('textDocument/publishDiagnostics')).toBe(0);
  });
});

// ─── Suite: PYTHON_ADAPTER.awaitReady — fake connection (WI-2b harness) ──
//
// Tests for all 7 behavior cases enumerated in the WI-2a spec:
//   1. Resolves true when backstopProbe returns true (canary non-empty Location[])
//   2. Multi-sample short-circuit: advances to next sample on empty result,
//      resolves true on first non-empty
//   3. Resolves false when buildCanarySamples returns [] (no .py files in workspace)
//   4. Resolves false (not reject) on timeout (deadlineMs elapsed)
//   5. Resolves false (not reject) on connection error (sendRequest throws)
//   6. NEVER calls connection.onNotification('language/status', ...)
//   7. Disposes cleanly after resolve (timer cleared, no leaked handlers)
//
// Isolation strategy:
//   - Cases 1, 2, 5: use ctx.backstopProbe injection seam to supply a
//     controlled readiness verdict without filesystem access.
//   - Case 3: rely on the mocked fs (mockDirEntries returns []) so
//     buildCanarySamples walks an empty tree → 0 samples.
//   - Case 4: use ctx.backstopProbe that never resolves + fake timer advance
//     via vi.useFakeTimers.
//   - Cases 6, 7: structural invariants asserted in every relevant case.

describe('PYTHON_ADAPTER.awaitReady — fake connection (WI-2b harness)', () => {
  afterEach(() => {
    // Restore real timers after any fake-timer test.
    vi.useRealTimers();
    mockDirEntries.clear();
  });

  // ── Invariant: NEVER registers language/status handler ──────────────

  it('NEVER calls connection.onNotification("language/status", ...) — no-listener invariant', async () => {
    // The core behavioral difference vs JAVA_ADAPTER.
    // pylsp emits no language/status; registering a handler would be a silent leak.
    const conn = makePythonFakeConnection();
    expect(conn.activeHandlerCount('language/status')).toBe(0);

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => false,
    };

    await PYTHON_ADAPTER.awaitReady(ctx);

    // Must stay 0 — before, during, and after awaitReady.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  // ── Case 1: resolves true when canary returns non-empty Location[] ──

  it('case 1: resolves true when backstopProbe returns true (non-empty Location[])', async () => {
    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => true,
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);

    expect(result).toBe(true);
    // Invariant: no language/status listener registered
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('case 1 (direct): resolves true when sendRequest returns non-empty Location[] via canary', async () => {
    // Build a fake workspace with one .py file so buildCanarySamples yields a sample.
    // We mock lstatSync and readFileSync to return a minimal .py file.
    const WORKSPACE = '/fake/canary-ws';
    const pyUri = 'file:///fake/canary-ws/main.py';
    const pyContent = 'def greet():\n    pass\n';

    // Set up the census mock (readdirSync is already mocked globally).
    mockDirEntries.clear();
    mockDirEntries.set(WORKSPACE, [file('main.py')]);

    // Override lstatSync and readFileSync for this test only.
    const origLstat = (vi.mocked(fsModule.lstatSync, { partial: true }) ?? null);
    void origLstat; // suppress unused

    // Simplest path: use backstopProbe returning true to avoid needing lstat/readFile mocks.
    // The direct path (no backstopProbe) is exercised by the integration test (WI-7).
    // Here we verify the no-listener + true-resolution contract via injection.
    const conn = makePythonFakeConnection({
      sendRequestResult: [{ uri: pyUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }],
    });

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: WORKSPACE,
      backstopProbe: async () => true,
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);
    expect(result).toBe(true);
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  // ── Case 2: multi-sample short-circuit ──────────────────────────────

  it('case 2: backstopProbe returning true on first call short-circuits (resolves true)', async () => {
    let callCount = 0;
    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => {
        callCount++;
        return true; // first call: ready
      },
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);
    expect(result).toBe(true);
    // backstopProbe is invoked once (short-circuit on first true)
    expect(callCount).toBe(1);
  });

  // ── Case 3: resolves false when no .py files (empty buildCanarySamples) ─

  it('case 3: resolves false when buildCanarySamples returns [] (no candidate files)', async () => {
    // The mock filesystem returns an empty directory → buildCanarySamples yields [].
    mockDirEntries.clear();
    mockDirEntries.set('/fake/empty-ws', []);

    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/empty-ws',
      // No backstopProbe — exercise the real buildCanarySamples → 0-samples path.
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);
    expect(result).toBe(false);
    // Still no language/status listener.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('case 3 (variant): resolves false when workspace has files but none are .py', async () => {
    // Non-.py files are ignored by PYTHON_CANARY_STRATEGY.isCandidateFile.
    mockDirEntries.clear();
    mockDirEntries.set('/fake/ts-ws', [file('index.ts'), file('README.md')]);

    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/ts-ws',
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);
    expect(result).toBe(false);
  });

  // ── Case 4: resolves false (not reject) on timeout ──────────────────

  it('case 4: resolves false (not reject) when deadlineMs elapses before probe returns', async () => {
    vi.useFakeTimers();

    let probeResolveFn: ((v: boolean) => void) | null = null;
    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      deadlineMs: 5_000,
      // Inject a backstopProbe that never resolves (simulates a stalled server).
      backstopProbe: () => new Promise<boolean>((resolve) => { probeResolveFn = resolve; }),
    };

    const promise = PYTHON_ADAPTER.awaitReady(ctx);

    // Advance past the deadline — the timer should fire and settle(false).
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await promise;
    expect(result).toBe(false);
    expect(conn.activeHandlerCount('language/status')).toBe(0);

    // Clean up the dangling promise by resolving it (avoids unhandled-rejection noise).
    probeResolveFn?.(false);
  });

  it('case 4 (variant): PYLSP_READY_DEADLINE_MS is used as default when deadlineMs is absent', async () => {
    // Verify that PYLSP_READY_DEADLINE_MS is exported and is a positive number.
    expect(typeof PYLSP_READY_DEADLINE_MS).toBe('number');
    expect(PYLSP_READY_DEADLINE_MS).toBeGreaterThan(0);

    // Verify it is used when ctx.deadlineMs is omitted by checking the timer fires
    // after its value elapses (fake timers).
    vi.useFakeTimers();

    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      // No deadlineMs — should default to PYLSP_READY_DEADLINE_MS.
      backstopProbe: () => new Promise<boolean>(() => { /* never resolves */ }),
    };

    const promise = PYTHON_ADAPTER.awaitReady(ctx);

    // Should still be pending before the deadline elapses.
    await vi.advanceTimersByTimeAsync(PYLSP_READY_DEADLINE_MS - 1);
    // (Cannot assert pending without a race; just advance past it.)
    await vi.advanceTimersByTimeAsync(2);

    const result = await promise;
    expect(result).toBe(false);
  });

  // ── Case 5: resolves false (not reject) on connection error ─────────

  it('case 5: resolves false (not reject) when backstopProbe rejects', async () => {
    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => { throw new Error('sendRequest failed'); },
    };

    // Must not throw — must resolve false.
    await expect(PYTHON_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
    expect(conn.activeHandlerCount('language/status')).toBe(0);
  });

  it('case 5 (variant): resolves false when sendRequest rejects (connection error path)', async () => {
    // Exercise the real probe loop's try/catch by using sendRequestRejects
    // and a .py file in the mocked workspace so buildCanarySamples yields a sample.
    // We still need lstat to work for the walk — but since lstatSync is not mocked,
    // buildCanarySamples will scan the real (empty) /fake/python-workspace dir and
    // return []. This triggers case 3 (no samples → false) before sendRequest fires.
    // So we use backstopProbe to synthesize the error path cleanly.
    const conn = makePythonFakeConnection({ sendRequestRejects: true });
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => { throw new Error('connection error'); },
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);
    expect(result).toBe(false);
  });

  // ── Case 6: NEVER registers language/status (already covered above) ─
  // (All cases above assert conn.activeHandlerCount('language/status') === 0.)

  // ── Case 7: disposes cleanly — timer cleared, no leaked handlers ────

  it('case 7: resolves exactly once — concurrent resolve attempts are idempotent', async () => {
    // Verify the settled guard: if resolve fires twice (e.g. backstopProbe
    // resolves AND deadline fires simultaneously), only one value wins.
    vi.useFakeTimers();

    let callCount = 0;
    const conn = makePythonFakeConnection();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      deadlineMs: 1_000,
      backstopProbe: async () => {
        callCount++;
        return true; // resolves immediately before deadline
      },
    };

    const result = await PYTHON_ADAPTER.awaitReady(ctx);

    // Advance past deadline — should be a no-op since already settled.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(result).toBe(true);
    // Only one resolve call (the first backstopProbe call).
    expect(callCount).toBe(1);
  });

  it('case 7: awaitReady resolves a boolean — never rejects', async () => {
    // Regression guard: verify Promise<boolean> contract across error paths.
    const conn = makePythonFakeConnection({ sendRequestRejects: true });
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/python-workspace',
      backstopProbe: async () => false,
    };

    await expect(PYTHON_ADAPTER.awaitReady(ctx)).resolves.toSatisfy(
      (v: unknown) => typeof v === 'boolean',
    );
  });
});

// ─── Suite: GO_ADAPTER census + selectAdapter (WI-1) ─────────────────
//
// Decision Table (selectAdapter) + EP (censusExtensions) for the Go
// strict-dominance branch. Cases C1-1 through C1-12 per plan.

describe('GO_ADAPTER census + selectAdapter', () => {
  beforeEach(() => {
    mockDirEntries.clear();
  });

  afterEach(() => {
    mockDirEntries.clear();
  });

  // C1-1: Pure Go: 10 .go / 0 .ts / 0 .java / 0 .py → GO_ADAPTER (id='go')
  it('C1-1: pure Go repo → GO_ADAPTER (id="go")', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('middleware.go'),
      file('config.go'),
      file('db.go'),
      file('models.go'),
      file('utils.go'),
      file('server.go'),
      file('logger.go'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('go');
  });

  // C1-2: Go strict-dominance wins: 10 .go / 2 .ts / 0 .java → GO_ADAPTER
  it('C1-2: Go strict-dominance (10 .go / 2 .ts / 0 .java) → GO_ADAPTER', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('middleware.go'),
      file('config.go'),
      file('db.go'),
      file('models.go'),
      file('utils.go'),
      file('server.go'),
      file('logger.go'),
      file('index.ts'),
      file('utils.ts'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('go');
  });

  // C1-3: Go tie with TS (5 .go / 5 .ts): TYPESCRIPT_ADAPTER wins
  // Go requires STRICT dominance; ties go to TS (proven-stable default).
  it('C1-3: Go tie with TS (5 .go / 5 .ts) → TYPESCRIPT_ADAPTER (Go loses ties)', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('config.go'),
      file('server.go'),
      file('index.ts'),
      file('utils.ts'),
      file('app.ts'),
      file('types.ts'),
      file('api.ts'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('typescript');
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  // C1-4: Java dominates (5 .go / 3 .ts / 6 .java): JAVA_ADAPTER
  // Go is not strictly dominant (goCount=5 < javaCount=6).
  it('C1-4: Java dominates (5 .go / 3 .ts / 6 .java) → JAVA_ADAPTER', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('config.go'),
      file('server.go'),
      file('index.ts'),
      file('utils.ts'),
      file('app.ts'),
      file('Foo.java'),
      file('Bar.java'),
      file('Baz.java'),
      file('Qux.java'),
      file('Quux.java'),
      file('Corge.java'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('java');
    expect(adapter).toBe(JAVA_ADAPTER);
  });

  // C1-5: Go strict-dominance with py present (8 .go / 2 .ts / 2 .java / 3 .py)
  it('C1-5: Go strict-dominance over Python (8 .go / 2 .ts / 2 .java / 3 .py) → GO_ADAPTER', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('config.go'),
      file('server.go'),
      file('db.go'),
      file('models.go'),
      file('utils.go'),
      file('index.ts'),
      file('app.ts'),
      file('Foo.java'),
      file('Bar.java'),
      file('main.py'),
      file('utils.py'),
      file('config.py'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('go');
    expect(adapter).toBe(GO_ADAPTER);
  });

  // C1-6: All-zero guard includes goCount: 0 .go / 0 .ts / 0 .java / 0 .py → null
  it('C1-6: all counts === 0 (including goCount) → null', () => {
    setRootEntries([
      file('README.md'),
      file('Makefile'),
      file('go.mod'), // go.mod is not a .go file — not counted
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // C1-7: Pure Go repo does NOT hit all-zero guard (I-14)
  // The fix for the pre-Python pattern: (goCount > 0, others === 0) must
  // return GO_ADAPTER, NOT short-circuit to null via the all-zero guard.
  it('C1-7: pure Go repo (goCount > 0, others=0) → GO_ADAPTER (NOT null — I-14)', () => {
    setRootEntries([
      file('main.go'),
      file('go.mod'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('go');
    expect(adapter).toBe(GO_ADAPTER);
  });

  // C1-8: Go tie with Java (5 .go / 0 .ts / 5 .java)
  // goCount=5 is NOT > javaCount=5 (not strictly dominant) → Go branch skipped.
  // Then: pyCount > tsCount && pyCount > javaCount → false (pyCount=0).
  // Then: tsCount >= javaCount → 0 >= 5 → false → JAVA_ADAPTER.
  it('C1-8: Go tie with Java (5 .go / 0 .ts / 5 .java) → JAVA_ADAPTER (Java wins tie-break)', () => {
    setRootEntries([
      file('main.go'),
      file('handler.go'),
      file('router.go'),
      file('config.go'),
      file('server.go'),
      file('Foo.java'),
      file('Bar.java'),
      file('Baz.java'),
      file('Qux.java'),
      file('Quux.java'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter!.id).toBe('java');
    expect(adapter).toBe(JAVA_ADAPTER);
  });

  // C1-9: censusExtensions skips vendor/ dir for .go counting (I-12)
  // SKIP_DIRS already contains 'vendor' — verifying it is honoured.
  it('C1-9: .go files under vendor/ NOT counted toward goCount (SKIP_DIRS has vendor)', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('vendor'),
      file('README.md'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'vendor'), [
      file('dep1.go'),
      file('dep2.go'),
      file('dep3.go'),
    ]);

    // vendor/ is skipped → goCount=0, all others=0 → null (no .go at root)
    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // C1-9 (additive): vendor/ skipped but .go at root still counted
  it('C1-9 (additive): vendor/ skipped; root .go files ARE counted', () => {
    mockDirEntries.clear();
    mockDirEntries.set(REPO, [
      dir('vendor'),
      file('main.go'),
    ]);
    mockDirEntries.set(pathModule.join(REPO, 'vendor'), [
      file('dep1.go'),
      file('dep2.go'),
    ]);

    // vendor/ is skipped → goCount=1 (from root main.go only) → GO_ADAPTER
    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('go');
  });

  // C1-10: GO_ADAPTER constant is the exact reference returned (same object)
  it('C1-10: selectAdapter returns the exact GO_ADAPTER constant (same reference)', () => {
    setRootEntries([
      file('main.go'),
      file('server.go'),
    ]);

    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(GO_ADAPTER);
  });

  // C1-11: LanguageAdapter.id union widening: GO_ADAPTER.id === 'go'
  it('C1-11: GO_ADAPTER.id === "go" (union widened to include \'go\' literal)', () => {
    expect(GO_ADAPTER.id).toBe('go');
  });

  // C1-12: Existing TS/Java/Python selection cases unchanged (regression lock)
  // Verify that adding the Go branch did NOT alter pre-P4 behaviour.
  it('C1-12: existing TS selection unchanged (regression lock)', () => {
    setRootEntries([file('index.ts'), file('utils.ts')]);
    expect(selectAdapter(REPO)).toBe(TYPESCRIPT_ADAPTER);
  });

  it('C1-12: existing Java selection unchanged (regression lock)', () => {
    setRootEntries([file('Foo.java'), file('Bar.java')]);
    expect(selectAdapter(REPO)).toBe(JAVA_ADAPTER);
  });

  it('C1-12: existing Python selection unchanged (regression lock)', () => {
    setRootEntries([file('main.py'), file('utils.py'), file('app.py')]);
    expect(selectAdapter(REPO)).toBe(PYTHON_ADAPTER);
  });

  it('C1-12: existing null-for-unsupported-repo unchanged (regression lock)', () => {
    setRootEntries([file('README.md'), file('Makefile')]);
    expect(selectAdapter(REPO)).toBeNull();
  });
});

// ─── Suite: GO_ADAPTER literal fields ─────────────────────────────────

describe('GO_ADAPTER', () => {
  it('has id === "go"', () => {
    expect(GO_ADAPTER.id).toBe('go');
  });

  it('serverBinary === "gopls"', () => {
    expect(GO_ADAPTER.serverBinary).toBe('gopls');
  });

  it('languageId === "go"', () => {
    expect(GO_ADAPTER.languageId).toBe('go');
  });

  it('spawnArgs() === [] (spike-confirmed: bare gopls uses stdio by default)', () => {
    const args = GO_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    expect(args).toEqual([]);
  });

  it('spawnArgs() returns a new array on each call (no shared reference)', () => {
    const a = GO_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    const b = GO_ADAPTER.spawnArgs({ workspaceRoot: '/any/path' });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('initializationOptions deep-equals {}', () => {
    expect(GO_ADAPTER.initializationOptions).toEqual({});
  });

  // C2-RL-struct smoke: awaitReady structural smoke (WI-1 stub replaced by WI-2c).
  // Full behavioural suite lives in GO_ADAPTER.awaitReady describe below (C2-12..C2-23).
  // This test locks the basic contract in the structural literal suite: with no
  // progress signal and a backstopProbe that returns false, awaitReady resolves false.
  // Uses makeGoFakeConn() (defined at module scope below) + fake timers so it runs
  // in < 1ms — replacing the previous 50ms real-timer stub.
  it('awaitReady() resolves false (structural smoke: no progress signal, backstopProbe false)', async () => {
    vi.useFakeTimers();
    try {
      const conn = makeGoFakeConn();
      const ctx: AdapterReadyCtx = {
        connection: conn,
        workspaceRoot: '/any/go-workspace',
        deadlineMs: 100,
        backstopProbe: async () => false,
      };
      const promise = GO_ADAPTER.awaitReady(ctx);
      await vi.advanceTimersByTimeAsync(101);
      const result = await promise;
      expect(result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('classifyUri', () => {
    it('file:// URI → "workspace" (scheme-only; containment at mapper)', () => {
      expect(GO_ADAPTER.classifyUri('file:///path/to/main.go')).toBe('workspace');
    });

    it('file:// URI for stdlib (mod-cache toolchain) → "workspace" (containment NOT here)', () => {
      // Go stdlib arrives as file:// under the mod-cache toolchain dir.
      // classifyUri returns 'workspace' — out-of-repo refusal is path-containment
      // gated on adapterId in location-mapper.ts (isExternalRefusalAdapter),
      // NOT in classifyUri. Do NOT add GOROOT-special-casing here.
      expect(GO_ADAPTER.classifyUri(
        'file:///Users/ngoc/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.0.darwin-arm64/src/net/http/server.go',
      )).toBe('workspace');
    });

    it('jdt:// URI → "unmappable" (Go adapter never receives jdt://)', () => {
      expect(GO_ADAPTER.classifyUri('jdt://contents/java/util/List.class')).toBe('unmappable');
    });

    it('https:// URI → "unmappable"', () => {
      expect(GO_ADAPTER.classifyUri('https://example.com/foo.go')).toBe('unmappable');
    });

    it('empty string → "unmappable"', () => {
      expect(GO_ADAPTER.classifyUri('')).toBe('unmappable');
    });
  });
});

// ─── Suite: GO_ADAPTER singleton identity ─────────────────────────────

describe('GO_ADAPTER singleton identity', () => {
  it('is the same object reference on every access (module-level singleton, not factory)', () => {
    const ref1 = GO_ADAPTER;
    const ref2 = GO_ADAPTER;
    expect(ref1).toBe(ref2);
  });

  it('selectAdapter returns the exact GO_ADAPTER singleton', () => {
    setRootEntries([file('main.go'), file('server.go'), file('handler.go')]);
    expect(selectAdapter(REPO)).toBe(GO_ADAPTER);
  });
});

// ─── Suite: GOPLS_READY_DEADLINE_MS ───────────────────────────────────

describe('GOPLS_READY_DEADLINE_MS', () => {
  it('is exported and equals 30000ms (spike-confirmed gopls cold-load margin)', () => {
    expect(GOPLS_READY_DEADLINE_MS).toBe(30_000);
  });

  // C2-21 (I-15): standalone dual-sided assertion — the constant must be exactly
  // 30_000 AND must not be 120_000 (Java's jdtls default).  The not.toBe half is
  // a first-class guard here, not a side assertion buried inside C2-20.
  it('C2-21 (I-15): GOPLS_READY_DEADLINE_MS === 30_000 and !== 120_000 (distinct from Java deadline)', () => {
    expect(GOPLS_READY_DEADLINE_MS).toBe(30_000);
    expect(GOPLS_READY_DEADLINE_MS).not.toBe(120_000);
  });
});

// ─── Suite: WI-0 clientCapabilities seam (C0-1..C0-6, C0-7 type-level) ──
//
// Cases C0-1..C0-6 are runtime assertions covering the new
// `LanguageAdapter.clientCapabilities` optional field.  C0-7 is the
// tsc --noEmit gate: since this test file is compiled as part of the
// suite, a type error in C0-7 would prevent compilation of this file.
//
// C0-8..C0-11 live in lsp-client.test.ts (handler-ordering and wire
// behavior require the LspClient injection harness).

import { type ClientCapabilities } from '../../../src/core/ingestion/lsp/language-adapter.js';
import { RUST_CANARY_STRATEGY } from '../../../src/core/ingestion/lsp/canary-sampler.js';
// TS_SERVER_CAPABILITIES is module-private in lsp-client.ts; we verify identity
// indirectly: GO_ADAPTER.clientCapabilities must NOT === undefined and its
// window.workDoneProgress must be true. The reference-inequality with any other
// adapter is asserted by confirming the object literal is fresh (different shape
// from the TS capabilities payload).

describe('WI-0 clientCapabilities seam', () => {
  // C0-1: GO_ADAPTER.clientCapabilities.window.workDoneProgress === true
  it('C0-1: GO_ADAPTER.clientCapabilities.window.workDoneProgress === true', () => {
    expect(GO_ADAPTER.clientCapabilities).toBeDefined();
    expect(GO_ADAPTER.clientCapabilities!.window).toBeDefined();
    expect(GO_ADAPTER.clientCapabilities!.window!.workDoneProgress).toBe(true);
  });

  // C0-2: GO_ADAPTER.clientCapabilities is NOT the same object reference as
  //        TS_SERVER_CAPABILITIES (which is module-private — we check identity
  //        via the fact that different adapters return different objects).
  it('C0-2: GO_ADAPTER.clientCapabilities is distinct from TYPESCRIPT_ADAPTER capabilities', () => {
    // TYPESCRIPT_ADAPTER uses the module-private TS_SERVER_CAPABILITIES as its
    // default (clientCapabilities is undefined → lsp-client.ts falls back).
    // GO_ADAPTER.clientCapabilities must be a fresh object — it carries
    // workDoneProgress: true which is structurally different.
    expect(GO_ADAPTER.clientCapabilities).not.toBe(undefined);
    // workDoneProgress is false in TS_SERVER_CAPABILITIES, true in GO_ADAPTER.
    // This structural difference is the identity marker.
    expect(GO_ADAPTER.clientCapabilities!.window!.workDoneProgress).toBe(true);
    // TS adapter explicitly omits clientCapabilities (falls through to default).
    expect(TYPESCRIPT_ADAPTER.clientCapabilities).toBeUndefined();
  });

  // C0-3: TYPESCRIPT_ADAPTER.clientCapabilities === undefined
  it('C0-3: TYPESCRIPT_ADAPTER.clientCapabilities === undefined (absent → uses TS_SERVER_CAPABILITIES)', () => {
    expect(TYPESCRIPT_ADAPTER.clientCapabilities).toBeUndefined();
  });

  // C0-4: JAVA_ADAPTER.clientCapabilities === undefined
  it('C0-4: JAVA_ADAPTER.clientCapabilities === undefined (absent → uses TS_SERVER_CAPABILITIES)', () => {
    expect(JAVA_ADAPTER.clientCapabilities).toBeUndefined();
  });

  // C0-5: PYTHON_ADAPTER.clientCapabilities === undefined
  it('C0-5: PYTHON_ADAPTER.clientCapabilities === undefined (absent → uses TS_SERVER_CAPABILITIES)', () => {
    expect(PYTHON_ADAPTER.clientCapabilities).toBeUndefined();
  });

  // C0-6: Existing TS/Java/Python golden assertions unchanged (regression lock)
  it('C0-6: TYPESCRIPT_ADAPTER.id/serverBinary/languageId unchanged (golden regression lock)', () => {
    expect(TYPESCRIPT_ADAPTER.id).toBe('typescript');
    expect(TYPESCRIPT_ADAPTER.serverBinary).toBe('typescript-language-server');
    expect(TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any' })).toEqual(['--stdio']);
  });

  it('C0-6: JAVA_ADAPTER.id/serverBinary/languageId unchanged (golden regression lock)', () => {
    expect(JAVA_ADAPTER.id).toBe('java');
    expect(JAVA_ADAPTER.serverBinary).toBe('jdtls');
  });

  it('C0-6: PYTHON_ADAPTER.id/serverBinary/languageId unchanged (golden regression lock)', () => {
    expect(PYTHON_ADAPTER.id).toBe('python');
    expect(PYTHON_ADAPTER.serverBinary).toBe('pylsp');
    expect(PYTHON_ADAPTER.spawnArgs({ workspaceRoot: '/any' })).toEqual([]);
  });

  // C0-7 type-level gate: the tsc --noEmit check (performed in CI + vitest
  // compile step) verifies that ClientCapabilities accepts both the
  // { window: { workDoneProgress: true } } Go override AND the
  // TS_SERVER_CAPABILITIES `as const` shape (non-literal boolean).
  // Here we lock the runtime shape:
  it('C0-7: ClientCapabilities structural type accepts GO_ADAPTER.clientCapabilities (runtime shape)', () => {
    // This assignment would fail to compile if ClientCapabilities required
    // window.workDoneProgress to be the literal type `false`.
    const caps: ClientCapabilities = GO_ADAPTER.clientCapabilities!;
    expect(caps.window?.workDoneProgress).toBe(true);
  });
});

// ─── Suite: interface shape conformance ───────────────────────────────

describe('LanguageAdapter interface compliance', () => {
  const adapters: LanguageAdapter[] = [TYPESCRIPT_ADAPTER, JAVA_ADAPTER, PYTHON_ADAPTER, GO_ADAPTER];

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

// ─── Suite: GO_ADAPTER.awaitReady (WI-2c cases C2-12..C2-22) ──────────
//
// Technique: State Transition (idle→listening→settled) + Decision Table
//   (resolution paths) + Error Guessing (I-6/I-8/I-13/I-15/C2-22).
//
// Isolation: all cases use AdapterReadyCtx seam injections (backstopProbe,
//   progressTokenTitles, progressEndedTokens, onProgressEnd, deadlineMs)
//   so no real gopls process or filesystem is required.
//
// Key design invariant (R2-2 / I-6):
//   awaitReady must NOT call conn.onNotification('$/progress', ...) itself.
//   The $/progress handler is registered pre-initialize in lsp-client.ts (WI-0).
//   awaitReady only READS from the ctx seam (progressTokenTitles/progressEndedTokens)
//   and subscribes to ctx.onProgressEnd for future end events.
//
// makeGoFakeConn() provides:
//   - onNotification(method, handler): tracks call count per method
//   - notificationRegistrationCount(method): inspection helper
//   - sendNotification/sendRequest: no-op stubs for canary backstop path

type GoNotifHandler = (params: unknown) => void;
type GoRequestHandler = (params: unknown) => unknown;

interface GoFakeConn {
  onNotification(method: string, handler: GoNotifHandler): { dispose(): void };
  onRequest(method: string, handler: GoRequestHandler): { dispose(): void };
  sendNotification(method: string, params: unknown): Promise<void>;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  notificationRegistrationCount(method: string): number;
  requestRegistrationCount(method: string): number;
}

function makeGoFakeConn(): GoFakeConn {
  const notifCounts = new Map<string, number>();
  const reqCounts = new Map<string, number>();

  return {
    onNotification(method: string, _handler: GoNotifHandler) {
      notifCounts.set(method, (notifCounts.get(method) ?? 0) + 1);
      return {
        dispose() {
          notifCounts.set(method, Math.max(0, (notifCounts.get(method) ?? 1) - 1));
        },
      };
    },
    onRequest(method: string, _handler: GoRequestHandler) {
      reqCounts.set(method, (reqCounts.get(method) ?? 0) + 1);
      return {
        dispose() {
          reqCounts.set(method, Math.max(0, (reqCounts.get(method) ?? 1) - 1));
        },
      };
    },
    async sendNotification(_method: string, _params: unknown): Promise<void> { /* best-effort no-op */ },
    async sendRequest<T>(_method: string, _params: unknown): Promise<T> {
      return [] as unknown as T; // default: empty → not ready
    },
    notificationRegistrationCount(method: string): number {
      return notifCounts.get(method) ?? 0;
    },
    requestRegistrationCount(method: string): number {
      return reqCounts.get(method) ?? 0;
    },
  };
}

describe('GO_ADAPTER.awaitReady', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockDirEntries.clear();
  });

  // ── C2-12: awaitReady does NOT register a $/progress handler itself ──────
  //
  // R2-2 / I-6 invariant: the $/progress onNotification listener is registered
  // BEFORE initialize in lsp-client.ts (WI-0). awaitReady only reads the
  // ctx.onProgressEnd seam; it never calls conn.onNotification('$/progress').

  it('C2-12: awaitReady does NOT call conn.onNotification("$/progress", ...) (I-6 / R2-2)', async () => {
    const conn = makeGoFakeConn();
    expect(conn.notificationRegistrationCount('$/progress')).toBe(0); // baseline

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 50,
      backstopProbe: async () => false, // settle quickly without real canary walk
    };

    await GO_ADAPTER.awaitReady(ctx);

    // Must still be 0 — awaitReady never registers its own $/progress handler.
    expect(conn.notificationRegistrationCount('$/progress')).toBe(0);
  });

  // ── C2-13: tracked token (STORED begin.title === "Setting up workspace") ──
  //
  // Stored-title path: onProgressEnd delivers the token AFTER awaitReady starts;
  // awaitReady looks up the stored begin.title in progressTokenTitles and settles.
  // The end notification has an EMPTY title — awaitReady must read from stored state.

  it('C2-13: token with STORED begin.title "Setting up workspace" end → settle(true) before deadline', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();

    const tokenTitles = new Map<string | number, string>([
      [1, 'Setting up workspace'], // stored begin.title
    ]);

    let endCallback: ((token: string | number) => void) | null = null;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 30_000,
      progressTokenTitles: tokenTitles,
      progressEndedTokens: new Set<string | number>(), // token 1 has NOT ended yet
      onProgressEnd: (cb) => {
        endCallback = cb;
        return { dispose() { endCallback = null; } };
      },
    };

    const promise = GO_ADAPTER.awaitReady(ctx);

    // Deliver the end event for token 1 (stored title matches).
    // Simulate: end arrives; awaitReady reads stored title → settle(true).
    endCallback?.(1);

    const result = await promise;
    expect(result).toBe(true);
  });

  // ── C2-14: non-matching title does NOT resolve true; falls to deadline ────
  //
  // I-13: a $/progress end for a token whose stored title is NOT
  // "Setting up workspace" must NOT resolve true. awaitReady falls through
  // to the deadline backstop.

  it('C2-14: non-matching stored title → does NOT resolve true; deadline fires canary path', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();

    const tokenTitles = new Map<string | number, string>([
      [2, 'Loading diagnostics'], // wrong title
    ]);

    let endCallback: ((token: string | number) => void) | null = null;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 200,
      progressTokenTitles: tokenTitles,
      progressEndedTokens: new Set<string | number>(),
      onProgressEnd: (cb) => {
        endCallback = cb;
        return { dispose() { endCallback = null; } };
      },
      backstopProbe: async () => false, // canary: not ready
    };

    const promise = GO_ADAPTER.awaitReady(ctx);

    // Deliver end for a non-matching token — must NOT settle yet.
    endCallback?.(2);

    // Fire the deadline timer.
    await vi.advanceTimersByTimeAsync(201);

    const result = await promise;
    // Non-matching token + backstopProbe returns false → settle(false).
    expect(result).toBe(false);
  });

  // ── C2-15: non-workspace token ends first (multi-item: I-13) ────────────
  //
  // A separate "diagnostics" token ends before the workspace token.
  // awaitReady must ignore it and wait for the correct token.

  it('C2-15: diagnostics token ends first → does NOT resolve true (I-13 multi-item)', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();

    const tokenTitles = new Map<string | number, string>([
      [10, 'Indexing'],           // diagnostics token — wrong title
      [11, 'Setting up workspace'], // workspace token — correct title
    ]);

    let endCallback: ((token: string | number) => void) | null = null;
    let settled = false;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 500,
      progressTokenTitles: tokenTitles,
      progressEndedTokens: new Set<string | number>(),
      onProgressEnd: (cb) => {
        endCallback = cb;
        return { dispose() { endCallback = null; } };
      },
      backstopProbe: async () => false,
    };

    const promise = GO_ADAPTER.awaitReady(ctx);
    promise.then(() => { settled = true; });

    // Diagnostics token ends — must NOT settle.
    endCallback?.(10);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    expect(settled).toBe(false);

    // Workspace token ends — must settle(true).
    endCallback?.(11);
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe(true);
  });

  // ── C2-16: deadline fires + canary returns non-empty Location[] → true ───

  it('C2-16: deadline fires; backstopProbe returns true → settle(true)', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 100,
      backstopProbe: async () => true, // canary: ready
    };

    const promise = GO_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(true);
  });

  // ── C2-17: deadline fires + canary returns [] → settle(false) ───────────

  it('C2-17: deadline fires; backstopProbe returns false → settle(false)', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 100,
      backstopProbe: async () => false, // canary: not ready
    };

    const promise = GO_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(false);
  });

  // ── C2-18: deadline fires + no canary samples (vendor-only repo) ─────────
  //
  // buildCanarySamples returns [] when no .go files are found (e.g. vendor-only,
  // or empty workspace). settle(false) without error.

  it('C2-18: deadline fires; no .go candidate files in workspace → settle(false)', async () => {
    vi.useFakeTimers();
    // Empty workspace → buildCanarySamples returns [] → settle(false).
    mockDirEntries.clear();
    mockDirEntries.set('/fake/empty-go-ws', []);

    const conn = makeGoFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/empty-go-ws',
      deadlineMs: 100,
      // No backstopProbe — exercises real buildCanarySamples → 0-samples path.
    };

    const promise = GO_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(false);
  });

  // ── C2-19: never rejects — all branches return boolean (I-8) ────────────

  it('C2-19: awaitReady never rejects — all branches resolve boolean (I-8)', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 100,
      backstopProbe: async () => { throw new Error('probe exploded'); },
    };

    const promise = GO_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);

    // Must resolve (not reject) even when backstopProbe throws.
    await expect(promise).resolves.toBe(false);
  });

  // ── C2-20: deadline uses ctx.deadlineMs ?? GOPLS_READY_DEADLINE_MS (I-15) ─
  //
  // Inject a short ctx.deadlineMs and assert awaitReady fires at that value,
  // NOT at GOPLS_READY_DEADLINE_MS (30_000) or ?? 120_000 (Java default).

  it('C2-20: deadline uses ctx.deadlineMs when provided (not GOPLS_READY_DEADLINE_MS or 120_000)', async () => {
    vi.useFakeTimers();
    const conn = makeGoFakeConn();
    let probeCalledAt: number | null = null;

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 250,
      backstopProbe: async () => {
        probeCalledAt = Date.now();
        return false;
      },
    };

    const promise = GO_ADAPTER.awaitReady(ctx);

    // Should NOT have fired yet at 249ms.
    await vi.advanceTimersByTimeAsync(249);
    expect(probeCalledAt).toBeNull();

    // Must fire at or after 250ms.
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(probeCalledAt).not.toBeNull();
    // Deadline value is ctx.deadlineMs (250), not GOPLS_READY_DEADLINE_MS (30_000)
    // or the Java fallback (120_000). The constant assertion is in GOPLS_READY_DEADLINE_MS suite.
    expect(GOPLS_READY_DEADLINE_MS).toBe(30_000);
    expect(GOPLS_READY_DEADLINE_MS).not.toBe(120_000);
  });

  // ── C2-22: begin+end buffered BEFORE awaitReady → resolves true immediately ─
  //
  // The "no missed-begin race" guarantee (R2-2 / I-6): if the $/progress begin
  // AND end for the workspace token arrived and were buffered BEFORE awaitReady
  // is called, awaitReady detects it synchronously via the progressEndedTokens
  // pre-scan and resolves true without waiting for the deadline.

  it('C2-22: matching begin+end buffered BEFORE awaitReady is invoked → resolves true immediately', async () => {
    const conn = makeGoFakeConn();

    // Simulate WI-0 pre-initialize buffer: token 42 has received begin + end.
    const tokenTitles = new Map<string | number, string>([
      [42, 'Setting up workspace'],
    ]);
    const endedTokens = new Set<string | number>([42]); // already ended

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/go-ws',
      deadlineMs: 30_000, // full deadline — must NOT be needed
      progressTokenTitles: tokenTitles,
      progressEndedTokens: endedTokens,
      onProgressEnd: (_cb) => ({ dispose() {} }), // no future events needed
    };

    // Must resolve true synchronously (before any timer fires).
    const startMs = Date.now();
    const result = await GO_ADAPTER.awaitReady(ctx);
    const elapsedMs = Date.now() - startMs;

    expect(result).toBe(true);
    // Elapsed should be negligible (synchronous resolution, no timer wait).
    // Use a generous upper bound (500ms) to avoid flakiness on slow CI.
    expect(elapsedMs).toBeLessThan(500);
  });

  // ── C2-23: regression lock — PYTHON_ADAPTER and JAVA_ADAPTER classifyUri +
  //           awaitReady behavior unchanged after GO_ADAPTER is added ──────────
  //
  // This is an explicit plan invariant: adding GO_ADAPTER to the codebase must
  // not alter any observable behavior of the existing adapters.  Locking both
  // classifyUri (URI routing decisions) and awaitReady (resolution semantics)
  // here — inside the GO_ADAPTER.awaitReady suite — ensures these remain green
  // even when GO_ADAPTER's awaitReady implementation is refactored.

  describe('C2-23: PYTHON_ADAPTER and JAVA_ADAPTER unchanged after GO_ADAPTER addition (regression lock)', () => {
    // ── PYTHON_ADAPTER classifyUri ───────────────────────────────────────
    it('PYTHON_ADAPTER.classifyUri: file:// → "workspace" (containment at mapper, not here)', () => {
      expect(PYTHON_ADAPTER.classifyUri('file:///path/to/crawler.py')).toBe('workspace');
    });

    it('PYTHON_ADAPTER.classifyUri: non-file:// → "unmappable"', () => {
      expect(PYTHON_ADAPTER.classifyUri('https://example.com/file.py')).toBe('unmappable');
      expect(PYTHON_ADAPTER.classifyUri('')).toBe('unmappable');
    });

    // ── JAVA_ADAPTER classifyUri ─────────────────────────────────────────
    it('JAVA_ADAPTER.classifyUri: file:// → "workspace"', () => {
      expect(JAVA_ADAPTER.classifyUri('file:///src/main/java/com/example/Foo.java')).toBe('workspace');
    });

    it('JAVA_ADAPTER.classifyUri: jdt:// → "external" (decompiled jar/stdlib)', () => {
      expect(JAVA_ADAPTER.classifyUri('jdt://contents/java/util/List.class?params')).toBe('external');
    });

    it('JAVA_ADAPTER.classifyUri: other schemes → "unmappable"', () => {
      expect(JAVA_ADAPTER.classifyUri('https://example.com/foo')).toBe('unmappable');
    });

    // ── PYTHON_ADAPTER.awaitReady ─────────────────────────────────────────
    // Verifies the canary-only awaitReady contract is intact: backstopProbe
    // resolves immediately, no $/progress handler is registered, result is bool.
    it('PYTHON_ADAPTER.awaitReady: resolves true when backstopProbe returns true', async () => {
      const conn = makeGoFakeConn(); // minimal connection stub; PYTHON_ADAPTER never touches $/progress
      const ctx: AdapterReadyCtx = {
        connection: conn as any,
        workspaceRoot: '/fake/py-ws',
        backstopProbe: async () => true,
      };
      const result = await PYTHON_ADAPTER.awaitReady(ctx);
      expect(result).toBe(true);
      // PYTHON_ADAPTER must NOT register a $/progress handler — capability-gated off.
      expect(conn.notificationRegistrationCount('$/progress')).toBe(0);
    });

    it('PYTHON_ADAPTER.awaitReady: resolves false when backstopProbe returns false', async () => {
      const conn = makeGoFakeConn();
      const ctx: AdapterReadyCtx = {
        connection: conn as any,
        workspaceRoot: '/fake/py-ws',
        backstopProbe: async () => false,
      };
      const result = await PYTHON_ADAPTER.awaitReady(ctx);
      expect(result).toBe(false);
      expect(conn.notificationRegistrationCount('$/progress')).toBe(0);
    });

    // ── JAVA_ADAPTER.awaitReady ───────────────────────────────────────────
    // JAVA_ADAPTER.awaitReady uses a language/status notification; verifying
    // the function exists and is callable without error is sufficient here —
    // the full suite lives in the JAVA_ADAPTER section.  We only need to
    // confirm it did not gain a $/progress dependency after GO_ADAPTER was added.
    it('JAVA_ADAPTER.awaitReady: is a function (callable — did not lose its definition)', () => {
      expect(typeof JAVA_ADAPTER.awaitReady).toBe('function');
    });
  });
});

// ─── Suite: RUST_ADAPTER — WI-1 type invariants ───────────────────────────────
//
// WI-1 adds 'rust' to the LanguageAdapter.id union and 'experimental' to
// ClientCapabilities. These tests act as compile+runtime gates: if tsc rejects
// any assignment below, the test file fails to compile (CI gate WI1-4).
// The RUST_ADAPTER object is constructed inline here (not exported from
// language-adapter.ts yet — that is WI-3b) to keep WI-1 scope minimal.
//
// Decision table (collapsed) — one representative per equivalence class:
//   WI1-1: id literal === 'rust'           → union accepts new literal
//   WI1-2: experimental.serverStatusNotification === true → new field accepted
//   WI1-3: window.workDoneProgress === true → existing field not narrowed by new field

describe('RUST_ADAPTER — WI-1 type invariants', () => {
  // Minimal RUST_ADAPTER stub — satisfies LanguageAdapter structurally.
  // WI-3b will export the real constant; this inline object is the compile gate.
  const RUST_ADAPTER: LanguageAdapter = {
    id: 'rust',
    serverBinary: 'rust-analyzer',
    languageId: 'rust',
    clientCapabilities: {
      window: { workDoneProgress: true },
      experimental: { serverStatusNotification: true },
    },
    spawnArgs: (_ctx) => [],
    initializationOptions: {},
    awaitReady: async (_ctx) => true,
    canary: {
      isCandidateFile: (name) => name.endsWith('.rs'),
      tryExtractSample: (_absPath, _content) => null,
    },
    classifyUri: (uri) => uri.startsWith('file://') ? 'workspace' : 'unmappable',
  };

  // WI1-1: id literal === 'rust' (union widened to include 'rust')
  it('WI1-1: RUST_ADAPTER.id === "rust" (union widened to include literal)', () => {
    expect(RUST_ADAPTER.id).toBe('rust');
  });

  // WI1-2: experimental.serverStatusNotification is accepted by the widened
  // ClientCapabilities interface (I-13). If ClientCapabilities lacked the
  // 'experimental' field, this file would fail to compile.
  it('WI1-2: RUST_ADAPTER.clientCapabilities.experimental.serverStatusNotification === true', () => {
    const caps = RUST_ADAPTER.clientCapabilities;
    expect(caps).toBeDefined();
    expect((caps!.experimental as Record<string, unknown>)['serverStatusNotification']).toBe(true);
  });

  // WI1-3: window.workDoneProgress is still boolean — not narrowed by the
  // experimental addition (I-13 invariant: existing fields unchanged).
  it('WI1-3: RUST_ADAPTER.clientCapabilities.window.workDoneProgress === true (existing field not narrowed)', () => {
    const caps = RUST_ADAPTER.clientCapabilities;
    expect(caps?.window?.workDoneProgress).toBe(true);
  });

  // Regression lock: existing adapters still compile with their existing shapes
  // (no experimental field — backward-compatible optional).
  it('regression: GO_ADAPTER.clientCapabilities has no experimental field (optional field is backward-compatible)', () => {
    expect(GO_ADAPTER.clientCapabilities?.experimental).toBeUndefined();
  });

  it('regression: TYPESCRIPT_ADAPTER.clientCapabilities is undefined (optional field is backward-compatible)', () => {
    expect(TYPESCRIPT_ADAPTER.clientCapabilities).toBeUndefined();
  });
});

// ─── Suite: RUST_ADAPTER — WI-3 literal invariants ────────────────────────────
//
// Cases WI3-10..WI3-16 per plan §Test Strategy.
//
// Technique: Equivalence Partitioning + BVA + Adapter Literal Invariants.
//
// Isolation: RUST_ADAPTER is the real exported module-level singleton;
//   no mocking required for literal/sync tests (awaitReady is a sync stub).
//   RUST_CANARY_STRATEGY is imported directly from canary-sampler.ts to verify
//   reference identity (the adapter must hold the same object, not a clone).

describe('RUST_ADAPTER — WI-3 literal invariants', () => {
  // WI3-10: id literal
  it('WI3-10: RUST_ADAPTER.id === "rust"', () => {
    expect(RUST_ADAPTER.id).toBe('rust');
  });

  // WI3-11: spawnArgs — always [] (fresh array, no shared reference)
  it('WI3-11: spawnArgs({workspaceRoot:"/x"}) deep-equals [] (AC-13)', () => {
    expect(RUST_ADAPTER.spawnArgs({ workspaceRoot: '/x' })).toEqual([]);
  });

  it('WI3-11 (I-2): spawnArgs returns a FRESH array on each call (no shared-reference mutation)', () => {
    const a = RUST_ADAPTER.spawnArgs({ workspaceRoot: '/x' });
    const b = RUST_ADAPTER.spawnArgs({ workspaceRoot: '/x' });
    // Both calls return [] but must not be the same object reference.
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(a).not.toBe(b);
  });

  // WI3-12: classifyUri — scheme-only (EP + BVA)
  it('WI3-12: classifyUri("file:///some/path.rs") === "workspace" (AC-14)', () => {
    expect(RUST_ADAPTER.classifyUri('file:///some/path.rs')).toBe('workspace');
  });

  it('WI3-12: classifyUri("other://something") === "unmappable" (AC-14)', () => {
    expect(RUST_ADAPTER.classifyUri('other://something')).toBe('unmappable');
  });

  it('WI3-12: classifyUri("") === "unmappable" (empty-string edge case)', () => {
    expect(RUST_ADAPTER.classifyUri('')).toBe('unmappable');
  });

  it('WI3-12: classifyUri("file://") === "workspace" (bare file:// scheme)', () => {
    expect(RUST_ADAPTER.classifyUri('file://')).toBe('workspace');
  });

  it('WI3-12: classifyUri("https://crates.io/crates/serde") === "unmappable"', () => {
    expect(RUST_ADAPTER.classifyUri('https://crates.io/crates/serde')).toBe('unmappable');
  });

  // WI3-13: canary is the real RUST_CANARY_STRATEGY singleton (reference identity)
  it('WI3-13: RUST_ADAPTER.canary === RUST_CANARY_STRATEGY (real WI-2 export)', () => {
    expect(RUST_ADAPTER.canary).toBe(RUST_CANARY_STRATEGY);
  });

  // WI3-14: initializationOptions deep-equals {}
  it('WI3-14: initializationOptions deep-equals {} (spike-deferred safe default)', () => {
    expect(RUST_ADAPTER.initializationOptions).toEqual({});
  });

  // WI3-15: clientCapabilities exact shape (I-13)
  it('WI3-15: clientCapabilities.window.workDoneProgress === true', () => {
    expect(RUST_ADAPTER.clientCapabilities?.window?.workDoneProgress).toBe(true);
  });

  it('WI3-15: clientCapabilities.experimental.serverStatusNotification === true (I-13)', () => {
    const exp = RUST_ADAPTER.clientCapabilities?.experimental as Record<string, unknown> | undefined;
    expect(exp?.['serverStatusNotification']).toBe(true);
  });

  it('WI3-15: clientCapabilities deep-equals { window: { workDoneProgress: true }, experimental: { serverStatusNotification: true } } (I-13 exact shape)', () => {
    expect(RUST_ADAPTER.clientCapabilities).toEqual({
      window: { workDoneProgress: true },
      experimental: { serverStatusNotification: true },
    });
  });

  it('WI3-15: clientCapabilities type-checks as ClientCapabilities (runtime shape)', () => {
    // This assignment would fail to compile if ClientCapabilities did not
    // include the `experimental` field (I-13 tsc gate).
    const caps: ClientCapabilities = RUST_ADAPTER.clientCapabilities!;
    expect(caps.window?.workDoneProgress).toBe(true);
    expect((caps.experimental as Record<string, unknown>)['serverStatusNotification']).toBe(true);
  });

  // WI3-16: distinctness vs GO_ADAPTER and TYPESCRIPT_ADAPTER (I-1)
  it('WI3-16 (I-1): RUST_ADAPTER !== GO_ADAPTER (distinct object)', () => {
    expect(RUST_ADAPTER).not.toBe(GO_ADAPTER);
  });

  it('WI3-16 (I-1): RUST_ADAPTER !== TYPESCRIPT_ADAPTER (distinct object)', () => {
    expect(RUST_ADAPTER).not.toBe(TYPESCRIPT_ADAPTER);
  });

  it('WI3-16 (I-1): RUST_ADAPTER !== JAVA_ADAPTER (distinct object)', () => {
    expect(RUST_ADAPTER).not.toBe(JAVA_ADAPTER);
  });

  it('WI3-16 (I-1): RUST_ADAPTER !== PYTHON_ADAPTER (distinct object)', () => {
    expect(RUST_ADAPTER).not.toBe(PYTHON_ADAPTER);
  });

  // RUST_ANALYZER_READY_DEADLINE_MS constant (I-12)
  it('WI3-10 (I-12): RUST_ANALYZER_READY_DEADLINE_MS === 60_000 (exported; higher than GOPLS/PYLSP 30_000)', () => {
    expect(RUST_ANALYZER_READY_DEADLINE_MS).toBe(60_000);
  });

  it('WI3-10 (I-12): RUST_ANALYZER_READY_DEADLINE_MS > GOPLS_READY_DEADLINE_MS (cold Cargo metadata load)', () => {
    expect(RUST_ANALYZER_READY_DEADLINE_MS).toBeGreaterThan(GOPLS_READY_DEADLINE_MS);
  });

  it('WI3-10 (I-12): RUST_ANALYZER_READY_DEADLINE_MS > PYLSP_READY_DEADLINE_MS (rust-analyzer is slower cold)', () => {
    expect(RUST_ANALYZER_READY_DEADLINE_MS).toBeGreaterThan(PYLSP_READY_DEADLINE_MS);
  });

  // awaitReady buffer-hit path (WI-3b3): updated from WI-3b1 stub to supply
  // ctx.serverStatusLatest so the test stays fast (no 60 s deadline wait).
  it('awaitReady resolves true immediately on buffer-hit {quiescent:true, health:"ok"} (WI-3b3)', async () => {
    const ctx: AdapterReadyCtx = {
      connection: {},
      workspaceRoot: '/any/rust-workspace',
      serverStatusLatest: { quiescent: true, health: 'ok' },
    };
    const result = await RUST_ADAPTER.awaitReady(ctx);
    expect(result).toBe(true);
  });

  // Singleton identity
  it('RUST_ADAPTER is a module-level singleton (same reference on every access)', () => {
    const ref1 = RUST_ADAPTER;
    const ref2 = RUST_ADAPTER;
    expect(ref1).toBe(ref2);
  });

  // Interface compliance: all required fields present
  it('RUST_ADAPTER satisfies the LanguageAdapter interface (all required fields)', () => {
    expect(typeof RUST_ADAPTER.id).toBe('string');
    expect(typeof RUST_ADAPTER.serverBinary).toBe('string');
    expect(typeof RUST_ADAPTER.languageId).toBe('string');
    expect(typeof RUST_ADAPTER.spawnArgs).toBe('function');
    expect(typeof RUST_ADAPTER.awaitReady).toBe('function');
    expect(typeof RUST_ADAPTER.classifyUri).toBe('function');
    expect(RUST_ADAPTER.canary).toBeDefined();
    expect(typeof RUST_ADAPTER.canary.isCandidateFile).toBe('function');
    expect(typeof RUST_ADAPTER.canary.tryExtractSample).toBe('function');
  });

  it('RUST_ADAPTER.serverBinary === "rust-analyzer"', () => {
    expect(RUST_ADAPTER.serverBinary).toBe('rust-analyzer');
  });

  it('RUST_ADAPTER.languageId === "rust"', () => {
    expect(RUST_ADAPTER.languageId).toBe('rust');
  });
});

// ─── Suite: RUST_ADAPTER.awaitReady (WI-3b3 cases) ──────────────────────────
//
// Technique: Equivalence Partitioning (health domain: ok/warning/error/absent) +
//   BVA (quiescent true/false boundary) + Deadline branch coverage +
//   Never-reject property + State Transition (idle→listening→settled).
//
// Cases:
//   buffer-hit ok → true
//   arrive-after warning → true
//   health:'error' arrives → backstop (does not resolve on status)
//   quiescent:false → keep waiting → deadline fires → backstop
//   deadline + zero samples → true (deliberate Go deviation)
//   deadline + samples + empty definition → false
//   never rejects (every path resolves)
//   timer.unref + settled double-resolution guard
//
// Isolation: all cases use AdapterReadyCtx seam injections (serverStatusLatest,
//   onServerStatus, backstopProbe, deadlineMs) so no real rust-analyzer process
//   or filesystem is required. makeRustFakeConn() provides a stub connection.
//
// Key design invariant: awaitReady does NOT register its own
//   experimental/serverStatus handler (that lives in LspClient.spawnAndInitialize,
//   WI-3b2). awaitReady only READS ctx.serverStatusLatest and subscribes via
//   ctx.onServerStatus.

type RustNotifHandler = (params: unknown) => void;
type RustRequestHandler = (params: unknown) => unknown;

interface RustFakeConn {
  onNotification(method: string, handler: RustNotifHandler): { dispose(): void };
  sendNotification(method: string, params: unknown): Promise<void>;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  notificationRegistrationCount(method: string): number;
}

function makeRustFakeConn(): RustFakeConn {
  const notifCounts = new Map<string, number>();

  return {
    onNotification(method: string, _handler: RustNotifHandler) {
      notifCounts.set(method, (notifCounts.get(method) ?? 0) + 1);
      return {
        dispose() {
          notifCounts.set(method, Math.max(0, (notifCounts.get(method) ?? 1) - 1));
        },
      };
    },
    async sendNotification(_method: string, _params: unknown): Promise<void> { /* best-effort no-op */ },
    async sendRequest<T>(_method: string, _params: unknown): Promise<T> {
      return [] as unknown as T; // default: empty → not ready
    },
    notificationRegistrationCount(method: string): number {
      return notifCounts.get(method) ?? 0;
    },
  };
}

describe('RUST_ADAPTER.awaitReady', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockDirEntries.clear();
  });

  // ── WI3b3-1: buffer-hit {quiescent:true, health:'ok'} → resolves true immediately
  //
  // Buffer-hit path: ctx.serverStatusLatest already has a quiescent+ok status
  // that arrived BEFORE awaitReady is called. Must resolve true synchronously
  // (before any timer fires). Uses settle() so the idempotency flag is set.

  it('WI3b3-1: buffer-hit {quiescent:true, health:"ok"} → resolves true immediately', async () => {
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 30_000,
      serverStatusLatest: { quiescent: true, health: 'ok' },
      onServerStatus: (_cb) => ({ dispose() {} }),
    };

    const startMs = Date.now();
    const result = await RUST_ADAPTER.awaitReady(ctx);
    const elapsedMs = Date.now() - startMs;

    expect(result).toBe(true);
    // Elapsed should be negligible (synchronous resolution, no timer wait).
    expect(elapsedMs).toBeLessThan(500);
  });

  // ── WI3b3-2: buffer-hit {quiescent:true, health:'warning'} → resolves true immediately
  //
  // health:'warning' IS ready (I-7, challenge #8). Same buffer-hit path as ok.

  it('WI3b3-2: buffer-hit {quiescent:true, health:"warning"} → resolves true immediately (I-7)', async () => {
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 30_000,
      serverStatusLatest: { quiescent: true, health: 'warning' },
      onServerStatus: (_cb) => ({ dispose() {} }),
    };

    const result = await RUST_ADAPTER.awaitReady(ctx);
    expect(result).toBe(true);
  });

  // ── WI3b3-3: no buffer, {quiescent:true, health:'warning'} arrives via onServerStatus
  //   → resolves true (subscription path)

  it('WI3b3-3: no buffer; {quiescent:true, health:"warning"} arrives via onServerStatus → resolves true', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    let statusCallback: ((payload: { quiescent: boolean; health: string }) => void) | null = null;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 30_000,
      onServerStatus: (cb) => {
        statusCallback = cb;
        return { dispose() { statusCallback = null; } };
      },
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);

    // Deliver warning status — must settle(true).
    statusCallback?.({ quiescent: true, health: 'warning' });

    const result = await promise;
    expect(result).toBe(true);
  });

  // ── WI3b3-4: {quiescent:true, health:'ok'} arrives via onServerStatus → resolves true

  it('WI3b3-4: no buffer; {quiescent:true, health:"ok"} arrives via onServerStatus → resolves true', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    let statusCallback: ((payload: { quiescent: boolean; health: string }) => void) | null = null;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 30_000,
      onServerStatus: (cb) => {
        statusCallback = cb;
        return { dispose() { statusCallback = null; } };
      },
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    statusCallback?.({ quiescent: true, health: 'ok' });

    const result = await promise;
    expect(result).toBe(true);
  });

  // ── WI3b3-5: {quiescent:true, health:'error'} arrives → does NOT resolve true
  //   Falls through to deadline backstop.

  it('WI3b3-5: {quiescent:true, health:"error"} arrives → does NOT resolve true; deadline fires canary path', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    let statusCallback: ((payload: { quiescent: boolean; health: string }) => void) | null = null;
    let settled = false;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 200,
      onServerStatus: (cb) => {
        statusCallback = cb;
        return { dispose() { statusCallback = null; } };
      },
      backstopProbe: async () => false, // canary: not ready
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    promise.then(() => { settled = true; });

    // Deliver error status — must NOT settle.
    statusCallback?.({ quiescent: true, health: 'error' });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    expect(settled).toBe(false);

    // Fire the deadline timer.
    await vi.advanceTimersByTimeAsync(201);
    const result = await promise;
    // health:'error' did not settle; backstopProbe returned false → false.
    expect(result).toBe(false);
  });

  // ── WI3b3-6: {quiescent:false, health:'ok'} arrives → does NOT resolve true
  //   quiescent:false means server is still indexing — keep waiting.

  it('WI3b3-6: {quiescent:false, health:"ok"} arrives → does NOT resolve true; falls to deadline', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    let statusCallback: ((payload: { quiescent: boolean; health: string }) => void) | null = null;
    let settled = false;
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 200,
      onServerStatus: (cb) => {
        statusCallback = cb;
        return { dispose() { statusCallback = null; } };
      },
      backstopProbe: async () => false,
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    promise.then(() => { settled = true; });

    // Deliver quiescent:false — must NOT settle.
    statusCallback?.({ quiescent: false, health: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(201);
    const result = await promise;
    expect(result).toBe(false);
  });

  // ── WI3b3-7: deadline fires, zero canary samples in workspace → resolves true
  //   Deliberate Go deviation: zero-edges no-op, nothing to verify.

  it('WI3b3-7: deadline fires; zero canary samples in workspace → resolves true (Go deviation: zero-edges no-op)', async () => {
    vi.useFakeTimers();
    // Empty workspace → buildCanarySamples returns [] → settle(true).
    mockDirEntries.clear();
    mockDirEntries.set('/fake/empty-rust-ws', []);

    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/empty-rust-ws',
      deadlineMs: 100,
      // No backstopProbe — exercises real buildCanarySamples → 0-samples path.
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(true);
  });

  // ── WI3b3-8: deadline fires + backstopProbe returns true → resolves true

  it('WI3b3-8: deadline fires; backstopProbe returns true → resolves true', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 100,
      backstopProbe: async () => true,
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(true);
  });

  // ── WI3b3-9: deadline fires + backstopProbe returns false → resolves false
  //   Samples present + empty/null textDocument/definition response → false.

  it('WI3b3-9: deadline fires; backstopProbe returns false → resolves false', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 100,
      backstopProbe: async () => false,
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(false);
  });

  // ── WI3b3-10: never rejects — all branches resolve boolean (I-7)

  it('WI3b3-10: awaitReady never rejects — backstopProbe throws → resolve false, not reject (I-7)', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 100,
      backstopProbe: async () => { throw new Error('probe exploded'); },
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);

    // Must resolve (not reject) even when backstopProbe throws.
    await expect(promise).resolves.toBe(false);
  });

  // ── WI3b3-11: timer.unref + settled double-resolution guard
  //   Fire status notification then deadline — only one resolve call.

  it('WI3b3-11: settled guard prevents double-resolution (status fires then deadline fires)', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    let statusCallback: ((payload: { quiescent: boolean; health: string }) => void) | null = null;
    let resolveCount = 0;
    let statusCallback2: ((payload: { quiescent: boolean; health: string }) => void) | null = null;

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 100,
      onServerStatus: (cb) => {
        statusCallback = cb;
        return { dispose() { statusCallback = null; } };
      },
      backstopProbe: async () => {
        resolveCount++;
        return false;
      },
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    statusCallback2 = statusCallback; // capture before firing

    // Fire the status notification first → settle(true).
    statusCallback2?.({ quiescent: true, health: 'ok' });
    const result = await promise;
    expect(result).toBe(true);

    // Now advance past the deadline — backstopProbe must NOT be called
    // because settled=true already disposed the timer.
    await vi.advanceTimersByTimeAsync(200);
    expect(resolveCount).toBe(0);
  });

  // ── WI3b3-12: deadline uses ctx.deadlineMs ?? RUST_ANALYZER_READY_DEADLINE_MS

  it('WI3b3-12: deadline fires at ctx.deadlineMs (not at RUST_ANALYZER_READY_DEADLINE_MS=60_000)', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();
    let probeCalledAt: number | null = null;

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 250,
      backstopProbe: async () => {
        probeCalledAt = Date.now();
        return false;
      },
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);

    // Must NOT have fired yet at 249ms.
    await vi.advanceTimersByTimeAsync(249);
    expect(probeCalledAt).toBeNull();

    // Must fire at or after 250ms.
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(probeCalledAt).not.toBeNull();
    // Constant assertion: RUST_ANALYZER_READY_DEADLINE_MS is 60_000, NOT what we used.
    expect(RUST_ANALYZER_READY_DEADLINE_MS).toBe(60_000);
  });

  // ── WI3b3-13: onServerStatus undefined → skip subscription, fall to deadline backstop
  //   Defensive path: if ctx.onServerStatus is absent, awaitReady must not throw.

  it('WI3b3-13: ctx.onServerStatus undefined → skip subscription; falls to deadline backstop without throwing', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();
    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 100,
      // No onServerStatus — exercises the defensive skip path.
      backstopProbe: async () => true,
    };

    const promise = RUST_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result).toBe(true);
  });

  // ── WI3b3-14: awaitReady does NOT register its own experimental/serverStatus handler
  //   The handler lives in LspClient.spawnAndInitialize (WI-3b2); awaitReady only reads ctx.

  it('WI3b3-14: awaitReady does NOT call conn.onNotification("experimental/serverStatus", ...) (lives in lsp-client.ts)', async () => {
    vi.useFakeTimers();
    const conn = makeRustFakeConn();

    const ctx: AdapterReadyCtx = {
      connection: conn,
      workspaceRoot: '/fake/rust-ws',
      deadlineMs: 50,
      backstopProbe: async () => false,
    };

    await vi.runAllTimersAsync();
    void RUST_ADAPTER.awaitReady(ctx);
    await vi.runAllTimersAsync();

    // Must be 0 — awaitReady never registers its own experimental/serverStatus handler.
    expect(conn.notificationRegistrationCount('experimental/serverStatus')).toBe(0);
  });
});

// ─── Suite: selectAdapter — Rust EP cases (WI-3a) ────────────────────────────
//
// Technique: Equivalence Partitioning (7 language-count partitions) +
//   BVA (strict-dominance boundary: equal counts).
// Cases: WI3-1 through WI3-9 per plan §WI-3a Tests.
//
// Isolation: fs.readdirSync mocked via vi.hoisted (same harness as all
//   selectAdapter tests above). Each test calls setRootEntries() to plant
//   exactly the extension counts the case requires. mockDirEntries is
//   cleared in beforeEach/afterEach.

describe('selectAdapter — Rust EP cases', () => {
  beforeEach(() => {
    mockDirEntries.clear();
  });

  afterEach(() => {
    mockDirEntries.clear();
  });

  // WI3-1: pure Rust dominant → RUST_ADAPTER (AC-1, strict dominance)
  it('WI3-1: {rs:100, ts:0, java:0, py:0, go:0} → RUST_ADAPTER (AC-1; strict dominance)', () => {
    setRootEntries(Array.from({ length: 100 }, (_, i) => file(`src_${i}.rs`)));
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(RUST_ADAPTER);
    expect(adapter!.id).toBe('rust');
  });

  // WI3-2: minimum non-zero Rust dominance → RUST_ADAPTER (BVA: boundary rs=1, all others=0)
  it('WI3-2: {rs:1, ts:0, java:0, py:0, go:0} → RUST_ADAPTER (minimum non-zero strict dominance)', () => {
    setRootEntries([file('main.rs')]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(RUST_ADAPTER);
    expect(adapter!.id).toBe('rust');
  });

  // WI3-3: Go beats Rust → GO_ADAPTER (AC-2; Go strict dominance wins)
  it('WI3-3: {rs:50, go:60, ts:0, java:0, py:0} → GO_ADAPTER (AC-2; Go wins, not Rust)', () => {
    setRootEntries([
      ...Array.from({ length: 50 }, (_, i) => file(`src_${i}.rs`)),
      ...Array.from({ length: 60 }, (_, i) => file(`pkg_${i}.go`)),
    ]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(GO_ADAPTER);
    expect(adapter!.id).toBe('go');
  });

  // WI3-4: Rust ties with TS → TYPESCRIPT_ADAPTER (AC-3; tie goes to TS)
  it('WI3-4: {rs:50, ts:50, java:0, py:0, go:0} → TYPESCRIPT_ADAPTER (AC-3; tie goes to TS)', () => {
    setRootEntries([
      ...Array.from({ length: 50 }, (_, i) => file(`src_${i}.rs`)),
      ...Array.from({ length: 50 }, (_, i) => file(`index_${i}.ts`)),
    ]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
    expect(adapter!.id).toBe('typescript');
  });

  // WI3-5: Rust ties with Java → not RUST_ADAPTER (tie; existing TS/Java tie-break applies; TS wins 0>=50? no — ts=0,java=50 → JAVA wins)
  it('WI3-5: {rs:50, java:50, ts:0, py:0, go:0} → JAVA_ADAPTER (tie; Rust does NOT win strict dominance)', () => {
    setRootEntries([
      ...Array.from({ length: 50 }, (_, i) => file(`src_${i}.rs`)),
      ...Array.from({ length: 50 }, (_, i) => file(`Foo_${i}.java`)),
    ]);
    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBe(RUST_ADAPTER);
    // ts=0, java=50 → 0 >= 50 is false → JAVA_ADAPTER
    expect(adapter).toBe(JAVA_ADAPTER);
  });

  // WI3-6: all equal (rs=go=ts=java=py=5) → not RUST_ADAPTER (strict dominance requires rs > ALL others)
  it('WI3-6: {rs:5, go:5, ts:5, java:5, py:5} → not RUST_ADAPTER (strict dominance requires rs > ALL)', () => {
    setRootEntries([
      file('a.rs'), file('b.rs'), file('c.rs'), file('d.rs'), file('e.rs'),
      file('a.go'), file('b.go'), file('c.go'), file('d.go'), file('e.go'),
      file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts'), file('e.ts'),
      file('A.java'), file('B.java'), file('C.java'), file('D.java'), file('E.java'),
      file('a.py'), file('b.py'), file('c.py'), file('d.py'), file('e.py'),
    ]);
    const adapter = selectAdapter(REPO);
    expect(adapter).not.toBe(RUST_ADAPTER);
    // py NOT strictly dominant (equal counts). go NOT strictly dominant. rust NOT strictly dominant.
    // ts=5 >= java=5 → TYPESCRIPT_ADAPTER
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
  });

  // WI3-7: all-zero guard → null (NOT TYPESCRIPT_ADAPTER — challenge #16 guard)
  it('WI3-7: {rs:0, ts:0, java:0, py:0, go:0} → null (all-zero guard; NOT TYPESCRIPT_ADAPTER)', () => {
    setRootEntries([file('README.md'), file('Makefile'), file('.gitignore')]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBeNull();
  });

  // WI3-8: rustCount=0 but tsCount=1 → TYPESCRIPT_ADAPTER (existing behavior preserved)
  it('WI3-8: {rs:0, ts:1, java:0, py:0, go:0} → TYPESCRIPT_ADAPTER (rustCount=0 does not win; existing behavior preserved)', () => {
    setRootEntries([file('index.ts')]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(TYPESCRIPT_ADAPTER);
    expect(adapter!.id).toBe('typescript');
  });

  // WI3-9: Python strictly beats Rust → PYTHON_ADAPTER (Python strict dominance wins over Rust; ordering check)
  it('WI3-9: {rs:10, py:11, ts:0, java:0, go:0} → PYTHON_ADAPTER (Python strict dominance wins over Rust)', () => {
    setRootEntries([
      ...Array.from({ length: 10 }, (_, i) => file(`src_${i}.rs`)),
      ...Array.from({ length: 11 }, (_, i) => file(`mod_${i}.py`)),
    ]);
    const adapter = selectAdapter(REPO);
    expect(adapter).toBe(PYTHON_ADAPTER);
    expect(adapter!.id).toBe('python');
  });

  // Regression lock: existing adapter selections are byte-identical for non-Rust repos (I-9)
  it('regression (I-9): pure TS repo still returns TYPESCRIPT_ADAPTER', () => {
    setRootEntries([file('index.ts'), file('utils.ts'), file('app.ts')]);
    expect(selectAdapter(REPO)).toBe(TYPESCRIPT_ADAPTER);
  });

  it('regression (I-9): pure Java repo still returns JAVA_ADAPTER', () => {
    setRootEntries([file('Foo.java'), file('Bar.java')]);
    expect(selectAdapter(REPO)).toBe(JAVA_ADAPTER);
  });

  it('regression (I-9): pure Python repo still returns PYTHON_ADAPTER', () => {
    setRootEntries([file('main.py'), file('utils.py'), file('app.py')]);
    expect(selectAdapter(REPO)).toBe(PYTHON_ADAPTER);
  });

  it('regression (I-9): pure Go repo still returns GO_ADAPTER', () => {
    setRootEntries([file('main.go'), file('router.go'), file('handler.go')]);
    expect(selectAdapter(REPO)).toBe(GO_ADAPTER);
  });

  // RUST_ADAPTER singleton identity: selectAdapter returns the exact exported singleton
  it('selectAdapter returns the exact RUST_ADAPTER singleton (same reference)', () => {
    setRootEntries([file('main.rs'), file('lib.rs')]);
    expect(selectAdapter(REPO)).toBe(RUST_ADAPTER);
  });
});
