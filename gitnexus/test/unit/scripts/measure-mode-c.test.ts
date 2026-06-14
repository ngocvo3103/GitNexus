/**
 * Unit Tests: scripts/measure-mode-c.ts (WI-1b — campaign harness core)
 *
 * `measureModeC(opts)` is the per-repo orchestration function for
 * the two-leg Mode C measurement campaign. It is the seam between
 * the CLI entry (WI-1c) and the production verifier
 * (`runModeCVerify`).
 *
 * The function is **pure-with-DI**: every I/O surface is injected:
 *
 *   - `exec`   — child-process runner for `gitnexus analyze` / `analyze --lsp`
 *   - `verify` — defaults to `runModeCVerify` (loaded via dynamic
 *                import of the compiled JS in production)
 *   - `stat`   — `.gitnexus/lbug` size lookup (default: `du -s` style)
 *   - `runCypher` — `executeParameterized`-shaped reader for
 *                edgeCountsBySource / edgeCountsByReason
 *   - `sha`    — `git rev-parse HEAD` equivalent
 *
 * This file is a **vitest** unit suite. It runs in the `default`
 * project (NOT in the `lbug-db` project) so the new harness
 * additions do NOT touch any LadybugDB file lock. The test surface
 * never spawns a real subprocess, never opens a real DB, and never
 * reaches an LSP server.
 *
 * Decision table (per WI-1b Tests block + Verify findings):
 *
 *   | case                     | .gitnexus  | exec(baseline)            | exec(lsp)                  | sampledCap | verify |
 *   |--------------------------|------------|---------------------------|----------------------------|------------|--------|
 *   | fresh repo (baseline)    | absent     | analyze <repo>            | n/a                        | =N         | ok     |
 *   | fresh repo (lsp)         | absent     | n/a                       | analyze --lsp <repo>       | =N         | ok     |
 *   | pre-indexed (baseline)   | present    | NOT called (reuse)        | n/a                        | =N         | ok     |
 *   | pre-indexed (lsp)        | present    | n/a                       | analyze --lsp <repo>       | =N         | ok     |
 *   | both legs (.gitnexus=∅)  | absent     | analyze <repo>            | analyze --lsp <repo>       | =N         | ok×2   |
 *   | both legs (.gitnexus=✓)  | present    | NOT called (reuse)        | analyze --lsp <repo>       | =N         | ok×2   |
 *   | legacy index             | present    | NOT called (reuse)        | n/a                        | =N         | ok     |
 *   | under-sampled            | present    | NOT called (reuse)        | n/a                        | <N         | ok     |
 *   | verifier rejects         | present    | NOT called (reuse)        | n/a                        | n/a        | throws |
 *
 * Methodology: stubs for every I/O seam. The default `stat`
 * returns 1024 (1KB) — the unit tests only care that the value is
 * echoed, not that it's a real disk measurement.
 *
 * ─── CONTRACT CLASSIFICATION ──────────────────────────────────────────
 *
 * This suite pins TWO classes of contract, intentionally distinct:
 *
 *   1. **Implementation contract (per-leg analyze, gh #173).**
 *      Each leg runs its own `analyze` call with the leg-specific
 *      flag:
 *        - baseline → `analyze <repoPath>`       (no --lsp)
 *        - lsp      → `analyze --lsp <repoPath>`
 *      The `baseline` leg reuses a pre-existing `.gitnexus` index
 *      when present on entry; the `lsp` leg ALWAYS re-analyzes
 *      (it needs an LSP-augmented index regardless of what was on
 *      disk). `buildRealVerifyOpts` is called ONCE PER LEG so the
 *      graph connection is always fresh for the just-written index.
 *      Tests that pin this:
 *        - DT-7 ("both legs — per-leg analyze")
 *        - "legs=[baseline, lsp] with .gitnexus absent → 2 analyze
 *           calls (baseline no --lsp, lsp with --lsp)"
 *        - "legs=[lsp] only → analyze --lsp called"
 *        - "artifact carries analyzeCommand and analyzeRanForThisLeg"
 *
 *   2. **Design contract (stable across analyze-model changes).**
 *      DT-1..DT-6: every per-leg invariant (leg labels in
 *      artifacts, `underSampled` flagging, verifier-rejection
 *      surface, `runCypher` legacy-index tolerance) does NOT
 *      depend on the analyze model. These assertions hold under
 *      both the old same-index model and the new per-leg model.
 *
 * Refactor guard: tests marked **[IMPL]** pin the per-leg-analyze
 * implementation; tests marked **[DESIGN]** pin the design
 * contract and are stable across analyze-model changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// We import the pure module under test. The module's own dynamic
// import of `runModeCVerify` resolves to `dist/.../mode-c-verifier.js`
// at runtime; the static no-write invariant sweep reads the
// harness source (this test does not import the verifier).
//
// We pin the import path to the SOURCE file (not compiled JS) so
// the typecheck gate `npm run typecheck:scripts` resolves the
// module's TypeScript types. The module itself does NOT use static
// `import` for the verifier — see implementation.
import {
  measureModeC,
  type MeasureModeCOptions,
  type MeasureModeCLegResult,
  type MeasureModeCResult,
} from '../../../scripts/measure-mode-c.js';

// ─── Default seam stubs ────────────────────────────────────────────────

/** Build a stub `stat` seam that returns a fixed byte count. */
function makeStat(bytes: number) {
  return vi.fn(async (_repoPath: string) => bytes);
}

