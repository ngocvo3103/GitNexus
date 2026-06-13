/**
 * Unit tests for `scripts/audit-recall-precision.ts`
 *
 * Pure-function coverage over:
 *   - classifyRow (verdict logic)
 *   - extractToken (identifier extraction)
 *   - hasDynamicPrefix (this./super. detection)
 *   - auditRecallPrecision (full audit pipeline with injected seam)
 *   - hashSeed / mulberry32 / shuffleInPlace (PRNG determinism)
 *
 * No filesystem I/O, no DB, no subprocess — every seam is injected.
 * This test runs in the `default` vitest project (NOT lbug-db).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRow,
  extractToken,
  hasDynamicPrefix,
  hashSeed,
  mulberry32,
  shuffleInPlace,
  auditRecallPrecision,
} from '../../../scripts/audit-recall-precision.js';
import type { RecallEdgeRow } from '../../../scripts/audit-recall-precision.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeRow(overrides: Partial<RecallEdgeRow> = {}): RecallEdgeRow {
  return {
    fromFile: 'src/foo.ts',
    fromName: 'caller',
    sourceLine: 10,
    sourceCol: 4,
    targetName: 'doThing',
    targetLabel: 'Function',
    reason: 'lsp-recall',
    ...overrides,
  };
}

// ─── PRNG determinism ─────────────────────────────────────────────────

describe('hashSeed', () => {
  it('is deterministic for the same input', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
  });
  it('differs for different inputs', () => {
    expect(hashSeed('abc')).not.toBe(hashSeed('def'));
  });
  it('returns a uint32 (non-negative integer)', () => {
    const h = hashSeed('hello world');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('mulberry32', () => {
  it('produces values in [0,1)', () => {
    const rng = mulberry32(hashSeed('test'));
    for (let i = 0; i < 20; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('is deterministic from the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const va = [a(), a(), a()];
    const vb = [b(), b(), b()];
    expect(va).toEqual(vb);
  });
  it('differs for different seeds', () => {
    const a = mulberry32(1)[Symbol.iterator] ? mulberry32(1) : mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe('shuffleInPlace', () => {
  it('does not change the set of elements', () => {
    const arr = [1, 2, 3, 4, 5, 6];
    const rng = mulberry32(hashSeed('shuffle-test'));
    shuffleInPlace(arr, rng);
    expect(arr.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('is deterministic from the same seed', () => {
    const arr1 = ['a', 'b', 'c', 'd', 'e'];
    const arr2 = ['a', 'b', 'c', 'd', 'e'];
    shuffleInPlace(arr1, mulberry32(hashSeed('s')));
    shuffleInPlace(arr2, mulberry32(hashSeed('s')));
    expect(arr1).toEqual(arr2);
  });
  it('handles empty array', () => {
    const arr: number[] = [];
    expect(() => shuffleInPlace(arr, mulberry32(1))).not.toThrow();
    expect(arr).toEqual([]);
  });
  it('handles single element', () => {
    const arr = [42];
    shuffleInPlace(arr, mulberry32(1));
    expect(arr).toEqual([42]);
  });
});

// ─── extractToken ─────────────────────────────────────────────────────

describe('extractToken', () => {
  it('extracts bare identifier at col', () => {
    // "doThing(foo)" — col=0 points at 'd'
    expect(extractToken('doThing(foo)', 0, 7)).toBe('doThing');
  });
  it('extracts member-call target — col at method name start', () => {
    // "obj.doThing()" — col=4 points at 'd' of 'doThing'
    expect(extractToken('obj.doThing()', 4, 7)).toBe('doThing');
  });
  it('extracts token when col points at opening paren', () => {
    // "foo()" — col=3 points at '('  → scan left for word char
    expect(extractToken('foo()', 3, 3)).toBe('foo');
  });
  it('returns null for col on non-word, non-adjacent char', () => {
    // "  (" — col=2, and adjacent chars are not word chars
    expect(extractToken('  (', 2, 1)).toBeNull();
  });
  it('handles col past end of line (clamps)', () => {
    // "bar" length=3, col=10 → clamps to 2 → extracts 'bar'
    expect(extractToken('bar', 10, 3)).toBe('bar');
  });
  it('handles col=0 on non-word char at start', () => {
    // ".foo" — col=0 is '.', try right → word char at 1
    expect(extractToken('.foo', 0, 3)).toBe('foo');
  });
  it('handles identifier with $ and _', () => {
    expect(extractToken('_$my_func()', 0, 9)).toBe('_$my_func');
  });
  it('handles col in middle of identifier', () => {
    // "longName()" — col=4 is in the middle
    expect(extractToken('longName()', 4, 4)).toBe('longName');
  });
});

// ─── hasDynamicPrefix ────────────────────────────────────────────────

describe('hasDynamicPrefix', () => {
  it('detects this. prefix', () => {
    // "this.doThing()" — col=5 points at 'd'
    expect(hasDynamicPrefix('this.doThing()', 5)).toBe(true);
  });
  it('detects super. prefix', () => {
    // "super.handle()" — col=6
    expect(hasDynamicPrefix('super.handle()', 6)).toBe(true);
  });
  it('returns false for bare call', () => {
    // "doThing()" — no this./super. prefix
    expect(hasDynamicPrefix('doThing()', 0)).toBe(false);
  });
  it('returns false for obj. prefix (not this/super)', () => {
    // "obj.doThing()" — col=4
    expect(hasDynamicPrefix('obj.doThing()', 4)).toBe(false);
  });
  it('returns false when no preceding dot', () => {
    expect(hasDynamicPrefix('foo', 0)).toBe(false);
  });
  it('handles this. with spaces — no false positive', () => {
    // "notthis.foo()" — col=8; before dot is "notthis", not "this"
    expect(hasDynamicPrefix('notthis.foo()', 8)).toBe(false);
  });
  it('handles super at start of expression', () => {
    // "  super.init()" — col=8
    expect(hasDynamicPrefix('  super.init()', 8)).toBe(true);
  });
});

// ─── classifyRow ─────────────────────────────────────────────────────

describe('classifyRow', () => {
  // (a) unpositioned
  it('returns unpositioned when sourceLine is null', () => {
    const row = makeRow({ sourceLine: null });
    expect(classifyRow(row, null)).toBe('unpositioned');
  });

  it('returns unpositioned when sourceLine is -1', () => {
    const row = makeRow({ sourceLine: -1 });
    expect(classifyRow(row, null)).toBe('unpositioned');
  });

  // (b) no-file
  it('returns no-file when lineText is null and positioned', () => {
    const row = makeRow({ sourceLine: 5, sourceCol: 0 });
    expect(classifyRow(row, null)).toBe('no-file');
  });

  // (c) dynamic
  it('returns dynamic for this. prefix', () => {
    // "this.doThing(x)" — col=5
    const row = makeRow({ sourceLine: 1, sourceCol: 5, targetName: 'doThing' });
    expect(classifyRow(row, 'this.doThing(x)')).toBe('dynamic');
  });

  it('returns dynamic for super. prefix', () => {
    const row = makeRow({ sourceLine: 1, sourceCol: 6, targetName: 'handle' });
    expect(classifyRow(row, 'super.handle()')).toBe('dynamic');
  });

  // (d) corroborated
  it('returns corroborated when token matches target name (bare call)', () => {
    // "doThing(foo)" — col=0, target=doThing
    const row = makeRow({ sourceLine: 0, sourceCol: 0, targetName: 'doThing' });
    expect(classifyRow(row, 'doThing(foo)')).toBe('corroborated');
  });

  it('returns corroborated for member call where col points at method', () => {
    // "obj.doThing()" — col=4
    const row = makeRow({ sourceLine: 0, sourceCol: 4, targetName: 'doThing' });
    expect(classifyRow(row, 'obj.doThing()')).toBe('corroborated');
  });

  // (e) name-mismatch
  it('returns name-mismatch when token does not match', () => {
    // "otherFn()" — col=0, target=doThing
    const row = makeRow({ sourceLine: 0, sourceCol: 0, targetName: 'doThing' });
    expect(classifyRow(row, 'otherFn()')).toBe('name-mismatch');
  });

  it('returns name-mismatch when targetName is empty', () => {
    const row = makeRow({ sourceLine: 0, sourceCol: 0, targetName: '' });
    expect(classifyRow(row, 'doThing()')).toBe('name-mismatch');
  });

  it('returns name-mismatch when targetName is null', () => {
    const row = makeRow({ sourceLine: 0, sourceCol: 0, targetName: null });
    expect(classifyRow(row, 'doThing()')).toBe('name-mismatch');
  });

  // Edge: col pointing at paren still finds the identifier
  it('returns corroborated when col is on the opening paren', () => {
    // "foo()" — col=3 points at '('
    const row = makeRow({ sourceLine: 0, sourceCol: 3, targetName: 'foo' });
    expect(classifyRow(row, 'foo()')).toBe('corroborated');
  });

  // Edge: target with $ in name
  it('returns corroborated for $ identifier', () => {
    const row = makeRow({ sourceLine: 0, sourceCol: 0, targetName: '$http' });
    expect(classifyRow(row, '$http(opts)')).toBe('corroborated');
  });
});

// ─── auditRecallPrecision (pipeline) ─────────────────────────────────

describe('auditRecallPrecision', () => {
  // Fixture rows: a mix of corroborated, name-mismatch, dynamic, unpositioned
  const fixtureRows = [
    // corroborated: bare call, col=0, target=myFunc
    {
      fromFile: 'src/a.ts', fromName: 'callerA',
      sourceLine: 0, sourceCol: 0, targetName: 'myFunc', targetLabel: 'Function', reason: 'lsp-recall',
    },
    // corroborated: member call, col=4, target=doWork
    {
      fromFile: 'src/b.ts', fromName: 'callerB',
      sourceLine: 0, sourceCol: 4, targetName: 'doWork', targetLabel: 'Method', reason: 'lsp-recall',
    },
    // name-mismatch: col=0, token=wrongFn ≠ target=rightFn
    {
      fromFile: 'src/c.ts', fromName: 'callerC',
      sourceLine: 0, sourceCol: 0, targetName: 'rightFn', targetLabel: 'Function', reason: 'lsp-recall',
    },
    // dynamic: this.prefix
    {
      fromFile: 'src/d.ts', fromName: 'callerD',
      sourceLine: 0, sourceCol: 5, targetName: 'init', targetLabel: 'Method', reason: 'lsp-recall',
    },
    // unpositioned
    {
      fromFile: 'src/e.ts', fromName: 'callerE',
      sourceLine: null, sourceCol: null, targetName: 'orphan', targetLabel: 'Function', reason: 'lsp-recall',
    },
    // no-file (positioned but file not found)
    {
      fromFile: 'src/missing.ts', fromName: 'callerF',
      sourceLine: 0, sourceCol: 0, targetName: 'gone', targetLabel: 'Function', reason: 'lsp-recall',
    },
  ] as RecallEdgeRow[];

  // Line text by file:line
  const lineDb: Record<string, string> = {
    'src/a.ts:0': 'myFunc(arg1, arg2)',
    'src/b.ts:0': 'obj.doWork()',
    'src/c.ts:0': 'wrongFn()',
    'src/d.ts:0': 'this.init()',
    // src/missing.ts intentionally absent
  };

  function makeRunCypher(rows: RecallEdgeRow[]) {
    return async (_repoId: string, _cypher: string, _params: Record<string, unknown>) => {
      // Return all rows regardless of cypher text (test stub)
      return rows as unknown[];
    };
  }

  function makeReadLine(db: Record<string, string>) {
    return (absPath: string, lineIndex: number): string | null => {
      // absPath ends with the relative portion after the repo root
      // In tests, absPath = /fake-repo/src/foo.ts, lineIndex=0
      // We key by the last two path segments (src/foo.ts) + lineIndex
      const parts = absPath.split('/');
      const rel = parts.slice(-2).join('/') + ':' + lineIndex;
      return db[rel] ?? null;
    };
  }

  it('returns correct stats for fixture rows', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'test-seed',
      runCypher: makeRunCypher(fixtureRows),
      readLine: makeReadLine(lineDb),
    });
    const s = result.stats;
    // 6 total rows, all audited (< sampleCap)
    expect(s.n).toBe(6);
    expect(s.corroborated).toBe(2); // a.ts, b.ts
    expect(s.nameMismatch).toBe(1); // c.ts
    expect(s.dynamic).toBe(1);      // d.ts
    expect(s.unpositioned).toBe(1); // e.ts
    expect(s.noFile).toBe(1);       // missing.ts
  });

  it('corroborationRate = corroborated / (corroborated + mismatch + dynamic)', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'test-seed',
      runCypher: makeRunCypher(fixtureRows),
      readLine: makeReadLine(lineDb),
    });
    // 2 / (2 + 1 + 1) = 0.5
    expect(result.stats.corroborationRate).toBeCloseTo(0.5, 5);
  });

  it('reviewRows has at most 40 entries', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'test-seed',
      runCypher: makeRunCypher(fixtureRows),
      readLine: makeReadLine(lineDb),
    });
    expect(result.reviewRows.length).toBeLessThanOrEqual(40);
  });

  it('reviewRows count = min(n, 40)', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'test-seed',
      runCypher: makeRunCypher(fixtureRows),
      readLine: makeReadLine(lineDb),
    });
    // 6 rows < 40
    expect(result.reviewRows.length).toBe(6);
  });

  it('returns n=0 when no lsp-recall rows', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'test-seed',
      runCypher: makeRunCypher([]),
      readLine: makeReadLine({}),
    });
    expect(result.stats.n).toBe(0);
    expect(result.stats.corroborationRate).toBe(0);
  });

  it('samples to sampleCap when total > sampleCap', async () => {
    // Build 20 rows
    const manyRows: RecallEdgeRow[] = Array.from({ length: 20 }, (_, i) => ({
      fromFile: `src/f${i}.ts`,
      fromName: `caller${i}`,
      sourceLine: 0,
      sourceCol: 0,
      targetName: 'target',
      targetLabel: 'Function',
      reason: 'lsp-recall',
    }));
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 10, // cap at 10
      seed: 'sample-test',
      runCypher: makeRunCypher(manyRows),
      readLine: () => null, // all no-file
    });
    expect(result.stats.n).toBe(10);
  });

  it('seeded sampling is deterministic', async () => {
    const manyRows: RecallEdgeRow[] = Array.from({ length: 30 }, (_, i) => ({
      fromFile: `src/f${i}.ts`,
      fromName: `caller${i}`,
      sourceLine: 0,
      sourceCol: i % 5,
      targetName: `fn${i}`,
      targetLabel: 'Function',
      reason: 'lsp-recall',
    }));
    const run1 = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 15,
      seed: 'det-seed',
      runCypher: makeRunCypher(manyRows),
      readLine: () => null,
    });
    const run2 = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 15,
      seed: 'det-seed',
      runCypher: makeRunCypher(manyRows),
      readLine: () => null,
    });
    expect(run1.stats).toEqual(run2.stats);
    expect(run1.reviewRows.map(r => r.fromFile)).toEqual(
      run2.reviewRows.map(r => r.fromFile),
    );
  });

  it('runCypher errors result in n=0 (graceful degradation)', async () => {
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'err-seed',
      runCypher: async () => { throw new Error('DB error'); },
      readLine: () => null,
    });
    expect(result.stats.n).toBe(0);
  });

  it('displayLine is 1-based (sourceLine=0 → displayLine=1)', async () => {
    const rows: RecallEdgeRow[] = [{
      fromFile: 'src/z.ts',
      fromName: 'caller',
      sourceLine: 0,
      sourceCol: 0,
      targetName: 'target',
      targetLabel: 'Function',
      reason: 'lsp-recall',
    }];
    const result = await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'disp-seed',
      runCypher: makeRunCypher(rows),
      readLine: () => 'target()',
    });
    const row = result.reviewRows[0];
    expect(row.displayLine).toBe(1);
  });

  it('file-level cache: each file is read at most once across multiple line lookups', async () => {
    // Three edges all from the same file, different lines.
    // The readFile seam must be called exactly once for that file.
    let readFileCallCount = 0;
    const fileContent = 'firstLine()\nsecondLine()\nthirdLine()\n';

    const rows: RecallEdgeRow[] = [
      { fromFile: 'src/shared.ts', fromName: 'c1', sourceLine: 0, sourceCol: 0, targetName: 'firstLine',  targetLabel: 'Function', reason: 'lsp-recall' },
      { fromFile: 'src/shared.ts', fromName: 'c2', sourceLine: 1, sourceCol: 0, targetName: 'secondLine', targetLabel: 'Function', reason: 'lsp-recall' },
      { fromFile: 'src/shared.ts', fromName: 'c3', sourceLine: 2, sourceCol: 0, targetName: 'thirdLine',  targetLabel: 'Function', reason: 'lsp-recall' },
    ];

    await auditRecallPrecision({
      repoPath: '/fake-repo',
      repoId: 'fake-repo',
      sampleCap: 500,
      seed: 'cache-test',
      runCypher: makeRunCypher(rows),
      readFile: (absPath: string) => {
        if (absPath.endsWith('shared.ts')) {
          readFileCallCount++;
          return fileContent;
        }
        return null;
      },
    });

    expect(readFileCallCount).toBe(1);
  });
});
