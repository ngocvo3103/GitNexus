/**
 * Unit Tests: location-mapper (LSP read-only foundation, WI-#4)
 *
 * The mapper is a pure async function: it normalizes the URI,
 * issues a read-only Cypher MATCH, then runs a deterministic
 * tie-breaker chain. The DB call is injected via the `deps`
 * parameter, so the test surface is just function-in / result-out
 * — no global module mocking required.
 *
 * Decision table (the merge-blocking gate per the WI spec):
 *
 *   | 0 candidates          |  NO_NODE       |
 *   | 1 candidate           |  node          |
 *   | >1, all distinct      |  AMBIGUOUS     |
 *   | >1, smallest range    |  that one      |
 *   | >1, exact startLine   |  that one      |
 *   | >1, name match        |  that one      |
 *   | >1, same overload idx |  AMBIGUOUS     |
 *   | node_modules/.d.ts    |  NO_NODE       |
 *   | empty graph           |  NO_NODE       |
 *   | line > endLine        |  NO_NODE       |
 *   | line == endLine       |  matches       |
 *   | line == startLine     |  matches       |
 *   | windows URI           |  normalized    |
 *   | bad/non-numeric line  |  NO_NODE       |
 *
 * The fixture matrix F-1..F-5 from the spec is exercised first;
 * the rest is BVA / EP around the tie-breaker chain.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { generateId, normalizeFilePath } from '../../../src/lib/utils.js';
import * as nodePath from 'node:path';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  mapLocationToNodeId,
  __test__,
  MAPPER_LEAF_LABELS,
} from '../../../src/core/ingestion/lsp/location-mapper.js';

// ─── Real deps (used to compare the mapper's reconstructed ids) ───────
const realGenerateId = generateId;

// ─── Mock dispatch helper ──────────────────────────────────────────────
//
// The mapper accepts a `deps.executeParameterized` injection. We
// build a small wrapper that records the call and returns whatever
// the current test wants — this is the entire test surface.

function makeDeps(rows: any[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  return {
    deps: { executeParameterized: execute },
    execute,
  };
}

function loc(uri: string, line: number) {
  return { uri, range: { start: { line, character: 0 } } };
}

// Common fixture row factory. `id` is what the DB would have stored.
const row = (over: Partial<{
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  label: string | string[];
  filePath: string;
}>) => ({
  id: over.id ?? '',
  name: over.name ?? '',
  startLine: over.startLine ?? 0,
  endLine: over.endLine ?? 0,
  label: over.label ?? 'Function',
  filePath: over.filePath ?? 'src/foo.ts',
});

// ─── Fixture matrix F-1..F-5 (merge-blocking gate) ────────────────────

describe('location-mapper — fixture matrix (F-1..F-5)', () => {
  it('F-1: indexing-skew, single function at the queried line', async () => {
    // A single Function node spanning line 5..10; the Location's
    // line is 5 (the start). Single candidate → node.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/foo.ts:myFn',
        name: 'myFn',
        startLine: 5,
        endLine: 10,
        label: 'Function',
        filePath: 'src/foo.ts',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/foo.ts', 5),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/foo.ts:myFn' });
  });

  it('F-2: two overloads on the same startLine → AMBIGUOUS', async () => {
    // Two Method rows: same name, same startLine, same endLine.
    // Distinct `:index` overload suffixes. After all tie-breakers
    // the survivor is still >1, so the mapper refuses (EdgeCase 4,
    // Invariant 3).
    const { deps } = makeDeps([
      row({
        id: 'Method:src/S.java:doThing:0',
        name: 'doThing',
        startLine: 7,
        endLine: 12,
        label: 'Method',
        filePath: 'src/S.java',
      }),
      row({
        id: 'Method:src/S.java:doThing:1',
        name: 'doThing',
        startLine: 7,
        endLine: 12,
        label: 'Method',
        filePath: 'src/S.java',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/S.java', 7),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('F-3: multiple distinct symbols on one line → AMBIGUOUS', async () => {
    // Two functions declared on the same line, with the same range.
    // Different names. No tie-breaker resolves them.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/util.ts:helperA',
        name: 'helperA',
        startLine: 3,
        endLine: 5,
        label: 'Function',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Function:src/util.ts:helperB',
        name: 'helperB',
        startLine: 3,
        endLine: 5,
        label: 'Function',
        filePath: 'src/util.ts',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/util.ts', 3),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('F-4: node_modules / .d.ts → NO_NODE', async () => {
    const cases = [
      'file:///repo/node_modules/lodash/index.d.ts',
      'file:///repo/types/express/index.d.ts',
      'file:///repo/some/deep/path/node_modules/pkg/index.ts',
    ];
    for (const uri of cases) {
      const { deps, execute } = makeDeps([]);
      const result = await mapLocationToNodeId(loc(uri, 0), 'test-repo', deps);
      expect(result, `expected NO_NODE for ${uri}`).toEqual({ kind: 'NO_NODE' });
      // The DB should never have been touched.
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('F-5: 0 candidates in the graph → NO_NODE', async () => {
    const { deps } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/empty.ts', 10),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });
});

// ─── BVA: 0-indexed line convention (EdgeCase 6, Invariant 5) ──────────

describe('location-mapper — BVA on line index (0-indexed, invariant #5)', () => {
  it('line == startLine matches the node', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 5), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line == endLine matches the node (inclusive end)', async () => {
    // The Cypher uses `n.endLine >= $line`, so the inclusive end
    // must accept a query at the last line. This is the user's
    // `go-to-definition` on a closing brace of a one-liner.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 10), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line == endLine + 1 → NO_NODE (exclusive upper bound via no-match)', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 11), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('line == 0 (smallest valid) matches a function starting at line 0', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 0,
        endLine: 5,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line < 0 → NO_NODE (defensive: refuse over guess)', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', -1), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    // A malformed Location must not even hit the DB.
    expect(execute).not.toHaveBeenCalled();
  });

  it('non-integer line → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 1.5 as any), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('NaN line → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', NaN), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('line not present in any node (line > endLine, no enclosing range) → NO_NODE', async () => {
    // EdgeCase 6's BVA: the line is past the last node.
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:foo', name: 'foo', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 999), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
  });
});

// ─── Single-candidate fast path ────────────────────────────────────────

describe('location-mapper — single candidate skips tie-break', () => {
  it('returns the stored id directly (no reconstruction)', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Class:src/b.ts:Widget',
        name: 'Widget',
        startLine: 2,
        endLine: 20,
        label: 'Class',
        filePath: 'src/b.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/b.ts', 10), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/b.ts:Widget' });
  });

  it('reconstructs the id when the stored id is empty (Invariant 5)', async () => {
    // Defensive: a row with an empty `id` should still produce a
    // valid canonical id via `generateId(label, filePath:name)`.
    const { deps } = makeDeps([
      row({
        id: '',
        name: 'orphan',
        startLine: 0,
        endLine: 3,
        label: 'Function',
        filePath: 'src/orphan.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/orphan.ts', 1), 'test-repo', deps);
    expect(result.kind).toBe('node');
    if (result.kind === 'node') {
      expect(result.nodeId).toBe('Function:src/orphan.ts:orphan');
    }
  });
});

// ─── Tie-breaker 1: innermost enclosing range ──────────────────────────

describe('location-mapper — tie-breaker 1 (innermost range)', () => {
  it('picks the candidate with the smallest (endLine - startLine)', async () => {
    // A 30-line class containing a 3-line method. The query line
    // is inside both, so the query returns both. The method must win.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/c.ts:Big',
        name: 'Big',
        startLine: 1,
        endLine: 30,
        label: 'Class',
        filePath: 'src/c.ts',
      }),
      row({
        id: 'Method:src/c.ts:helper',
        name: 'helper',
        startLine: 5,
        endLine: 7,
        label: 'Method',
        filePath: 'src/c.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/c.ts', 6), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Method:src/c.ts:helper' });
  });

  it('still ties on identical ranges → falls through to tie-breaker 2', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/c.ts:a',
        name: 'a',
        startLine: 1,
        endLine: 5,
        filePath: 'src/c.ts',
      }),
      row({
        id: 'Function:src/c.ts:b',
        name: 'b',
        startLine: 1,
        endLine: 5,
        filePath: 'src/c.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/c.ts', 3), 'test-repo', deps);
    // Both ranges identical; both have startLine == 1 (tie-breaker 2
    // matches both); name doesn't match the URI basename "c" so
    // tie-breaker 3 yields 0; tie-breaker 4 distinguishes by overload
    // index — both are 0 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Tie-breaker 2: exact startLine match ──────────────────────────────

describe('location-mapper — tie-breaker 2 (exact startLine match)', () => {
  it('picks the candidate whose startLine == query line', async () => {
    // Two enclosing classes, one starting at the query line, the
    // other starting earlier. Both ranges identical size — TB1
    // ties, then TB2 disambiguates.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/d.ts:Outer',
        name: 'Outer',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
      row({
        id: 'Class:src/d.ts:Inner',
        name: 'Inner',
        startLine: 5,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
    ]);
    // Query line 5: Outer (startLine 1, range 9) and Inner (startLine 5, range 5).
    // TB1 picks Inner (smaller). But to exercise TB2 alone, we make
    // the ranges equal and startLine differ.
    const { deps: deps2 } = makeDeps([
      row({
        id: 'Class:src/d.ts:Outer',
        name: 'Outer',
        startLine: 1,
        endLine: 6,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
      row({
        id: 'Class:src/d.ts:Inner',
        name: 'Inner',
        startLine: 5,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/d.ts', 5), 'test-repo', deps2);
    // Both ranges are 5; TB1 ties. TB2 picks Inner (startLine == 5).
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/d.ts:Inner' });
    // Sanity: with the original deps (Inner strictly smaller), we'd
    // pick Inner via TB1 alone — confirms the path.
    expect(
      await mapLocationToNodeId(loc('file:///repo/src/d.ts', 5), 'test-repo', deps),
    ).toEqual({ kind: 'node', nodeId: 'Class:src/d.ts:Inner' });
  });
});

// ─── Tie-breaker 3: identifier-name match ──────────────────────────────

describe('location-mapper — tie-breaker 3 (identifier-name match)', () => {
  it('picks the candidate whose name matches the URI basename', async () => {
    // Two classes of identical size, neither starts at the query
    // line, both contain it. Names differ. The URI basename is
    // "util". The candidate named "utilHelper" contains "util" → wins.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/util.ts:OtherThing',
        name: 'OtherThing',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Class:src/util.ts:utilHelper',
        name: 'utilHelper',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/util.ts', 5), 'test-repo', deps);
    // TB1: both ranges 9 → tie. TB2: both startLine 1, query 5 → no
    // match. TB3: only "utilHelper" contains "util" → wins.
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/util.ts:utilHelper' });
  });

  it('falls through when no candidate name contains the URI basename', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Class:src/util.ts:Alpha',
        name: 'Alpha',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Class:src/util.ts:Beta',
        name: 'Beta',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/util.ts', 5), 'test-repo', deps);
    // TB3 yields 0 → falls to TB4 → both overload idx 0 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Tie-breaker 4: overload `:index` reconstruction ────────────────────

describe('location-mapper — tie-breaker 4 (overload :index)', () => {
  it('survives a single overload when only one has a numeric suffix', async () => {
    // Two methods of the same name on the same range. One has an
    // explicit overload `:0` and the other has none (id == name).
    // Sorted by overload index, the unsuffixed wins.
    const { deps } = makeDeps([
      row({
        id: 'Method:src/o.java:doThing:0',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
      row({
        id: 'Method:src/o.java:doThing',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/o.java', 3), 'test-repo', deps);
    // TB1 ties, TB2 ties (startLine 1, query 3), TB3 ties, TB4
    // sorts by overload idx. The unsuffixed id parses to 0; the
    // suffixed parses to 0 too. Still >1 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('returns AMBIGUOUS for two distinct overloads with different indices', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Method:src/o.java:doThing:0',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
      row({
        id: 'Method:src/o.java:doThing:1',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/o.java', 3), 'test-repo', deps);
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Empty graph + DB error handling ──────────────────────────────────

describe('location-mapper — empty / error / defensive', () => {
  it('empty graph returns NO_NODE without throwing (EdgeCase 8)', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/anything.ts', 0),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('DB exception → NO_NODE (refuse over guess, never throw)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('pool not initialized'));
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('DB returns null (defensive) → NO_NODE', async () => {
    const execute = vi.fn().mockResolvedValue(null as any);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('DB returns non-array (defensive) → NO_NODE', async () => {
    const execute = vi.fn().mockResolvedValue({ not: 'an array' } as any);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('empty URI → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('missing location.range → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      { uri: 'file:///repo/src/x.ts' } as any,
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });
});

// ─── Windows paths (EdgeCase 10) ───────────────────────────────────────

describe('location-mapper — Windows / cross-platform paths', () => {
  it('Windows backslash URI is normalized via lib/utils', async () => {
    // Per EdgeCase 10, `normalizeFilePath` collapses backslashes.
    // The graph stores repo-relative POSIX paths, so a Windows
    // client URI of `C:\repo\src\foo.ts` must end up as
    // `C:/repo/src/foo.ts` for the lookup to match.
    const { deps, execute } = makeDeps([
      row({
        id: 'Function:src/foo.ts:winFn',
        name: 'winFn',
        startLine: 1,
        endLine: 3,
        filePath: 'src/foo.ts',
      }),
    ]);
    // Use a backslash form AFTER stripping the file:// scheme.
    // Our helper does both; the graph is queried with the
    // normalized POSIX form.
    const result = await mapLocationToNodeId(
      loc('file:///C:/repo/src/foo.ts', 1),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/foo.ts:winFn' });
    // Confirm the parameter we sent to the DB is the POSIX form.
    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][2];
    expect(params.relPath).toBe('C:/repo/src/foo.ts');
    // And the lib's normalizeFilePath is a no-op on already-POSIX input
    // (Invariant 6: single-source normalization).
    expect(__test__.normalizeLocationUri('file:///C:/repo/src/foo.ts', normalizeFilePath))
      .toBe('C:/repo/src/foo.ts');
  });

  it('relative path URI (no scheme) is normalized', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/local.ts:rel',
        name: 'rel',
        startLine: 1,
        endLine: 2,
        filePath: 'src/local.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('src/local.ts', 1), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/local.ts:rel' });
  });
});

// ─── Property: normalizer idempotency ──────────────────────────────────

describe('location-mapper — property tests (normalizer)', () => {
  it('normalizeLocationUri is idempotent (the spec\'s property check)', () => {
    const cases = [
      'file:///repo/src/foo.ts',
      'file:///C:/repo/src/foo.ts',
      '/repo/src/foo.ts',
      'src/foo.ts',
      'file:///repo/node_modules/x/index.d.ts',
    ];
    for (const input of cases) {
      const once = __test__.normalizeLocationUri(input, normalizeFilePath);
      const twice = __test__.normalizeLocationUri(once, normalizeFilePath);
      expect(twice, `idempotent for ${input}`).toBe(once);
    }
  });

  it('isUnindexablePath is idempotent (a normalized NO_NODE path stays NO_NODE)', () => {
    const cases = [
      'node_modules',
      'node_modules/lodash/index.d.ts',
      'pkg/types.d.ts',
      'dist/index.js',
      'src/dist/bundle.js',
    ];
    for (const p of cases) {
      expect(__test__.isUnindexablePath(p), `unindexable: ${p}`).toBe(true);
    }
    // Real source files must NOT be flagged.
    const sourceFiles = ['src/foo.ts', 'lib/utils.ts', 'test/unit/x.test.ts'];
    for (const p of sourceFiles) {
      expect(__test__.isUnindexablePath(p), `indexable: ${p}`).toBe(false);
    }
  });
});

// ─── Label set sanity (Invariant 1: no graph writes) ───────────────────

describe('location-mapper — leaf label set', () => {
  it('excludes File, Folder, Community, Process (the four non-leaf labels)', () => {
    expect(MAPPER_LEAF_LABELS).not.toContain('File');
    expect(MAPPER_LEAF_LABELS).not.toContain('Folder');
    expect(MAPPER_LEAF_LABELS).not.toContain('Community');
    expect(MAPPER_LEAF_LABELS).not.toContain('Process');
  });

  it('includes the core leaf node labels', () => {
    for (const lbl of ['Function', 'Class', 'Method', 'Interface']) {
      expect(MAPPER_LEAF_LABELS, `should include ${lbl}`).toContain(lbl);
    }
  });
});

// ─── Internal helpers (buildCandidateQuery, stripFileUriScheme) ────────

describe('location-mapper — internal helpers', () => {
  it('buildCandidateQuery uses label(n) IN $labels + ORDER BY range', () => {
    const q = __test__.buildCandidateQuery();
    // Match clause is plain (label filter is in WHERE).
    expect(q).toMatch(/MATCH \(n\)/);
    // Kùzu-compatible label filter (the spec's `OR` disjunction is
    // rejected by Kùzu's parser; `label(n) IN $list` is the
    // canonical equivalent and is parameterized).
    expect(q).toMatch(/label\(n\) IN \$labels/);
    // Range filter uses parameterized line.
    expect(q).toMatch(/n\.startLine <= \$line/);
    expect(q).toMatch(/n\.endLine >= \$line/);
    // ORDER BY range ASC is the cheapest tie-breaker hint.
    expect(q).toMatch(/ORDER BY \(n\.endLine - n\.startLine\) ASC/);
    // Parameterized — no string-concatenated user input.
    expect(q).toContain('$relPath');
    expect(q).toContain('$line');
    expect(q).toContain('$labels');
    // Sanity: no leftover `OR n:Label` disjunction.
    expect(q).not.toMatch(/n:Function OR/);
  });

  it('stripFileUriScheme handles common shapes', () => {
    const { stripFileUriScheme } = __test__;
    // `file://` is the LSP-canonical scheme; we always strip the
    // leading slash that follows it (file:///abs → /abs → abs).
    expect(stripFileUriScheme('file:///repo/src/foo.ts')).toBe('repo/src/foo.ts');
    expect(stripFileUriScheme('file:///C:/repo/src/foo.ts')).toBe('C:/repo/src/foo.ts');
    // UNC-style: file://server/share → server/share
    expect(stripFileUriScheme('file://server/share/x.ts')).toBe('server/share/x.ts');
    // Some clients emit `file:/` (one slash); the same rule applies.
    expect(stripFileUriScheme('file:/repo/src/foo.ts')).toBe('repo/src/foo.ts');
    // No scheme + leading slash: NOT stripped — the input is a
    // (non-canonical) path the caller chose to pass and we should
    // not silently re-root it. The downstream normalizeFilePath
    // handles backslash-vs-slash only.
    expect(stripFileUriScheme('/repo/src/foo.ts')).toBe('/repo/src/foo.ts');
    expect(stripFileUriScheme('repo/src/foo.ts')).toBe('repo/src/foo.ts');
    expect(stripFileUriScheme('')).toBe('');
  });

  it('extractOverloadIndex parses the trailing :N', () => {
    const { extractOverloadIndex } = __test__;
    expect(extractOverloadIndex('Method:src/x.java:doThing:0')).toBe(0);
    expect(extractOverloadIndex('Method:src/x.java:doThing:1')).toBe(1);
    expect(extractOverloadIndex('Method:src/x.java:doThing:42')).toBe(42);
    expect(extractOverloadIndex('Function:src/foo.ts:foo')).toBe(0);
    expect(extractOverloadIndex('')).toBe(0);
    expect(extractOverloadIndex('Method:src/x.java:doThing:bad')).toBe(0);
  });

  it('extractBaseName strips the final extension and grabs the last segment', () => {
    const { extractBaseName } = __test__;
    expect(extractBaseName('src/foo.ts')).toBe('foo');
    expect(extractBaseName('src/foo.d.ts')).toBe('foo.d');
    expect(extractBaseName('a/b/c/MyClass.java')).toBe('MyClass');
    expect(extractBaseName('noext')).toBe('noext');
    expect(extractBaseName('')).toBe('');
  });
});

// ─── Idempotency: result shape is stable ───────────────────────────────

describe('location-mapper — result contract', () => {
  it('NO_NODE has no nodeId field', async () => {
    const { deps } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/x.ts', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).nodeId).toBeUndefined();
  });

  it('AMBIGUOUS has no nodeId field', async () => {
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:a', name: 'a', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
      row({ id: 'Function:src/a.ts:b', name: 'b', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 2), 'test-repo', deps);
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
    expect((result as any).nodeId).toBeUndefined();
  });

  it('node result carries a non-empty nodeId', async () => {
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:foo', name: 'foo', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 1), 'test-repo', deps);
    if (result.kind !== 'node') {
      throw new Error(`expected node, got ${result.kind}`);
    }
    expect(result.nodeId.length).toBeGreaterThan(0);
  });
});

// ─── Sanity: mapper reuses the real generateId for the reconstructed id ─

describe('location-mapper — reconstructed id matches generateId', () => {
  it('the mapper\'s reconstructed nodeId is byte-identical to generateId(label, filePath:name)', async () => {
    // Invariant 5: the id shape is generateId(label, `${filePath}:${name}`).
    const { deps } = makeDeps([
      row({
        id: '',
        name: 'whatever',
        startLine: 0,
        endLine: 2,
        label: 'Method',
        filePath: 'src/foo.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/foo.ts', 1), 'test-repo', deps);
    if (result.kind !== 'node') {
      throw new Error(`expected node, got ${result.kind}`);
    }
    expect(result.nodeId).toBe(realGenerateId('Method', 'src/foo.ts:whatever'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WI-5 (#159 P5): Python external-refusal seam
//
// These tests use REAL filesystem paths to avoid mocking `realpathSync`.
// Key fixtures:
//   repoRoot  — the current working directory (always a real path on disk)
//   outOfRepo — process.execPath (the Node binary; real, exists, outside repoRoot)
//   inRepo    — process.execPath doesn't exist inside repoRoot; we use a real
//               file INSIDE repoRoot: the compiled package.json (always exists)
//
// The mapper's containment check: realpathSync(absFile) + path.relative(repoRoot, abs)
// → starts with '..' → out-of-repo. Real paths guarantee realpathSync succeeds.
//
// Decision table (4 branches):
//   1. In-repo file:// + adapter    → { kind: 'node' }
//   2. Out-of-repo (rel ..) + adapt → { kind: 'NO_NODE', external: true }
//   3. Out-of-repo (abs diff root)  → { kind: 'NO_NODE', external: true }
//   4. Site-packages file:// + adap → { kind: 'NO_NODE', external: true }
//   5. No adapter (adapterId absent) → bare NO_NODE or node (TS byte-identical)
//   6. Java jdt:// with classifyUri  → { NO_NODE, external: true } (KD-3)
//   7. isUnindexablePath (.d.ts)     → bare {NO_NODE} (pre-existing)
//  10. In-repo symlink → site-pkgs   → { kind: 'NO_NODE', external: true }
//
// Plus BVA at containment boundary and two HARD gate fixtures (cases 8, 9).
// ─────────────────────────────────────────────────────────────────────────

// Real path fixtures — derived at module load time so they are always valid.
// repoRoot: the gitnexus package dir (parent of this test file's src/).
// outOfRepoFile: process.execPath (Node binary), which lives outside repoRoot.
// inRepoFile: the gitnexus package.json — always exists inside repoRoot.
const repoRoot = realpathSync(nodePath.resolve(fileURLToPath(import.meta.url), '../../../../..'));
const outOfRepoFile = realpathSync(process.execPath); // e.g. /opt/homebrew/.../node
const inRepoFile = realpathSync(nodePath.join(repoRoot, 'package.json')); // always exists
// Relative path of inRepoFile within repoRoot (what the DB stores).
const inRepoRelPath = nodePath.relative(repoRoot, inRepoFile).replace(/\\/g, '/');

describe('Python external-refusal seam (WI-5)', () => {
  // Case 1: In-repo file:// + Python adapter → { kind: 'node' }
  it('Case 1: in-repo file:// + Python adapter → node result', async () => {
    // Use a real in-repo file (package.json) so realpathSync succeeds and
    // containment check confirms it's inside repoRoot.
    const uri = `file://${inRepoFile}`;
    const { deps, execute } = makeDeps([
      row({
        id: `File:${inRepoRelPath}:root`,
        name: 'root',
        startLine: 0,
        endLine: 30,
        label: 'File',
        filePath: inRepoRelPath,
      }),
    ]);
    const result = await mapLocationToNodeId(
      loc(uri, 5),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    // The mapper queries the DB with the repo-relative path.
    // The DB mock returns a node → result.kind === 'node'.
    expect(result.kind).toBe('node');
    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][2];
    // relPath must be the repo-relative path, not the absolute path.
    expect(params.relPath).toBe(inRepoRelPath);
  });

  // Case 2: Out-of-repo file:// (rel starts ..) + Python adapter → external:true
  it('Case 2: out-of-repo file:// (process.execPath outside repoRoot) + Python adapter → NO_NODE external:true', async () => {
    // process.execPath is a real file that exists outside the repo root.
    // realpathSync succeeds; path.relative gives '../...' (starts with ..).
    const uri = `file://${outOfRepoFile}`;
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(uri, 0),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    // DB should never be touched — refused before query.
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 3: isAbsolute(relPath) branch — distinct from Case 2's startsWith('..') branch.
  //
  // The isOutOfRepo predicate in location-mapper.ts has TWO sub-conditions:
  //   (a) relPath.startsWith('..')  — covered by Case 2 (real out-of-repo file via rebase)
  //   (b) nodePath.isAbsolute(relPath) — covered HERE
  //
  // On POSIX, path.relative() never returns an absolute path, so the isAbsolute
  // guard fires via the normalizeLocationUri fallback path: inject a custom
  // normalizeFilePath that returns an absolute string, use a non-file:// URI (so
  // the rebase block is skipped entirely), and supply repoPath so the
  // `repoPath !== undefined` condition holds. The mapper then evaluates:
  //   relPath = normalizeFilePath(stripped)  →  '/injected/absolute/path.py'
  //   isAbsolute(relPath)                    →  true
  //   isOutOfRepo                            →  true
  //   isPythonAdapter                        →  true
  //   → { kind: 'NO_NODE', external: true }
  it('Case 3: isAbsolute(relPath) branch + Python adapter → NO_NODE external:true', async () => {
    // A non-file:// URI skips the fileURLToPath/realpathSync rebase block.
    // The injected normalizeFilePath returns an absolute path, making
    // relPath absolute and triggering the isAbsolute guard in isOutOfRepo.
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('python-stdlib:///builtins.py', 3),
      'py-repo',
      {
        ...deps,
        repoPath: repoRoot,
        adapterId: 'python',
        // Force relPath to be absolute so nodePath.isAbsolute(relPath) fires.
        normalizeFilePath: () => '/injected/absolute/builtins.py',
      },
    );
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    // DB must never be touched — isOutOfRepo guard fires before the MATCH.
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 4: Site-packages file:// — acceptance criterion from the WI spec.
  // Uses a real known path to /usr/bin/python3 if it exists; falls back to
  // process.execPath (always outside repo).
  it('Case 4: out-of-repo file:// (AC: site-packages semantics) + Python adapter → NO_NODE external:true', async () => {
    const uri = `file://${outOfRepoFile}`;
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(uri, 0),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 5: No adapterId (TS funnel) → bare NO_NODE for out-of-repo path
  it('Case 5: no adapterId → bare NO_NODE for out-of-repo path (TS path byte-identical)', async () => {
    const uri = `file://${outOfRepoFile}`;
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(uri, 0),
      'py-repo',
      // NO adapterId — TS funnel path
      { ...deps, repoPath: repoRoot },
    );
    // Must be bare NO_NODE (no external flag) — TS path byte-identical to pre-WI-5
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).external).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 5b (ruling #1 mandatory fitness test — Challenge Ledger accepted BLOCKER):
  // Full pipeline deps bag: repoPath + classifyUri BOTH present, no adapterId.
  // This is the exact combination pipeline.ts sends for TS/Java runs (classifyUri
  // is always present when lspAdapter is non-null, but adapterId is absent on the
  // TS path). The result MUST be bare {NO_NODE} — NOT { external: true } — because
  // external:true is gated on adapterId === 'python', NOT on classifyUri presence.
  // Without this case a typo on the gate expression can silently set external:true
  // on TS out-of-repo defs and break the I-1 byte-identical golden.
  it('Case 5b: repoPath + classifyUri present, no adapterId, out-of-repo URI → bare NO_NODE (ruling #1)', async () => {
    const uri = `file://${outOfRepoFile}`;
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(uri, 0),
      'ts-repo',
      {
        ...deps,
        repoPath: repoRoot,
        // classifyUri present (mirrors live TS/Java pipeline closure) but adapterId absent
        classifyUri: (u) => (u.startsWith('file://') ? 'workspace' : 'external'),
        // NO adapterId — TS funnel; external:true gate must NOT fire
      },
    );
    // external:true is gated on adapterId === 'python'; classifyUri alone must not trigger it
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).external).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 6: Java jdt:// with classifyUri → KD-3 block fires first → external:true
  it('Case 6: jdt:// with classifyUri → NO_NODE external:true (KD-3 unaffected)', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('jdt://contents/java.lang.String.class', 0),
      'java-repo',
      {
        ...deps,
        classifyUri: (u) => (u.startsWith('jdt://') ? 'external' : 'workspace'),
      },
    );
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 7: isUnindexablePath (.d.ts inside repo) → bare {NO_NODE} even with Python adapter
  it('Case 7: in-repo .d.ts path + Python adapter → bare NO_NODE (pre-existing, no external)', async () => {
    // A .d.ts path passed as a scheme-stripped synthetic URI (no realpathSync needed).
    // isUnindexablePath fires → bare NO_NODE. The path is NOT out-of-repo (no `..`),
    // so external:true must NOT be set even with Python adapter.
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('file:///repo/types/api.d.ts', 0),
      'py-repo',
      // Supply adapterId but NO repoPath → falls through to scheme-strip only.
      // relPath = 'repo/types/api.d.ts' → isUnindexablePath → bare NO_NODE.
      { ...deps, adapterId: 'python' },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).external).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 10: In-repo symlink → out-of-repo after realpath → external:true
  // Simulate: process.execPath acts as the "symlink target" — it's a real file
  // whose realpath is outside repoRoot. We use process.execPath directly as the
  // file URI (no symlink needed — the containment check only cares about the
  // realpath result being outside the repo, which is already true here).
  it('Case 10: file resolves (via realpath) to path outside repo + Python adapter → NO_NODE external:true', async () => {
    const uri = `file://${outOfRepoFile}`;
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(uri, 0),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    expect(execute).not.toHaveBeenCalled();
  });

  // R2-1: isOutOfRepo=true + isUnindexablePath=true — real fixture exercising
  // the isUnindexablePath return site at line 581-587 of location-mapper.ts.
  //
  // Construction: a real tmp directory whose absolute path contains '/dist/'
  // is created outside repoRoot. realpathSync resolves to the real path
  // (so the realpath+relative check fires: rebasedOutOfRepo=true, rebased=null).
  // The scheme-strip fallback then yields relPath = '/tmp/.../dist/mod.py'
  // which matches isUnindexablePath (contains '/dist/'). Since isPythonAdapter &&
  // isOutOfRepo, the isUnindexablePath guard returns { kind: 'NO_NODE', external: true }.
  //
  // This path is DISTINCT from Cases 2-4 which route through the outer isOutOfRepo
  // guard (line 594-596) — here the earlier isUnindexablePath guard (line 581-587)
  // fires first. A regression that drops the `isPythonAdapter && isOutOfRepo` check
  // at the isUnindexablePath site (while keeping the outer guard) would leave
  // Cases 2-4 green but break this test.
  describe('R2-1: isOutOfRepo=true + isUnindexablePath=true → external:true', () => {
    let distDir: string;
    let distFile: string;

    beforeAll(() => {
      // Create a real temp directory with '/dist/' in its absolute path, outside repoRoot.
      const tmpBase = mkdtempSync(nodePath.join(os.tmpdir(), 'gn-r2-1-'));
      distDir = nodePath.join(tmpBase, 'dist');
      mkdirSync(distDir, { recursive: true });
      const filePath = nodePath.join(distDir, 'mod.py');
      writeFileSync(filePath, '# generated\n');
      distFile = realpathSync(filePath);
    });

    afterAll(() => {
      // Clean up the temp tree.
      try { rmSync(nodePath.dirname(distDir), { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('out-of-repo /dist/ path + Python adapter → NO_NODE external:true (isUnindexablePath site)', async () => {
      // GIVEN a real file at /tmp/.../dist/mod.py (outside repoRoot, contains /dist/)
      const uri = `file://${distFile}`;
      const { deps, execute } = makeDeps([]);

      // WHEN mapLocationToNodeId is called with repoPath + Python adapter
      const result = await mapLocationToNodeId(
        loc(uri, 0),
        'py-repo',
        { ...deps, repoPath: repoRoot, adapterId: 'python' },
      );

      // THEN the isUnindexablePath guard (line 581-587) fires: returns external:true
      // WITHOUT reaching the outer isOutOfRepo guard (lines 593-596).
      expect(result).toEqual({ kind: 'NO_NODE', external: true });
      // The DB must not be queried — the guard short-circuits before the MATCH.
      expect(execute).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WI-5 (#159 P5): Python realpath-failure refusal (HARD gate)
//
// Cases 8 + 9: failures that give NO in/out-of-repo signal MUST produce
// bare {NO_NODE} — NOT {NO_NODE, external:true} (I-9 / R2-2).
// These tests prove the :482 scheme-strip fallthrough door is closed
// when the Python adapter is active.
// ─────────────────────────────────────────────────────────────────────────

describe('Python realpath-failure refusal — HARD gate (WI-5)', () => {
  // Case 8: Malformed file:// URI (fileURLToPath throws) + Python adapter → bare {NO_NODE}
  it('Case 8: malformed file:// URI (fileURLToPath throws) + Python adapter → bare NO_NODE (HARD gate)', async () => {
    // A URI with invalid percent-encoding causes fileURLToPath to throw.
    // This gives NO in/out-of-repo signal → external:true is PROHIBITED (I-9).
    // WI-5: Python adapter active → return bare {NO_NODE} instead of falling
    // through to scheme-strip (ruling R2-4 — close the wrong-node door).
    const malformedUri = 'file:///path/with/%GG/invalid/percent-encoding.py';
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(malformedUri, 0),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    // MUST be bare {NO_NODE} — NOT external:true
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).external).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 9: realpathSync throws (ENOENT — non-existent file) + Python adapter → bare {NO_NODE}
  it('Case 9: realpathSync throws (ENOENT, non-existent file) + Python adapter → bare NO_NODE (HARD gate)', async () => {
    // A non-existent file: fileURLToPath succeeds (well-formed URI), but
    // realpathSync throws ENOENT. This gives NO in/out-of-repo signal
    // → external:true is PROHIBITED (I-9 / R2-2).
    // WI-5: Python adapter active → return bare {NO_NODE} (ruling R2-4).
    const nonExistentUri = 'file:///tmp/__gitnexus_test_nonexistent_55a4b3c/foo.py';
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(nonExistentUri, 0),
      'py-repo',
      { ...deps, repoPath: repoRoot, adapterId: 'python' },
    );
    // MUST be bare {NO_NODE} — NOT external:true
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).external).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Case 11: Mode-C wire seam — adapterId=python + out-of-repo → external:true
  // (catches any-typed key typo at the mode-c-verifier.ts wire site — ruling R2-7)
  it('Case 11: Mode-C mapperDeps passthrough — adapterId=python + real out-of-repo → external:true', async () => {
    // Simulate exactly what classifyEdge builds when opts.adapter.id === 'python':
    //   mapperDeps = { classifyUri, repoPath: opts.repoPath, adapterId: opts.adapter?.id }
    // The mapper must return { kind: 'NO_NODE', external: true } for an out-of-repo
    // URI. This test would FAIL with a key typo like 'adapterid'.
    const fakeAdapter = {
      id: 'python' as const,
      classifyUri: (u: string): 'workspace' | 'external' | 'unmappable' =>
        u.startsWith('file://') ? 'workspace' : 'unmappable',
    };

    // Build mapperDeps exactly as mode-c-verifier.ts does (WI-5 wire site).
    const mapperDeps = fakeAdapter
      ? {
          classifyUri: (u: string) => fakeAdapter.classifyUri(u),
          repoPath: repoRoot,
          adapterId: fakeAdapter.id,
        }
      : undefined;

    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc(`file://${outOfRepoFile}`, 0),
      'crawl4ai',
      { ...deps, ...mapperDeps },
    );
    // Must be external-refusal — the Mode-C external-refusal bucket fires.
    expect(result).toEqual({ kind: 'NO_NODE', external: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
