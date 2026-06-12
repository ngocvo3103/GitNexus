/**
 * Unit Tests: Mode C verifier — #174 position routing
 *
 * Verifies:
 *   c. Verifier decision table: positioned rows probe at (callLine, callCol);
 *      NULL-line rows → unpositioned counter (NOT matches / fc / refusals).
 *   positionCoverage math: fraction of non-NULL sourceLine rows.
 *
 * All tests use fully-injected RunModeCVerifyOpts (no DB, no real LSP).
 * The `executeParameterized` mock returns rows whose `callLine`/`callCol`
 * fields mirror what the new Cypher query (`r.sourceLine AS callLine`,
 * `r.sourceCol AS callCol`) returns.
 *
 * The pre-#174 bug: classifyEdge probed `{ line: a.startLine, character: 0 }`
 * (the caller's declaration line), which resolved to the enclosing function
 * itself — structurally preventing any match. This file is the test that
 * would have caught it, had it existed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runModeCVerify,
  __test__,
  type RunModeCVerifyOpts,
} from '../../../src/core/ingestion/lsp/mode-c-verifier.js';
import type { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';

// ─── shared mock factories ─────────────────────────────────────────────

/** Always-ready probe. */
const readyProbe = async () => ({ ready: true });

/** Build a mock LspClient that records every request params. */
function makeMockClient(returnVal: any = []) {
  const captured: Array<{ method: string; params: any }> = [];
  const request = vi.fn(async (method: string, params: any) => {
    captured.push({ method, params });
    return returnVal;
  });
  const client = { request } as unknown as LspClient & { request: ReturnType<typeof vi.fn> };
  return { client, captured };
}

/** NO_NODE mapper — always refuses. */
const noNodeMapper = async () => ({ kind: 'NO_NODE' as const });

/** Node mapper — always returns a fixed nodeId. */
function nodeMapper(nodeId: string) {
  return async () => ({ kind: 'node' as const, nodeId });
}

/**
 * Build a DB row matching what `r.sourceLine AS callLine, r.sourceCol AS callCol`
 * returns. `callLine: null` → unpositioned legacy row.
 */
function makeRow(over: {
  sourceFile?: string;
  sourceLine?: number;   // node's startLine (always a number to pass projectEdge)
  sourceId?: string;
  targetId?: string;
  reason?: string;
  callLine?: number | null;  // edge's sourceLine column (#174)
  callCol?: number | null;   // edge's sourceCol column (#174)
} = {}) {
  return {
    sourceFile: over.sourceFile ?? '/abs/src/a.ts',
    sourceLine: over.sourceLine ?? 1,
    sourceName: 'caller',
    sourceId: over.sourceId ?? 'fn:caller',
    targetFile: '/abs/src/b.ts',
    targetStartLine: 5,
    targetEndLine: 10,
    targetName: 'callee',
    targetId: over.targetId ?? 'fn:callee',
    confidence: 0.5,
    reason: over.reason ?? 'fuzzy-global',
    callLine: over.callLine !== undefined ? over.callLine : 7,
    callCol: over.callCol !== undefined ? over.callCol : 3,
  };
}

/** Build minimal RunModeCVerifyOpts. */
function makeOpts(
  rows: any[],
  clientArg: LspClient,
  mapperArg: RunModeCVerifyOpts['mapLocationToNodeId'],
): RunModeCVerifyOpts {
  return {
    repoId: 'test-repo',
    client: clientArg,
    mapLocationToNodeId: mapperArg,
    executeParameterized: async () => rows,
    probe: readyProbe,
    sampleSize: 200,
    seed: 'test-seed',
  };
}

// ─── projectEdge tests ─────────────────────────────────────────────────

