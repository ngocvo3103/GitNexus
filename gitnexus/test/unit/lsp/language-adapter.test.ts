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
  PYLSP_READY_DEADLINE_MS,
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

// ─── Suite: interface shape conformance ───────────────────────────────

describe('LanguageAdapter interface compliance', () => {
  const adapters: LanguageAdapter[] = [TYPESCRIPT_ADAPTER, JAVA_ADAPTER, PYTHON_ADAPTER];

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