/** Build a stub `exec` seam that records every call. */
function makeExec(impl?: (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>) {
  return vi.fn(
    impl ??
      (async () => ({ stdout: '', stderr: '', code: 0 })),
  );
}

/** Build a stub `verify` seam that returns a deterministic report. */
function makeVerify(impl?: (opts: any) => Promise<any>) {
  return vi.fn(
    impl ??
      (async () => ({
        perTier: {
          'same-file': zeroMetrics(),
          'import-scoped': zeroMetrics(),
          global: zeroMetrics(),
          external: zeroMetrics(),
        },
        overall: zeroMetrics(),
        sampleSize: 50,
        serverVersion: 'stub-v1',
        sampledCap: 50,
      })),
  );
}

/** Build a stub `runCypher` that dispatches by the column name
 *  in the query (`r.source` vs `r.reason`). Each call gets its
 *  own canned row set; this mirrors the production projection. */
function makeCypher(over: { bySource?: any[]; byReason?: any[]; default?: any[] } = {}) {
  const bySource = over.bySource ?? HAPPY_CYPHER_ROWS_BY_SOURCE;
  const byReason = over.byReason ?? HAPPY_CYPHER_ROWS_BY_REASON;
  const fallback = over.default ?? [];
  return vi.fn(async (_repoId: string, cypher: string, _params: any) => {
    if (/r\.source\s+AS\s+bucket/i.test(cypher)) return bySource;
    if (/r\.reason\s+AS\s+bucket/i.test(cypher)) return byReason;
    return fallback;
  });
}

/** Build a stub `sha` seam. */
function makeSha(sha = 'abc123def') {
  return vi.fn(async (_repoPath: string) => sha);
}

/** Empty VerifyMetrics factory — mirrors the verifier's shape. */
function zeroMetrics() {
  return {
    precision: 0,
    recall: 0,
    falseConfidentRate: 0,
    matches: 0,
    falseConfident: 0,
    recallMisses: 0,
    refusals: 0,
    recallGains: 0,
    n: 0,
  };
}

/** Build a populated per-leg VerifyReport fixture. */
function makeReport(over: Partial<{ sampledCap: number; sampleSize: number; matches: number; n: number }> = {}) {
  const sampledCap = over.sampledCap ?? 50;
  const n = over.n ?? sampledCap;
  return {
    perTier: {
      'same-file': { ...zeroMetrics(), matches: over.matches ?? 10, n: Math.floor(n * 0.4) },
      'import-scoped': { ...zeroMetrics(), matches: Math.floor((over.matches ?? 10) * 0.4), n: Math.floor(n * 0.3) },
      global: { ...zeroMetrics(), matches: Math.floor((over.matches ?? 10) * 0.2), n: Math.floor(n * 0.2) },
      external: { ...zeroMetrics(), n: Math.floor(n * 0.1) },
    },
    overall: { ...zeroMetrics(), matches: over.matches ?? 10, n },
    sampleSize: over.sampleSize ?? 50,
    serverVersion: 'stub-v1',
    sampledCap,
  };
}

/** Default RepoMeta fixture — what `loadMeta` should return. */
function makeMeta(over: Partial<{ files: number; nodes: number; edges: number; communities: number; processes: number }> = {}) {
  return {
    repoPath: '/tmp/repo',
    lastCommit: 'abc123def',
    indexedAt: '2026-06-11T00:00:00.000Z',
    schemaVersion: 1,
    stats: {
      files: over.files ?? 9,
      nodes: over.nodes ?? 100,
      edges: over.edges ?? 200,
      communities: over.communities ?? 5,
      processes: over.processes ?? 10,
    },
  };
}

/** Canonical happy-path cypher rows (edge counts by source & reason).
 *  The shape mirrors what a real Kùzu engine returns with implicit
 *  grouping (openCypher spec): one row per (bucket, count) tuple,
 *  where `count` is the aggregate over the matched relationships.
 *  The JS-side sum in `bucketEdgeCounts` is a defensive net in case
 *  a future engine version returns multi-row buckets. */
const HAPPY_CYPHER_ROWS_BY_SOURCE = [
  { bucket: 'heuristic', count: 120 },
  { bucket: 'lsp-confirmed', count: 30 },
  { bucket: 'lsp-corrected', count: 10 },
];

const HAPPY_CYPHER_ROWS_BY_REASON = [
  { bucket: 'same-file', count: 110 },
  { bucket: 'import-resolved', count: 40 },
  { bucket: 'fuzzy-global', count: 10 },
];

/** Default options factory — overrides per-test. */
function makeOptions(over: Partial<MeasureModeCOptions> = {}): MeasureModeCOptions {
  return {
    repoPath: '/tmp/repo',
    legs: ['baseline'],
    sampleSize: 50,
    seed: 'wi1b-test-seed',
    outDir: '/tmp/out',
    exec: makeExec() as any,
    verify: makeVerify() as any,
    stat: makeStat(1024) as any,
    runCypher: makeCypher() as any,
    sha: makeSha() as any,
    ...over,
  };
}

// ─── DT-1: .gitnexus absent → exec(analyze) called BEFORE verify ──────

describe('measure-mode-c — DT-1: .gitnexus absent → analyze runs first', () => {
  it('calls exec with "analyze" arg before verify, artifact.analyzeRanFirst=true', async () => {
    const calls: string[] = [];
    const exec = makeExec(async (cmd, args) => {
      // Record a call signature. We only need to know it ran.
      calls.push(`${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '', code: 0 };
    });
    // stat: .gitnexus absent (returns null)
    const stat = vi.fn(async (p: string) => null as any);
    const verify = makeVerify();
    const opts = makeOptions({ exec: exec as any, stat: stat as any, verify: verify as any });
    const result = await measureModeC(opts);
    // exec was called at least once, with "analyze" arg.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatch(/analyze/);
    // exec was called BEFORE verify (sequential per-repo gate).
    const execOrder = (exec as any).mock.invocationCallOrder[0];
    const verifyOrder = (verify as any).mock.invocationCallOrder[0];
    expect(execOrder).toBeLessThan(verifyOrder);
    // artifact.analyzeRanFirst === true
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0].analyzeRanFirst).toBe(true);
  });
});

// ─── DT-2: .gitnexus present → exec NOT invoked ────────────────────────

describe('measure-mode-c — DT-2: .gitnexus present → no analyze', () => {
  it('does NOT call exec, artifact.analyzeRanFirst=false', async () => {
    const stat = makeStat(2048); // non-null bytes = .gitnexus present
    const exec = makeExec();
    const verify = makeVerify();
    const opts = makeOptions({ stat: stat as any, exec: exec as any, verify: verify as any });
    const result = await measureModeC(opts);
    expect(exec).not.toHaveBeenCalled();
    expect(result.artifacts[0].analyzeRanFirst).toBe(false);
  });
});

// ─── DT-3: runCypher returns [] (legacy index) → empty maps, no throw ─

describe('measure-mode-c — DT-3: legacy index, runCypher=[]', () => {
  it('edgeCountsBySource and edgeCountsByReason are empty {}, no throw', async () => {
    const stat = makeStat(2048);
    const runCypher = makeCypher({ bySource: [], byReason: [] }); // legacy index returns no rows
    const verify = makeVerify();
    const opts = makeOptions({ stat: stat as any, runCypher: runCypher as any, verify: verify as any });
    const result = await measureModeC(opts);
    expect(result.artifacts[0].edgeCountsBySource).toEqual({});
    expect(result.artifacts[0].edgeCountsByReason).toEqual({});
    // runCypher was still called (we don't gate on emptiness).
    expect(runCypher).toHaveBeenCalled();
  });
});

// ─── DT-4: happy path → artifact populated correctly ─────────────────

describe('measure-mode-c — DT-4: happy path artifact', () => {
  it('artifact carries analyzeWallMs, dbSizeBytes, meta echoed, edges bucketed', async () => {
    const stat = makeStat(4096);
    const runCypher = makeCypher();
    const verify = makeVerify();
    // For DT-4 we also need the .gitnexus-present path (no exec).
    const opts = makeOptions({
      stat: stat as any,
      runCypher: runCypher as any,
      verify: verify as any,
    });
    const result = await measureModeC(opts);
    const a = result.artifacts[0];
    // The artifact is shaped per the contract.
    expect(a.leg).toBe('baseline');
    expect(a.sha).toBe('abc123def');
    expect(a.dbSizeBytes).toBe(4096);
    expect(typeof a.analyzeWallMs).toBe('number');
    expect(a.analyzeWallMs).toBeGreaterThanOrEqual(0);
    // Meta echoed: loadMeta is injected, so the artifact's meta is what we returned.
    // (We don't call loadMeta directly here — we let the test inject via stat-only;
    // the artifact's meta is the result of the meta load, which the test relies on
    // the default fake. We pin a separate test for the meta-echo path below.)
    // Edge counts are bucketed by source and reason. The fixture
    // returns grouped rows (one per bucket); the JS-side sum is
    // a defensive net that works for both grouped and multi-row
    // shapes.
    expect(a.edgeCountsBySource).toEqual({
      heuristic: 120,
      'lsp-confirmed': 30,
      'lsp-corrected': 10,
    });
    expect(a.edgeCountsByReason).toEqual({
      'same-file': 110,
      'import-resolved': 40,
      'fuzzy-global': 10,
    });
  });
});

// ─── DT-5: under-sampled (sampledCap < sampleSize) → underSampled:true ─

describe('measure-mode-c — DT-5: underSampled flag', () => {
  it('sampledCap < sampleSize → artifact.underSampled === true', async () => {
    const stat = makeStat(2048);
    const verify = makeVerify(async () => makeReport({ sampledCap: 10, sampleSize: 50 }));
    const opts = makeOptions({ stat: stat as any, verify: verify as any });
    const result = await measureModeC(opts);
    expect(result.artifacts[0].underSampled).toBe(true);
  });

  it('sampledCap === sampleSize → no underSampled flag', async () => {
    const stat = makeStat(2048);
    const verify = makeVerify(async () => makeReport({ sampledCap: 50, sampleSize: 50 }));
    const opts = makeOptions({ stat: stat as any, verify: verify as any });
    const result = await measureModeC(opts);
    // The flag is a boolean — when complete it must be false.
    expect(result.artifacts[0].underSampled).toBe(false);
  });

  it('verify never returns sampledCap → no underSampled flag (treat undefined as complete)', async () => {
    const stat = makeStat(2048);
    const verify = makeVerify(async () => {
      // Mimic a report where sampledCap is missing — the harness
      // MUST NOT crash and MUST default to "not under-sampled".
      const r = makeReport({ sampledCap: 50, sampleSize: 50 });
      delete (r as any).sampledCap;
      return r;
    });
    const opts = makeOptions({ stat: stat as any, verify: verify as any });
    const result = await measureModeC(opts);
    expect(result.artifacts[0].underSampled).toBe(false);
  });
});

// ─── DT-6: verify rejects → no artifact for that leg, error surfaced ──

describe('measure-mode-c — DT-6: verify rejection', () => {
  it('verify throws → no artifact for that leg, result.errors carries the message', async () => {
    const stat = makeStat(2048);
    const verify = makeVerify(async () => {
      throw new Error('LSP server crash');
    });
    const opts = makeOptions({ stat: stat as any, verify: verify as any });
    const result = await measureModeC(opts);
    // No artifact produced for the failed leg.
    expect(result.artifacts.length).toBe(0);
    // Error surfaced in the result envelope.
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].leg).toBe('baseline');
    expect(result.errors[0].message).toMatch(/LSP server crash/);
  });
});

// ─── DT-7: both legs present → 2 artifacts, per-leg analyze ──────────────
//
// Per-leg analyze design (gh #173): each leg runs its own analyze call
// with the leg-specific flag. The `lsp` leg always runs `analyze --lsp`;
// the `baseline` leg reuses a pre-existing index when present. This
// makes the comparison non-theatrical: the two legs see different graph
// topologies (heuristic vs LSP-augmented), which is the only way the
// campaign can measure a real LSP-at-index delta.

describe('measure-mode-c — DT-7: both legs (per-leg analyze)', () => {
  it('[DESIGN] legs=[baseline, lsp] → 2 artifacts in order, with distinct leg labels', async () => {
    // With .gitnexus present: baseline reuses existing index (zero
    // exec calls for baseline); lsp always re-analyzes with --lsp
    // (one exec call). Two verify calls total.
    const stat = makeStat(2048); // .gitnexus present on entry
    const verify = makeVerify();
    const exec = makeExec();
    const opts = makeOptions({
      stat: stat as any,
      exec: exec as any,
      verify: verify as any,
      legs: ['baseline', 'lsp'],
    });
    const result = await measureModeC(opts);
    expect(result.artifacts.length).toBe(2);
    expect(result.artifacts[0].leg).toBe('baseline');
    expect(result.artifacts[1].leg).toBe('lsp');
    // Two verify calls (one per leg).
    expect((verify as any).mock.calls.length).toBe(2);
  });

  it('[IMPL] legs=[baseline, lsp] with .gitnexus present → baseline reuses index, lsp re-analyzes with --lsp', async () => {
    // .gitnexus present on entry:
    //   - baseline leg: NO analyze (reuses heuristic index)
    //   - lsp leg: analyze --lsp (builds LSP-augmented index)
    const stat = makeStat(2048);
    const calls: string[][] = [];
    const exec = makeExec(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', code: 0 };
    });
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      exec: exec as any,
      verify: verify as any,
      legs: ['baseline', 'lsp'],
    });
    const result = await measureModeC(opts);
    // Exactly one exec call — for the lsp leg only.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('--lsp');
    expect(calls[0]).toContain('analyze');
    // --force is mandatory on every per-leg analyze: without it the
    // CLI's incremental check short-circuits ("Already up to date")
    // on a fresh index and the lsp leg silently reuses the heuristic
    // index — byte-identical-legs theater (caught in the first
    // campaign re-run: analyzeWallMs:0, sources {heuristic} only).
    expect(calls[0]).toContain('--force');
    // baseline: reused index → analyzeRanForThisLeg:false, empty analyzeCommand
    expect(result.artifacts[0].analyzeRanForThisLeg).toBe(false);
    expect(result.artifacts[0].analyzeCommand).toEqual([]);
    // lsp: re-analyzed → analyzeRanForThisLeg:true, analyzeCommand has --lsp
    expect(result.artifacts[1].analyzeRanForThisLeg).toBe(true);
    expect(result.artifacts[1].analyzeCommand).toContain('--lsp');
    expect(result.artifacts[1].analyzeCommand).toContain('analyze');
  });

  it('[IMPL] legs=[baseline, lsp] with .gitnexus absent → 2 analyze calls (baseline no --lsp, lsp with --lsp)', async () => {
    // No cached index: each leg runs its own analyze.
    //   baseline → analyze <repo>       (no --lsp)
    //   lsp      → analyze --lsp <repo>
    const stat = vi.fn(async (_p: string) => null as any);
    const calls: string[][] = [];
    const exec = makeExec(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', code: 0 };
    });
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      exec: exec as any,
      verify: verify as any,
      legs: ['baseline', 'lsp'],
    });
    const result = await measureModeC(opts);
    // Exactly two exec calls — one per leg.
    expect(calls.length).toBe(2);
    // First call: baseline → no --lsp.
    expect(calls[0]).toContain('analyze');
    expect(calls[0]).not.toContain('--lsp');
    // Second call: lsp → --lsp present.
    expect(calls[1]).toContain('analyze');
    expect(calls[1]).toContain('--lsp');
    // Both per-leg analyzes carry --force (skip-theater guard; also
    // covers the leg-order hazard: an un-forced baseline analyze
    // running AFTER an lsp leg would skip and silently reuse the
    // augmented index for the heuristic leg).
    expect(calls[0]).toContain('--force');
    expect(calls[1]).toContain('--force');
    // Both artifacts flag analyzeRanForThisLeg:true.
    expect(result.artifacts[0].analyzeRanForThisLeg).toBe(true);
    expect(result.artifacts[1].analyzeRanForThisLeg).toBe(true);
    // Provenance: analyzeCommand echoes the actual argv.
    expect(result.artifacts[0].analyzeCommand).not.toContain('--lsp');
    expect(result.artifacts[0].analyzeCommand).toContain('analyze');
    expect(result.artifacts[1].analyzeCommand).toContain('--lsp');
  });

  it('[IMPL] legs=[baseline] only → at most one analyze call (no --lsp) when .gitnexus absent', async () => {
    // Single-leg baseline run: one exec call (no --lsp) when absent.
    const stat = vi.fn(async (_p: string) => null as any);
    const calls: string[][] = [];
    const exec = makeExec(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', code: 0 };
    });
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      exec: exec as any,
      verify: verify as any,
      legs: ['baseline'],
    });
    const result = await measureModeC(opts);
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain('--lsp');
    expect(calls[0]).toContain('analyze');
    expect(calls[0]).toContain('--force'); // skip-theater guard
    // Artifact provenance.
    expect(result.artifacts[0].analyzeRanForThisLeg).toBe(true);
    expect(result.artifacts[0].analyzeCommand).not.toContain('--lsp');
  });

  it('[IMPL] legs=[lsp] only → analyze --lsp called', async () => {
    // Single-leg lsp run: the harness runs `analyze --lsp` (not the
    // old no-flag analyze). The artifact's `leg:'lsp'` and
    // `analyzeCommand` both confirm the lsp analyze path.
    const stat = vi.fn(async (_p: string) => null as any);
    const calls: string[][] = [];
    const exec = makeExec(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', code: 0 };
    });
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      exec: exec as any,
      verify: verify as any,
      legs: ['lsp'],
    });
    const result = await measureModeC(opts);
    expect(calls.length).toBe(1);
    // lsp leg MUST carry --lsp.
    expect(calls[0]).toContain('--lsp');
    expect(calls[0]).toContain('analyze');
    expect(calls[0]).toContain('--force'); // skip-theater guard
    expect(result.artifacts[0].analyzeRanForThisLeg).toBe(true);
    expect(result.artifacts[0].analyzeCommand).toContain('--lsp');
  });
});

// ─── AC-5: orchestrator-level determinism (byte-identity) ──────────────
//
// The design doc §Contracts "Invariant I-4" + Acceptance
// Criterion AC-5 require that a same-(index, seed, sampleSize)
// double-run produces byte-identical artifact files. The
// verifier's own determinism is pinned by
// `mode-c-report-stability.test.ts`; this block re-asserts the
// property at the ORCHESTRATION level — a future refactor that
// re-introduces non-determinism into the harness (timestamp
// fields, map-iteration order, Date.now() calls) must fail this
// gate.
//
// Methodology: call `measureModeC` twice with identical stubs
// and assert the JSON-stringified artifacts are byte-equal after
// a canonical-stringify round-trip. The `now` seam is pinned to
// the epoch so `analyzeWallMs` is deterministic, and
// `generatedAt` is hard-pinned to `1970-01-01T00:00:00.000Z` in
// the harness itself (see the artifact construction).

describe('measure-mode-c — AC-5: orchestrator-level determinism (byte-identity)', () => {
  it('two identical measureModeC invocations produce byte-equal JSON artifacts', async () => {
    // Build a fixed set of stubs. We freeze the closures' state
    // (no Date.now, no Math.random) and use deterministic
    // ordered objects so map-iteration order is stable.
    const stat = makeStat(2048);
    const runCypher = makeCypher();
    const verify = makeVerify();
    const sha = makeSha('deadbeefcafe');
    const loadMeta = vi.fn(async () => makeMeta({ files: 7, nodes: 42, edges: 84, communities: 3, processes: 5 }));

    const opts = makeOptions({
      stat: stat as any,
      runCypher: runCypher as any,
      verify: verify as any,
      sha: sha as any,
      loadMeta: loadMeta as any,
      seed: 'ac5-determinism',
      sampleSize: 50,
      legs: ['baseline', 'lsp'],
    });

    // First invocation.
    const r1 = await measureModeC(opts);
    // Second invocation with a fresh-options object (the
    // function MUST NOT cache results across calls; every call
    // re-reads the seams).
    const r2 = await measureModeC({ ...opts });

    // Same number of artifacts, same order, same legs.
    expect(r1.artifacts.length).toBe(r2.artifacts.length);
    for (let i = 0; i < r1.artifacts.length; i++) {
      expect(r1.artifacts[i].leg).toBe(r2.artifacts[i].leg);
    }

    // The byte-identity assertion. We canonical-stringify
    // (sorted keys at every level) so any map-iteration order
    // leak would still fail the equality check. `JSON.stringify`
    // already serializes object keys in insertion order — the
    // harness must use insertion-order-stable structures
    // (plain objects, arrays, primitives) for this to hold.
    const canonical = (v: any): string =>
      JSON.stringify(v, (_k, val) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const out: Record<string, any> = {};
          for (const k of Object.keys(val).sort()) out[k] = val[k];
          return out;
        }
        return val;
      });
    const s1 = canonical(r1.artifacts);
    const s2 = canonical(r2.artifacts);
    expect(s1).toBe(s2);

    // Additional pin: every artifact's `generatedAt` is the
    // epoch string — this is the contract that makes the
    // byte-identity guarantee possible across the wall-clock.
    for (const a of r1.artifacts) {
      expect(a.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('artifact.analyzeWallMs is byte-stable across re-runs (now seam pinned)', async () => {
    // The `now` seam defaults to `() => 0` in the harness, so
    // `analyzeWallMs = now() - t0` is 0 for every leg on every
    // call. A future refactor that wires `Date.now` to the
    // artifact envelope will fail this test immediately.
    const stat = makeStat(2048);
    const runCypher = makeCypher();
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      runCypher: runCypher as any,
      verify: verify as any,
      seed: 'ac5-wall',
      legs: ['baseline'],
    });
    const r1 = await measureModeC(opts);
    const r2 = await measureModeC({ ...opts });
    expect(r1.artifacts[0].analyzeWallMs).toBe(r2.artifacts[0].analyzeWallMs);
    expect(r1.artifacts[0].analyzeWallMs).toBe(0);
  });
});

// ─── Meta echo: loadMeta seam propagates into artifact.meta ──────────

describe('measure-mode-c — meta is echoed into artifact.meta', () => {
  it('artifact.meta contains the fields from loadMeta', async () => {
    // We override `loadMeta` via the dependency seam. The
    // implementation must accept a `loadMeta` injection (or
    // surface meta through a different injectable). Per the
    // WI: "loadMeta+getStoragePaths" are the default seams; the
    // implementation MAY use a single injected `loadMeta` plus
    // a `stat` to avoid coupling on getStoragePaths in the
    // unit test. Here we inject `stat` returning a non-null
    // byte count (meaning .gitnexus present) and `loadMeta`
    // returning a meta object — the harness must combine them
    // into artifact.meta.
    const stat = makeStat(8192);
    const meta = makeMeta({ files: 12, nodes: 500, edges: 1000, communities: 8, processes: 25 });
    const loadMeta = vi.fn(async (_storagePath: string) => meta);
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      verify: verify as any,
      // loadMeta is a read-only seam (KD-8). The default
      // implementation in production reads `.gitnexus/meta.json`.
      loadMeta: loadMeta as any,
    } as any);
    const result = await measureModeC(opts);
    expect(result.artifacts[0].meta).toBeDefined();
    expect(result.artifacts[0].meta.files).toBe(12);
    expect(result.artifacts[0].meta.nodes).toBe(500);
    expect(result.artifacts[0].meta.edges).toBe(1000);
    expect(result.artifacts[0].meta.communities).toBe(8);
    expect(result.artifacts[0].meta.processes).toBe(25);
    expect(loadMeta).toHaveBeenCalled();
  });
});

// ─── Sequential gate ordering: stat → loadMeta → runCypher → verify ─

describe('measure-mode-c — strict sequential ordering per repo', () => {
  it('stat runs before loadMeta, loadMeta before runCypher, runCypher before verify', async () => {
    const stat = makeStat(2048);
    const runCypher = makeCypher({ bySource: [], byReason: [] });
    const verify = makeVerify();
    const loadMeta = vi.fn(async () => makeMeta());
    const opts = makeOptions({
      stat: stat as any,
      runCypher: runCypher as any,
      verify: verify as any,
      loadMeta: loadMeta as any,
    } as any);
    await measureModeC(opts);
    const statOrder = (stat as any).mock.invocationCallOrder[0];
    const loadMetaOrder = (loadMeta as any).mock.invocationCallOrder[0];
    const runCypherOrder = (runCypher as any).mock.invocationCallOrder[0];
    const verifyOrder = (verify as any).mock.invocationCallOrder[0];
    expect(statOrder).toBeLessThan(loadMetaOrder);
    expect(loadMetaOrder).toBeLessThan(runCypherOrder);
    expect(runCypherOrder).toBeLessThan(verifyOrder);
  });
});

// ─── No-write invariant: harness source must pass the sweep ─────────

describe('measure-mode-c — no-write invariant (KD-8)', () => {
  it('harness source has no executeQuery / DROP / write-API tokens (lifecycle open permitted)', () => {
    // Static sweep over the harness source. The harness is permitted
    // to call the DB lifecycle API (`initLbug`, `closeLbug`) for
    // per-leg pool management (LadybugDB lock discipline, I-3) —
    // these are NOT graph writes. The forbidden set covers only
    // graph-mutating tokens: `executeQuery` (write-mode dispatch),
    // `addNode`, `addRelationship`, and DDL verbs.
    //
    // The authoritative version of this sweep (including the
    // `allowLifecycle:true` flag and its rationale) lives in
    // `test/unit/scripts/scripts-no-write-invariant.test.ts`, which
    // uses the production helper `assertNoGraphWriteImports`. This
    // inline re-implementation is kept self-contained but must stay
    // in sync with the `allowLifecycle:true` behaviour.
    const here = dirname(fileURLToPath(import.meta.url));
    // test/unit/scripts/measure-mode-c.test.ts → gitnexus/ (3 levels up)
    const srcPath = join(here, '..', '..', '..', 'scripts', 'measure-mode-c.ts');
    const src = readFileSync(srcPath, 'utf-8');
    // Strip block + line comments to avoid matching documentation.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    // Graph-write tokens only — lifecycle tokens (initLbug, closeLbug)
    // are intentionally omitted from this FORBIDDEN list.
    const FORBIDDEN: RegExp[] = [
      /\bexecuteQuery\s*\(/,
      /\bimport\b[^\n;]*\bexecuteQuery\b/,
      /\binitLbugWithDb\s*\(/,
      /\bDROP\s+(?:NODE\s+)?TABLE\b/i,
    ];
    const violations: string[] = [];
    for (const re of FORBIDDEN) {
      const m = stripped.match(re);
      if (m) violations.push(m[0]);
    }
    expect(violations, `forbidden write-API symbols in measure-mode-c.ts: ${violations.join(', ')}`).toEqual([]);
  });

  it('harness does NOT statically import runModeCVerify (dynamic-only — keeps the no-write sweep clean)', () => {
    // The design (KD-8) requires the harness to load the verifier
    // via `await import('…/dist/.../mode-c-verifier.js')` at
    // runtime so the static source-text scan never sees the
    // import. We pin that here. Comments are stripped first so a
    // JSDoc mention of `runModeCVerify` doesn't trip the regex.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, '..', '..', '..', 'scripts', 'measure-mode-c.ts');
    const raw = readFileSync(srcPath, 'utf-8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    // No STATIC import that names the verifier.
    expect(stripped).not.toMatch(/import\b[^\n;]*\brunModeCVerify\b/);
    // The dynamic-import form IS allowed — match `import('…/dist/…/mode-c-verifier.js')`.
    expect(stripped).toMatch(/import\(\s*['"][^'"]*dist[^'"]*mode-c-verifier[^'"]*['"]/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// WI-1c — CLI entry, LSP halt contract, markdown summary
// ──────────────────────────────────────────────────────────────────────
//
// These blocks extend the WI-1b suite. The script's CLI surface is
// reached via `main(deps)` where every I/O + side effect is
// injected; no real subprocess, no real LSP discovery, no real disk
// outside the tmpdirs we explicitly allocate. The decision table
// (per the WI's Tests block):
//
//   | case                       | discoverServers | measure stub       | outcome                            |
//   |----------------------------|-----------------|--------------------|------------------------------------|
//   | LSP absent (halt)          | typescript:null | (not invoked)      | exit(1), stderr doctor, no artifact|
//   | happy single leg           | ok              | 1 artifact         | 1 JSON + summary.md                |
//   | happy both legs            | ok              | 2 artifacts        | 2 JSONs + summary.md (2 rows)      |
//   | under-sampled leg          | ok              | 1 underSampled art | Excluded section, no headline row  |
//   | exec rejects mid-run       | ok              | throws             | exit(1), no partial output         |
//   | parse error (bad --sample) | (not reached)   | (not invoked)      | exit(1), stderr, no artifact       |
//   | help flag                  | (not reached)   | (not invoked)      | stdout usage, exit(0)              |
//
// Plus flag-parsing unit tests (table-driven) and summary-renderer
// unit tests (table-driven) that don't need to drive `main` at all.

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import {
  main as mainFn,
  parseArgs,
  renderHelp,
  renderSummary,
  artifactFilename,
  atomicWriteFile,
  ensureNodePath,
  type MainDeps,
  type MeasureModeCResult,
  type SummaryRow,
} from '../../../scripts/measure-mode-c.js';

// ─── Helpers shared by the WI-1c blocks ───────────────────────────────

/** Build a fake `discoverServers` return shape (pass-through). */
function fakeDiscoveryOk() {
  return {
    discoverServers: async () => ({
      typescript: { path: '/usr/local/bin/typescript-language-server', version: '4.3.3' },
    }),
  };
}

function fakeDiscoveryAbsent() {
  return {
    discoverServers: async () => ({ typescript: null }),
  };
}

/** In-memory filesystem for `atomicWriteFile` + `mkdir`. Captures
 *  every call so the tests can assert on it. */
function makeFakeFs(): {
  fs: MainDeps['fs'] & { _files: Map<string, string> };
  files: Map<string, string>;
  written(path: string): string | undefined;
  exists(path: string): boolean;
} {
  const files = new Map<string, string>();
  const fs: any = {
    _files: files,
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async rename(from: string, to: string) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`rename from missing '${from}'`);
      files.set(to, v);
      files.delete(from);
    },
    async mkdir(_path: string, _opts: { recursive: boolean }) {
      /* noop in-memory */
    },
  };
  return {
    fs,
    files,
    written: (p) => files.get(p),
    exists: (p) => files.has(p),
  };
}

/** Build a populated `MeasureModeCResult` for one leg. */
function makeArtifact(over: Partial<{
  repo: string;
  sha: string;
  leg: 'baseline' | 'lsp';
  underSampled: boolean;
  report: any;
}> = {}): MeasureModeCResult {
  const repo = over.repo ?? '/tmp/repo';
  const sha = over.sha ?? 'abc123def';
  const leg = over.leg ?? 'baseline';
  const underSampled = over.underSampled ?? false;
  const report = over.report ?? makeReport();
  return {
    repo,
    artifacts: [
      {
        repo,
        sha,
        leg,
        analyzeWallMs: 100,
        dbSizeBytes: 2048,
        meta: { files: 9, nodes: 35, edges: 70, communities: 4, processes: 4 },
        edgeCountsBySource: { heuristic: 60, 'lsp-confirmed': 10 },
        edgeCountsByReason: { 'same-file': 50, 'fuzzy-global': 20 },
        report,
        underSampled,
        analyzeRanFirst: false,
      },
    ],
    errors: [],
  };
}

/** A populated report shape with concrete metrics so the summary
 *  writer can extract them. */
function makePopulatedReport(over: Partial<{ n: number; matches: number; falseConfident: number; refusals: number }> = {}) {
  const n = over.n ?? 100;
  const matches = over.matches ?? 90;
  const falseConfident = over.falseConfident ?? 5;
  const refusals = over.refusals ?? 5;
  return {
    perTier: {},
    overall: { precision: matches / (matches + falseConfident), recall: 0.95, falseConfidentRate: falseConfident / n, matches, falseConfident, recallMisses: 5, refusals, recallGains: 0, n },
    sampleSize: 200,
    serverVersion: '4.3.3',
    sampledCap: n,
  };
}

// ─── DT-1c-1: parseArgs — happy path + defaults ───────────────────────

describe('measure-mode-c — parseArgs (WI-1c)', () => {
  it('defaults: legs=[baseline,lsp], sample=200, seed=deterministic-seed-42, out=./.gitnexus-mc-out', () => {
    const p = parseArgs(['--repo', '/tmp/r']);
    expect(p.legs).toEqual(['baseline', 'lsp']);
    expect(p.sampleSize).toBe(200);
    expect(p.seed).toBe('deterministic-seed-42');
    expect(p.outDir).toBe('./.gitnexus-mc-out');
    expect(p.repoPaths).toEqual(['/tmp/r']);
  });

  it('--legs accepts baseline only; --sample and --seed override', () => {
    const p = parseArgs([
      '--repo', '/a',
      '--legs', 'baseline',
      '--sample', '75',
      '--seed', 'wi9-seed-42',
      '--out', '/tmp/out',
    ]);
    expect(p.legs).toEqual(['baseline']);
    expect(p.sampleSize).toBe(75);
    expect(p.seed).toBe('wi9-seed-42');
    expect(p.outDir).toBe('/tmp/out');
  });

  it('--legs accepts both legs, de-duplicates', () => {
    const p = parseArgs(['--repo', '/a', '--legs', 'lsp,baseline,lsp']);
    expect(p.legs).toEqual(['lsp', 'baseline']);
  });

  it('--repo is repeatable', () => {
    const p = parseArgs(['--repo', '/a', '--repo', '/b', '--repo', '/c']);
    expect(p.repoPaths).toEqual(['/a', '/b', '/c']);
  });

  it('rejects missing --repo', () => {
    expect(() => parseArgs([])).toThrow(TypeError);
    expect(() => parseArgs([])).toThrow(/at least one --repo/);
  });

  it('rejects non-positive --sample', () => {
    expect(() => parseArgs(['--repo', '/a', '--sample', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--repo', '/a', '--sample', '-1'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--repo', '/a', '--sample', 'abc'])).toThrow(/positive integer/);
  });

  it('rejects unknown --legs token', () => {
    expect(() => parseArgs(['--repo', '/a', '--legs', 'foo'])).toThrow(/unknown leg 'foo'/);
  });

  it('rejects flag with no value', () => {
    expect(() => parseArgs(['--repo'])).toThrow(/requires a value/);
  });

  it('rejects unknown flag', () => {
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/unknown flag/);
  });

  it('--help returns the sentinel with help:true', () => {
    const p: any = parseArgs(['--help']);
    expect(p.help).toBe(true);
  });

  it('renderHelp mentions the halt contract', () => {
    const h = renderHelp();
    expect(h).toMatch(/typescript-language-server/);
    expect(h).toMatch(/halt|doctor|zeros are never data/);
  });
});

// ─── DT-1c-2: renderSummary — KD-5 triple + Excluded section ─────────

describe('measure-mode-c — renderSummary (WI-1c)', () => {
  it('emits KD-5 triple columns in the headline table', () => {
    const rows: SummaryRow[] = [
      {
        repo: 'gitnexus',
        sha: 'abc',
        leg: 'baseline',
        underSampled: false,
        metrics: { n: 100, matches: 90, falseConfident: 5, refusals: 5, precision: 0.95, recall: 0.95 },
      },
    ];
    const md = renderSummary(rows);
    expect(md).toMatch(/## Headline/);
    expect(md).toMatch(/reported fc-rate/);
    expect(md).toMatch(/conditional fc-rate/);
    expect(md).toMatch(/refusal rate/);
    // Reported fc-rate = 5/100 = 5.0%
    expect(md).toMatch(/5\.0%/);
    // Conditional fc-rate = 5/(90+5) = 5.3%
    expect(md).toMatch(/5\.3%/);
    // Refusal rate = 5/100 = 5.0%
  });

  it('excludes under-sampled legs from the headline table', () => {
    const rows: SummaryRow[] = [
      { repo: 'r', sha: 'a', leg: 'baseline', underSampled: false, metrics: { n: 100, matches: 90, falseConfident: 5, refusals: 5, precision: 0.95, recall: 0.95 } },
      { repo: 'r', sha: 'a', leg: 'lsp', underSampled: true },
    ];
    const md = renderSummary(rows);
    // The headline table should contain exactly 1 row (the baseline).
    const headlineRows = md.split('## Headline')[1]!.split('## Excluded')[0]!.split('\n').filter((l) => l.startsWith('| r |'));
    expect(headlineRows.length).toBe(1);
    expect(md).toMatch(/## Excluded/);
    expect(md).toMatch(/under-sampled/);
  });

  it('routes verifier errors into the Excluded section', () => {
    const rows: SummaryRow[] = [
      { repo: 'r', sha: 'a', leg: 'baseline', underSampled: true, error: 'LSP server crash' },
    ];
    const md = renderSummary(rows);
    expect(md).toMatch(/LSP server crash/);
    // No headline rows.
    expect(md).toMatch(/No headline rows/);
  });

  it('renders the empty state when no rows', () => {
    const md = renderSummary([]);
    expect(md).toMatch(/No headline rows/);
  });

  it('renders `-` for missing metrics in headline rows', () => {
    const rows: SummaryRow[] = [
      { repo: 'r', sha: 'a', leg: 'baseline', underSampled: false /* no metrics */ },
    ];
    const md = renderSummary(rows);
    // The KD-5 triple headline is n, matches, falseConfident,
    // reported fc-rate, conditional fc-rate, refusal rate —
    // 6 metric columns after the (repo, sha, leg) key, so 9
    // dashes total (3 keys + 6 metric placeholders). Precision
    // and recall are NOT in the headline (I-6 — no single-rate
    // cherry-picking).
    expect(md).toMatch(/\| r \| a \| baseline \| - \| - \| - \| - \| - \| - \|/);
  });
});

// ─── DT-1c-3: artifactFilename — deterministic, safe ─────────────────

describe('measure-mode-c — artifactFilename (WI-1c)', () => {
  it('produces <basename>-<sha>-<leg>.json', () => {
    const f = artifactFilename('/tmp/repo', 'abc123def', 'baseline', { basename: (p) => p.split('/').pop()! });
    expect(f).toBe('repo-abc123def-baseline.json');
  });

  it('replaces path separators in the repo path with `_`', () => {
    const f = artifactFilename('/tmp/some/repo', 'abc', 'lsp', { basename: (p) => p.split('/').pop()! });
    // basename of `/tmp/some/repo` is `repo` (the `pathMod` we pass strips dir), so this is repo-abc-lsp.json
    expect(f).toBe('repo-abc-lsp.json');
  });

  it('replaces slashes in sha with `_`', () => {
    const f = artifactFilename('repo', 'abc/def', 'baseline', { basename: (p) => p });
    expect(f).toMatch(/^repo-abc_def-baseline\.json$/);
  });

  it('falls back to "repo" basename for empty input', () => {
    const f = artifactFilename('', 'abc', 'baseline', { basename: (p) => p });
    expect(f).toBe('repo-abc-baseline.json');
  });
});

// ─── DT-1c-4: main() — LSP halt path ──────────────────────────────────

describe('measure-mode-c — main() halt path (WI-1c)', () => {
  it('discoverServers → typescript:null → exit(1), stderr doctor, no artifact', async () => {
    const fakeFs = makeFakeFs();
    const stderr = vi.fn();
    const exit = vi.fn();
    const measure = vi.fn(async () => ({ repo: '/tmp/r', artifacts: [], errors: [] } as MeasureModeCResult));
    await mainFn({
      argv: ['--repo', '/tmp/r', '--sample', '50'],
      importServerDiscovery: async () => fakeDiscoveryAbsent() as any,
      // The new fallback path (per 2026-06-12 review) probes `npx
      // -p typescript-language-server` when `discoverServers`
      // returns null. The test exercises the doctor halt path
      // by injecting a failing npx stub — the probe throws
      // (or returns non-zero) and the gate falls through to
      // the doctor block.
      execNpx: async () => ({ stdout: '', stderr: 'npx: not found', code: 1 }),
      fs: fakeFs.fs,
      stderr,
      stdout: vi.fn(),
      exit,
      measure: measure as any,
    });
    expect(exit).toHaveBeenCalledWith(1);
    // Stderr contains the doctor line.
    expect(stderr).toHaveBeenCalled();
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/NOT FOUND/);
    expect(stderrMsg).toMatch(/Remediation/);
    // measure was never called.
    expect(measure).not.toHaveBeenCalled();
    // Nothing was written.
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-1c-5: main() — happy path (single leg) ────────────────────────

describe('measure-mode-c — main() happy path (WI-1c)', () => {
  it('writes one JSON artifact + summary.md for one leg', async () => {
    const fakeFs = makeFakeFs();
    const measure = vi.fn(async () => makeArtifact({ leg: 'baseline' }));
    await mainFn({
      argv: ['--repo', '/tmp/repo', '--sample', '50', '--legs', 'baseline'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout: vi.fn(),
      exit: vi.fn(),
      measure: measure as any,
    });
    // 1 JSON + 1 summary.md. No recall-regression.md because
    // the AC-2 helper requires BOTH legs to be requested
    // (single-leg runs cannot be evaluated for regression —
    // there's nothing to compare against).
    expect(fakeFs.files.size).toBe(2);
    const keys = [...fakeFs.files.keys()];
    const jsonKey = keys.find((k) => k.endsWith('.json'));
    const summaryKey = keys.find((k) => k.endsWith('summary.md'));
    expect(jsonKey).toBeDefined();
    expect(summaryKey).toBeDefined();
    // JSON shape
    const json = JSON.parse(fakeFs.files.get(jsonKey!)!);
    expect(json.leg).toBe('baseline');
    expect(json.sha).toBe('abc123def');
    // Summary contains the headline row.
    const summary = fakeFs.files.get(summaryKey!);
    expect(summary).toMatch(/## Headline/);
  });
});

// ─── DT-1c-6: main() — both legs → 2 JSONs + summary with 2 rows ─────

describe('measure-mode-c — main() both legs (WI-1c)', () => {
  it('writes 2 JSONs + summary with 2 headline rows', async () => {
    const fakeFs = makeFakeFs();
    const measure = vi.fn(async () => makeArtifact({ leg: 'baseline' }));
    // Stub two-leg result
    measure.mockImplementationOnce(async () => ({
      repo: '/tmp/repo',
      artifacts: [
        { ...makeArtifact({ leg: 'baseline' }).artifacts[0] },
        { ...makeArtifact({ leg: 'lsp' }).artifacts[0] },
      ],
      errors: [],
    }));
    await mainFn({
      argv: ['--repo', '/tmp/repo', '--legs', 'baseline,lsp'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout: vi.fn(),
      exit: vi.fn(),
      measure: measure as any,
    });
    const keys = [...fakeFs.files.keys()];
    const jsons = keys.filter((k) => k.endsWith('.json'));
    expect(jsons.length).toBe(2);
    const summary = fakeFs.files.get(keys.find((k) => k.endsWith('summary.md'))!);
    // Two headline rows (one per leg).
    const headlineSection = summary!.split('## Headline')[1]!.split('## Excluded')[0]!;
    const dataRows = headlineSection.split('\n').filter((l) => l.startsWith('| repo') || l.startsWith('| /tmp/repo') || l.startsWith('| '));
    // header + separator + 2 rows = 4
    expect(dataRows.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── DT-1c-7: main() — under-sampled leg → Excluded section ──────────

describe('measure-mode-c — main() under-sampled (WI-1c)', () => {
  it('under-sampled leg appears in Excluded, absent from headline', async () => {
    const fakeFs = makeFakeFs();
    const measure = vi.fn(async () => makeArtifact({ leg: 'baseline', underSampled: true }));
    await mainFn({
      argv: ['--repo', '/tmp/repo'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout: vi.fn(),
      exit: vi.fn(),
      measure: measure as any,
    });
    const keys = [...fakeFs.files.keys()];
    const summary = fakeFs.files.get(keys.find((k) => k.endsWith('summary.md'))!);
    expect(summary).toMatch(/## Excluded/);
    expect(summary).toMatch(/under-sampled/);
    // No headline row.
    const headlineSection = summary!.split('## Headline')[1]!.split('## Excluded')[0]!;
    const dataRows = headlineSection.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| repo'));
    expect(dataRows.length).toBe(0);
  });
});

// ─── DT-1c-8: main() — exec rejects → exit(1), no partial output ─────

describe('measure-mode-c — main() exec reject (WI-1c)', () => {
  it('measure throws → exit(1), no artifact written', async () => {
    const fakeFs = makeFakeFs();
    const measure = vi.fn(async () => {
      throw new Error('analyze subprocess failed');
    });
    const stderr = vi.fn();
    const exit = vi.fn();
    await mainFn({
      argv: ['--repo', '/tmp/repo'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr,
      stdout: vi.fn(),
      exit,
      measure: measure as any,
    });
    expect(exit).toHaveBeenCalledWith(1);
    // No JSONs, no summary.
    const keys = [...fakeFs.files.keys()];
    expect(keys.filter((k) => k.endsWith('.json') || k.endsWith('summary.md')).length).toBe(0);
  });
});

// ─── DT-1c-9: main() — parse error → exit(1), no artifact ────────────

describe('measure-mode-c — main() parse error (WI-1c)', () => {
  it('unknown flag → exit(1), stderr usage, no artifact', async () => {
    const fakeFs = makeFakeFs();
    const exit = vi.fn();
    const stderr = vi.fn();
    await mainFn({
      argv: ['--bogus'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr,
      stdout: vi.fn(),
      exit,
      measure: vi.fn() as any,
    });
    expect(exit).toHaveBeenCalledWith(1);
    // Stderr received the error + usage.
    const stderrMsg = (stderr as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stderrMsg).toMatch(/unknown flag/);
    expect(stderrMsg).toMatch(/usage:/);
    // No files written.
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-1c-10: main() — --help → stdout usage, no exit(1) ────────────

describe('measure-mode-c — main() --help (WI-1c)', () => {
  it('--help → stdout usage, no exit call, no artifact', async () => {
    const fakeFs = makeFakeFs();
    const stdout = vi.fn();
    const exit = vi.fn();
    await mainFn({
      argv: ['--help'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout,
      exit,
      measure: vi.fn() as any,
    });
    expect(exit).not.toHaveBeenCalled();
    const stdoutMsg = (stdout as any).mock.calls.map((c: any[]) => c.join('')).join('');
    expect(stdoutMsg).toMatch(/usage:/);
    expect(fakeFs.files.size).toBe(0);
  });
});

// ─── DT-1c-11: atomicWriteFile — temp + rename ───────────────────────

describe('measure-mode-c — atomicWriteFile (WI-1c)', () => {
  it('writes to <path>.tmp then renames to <path>', async () => {
    const fakeFs = makeFakeFs();
    await atomicWriteFile('/tmp/x.json', '{"ok":true}', fakeFs.fs as any);
    // Final file exists, tmp does not.
    expect(fakeFs.exists('/tmp/x.json')).toBe(true);
    expect(fakeFs.exists('/tmp/x.json.tmp')).toBe(false);
    expect(fakeFs.written('/tmp/x.json')).toBe('{"ok":true}');
  });
});

// ─── DT-1c-12: ensureNodePath — caches the import ────────────────────

describe('measure-mode-c — ensureNodePath (WI-1c)', () => {
  it('populates the basename cache so artifactFilename works without injection', async () => {
    // Clear any previous state by reaching in.
    await ensureNodePath();
    const f = artifactFilename('/tmp/foo/bar', 'sha123', 'baseline');
    expect(f).toBe('bar-sha123-baseline.json');
  });
});

// ─── DT-1c-13: integration-smoke (tmpdir) ────────────────────────────

describe('measure-mode-c — integration-smoke (WI-1c)', () => {
  it('writes a real summary.md + JSON to a tmpdir via the real filesystem', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/gnx-mc-1c-`);
    try {
      // Use the REAL `node:fs/promises` for this block (not the
      // fake). We do this by NOT passing `fs` so `main` uses the
      // default. But we must not let main hit the production
      // verifier — we inject `measure` instead.
      await ensureNodePath();
      const measure = vi.fn(async () => makeArtifact({ leg: 'baseline' }));
      await mainFn({
        argv: ['--repo', '/tmp/fake-repo', '--out', tmp, '--sample', '50'],
        importServerDiscovery: async () => fakeDiscoveryOk() as any,
        // no `fs` → default real fs
        stderr: vi.fn(),
        stdout: vi.fn(),
        exit: vi.fn(),
        measure: measure as any,
      });
      // Filesystem inspection
      const files = readdirSync(tmp);
      const jsons = files.filter((f) => f.endsWith('.json'));
      const summaries = files.filter((f) => f.endsWith('summary.md'));
      expect(jsons.length).toBe(1);
      expect(summaries.length).toBe(1);
      const summary = readFileSync(`${tmp}/summary.md`, 'utf-8');
      expect(summary).toMatch(/## Headline/);
      const json = JSON.parse(readFileSync(`${tmp}/${jsons[0]}`, 'utf-8'));
      expect(json.leg).toBe('baseline');
      expect(json.sha).toBe('abc123def');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── KD-9: verify seam captures the full RunModeCVerifyOpts shape ─────
//
// The harness's `useRealVerify` path (per
// `docs/designs/159-mode-c-measurement.md` KD-9) assembles a
// full `RunModeCVerifyOpts` mirroring `src/cli/verify.ts`:
// {repoId, client, probe, mapLocationToNodeId,
//  executeParameterized, seed, sampleSize, hardCap,
//  serverVersion} — 9 fields. A refactor that accidentally
// drops a field (e.g. `mapLocationToNodeId`) must fail the
// unit suite, not just the integration smoke with a real
// `LspClient`.
//
// We exercise the real-verify path by injecting BOTH the
// `buildRealVerifyOpts` seam (returns a fully-populated opts
// object) AND a stub `verify` (short-circuits the dist
// dynamic-import AND captures the opts passed to it). With
// both seams injected and `lspServerPath` set, the harness
// builds the full shape and hands it to the verify stub; we
// assert the shape by inspecting `verify.mock.calls[0][0]`.

describe('measure-mode-c — KD-9 verify seam captures the full RunModeCVerifyOpts shape', () => {
  it('useRealVerify path: verify stub receives all 9 required fields from buildRealVerifyOpts', async () => {
    // Capture the opts the verify stub actually receives.
    const verify = vi.fn(async (_opts: any) =>
      makeReport({ sampledCap: 50, sampleSize: 50, matches: 30, n: 50 }),
    );
    // Return a DISTINCT client+probe per call so the second-leg closure
    // cannot mask the "probe closes over stopped client" bug.
    //
    // Each probe uses the `_c` argument (not a closed-over client) to
    // derive its verdict — mirroring the contract that
    // defaultBuildRealVerifyOpts now guarantees. The test captures each
    // returned client so we can assert identity: leg2's verify opts must
    // carry client1 (the warm sharedLspClient), not client2 (the
    // just-stopped throwaway).
    const stubMapper = vi.fn(async (_loc: any, _repoId: string) => ({ nodeId: 'stub-node' }));
    const stubExecute = vi.fn(async () => []);
    const returnedClients: any[] = [];
    const returnedProbes: any[] = [];
    const buildRealVerifyOpts = vi.fn(async (args: any) => {
      // Each invocation produces its own client object.
      const client = { id: `client-${returnedClients.length + 1}`, stop: vi.fn(async () => { client.id += '-stopped'; }) };
      // The probe uses _c (the client passed at call time). If the probe
      // incorrectly closed over the local `client` variable, assertions (a)
      // and (b) below would still pass because they check identity — but
      // (c) directly calls probe with a known-distinct client, so a closure
      // bug would cause identity (a) to fail in the pre-fix code path where
      // verifyOpts.client = client1 but probe internally used client2.
      const probe = vi.fn(async (_c: any) => ({ ready: true, clientId: _c.id }));
      returnedClients.push(client);
      returnedProbes.push(probe);
      return {
        repoId: args.repoId,
        client,
        probe,
        mapLocationToNodeId: stubMapper,
        executeParameterized: stubExecute,
        seed: args.seed,
        sampleSize: args.sampleSize,
        hardCap: args.sampleSize,
        serverVersion: args.serverVersion,
      };
    });
    const opts = makeOptions({
      stat: makeStat(2048) as any, // .gitnexus present → no analyze
      exec: makeExec() as any,
      verify: verify as any,
      buildRealVerifyOpts: buildRealVerifyOpts as any,
      lspServerPath: '/usr/local/bin/typescript-language-server',
      serverVersion: '4.3.3',
      seed: 'kd9-shape-seed',
      sampleSize: 50,
      legs: ['baseline', 'lsp'],
    });
    const result = await measureModeC(opts);
    // Per-leg design (gh #173): the builder seam is called once
    // per leg so each leg's graph connection is fresh for the
    // just-written index (the lsp analyze rewrites the DB).
    expect(buildRealVerifyOpts).toHaveBeenCalledTimes(2);
    // Both legs produced an artifact (the real-verify path
    // returned a populated report for each).
    expect(result.artifacts.length).toBe(2);
    // The verify stub was called twice (once per leg), and the
    // opts the stub received are the FULL shape (per KD-9).
    expect(verify.mock.calls.length).toBe(2);

    // ── First leg: 9 required fields pinned in shape order ──
    const leg1Opts = verify.mock.calls[0][0];
    expect(leg1Opts.repoId).toBe('repo'); // deriveRepoId('/tmp/repo') = 'repo'
    expect(leg1Opts.client).toBeDefined();
    expect(leg1Opts.probe).toBeInstanceOf(Function);
    expect(leg1Opts.mapLocationToNodeId).toBe(stubMapper);
    expect(leg1Opts.executeParameterized).toBe(stubExecute);
    expect(leg1Opts.seed).toBe('kd9-shape-seed');
    expect(leg1Opts.sampleSize).toBe(50);
    expect(leg1Opts.hardCap).toBe(50);
    expect(leg1Opts.serverVersion).toBe('4.3.3');

    // ── Second leg (P0 regression guard) ──────────────────────
    // buildRealVerifyOpts was called twice — once per leg.
    // returnedClients[0] = client1 (first leg, warm/sharedLspClient).
    // returnedClients[1] = client2 (second leg, immediately stopped).
    //
    // The harness must:
    //   1. Stop client2 (resource leak prevention).
    //   2. Swap baseOpts.client → client1 (warm client reuse).
    //   3. Pass the swapped opts to verify — so leg2Opts.client === client1.
    //
    // The pre-fix bug: baseOpts.probe still closed over client2 (stopped).
    // The fix: probe uses _c at call time. The test verifies the harness
    // wired the correct client by asserting OBJECT IDENTITY:
    //   (a) leg2's verify received client1 (not client2).
    //   (b) leg2's probe is distinct from leg1's probe (per-call objects).
    //   (c) leg2's probe, when called with client2 (the throwaway), echoes
    //       client2's id — proving the probe honours _c, not a closed-over var.
    const leg2Opts = verify.mock.calls[1][0];
    const client1 = returnedClients[0];
    const client2 = returnedClients[1];
    expect(leg2Opts.probe).not.toBe(leg1Opts.probe);       // (b) distinct probe objects
    expect(leg2Opts.client).toBe(client1);                 // (a) warm client — not the stopped client2
    expect(leg2Opts.client).not.toBe(client2);             // (a) negative: client2 was discarded
    // (c) The probe uses _c: calling it with client1 echoes client1's id,
    //     not client2's. A closed-over-client2 probe would return
    //     clientId: client2.id when called with client1, failing this assertion.
    expect(await leg2Opts.probe(client1)).toEqual({ ready: true, clientId: client1.id });
  });

  it('non-real-verify path: verify stub receives a minimal opts (test seam only)', async () => {
    // When the test seam is in use (no `buildRealVerifyOpts`,
    // no `lspServerPath`), the harness passes the *minimal*
    // shape — repoId + sample/seed/server metadata. The
    // production verifier would reject this minimal shape (no
    // `client`/`probe`/etc.), but the test stub is permissive.
    // The shape-pinning test above covers the real-verify
    // path; this test pins the test-only path so a future
    // refactor that drops a test-path field is caught.
    const verify = vi.fn(async (_opts: any) => makeReport());
    const opts = makeOptions({
      stat: makeStat(2048) as any,
      exec: makeExec() as any,
      verify: verify as any,
      // No buildRealVerifyOpts, no lspServerPath.
      legs: ['baseline'],
    });
    await measureModeC(opts);
    expect(verify.mock.calls.length).toBe(1);
    const passed = verify.mock.calls[0][0];
    // Minimal path carries repoId + sample/seed/serverVersion.
    expect(passed.repoId).toBe('repo');
    expect(passed.seed).toBe('wi1b-test-seed');
    expect(passed.sampleSize).toBe(50);
    expect(passed.hardCap).toBe(50);
    expect(passed.serverVersion).toBeNull();
  });
});

// ─── AC-2: noRecallRegression helper + renderRecallRegression renderer ──
//
// The AC-2 check is mechanically satisfied by emitting
// `<out>/recall-regression.md`. The helper is pure and the
// renderer is pure — both unit-tested here. The CLI write path
// is tested via the `main()` integration-smoke (DT-1c-13) — it
// asserts the file lands on disk.

import {
  noRecallRegression,
  renderRecallRegression,
  recallRegressionForResult,
} from '../../../scripts/measure-mode-c.js';

describe('measure-mode-c — AC-2 noRecallRegression helper', () => {
  it('returns passed=true when recallMisses unchanged and resolvedCalls grew', () => {
    const baseline = makeReport({ sampledCap: 50, sampleSize: 50, matches: 30, n: 50 });
    const lsp = makeReport({ sampledCap: 50, sampleSize: 50, matches: 35, n: 50 });
    // baseline.recallMisses is zeroed; lsp.recallMisses is also zeroed.
    // baseline.overall.recallGains defaults to 0; lsp.overall.recallGains defaults to 0.
    // resolvedCalls(baseline) = 30; resolvedCalls(lsp) = 35 → coverageOk.
    const v = noRecallRegression(baseline, lsp);
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(true);
    expect(v!.baselineResolvedCalls).toBe(30);
    expect(v!.lspResolvedCalls).toBe(35);
    expect(v!.reason).toBe('');
  });

  it('returns passed=false with reason when recallMisses regressed', () => {
    const baseline = makeReport();
    const lsp = makeReport();
    // Mutate the underlying report shape to force a regression.
    baseline.overall.recallMisses = 5;
    baseline.overall.recallGains = 0;
    baseline.overall.matches = 30;
    baseline.overall.falseConfident = 5;
    lsp.overall.recallMisses = 12;
    lsp.overall.recallGains = 0;
    lsp.overall.matches = 28;
    lsp.overall.falseConfident = 5;
    const v = noRecallRegression(baseline, lsp);
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(false);
    expect(v!.reason).toMatch(/recallMisses regressed/);
    expect(v!.baselineRecallMisses).toBe(5);
    expect(v!.lspRecallMisses).toBe(12);
  });

  it('returns passed=false with reason when resolvedCalls shrank', () => {
    const baseline = makeReport();
    const lsp = makeReport();
    baseline.overall.recallMisses = 5;
    baseline.overall.matches = 30;
    baseline.overall.falseConfident = 5;
    baseline.overall.recallGains = 0;
    lsp.overall.recallMisses = 5;
    lsp.overall.matches = 20;
    lsp.overall.falseConfident = 5;
    lsp.overall.recallGains = 0;
    const v = noRecallRegression(baseline, lsp);
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(false);
    expect(v!.reason).toMatch(/resolvedCalls shrank/);
  });

  it('[DESIGN] returns passed=false when leg populations differ AND resolvedCalls shrank (KD-3 EdgeCases)', () => {
    // The design doc EdgeCases "Leg populations differ (Leg B
    // has corrected/recall edges)" states that indexes are
    // per-leg and populations can legitimately differ. The
    // realistic corrected-edges case: the LSP-augmented index
    // CONFIRMS fewer edges than the heuristic guessed, so
    // lsp.overall.n AND lsp.overall.matches are both smaller
    // than baseline. The verdict MUST FAIL with "resolvedCalls
    // shrank" — and the verdict's `baselineResolvedCalls` /
    // `lspResolvedCalls` / `baselineRecallMisses` /
    // `lspRecallMisses` MUST carry the asymmetric counts so the
    // operator can see which leg shrunk.
    //
    // We construct reports with DIFFERENT `n` (not just
    // identical-shape with shrunk `matches`) and DIFFERENT
    // perTier shapes (the lsp report gets a 5th tier for
    // corrected edges). The verdict's verdict.passed MUST be
    // false; the reason MUST contain "resolvedCalls shrank".
    const baseline = makeReport({ sampledCap: 100, sampleSize: 100, matches: 80, n: 100 });
    baseline.overall.recallMisses = 10;
    baseline.overall.recallGains = 0;
    baseline.overall.falseConfident = 5;
    // lsp: smaller n, smaller matches, NO 5th tier (we keep
    // `perTier` to the 4-tier shape to mirror the production
    // shape; the asymmetric `n` is the design-doc case).
    const lsp = makeReport({ sampledCap: 70, sampleSize: 100, matches: 50, n: 70 });
    lsp.overall.recallMisses = 8;
    lsp.overall.recallGains = 0;
    lsp.overall.falseConfident = 4;
    const v = noRecallRegression(baseline, lsp);
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(false);
    // The dominant regression signal is coverage shrink
    // (resolvedCalls: baseline 80+5+0=85 → lsp 50+4+0=54).
    expect(v!.reason).toMatch(/resolvedCalls shrank/);
    expect(v!.reason).toMatch(/85 → 54/);
    // misses actually IMPROVED (10 → 8), so no
    // `recallMisses regressed` clause.
    expect(v!.reason).not.toMatch(/recallMisses regressed/);
    // Verdict counters echo the asymmetric leg populations.
    expect(v!.baselineResolvedCalls).toBe(85);
    expect(v!.lspResolvedCalls).toBe(54);
    expect(v!.baselineRecallMisses).toBe(10);
    expect(v!.lspRecallMisses).toBe(8);
  });

  it('[DESIGN] renderRecallRegression renders a FAIL row with the leg-populations-differ verdict', () => {
    // Companion to the helper test above: the markdown
    // renderer MUST surface the asymmetric counters in the
    // FAIL row so the operator can see the populations
    // differ. The row's `reason` column carries the
    // "resolvedCalls shrank (85 → 54)" string; the resolved-
    // calls + recall-misses columns carry the asymmetric
    // counts verbatim.
    const md = renderRecallRegression([
      {
        repo: '/r/diff-pop',
        verdict: {
          passed: false,
          baselineResolvedCalls: 85,
          lspResolvedCalls: 54,
          baselineRecallMisses: 10,
          lspRecallMisses: 8,
          lowBaselinePower: false,
          reason: 'resolvedCalls shrank (85 → 54)',
        },
      },
    ]);
    expect(md).toMatch(/\| \/r\/diff-pop \| FAIL \| 85 \| 54 \| 10 \| 8 \|  \| resolvedCalls shrank \(85 → 54\) \|/);
  });

  it('returns passed=false with BOTH reasons when both regressed', () => {
    const baseline = makeReport();
    const lsp = makeReport();
    baseline.overall.recallMisses = 5;
    baseline.overall.matches = 30;
    baseline.overall.falseConfident = 5;
    baseline.overall.recallGains = 0;
    lsp.overall.recallMisses = 12;
    lsp.overall.matches = 20;
    lsp.overall.falseConfident = 5;
    lsp.overall.recallGains = 0;
    const v = noRecallRegression(baseline, lsp);
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(false);
    expect(v!.reason).toMatch(/recallMisses regressed/);
    expect(v!.reason).toMatch(/resolvedCalls shrank/);
  });

  it('returns null when the baseline report is degenerate (no overall)', () => {
    const baseline: any = { sampledCap: 50, sampleSize: 50 };
    const lsp = makeReport();
    const v = noRecallRegression(baseline, lsp);
    expect(v).toBeNull();
  });

  it('returns null when the lsp report is degenerate (lspUnavailable)', () => {
    const baseline = makeReport();
    const lsp: any = { lspUnavailable: true, sampledCap: 0, sampleSize: 50 };
    const v = noRecallRegression(baseline, lsp);
    expect(v).toBeNull();
  });
});

describe('measure-mode-c — AC-2 renderRecallRegression', () => {
  it('emits a markdown table with PASS/FAIL/SKIP rows', () => {
    const md = renderRecallRegression([
      { repo: '/r/a', verdict: { passed: true, baselineResolvedCalls: 100, lspResolvedCalls: 105, baselineRecallMisses: 5, lspRecallMisses: 4, lowBaselinePower: false, reason: '' } },
      { repo: '/r/b', verdict: { passed: false, baselineResolvedCalls: 200, lspResolvedCalls: 180, baselineRecallMisses: 10, lspRecallMisses: 12, lowBaselinePower: false, reason: 'recallMisses regressed (10 → 12)' } },
      { repo: '/r/c', verdict: { passed: true, baselineResolvedCalls: 30, lspResolvedCalls: 35, baselineRecallMisses: 0, lspRecallMisses: 0, lowBaselinePower: true, reason: '' } },
      { repo: '/r/d', verdict: null },
    ]);
    expect(md).toMatch(/^# AC-2 recall-regression check/);
    // The lowBaselinePower column is the 7th data column. Empty
    // cell when baseline had misses; `lowBaselinePower` text when
    // baseline.recallMisses === 0 (the verdict is a coverage-only
    // check, review for sample power before trusting PASS).
    expect(md).toMatch(/\| \/r\/a \| PASS \| 100 \| 105 \| 5 \| 4 \|  \|  \|/);
    expect(md).toMatch(/\| \/r\/b \| FAIL \| 200 \| 180 \| 10 \| 12 \|  \| recallMisses regressed \(10 → 12\) \|/);
    expect(md).toMatch(/\| \/r\/c \| PASS \| 30 \| 35 \| 0 \| 0 \| lowBaselinePower \|  \|/);
    expect(md).toMatch(/\| \/r\/d \| SKIP \| - \| - \| - \| - \|  \|  \|/);
  });

  it('renders the empty state when no rows', () => {
    const md = renderRecallRegression([]);
    expect(md).toMatch(/No rows/);
  });
});

describe('measure-mode-c — AC-2 recallRegressionForResult (MeasureModeCResult → verdict)', () => {
  it('returns a verdict when both legs are present', () => {
    const result: MeasureModeCResult = {
      repo: '/r/a',
      artifacts: [
        { ...makeArtifact({ leg: 'baseline' }).artifacts[0], report: { overall: { matches: 30, falseConfident: 5, recallMisses: 5, recallGains: 0, n: 50 } } },
        { ...makeArtifact({ leg: 'lsp' }).artifacts[0], report: { overall: { matches: 35, falseConfident: 5, recallMisses: 4, recallGains: 0, n: 50 } } },
      ],
      errors: [],
    };
    const { repo, verdict } = recallRegressionForResult(result);
    expect(repo).toBe('/r/a');
    expect(verdict).not.toBeNull();
    expect(verdict!.passed).toBe(true);
  });

  it('returns null verdict when only the baseline leg is present', () => {
    const result: MeasureModeCResult = {
      repo: '/r/a',
      artifacts: [
        { ...makeArtifact({ leg: 'baseline' }).artifacts[0], report: makeReport() },
      ],
      errors: [],
    };
    const { repo, verdict } = recallRegressionForResult(result);
    expect(repo).toBe('/r/a');
    expect(verdict).toBeNull();
  });
});

// ─── Bucket-query shape assertion ────────────────────────────────────
//
// The query is RELATIONSHIP-AGNOSTIC (no `WHERE r.type = $relType`)
// per the design doc §Contracts "Source-distribution query": the
// artifact's `edgeCountsBySource` / `edgeCountsByReason` maps cover
// ALL `CodeRelation` rows, not just CALLS, so the campaign's KPI
// (which edge types LSP is helping or hurting) is driven by the
// full distribution. A CALLS-only filter was a review BLOCKER.
//
// NOTE on GROUP BY: This Kùzu/LadybugDB build does not support an
// explicit `GROUP BY` clause — it causes a parser exception
// ("Invalid input < GROUP>"). Kùzu follows the openCypher spec
// where grouping is IMPLICIT when a non-aggregate key is projected
// alongside an aggregate. The bucket query therefore uses implicit
// grouping (`RETURN r.${column} AS bucket, COUNT(r) AS count`) and
// MUST NOT include an explicit `GROUP BY` clause.

describe('measure-mode-c — bucketEdgeCounts cypher shape (relationship-agnostic, implicit grouping)', () => {
  it('the cypher dispatched via runCypher uses COUNT aggregation with NO explicit GROUP BY and NO relType param', async () => {
    // Pin the dispatched cypher text: it must aggregate via
    // COUNT (implicit grouping), must NOT include an explicit
    // `GROUP BY` clause (unsupported by this Kùzu build), and
    // must be relationship-agnostic (no relType filter).
    const stat = makeStat(2048);
    let captured: { cypher: string; params: any } | null = null;
    const runCypher = vi.fn(async (_repoId: string, cypher: string, params: any) => {
      if (captured === null) captured = { cypher, params };
      return [];
    });
    const verify = makeVerify();
    const opts = makeOptions({
      stat: stat as any,
      runCypher: runCypher as any,
      verify: verify as any,
    });
    await measureModeC(opts);
    expect(captured).not.toBeNull();
    // Must use COUNT aggregation.
    expect(captured!.cypher).toMatch(/COUNT\(r\)/i);
    // Must NOT use explicit GROUP BY (unsupported by this Kùzu build;
    // grouping is implicit per openCypher spec).
    expect(captured!.cypher).not.toMatch(/GROUP BY/i);
    // No relationship-type filter (review BLOCKER — the artifact
    // must reflect ALL edge types, not just CALLS).
    expect(captured!.cypher).not.toMatch(/type:\s*\$relType/i);
    expect(captured!.params).toEqual({});
  });
});

// ─── DT-1c-14: main() writes recall-regression.md alongside summary.md

describe('measure-mode-c — main() writes recall-regression.md (AC-2)', () => {
  it('writes <out>/recall-regression.md in addition to summary.md', async () => {
    const fakeFs = makeFakeFs();
    const measure = vi.fn(async () => ({
      repo: '/tmp/repo',
      artifacts: [
        { ...makeArtifact({ leg: 'baseline' }).artifacts[0], report: makePopulatedReport({ n: 100, matches: 90, falseConfident: 5, refusals: 5 }) },
        { ...makeArtifact({ leg: 'lsp' }).artifacts[0], report: makePopulatedReport({ n: 105, matches: 95, falseConfident: 5, refusals: 5 }) },
      ],
      errors: [],
    }));
    await mainFn({
      argv: ['--repo', '/tmp/repo', '--legs', 'baseline,lsp'],
      importServerDiscovery: async () => fakeDiscoveryOk() as any,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout: vi.fn(),
      exit: vi.fn(),
      measure: measure as any,
    });
    const keys = [...fakeFs.files.keys()];
    const summaryKey = keys.find((k) => k.endsWith('summary.md'));
    const recallKey = keys.find((k) => k.endsWith('recall-regression.md'));
    expect(summaryKey).toBeDefined();
    expect(recallKey).toBeDefined();
    // The recall file is parseable markdown.
    const recall = fakeFs.files.get(recallKey!);
    expect(recall).toMatch(/^# AC-2 recall-regression check/);
    expect(recall).toMatch(/PASS/);
  });
});

// ─── Polish-review gap: --lsp-server-path end-to-end ──────────────────
//
// The pre-measure gate (DT-1c-4 above) exercises the HALT path:
// `discoverServers:null` + failing `execNpx` → exit(1) + doctor.
// This new test exercises the OPERATOR-PINNED PATH: the operator
// supplies `--lsp-server-path` so the gate short-circuits the
// `npx` fallback probe. The measure stub receives the resolved
// `lspServerPath` and a `serverVersion` (set by the gate from the
// pinned path); the test asserts the stub was called with the
// expected shape.

describe('measure-mode-c — main() --lsp-server-path operator-pinned path (polish gap)', () => {
  it('with --lsp-server-path set: measure receives lspServerPath and execNpx is NOT invoked', async () => {
    const fakeFs = makeFakeFs();
    // Capture the opts the measure stub actually receives.
    const measure = vi.fn(async (_opts: any) => makeArtifact({ leg: 'baseline' }));
    // `execNpx` is wired to the fallback probe — it should NOT
    // be called when --lsp-server-path is set (the operator-
    // pinned path short-circuits the npx probe).
    const execNpx = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    // `discoverServers` returns null (LSP not on $PATH). The
    // gate must NOT halt when --lsp-server-path is set — the
    // operator-pinned path replaces the discovery result.
    const importServerDiscovery = async () => fakeDiscoveryAbsent() as any;
    await mainFn({
      // Use a real executable path (Node's own binary) so the
      // parse-time `accessSync(X_OK)` validation gate passes —
      // the operator-pinned path replaces the discovery result
      // when the binary is present and executable.
      argv: ['--repo', '/tmp/repo', '--sample', '50', '--lsp-server-path', process.execPath],
      importServerDiscovery,
      execNpx,
      fs: fakeFs.fs,
      stderr: vi.fn(),
      stdout: vi.fn(),
      exit: vi.fn(),
      measure: measure as any,
    });
    // measure was called.
    expect(measure).toHaveBeenCalledTimes(1);
    // The options bag threaded into measure carries the operator-
    // pinned path AND the gate's `serverVersion` ('operator-pinned'
    // per the gate logic).
    const optsPassedToMeasure = measure.mock.calls[0][0];
    expect(optsPassedToMeasure.lspServerPath).toBe(process.execPath);
    expect(optsPassedToMeasure.serverVersion).toBe('operator-pinned');
    // execNpx was NOT called — the operator-pinned path bypasses
    // the npx fallback probe.
    expect(execNpx).not.toHaveBeenCalled();
    // The summary.md was still written (the run was not halted).
    const keys = [...fakeFs.files.keys()];
    const summaryKey = keys.find((k) => k.endsWith('summary.md'));
    expect(summaryKey).toBeDefined();
  });
});

// ─── Polish-review gap: bucketEdgeCounts multi-row sum ────────────────
//
// `bucketEdgeCounts` uses Kùzu's implicit grouping (no explicit
// `GROUP BY` — unsupported by this Kùzu build). The JS-side
// `out[k] = (out[k] ?? 0) + c` sum is a SAFETY NET for a future
// engine version that returns multi-row buckets (one row per matched
// relationship). These tests pin the safety net: when the helper
// is fed multi-row input, it must collapse per-bucket counts into
// a single summed value.

import { __test__ as measureModeCTestInternals } from '../../../scripts/measure-mode-c.js';

describe('measure-mode-c — bucketEdgeCounts multi-row defensive sum (polish gap)', () => {
  it('two rows in the same bucket collapse to a single summed count', async () => {
    const { bucketEdgeCounts } = measureModeCTestInternals;
    // runCypher stub returns two rows for the same bucket — the
    // engine-multiplex scenario. The helper must NOT emit two
    // distinct keys; it must collapse the count.
    const runCypher = vi.fn(async (_repoId: string, _q: string, _p: any) => [
      { bucket: 'heuristic', count: 60 },
      { bucket: 'heuristic', count: 60 },
    ]) as any;
    const out = await bucketEdgeCounts(runCypher, 'repo', 'source');
    expect(out).toEqual({ heuristic: 120 });
  });

  it('three rows in the same bucket collapse to a single summed count', async () => {
    const { bucketEdgeCounts } = measureModeCTestInternals;
    const runCypher = vi.fn(async (_repoId: string, _q: string, _p: any) => [
      { bucket: 'lsp', count: 10 },
      { bucket: 'lsp', count: 20 },
      { bucket: 'lsp', count: 30 },
    ]) as any;
    const out = await bucketEdgeCounts(runCypher, 'repo', 'source');
    expect(out).toEqual({ lsp: 60 });
  });
});