describe('__test__.projectEdge (#174)', () => {
  const { projectEdge } = __test__;

  it('returns a CallEdge with callLine/callCol from the row', () => {
    const edge = projectEdge(makeRow({ callLine: 42, callCol: 7 }));
    expect(edge).not.toBeNull();
    expect(edge!.callLine).toBe(42);
    expect(edge!.callCol).toBe(7);
  });

  it('callLine === -1 sentinel when callLine is null (unpositioned row)', () => {
    const edge = projectEdge(makeRow({ callLine: null, callCol: null }));
    expect(edge).not.toBeNull();
    // -1 is the sentinel for "unpositioned"
    expect(edge!.callLine).toBe(-1);
  });

  it('callCol defaults to 0 when only callCol is null', () => {
    const edge = projectEdge(makeRow({ callLine: 5, callCol: null }));
    expect(edge).not.toBeNull();
    expect(edge!.callLine).toBe(5);
    expect(edge!.callCol).toBe(0);
  });

  it('callLine === -1 when callLine is undefined (absent column, pre-#174 row)', () => {
    const row = makeRow({ callLine: 7, callCol: 3 });
    delete (row as any).callLine;
    const edge = projectEdge(row);
    expect(edge!.callLine).toBe(-1);
  });

  it('drops row with no sourceFile', () => {
    const row = makeRow();
    (row as any).sourceFile = '';
    expect(projectEdge(row)).toBeNull();
  });

  it('drops row when sourceLine (node prop) is not a number', () => {
    const row = makeRow();
    (row as any).sourceLine = null;
    expect(projectEdge(row)).toBeNull();
  });
});

// ─── unpositioned routing ──────────────────────────────────────────────

describe('runModeCVerify — unpositioned counter (#174)', () => {
  it('NULL-sourceLine row goes to unpositioned counter, not matches/fc/refusals', async () => {
    const { client } = makeMockClient([]);  // LSP should never be called
    const opts = makeOpts(
      [makeRow({ callLine: null, callCol: null, targetId: 'fn:callee' })],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);

    // The unpositioned row must be counted — n stays 0 (not probed).
    expect(report.overall.unpositioned).toBe(1);
    expect(report.overall.n).toBe(0);
    expect(report.overall.matches).toBe(0);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.refusals).toBe(0);
    // LSP must NOT have been called for an unpositioned row.
    expect(client.request).not.toHaveBeenCalled();
  });

  it('per-tier unpositioned counter increments in the correct tier', async () => {
    const { client } = makeMockClient([]);
    const opts = makeOpts(
      [
        makeRow({ reason: 'same-file', callLine: null }),     // same-file unpositioned
        makeRow({ reason: 'fuzzy-global', callLine: null }),  // global unpositioned
      ],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);

    expect(report.perTier['same-file'].unpositioned).toBe(1);
    expect(report.perTier.global.unpositioned).toBe(1);
    expect(report.perTier['import-scoped'].unpositioned).toBe(0);
    expect(report.overall.unpositioned).toBe(2);
    // LSP not called
    expect(client.request).not.toHaveBeenCalled();
  });

  it('mix of positioned and unpositioned: only positioned edges are probed', async () => {
    const { client, captured } = makeMockClient([{ uri: '/abs/src/b.ts', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } }]);
    const opts = makeOpts(
      [
        makeRow({ sourceId: 'fn:a', targetId: 'fn:callee', callLine: 7, callCol: 3 }),   // positioned
        makeRow({ sourceId: 'fn:b', targetId: 'fn:callee', callLine: null }),             // unpositioned
        makeRow({ sourceId: 'fn:c', targetId: 'fn:callee', callLine: 12, callCol: 5 }),  // positioned
      ],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);

    // 2 positioned → probed; 1 unpositioned → not probed.
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(report.overall.unpositioned).toBe(1);
    expect(report.overall.n).toBe(2);
  });
});

// ─── positionCoverage math ─────────────────────────────────────────────

describe('runModeCVerify — positionCoverage (#174)', () => {
  it('positionCoverage === 1.0 when all rows are positioned', async () => {
    const { client } = makeMockClient([]);
    const opts = makeOpts(
      [
        makeRow({ callLine: 5, callCol: 0 }),
        makeRow({ callLine: 10, callCol: 2 }),
      ],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);
    expect(report.positionCoverage).toBe(1.0);
  });

  it('positionCoverage === 0.0 when all rows are unpositioned', async () => {
    const { client } = makeMockClient([]);
    const opts = makeOpts(
      [makeRow({ callLine: null }), makeRow({ callLine: null })],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);
    expect(report.positionCoverage).toBe(0.0);
  });

  it('positionCoverage === undefined when rows array is empty (no data ≠ 0% coverage)', async () => {
    // An empty graph has no CALLS rows at all. positionCoverage must be
    // undefined (not 0.0) so callers can distinguish "no data" from "data
    // exists but all rows are unpositioned" (the latter is 0.0).
    const { client } = makeMockClient([]);
    const opts = makeOpts([], client, noNodeMapper);
    const report = await runModeCVerify(opts);
    expect(report.positionCoverage).toBeUndefined();
  });

  it('positionCoverage is fractional for a mix', async () => {
    const { client } = makeMockClient([]);
    const opts = makeOpts(
      [
        makeRow({ callLine: 1, callCol: 0 }),    // positioned
        makeRow({ callLine: null }),              // unpositioned
        makeRow({ callLine: null }),              // unpositioned
        makeRow({ callLine: 99, callCol: 10 }),  // positioned
      ],
      client,
      noNodeMapper,
    );
    const report = await runModeCVerify(opts);
    // 2 positioned out of 4 total → 0.5
    expect(report.positionCoverage).toBeCloseTo(0.5);
  });
});

// ─── classifyEdge probes at callLine/callCol ──────────────────────────

describe('runModeCVerify — classifyEdge probes persisted position (#174)', () => {
  it('probes at (callLine, callCol) — NOT at (sourceLine=node startLine, character:0)', async () => {
    const { client, captured } = makeMockClient([]);
    const opts = makeOpts(
      // sourceLine=1 (node startLine), callLine=7, callCol=3
      [makeRow({ sourceLine: 1, callLine: 7, callCol: 3, targetId: 'fn:callee' })],
      client,
      noNodeMapper,
    );
    await runModeCVerify(opts);

    expect(captured).toHaveLength(1);
    const pos = captured[0].params.position;
    // Must probe at the call-site position, NOT at the node's startLine.
    expect(pos.line).toBe(7);
    expect(pos.character).toBe(3);
    // The pre-#174 bug would have set line:1, character:0 here.
    expect(pos.line).not.toBe(1);
  });

  it('positioned row → match when LSP agrees with heuristic target', async () => {
    const targetId = 'fn:callee';
    const { client } = makeMockClient([{ uri: '/abs/src/b.ts', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } }]);
    const opts = makeOpts(
      [makeRow({ callLine: 7, callCol: 3, targetId })],
      client,
      nodeMapper(targetId), // LSP resolves to the same node → match
    );
    const report = await runModeCVerify(opts);

    expect(report.overall.matches).toBe(1);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.unpositioned).toBe(0);
    // This assertion is the core of #174: matches > 0 is only possible when
    // we probe at the correct call-site position. Before #174, matches was
    // structurally 0 for every repo.
    expect(report.overall.matches).toBeGreaterThan(0);
  });

  it('NULL-line row → unpositioned (never falseConfident) even when heuristic had a target', async () => {
    // Pre-#174 bug: the wrong-position probe returned the enclosing function,
    // not the callee → falseConfident inflated. After the fix: the row is
    // routed to unpositioned and never probed.
    const { client } = makeMockClient([]);
    const opts = makeOpts(
      [makeRow({ callLine: null, targetId: 'fn:callee' })],
      client,
      nodeMapper('fn:different'), // would be fc if probed, but must NOT be probed
    );
    const report = await runModeCVerify(opts);

    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.unpositioned).toBe(1);
    // LSP must never have been called.
    expect(client.request).not.toHaveBeenCalled();
  });
});

// ─── lspUnavailable path ──────────────────────────────────────────────

describe('runModeCVerify — probe-not-ready (#174 shape stable)', () => {
  it('returns positionCoverage === undefined when probe fails (no rows read)', async () => {
    const { client } = makeMockClient([]);
    const opts: RunModeCVerifyOpts = {
      repoId: 'test-repo',
      client,
      mapLocationToNodeId: noNodeMapper,
      executeParameterized: async () => { throw new Error('should not be called'); },
      probe: async () => ({ ready: false, reason: 'workspace not built' }),
      sampleSize: 10,
    };
    const report = await runModeCVerify(opts);

    expect(report.lspUnavailable).toBe(true);
    // positionCoverage is not set when we short-circuit before reading rows.
    expect(report.positionCoverage).toBeUndefined();
  });
});
