/**
 * Integration Smoke: pylsp real binary (guarded).
 *
 * WI-7 acceptance gate. Mirrors the guarded-skip pattern from
 * `java-jdtls-real.test.ts`:
 *   - `beforeAll` resolves `pylsp` via `discoverServers()`.
 *   - Every `it` does `if (!pylspBinary) return;` (skip-clean, not fail).
 *
 * Windows paths are explicitly OUT OF SCOPE for this test (POSIX-only CI).
 * The suite exits early on `process.platform === 'win32'`.
 *
 * What we verify:
 *
 *   B-1  Skip-clean: without pylsp binary, every `it` exits immediately.
 *        No SKIP status, no assertion failure.
 *
 *   B-2  `LspClient` spawned with `PYTHON_ADAPTER` against a temp .py
 *        workspace → `start()` resolves `true` (state = 'ready').
 *
 *   B-3  `awaitReady` resolves promptly within `PYLSP_READY_DEADLINE_MS`
 *        (15 s budget, vs Java's 180 s — pylsp has no JVM warm-up).
 *
 *   B-4  `textDocument/definition` request on in-workspace symbol
 *        (`def process_data`) returns `Location[]` with ≥1 entry and
 *        `uri` inside `workspaceRoot`.
 *
 *   B-5  Canary sample lands on `def`/`class` declaration line (priority 1),
 *        NOT an import line — PYTHON_CANARY_STRATEGY confirmed live.
 *
 *   B-6  Site-packages/stdlib URI returned by pylsp for a stdlib symbol
 *        (`pathlib.Path`) → `mapLocationToNodeId` →
 *        `{ kind: 'NO_NODE', external: true }` — mis-map count === 0.
 *        Confirms repoPath threading for the out-of-repo containment check
 *        (WI-5 Mode-C repoPath gap fixed end-to-end).
 *
 *   B-7  `repoPath` correctly threaded to mapper so containment check fires
 *        for out-of-repo `file://` URIs (confirms WI-5 end-to-end).
 *
 *   B-8  `LspClient.stop()` after the test disposes cleanly — no dangling
 *        process; no orphan pylsp after `awaitReady`-false (ruling R2-9).
 *
 * Crawl4ai deeper checks (gated on crawl4ai repo present):
 *
 *   B-9  `analyze --lsp` on crawl4ai: Mode-A confirm+correct augmentation
 *        count ≥ 1 (must be > 0).
 *
 *   B-10 `analyze --lsp` on crawl4ai: external-refusal count > 0 (site-packages
 *        defs bucketed correctly, not counted as recall-misses).
 *
 *   B-11 `analyze --lsp` on crawl4ai: mis-map count === 0 (I-8 oracle: every
 *        NodeId returned resolves to a path strictly inside repoPath).
 *
 * Invariants:
 *   - Guarded-skip: zero failures when pylsp absent.
 *   - I-8 mis-map oracle asserted in aggregate (not per-URI spot-checks).
 *   - Mode-A augmentation (B-9) and external-refusal (B-10) independently
 *     asserted (ruling R2-8 split).
 *
 * Fixture design:
 *   simple.py   — `def process_data(items): pass` (decl-first canary target)
 *   pyproject.toml — minimal TOML (pylsp uses this to identify workspace root)
 *
 * The `pathlib.Path` call-site is the stdlib anchor for B-6:
 * pylsp resolves `Path` to a `file://` URI inside the Python stdlib prefix,
 * which is outside the fixture `workspaceRoot` → must bucket as external.
 *
 * Timeout budget:
 *   beforeAll  — 60 s (discoverServers probes npx as last resort)
 *   start it   — PYLSP_READY_DEADLINE_MS + 5_000 ms (35 s) so Vitest harness
 *                does not cancel before the production deadline fires
 *   def its    — PYLSP_READY_DEADLINE_MS + 5_000 ms each (same rationale)
 *   crawl4ai   — 300 s (full analyze --lsp on a real Python repo)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import {
  PYTHON_ADAPTER,
  PYLSP_READY_DEADLINE_MS,
} from '../../../src/core/ingestion/lsp/language-adapter.js';
import { mapLocationToNodeId } from '../../../src/core/ingestion/lsp/location-mapper.js';
import { buildCanarySamples } from '../../../src/core/ingestion/lsp/canary-sampler.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredServer { path: string; version: string }

// ─── Platform guard ───────────────────────────────────────────────────────────

// Windows path handling is explicitly out of scope (POSIX-only CI).
// The suite body is still exercised on mac/linux so the guard only short-circuits
// Windows forks.
const isWindows = process.platform === 'win32';

// ─── Fixture content ─────────────────────────────────────────────────────────

/**
 * simple.py — minimal Python file.
 *
 * Layout (0-based lines):
 *   line 0: `from pathlib import Path`
 *   line 1: (blank)
 *   line 2: `def process_data(items):`
 *   line 3: `    return list(items)`
 *   line 4: (blank)
 *   line 5: `class DataProcessor:`
 *   line 6: `    def run(self):`
 *   line 7: `        p = Path(".")`
 *   line 8: `        return p`
 *
 * The PYTHON_CANARY_STRATEGY should pick `process_data` on line 2 (priority 1 —
 * `def` declaration) rather than `Path` on line 0 (import, last-resort).
 *
 * The `Path(".")` call on line 7 serves as the stdlib anchor for B-6:
 * pylsp resolves `Path` to its stdlib `file://` URI.
 */
const SIMPLE_PY = `from pathlib import Path

def process_data(items):
    return list(items)

class DataProcessor:
    def run(self):
        p = Path(".")
        return p
`;

// 0-based position of `process_data` on the `def` line (line 2).
// `def process_data(...)` — "process_data" starts at character 4 (0-indexed).
const DEF_LINE = 2;
const DEF_COL  = 4; // 'd' of 'def'; identity token is "process_data" which
                     // pylsp can resolve; using the `def` keyword col is safe
                     // because pylsp's definition on `def NAME` returns the
                     // same declaration Location[].

// 0-based position of `Path` in `from pathlib import Path` (line 0).
// "from pathlib import Path" — "Path" starts at character 20.
const IMPORT_LINE = 0;
const IMPORT_COL  = 20; // 'P' of 'Path' in the import statement

// 0-based position of `Path` in `p = Path(".")` (line 7).
// `        p = Path(".")` — "Path" starts at character 12.
const STDLIB_CALL_LINE = 7;
const STDLIB_CALL_COL  = 12; // 'P' of 'Path' call-site

/**
 * Minimal pyproject.toml. pylsp uses this to identify the project root.
 * Without it pylsp treats files in isolation and cannot resolve
 * cross-file imports.
 */
const PYPROJECT_TOML = `[project]
name = "gn-pylsp-smoke"
version = "0.1.0"
`;

// ─── State ────────────────────────────────────────────────────────────────────

let pylspBinary: DiscoveredServer | null = null;

/** realpath-resolved fixture repo root (macOS /tmp → /private/tmp). */
let fixtureDir: string;
let tmpDirRaw: string; // for cleanup only

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (isWindows) {
    // eslint-disable-next-line no-console
    console.log('[IT:python-pylsp-real] SKIP — Windows platform out of scope');
    return;
  }

  const discovered = await discoverServers();
  pylspBinary = discovered.python ?? null;

  if (!pylspBinary) {
    // eslint-disable-next-line no-console
    console.log(
      '[IT:python-pylsp-real] SKIP — pylsp not found on PATH; all tests will skip-clean',
    );
    return;
  }

  // Build the fixture repo in a temp dir.
  tmpDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pylsp-smoke-'));
  // Realpath is mandatory on macOS: pylsp returns file:// URIs with the
  // resolved /private/tmp path; without realpath the containment comparison fails.
  fixtureDir = fs.realpathSync(tmpDirRaw);

  fs.writeFileSync(path.join(fixtureDir, 'simple.py'), SIMPLE_PY, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'pyproject.toml'), PYPROJECT_TOML, 'utf8');
  // 60s budget: discoverServers() probes npx as last resort (30-45s on cold npm cache).
}, 60_000);

afterAll(() => {
  if (tmpDirRaw && fs.existsSync(tmpDirRaw)) {
    fs.rmSync(tmpDirRaw, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pylsp real-binary smoke (WI-7 — guarded)', () => {

  /**
   * B-1: skip-clean without pylsp.
   *
   * This `it` exits immediately when `pylspBinary === null` or on Windows.
   * The guard is the ONLY assertion — we verify that absence of the binary
   * doesn't cause a test failure.
   *
   * The `return;` pattern mirrors java-jdtls-real.test.ts:221.
   * Unlike `.skip()`, early return counts as passed (no red mark in CI).
   */
  it('skip-clean when pylsp is absent (B-1, I-4)', () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip — passes silently
    // If we reach here, pylsp IS present.
    expect(pylspBinary.path).toBeTruthy();
    expect(pylspBinary.version).toBeTruthy();
  });

  /**
   * B-2 + B-3: LspClient warms pylsp on the fixture; `start()` resolves
   * within the `PYLSP_READY_DEADLINE_MS` budget (≤ 15 s, NOT 180 s as with jdtls).
   *
   * Proves the full spawn → initialize → awaitReady (canary round-trip) →
   * ready cycle works end-to-end with the real pylsp binary.
   *
   * The short deadline (15 s) is intentional: pylsp starts in <1 s with no
   * JVM warm-up. If this test times out, the canary strategy or awaitReady
   * loop is stalling — a genuine defect to investigate.
   *
   * Timeout: 15 s (B-3 deadline budget; pylsp cold-start <1 s).
   */
  it('client starts and reaches state=ready within pylsp deadline (B-2, B-3)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    const client = new LspClient({
      workspaceRoot: fixtureDir,
      binaryPath: pylspBinary.path,
      adapter: PYTHON_ADAPTER,
    });

    try {
      // start() completes only after PYTHON_ADAPTER.awaitReady resolves.
      // awaitReady runs the PRIMARY canary round-trip (ruling R2-11).
      // If the canary never returns a non-empty Location[], awaitReady
      // resolves false after PYLSP_READY_DEADLINE_MS → start() throws.
      await client.start();
      expect(client.getState()).toBe('ready');
    } finally {
      await client.stop();
      // B-8: after stop(), no dangling process (ruling R2-9 — cleanupAfterFailure
      // SIGTERM path is already covered by lsp-client.ts:835-850).
      expect(client.getState()).toBe('stopped');
    }
    // Timeout must exceed PYLSP_READY_DEADLINE_MS so the Vitest harness does not
    // cancel before the production deadline fires (review finding: spec alignment).
  }, PYLSP_READY_DEADLINE_MS + 5_000);

  /**
   * B-4 + B-5: `textDocument/definition` on in-workspace `def process_data`
   * returns a Location[] with ≥1 entry whose URI is inside `workspaceRoot`.
   *
   * B-5: canary samples must land on the `def` declaration line, NOT the
   * import line — PYTHON_CANARY_STRATEGY priority-1 confirmed live.
   *
   * We verify:
   *   (a) At least one sample is found in the fixture (buildCanarySamples works).
   *   (b) The first sample's line is NOT the import line (line 0) — priority-1
   *       fires on the `def` or `class` keyword first.
   *   (c) A raw definition request at the `def` call-site returns a Location[]
   *       with ≥1 entry whose URI begins with `file://` inside fixtureDir.
   *
   * Timeout: 15 s.
   */
  it('definition on `def process_data` returns in-workspace Location[] (B-4, B-5)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    // ── B-5: canary sample priority check ─────────────────────────────
    const samples = await buildCanarySamples(fixtureDir, {
      strategy: PYTHON_ADAPTER.canary,
    });
    expect(samples.length).toBeGreaterThan(0);

    // The first sample must NOT be on the import line (line 0 in simple.py).
    // Priority-1 (`def`/`class` declaration) must dominate the import.
    const firstSample = samples[0];
    // The fixture has `def process_data` at line 2 and `class DataProcessor`
    // at line 5 — both are priority-1. Priority-3 (import) is line 0.
    // A correct strategy must pick line >= 2.
    expect(firstSample.position.line).toBeGreaterThanOrEqual(DEF_LINE);
    expect(firstSample.position.line).not.toBe(IMPORT_LINE);

    // ── B-4: raw definition at `def process_data` position ────────────
    const simpleUri = `file://${path.join(fixtureDir, 'simple.py')}`;

    const client = new LspClient({
      workspaceRoot: fixtureDir,
      binaryPath: pylspBinary.path,
      adapter: PYTHON_ADAPTER,
    });

    try {
      await client.start();
      expect(client.getState()).toBe('ready');

      // didOpen is required before requesting definition on this file.
      await client.didOpen(simpleUri, SIMPLE_PY, 'python');

      const result = await client.request<unknown[]>(
        'textDocument/definition',
        {
          textDocument: { uri: simpleUri },
          position: { line: DEF_LINE, character: DEF_COL },
        },
        10_000,
      );

      // B-2 (this suite) already asserts client.getState() === 'ready', which
      // means awaitReady returned true, which means the primary canary round-trip
      // (a textDocument/definition request on the `def process_data` position)
      // returned a non-empty Location[]. A second definition request at the same
      // declared position MUST therefore also return a non-empty result — null/[]
      // here implies a test fixture or position bug, not an acceptable indexing gap.
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBeGreaterThan(0);
      const loc = (result as unknown[])[0] as { uri?: string; range?: unknown };
      expect(loc).toHaveProperty('uri');
      expect(loc).toHaveProperty('range');
      // Must be a file:// URI — pylsp never returns jdt://-style URIs.
      expect(loc.uri).toMatch(/^file:\/\//);
      // The in-workspace definition must point inside fixtureDir.
      // classifyUri returns 'workspace' for all file:// (Option C).
      expect(PYTHON_ADAPTER.classifyUri(loc.uri!)).toBe('workspace');
      // The URI must be within the fixture workspace, not a stdlib path.
      expect(loc.uri).toContain(fixtureDir);
    } finally {
      await client.stop();
    }
    // Timeout must exceed PYLSP_READY_DEADLINE_MS (spec alignment — finding B-2/B-3).
  }, PYLSP_READY_DEADLINE_MS + 5_000);

  /**
   * B-6 + B-7: site-packages/stdlib URI → mapLocationToNodeId →
   * `{ kind: 'NO_NODE', external: true }` (mis-map count === 0).
   *
   * This is the load-bearing external-refusal assertion for Python.
   * pylsp returns ordinary `file://` URIs for BOTH in-repo AND stdlib
   * definitions — the ONLY distinguishing signal is whether the path
   * falls outside `workspaceRoot`. The containment check in
   * `mapLocationToNodeId` (gated on `adapterId === 'python'`) must tag
   * stdlib paths as `{ kind: 'NO_NODE', external: true }`.
   *
   * If this fails:
   *   - A stdlib symbol would fall through to the DB query path and
   *     produce a bare `{NO_NODE}` — Mode-C cannot distinguish this
   *     from a genuine recall-miss (I-8 violated).
   *   - OR worse, it resolves to a wrong graph node (mis-map).
   *
   * This test covers the mapper-in-isolation path (Part A) and the
   * TS-path byte-identical invariant (I-1). Part B (real server returns
   * stdlib URI then feeds through mapper) is in the companion test below.
   *
   * B-7: `repoPath` is threaded correctly — the containment guard fires
   * because `repoPath` is set on the deps bag (WI-5 gap closed).
   *
   * This test does NOT spawn LspClient — it is mapper-only.
   */
  it('stdlib URI → NO_NODE external:true via mapper; TS path bare NO_NODE (B-6 Part A, B-7)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    // Use process.execPath (the Node binary): a real file guaranteed to exist
    // on disk AND guaranteed to be outside fixtureDir (a temp dir under /tmp
    // or /private/tmp). realpathSync must succeed — if the path does not exist,
    // the Python adapter returns bare {NO_NODE} early (ruling R2-4) and
    // external:true is never set. Using a non-existent virtual path would
    // silently test the wrong branch.
    const pathlibPath = fs.realpathSync(process.execPath);
    const stdlibUri = `file://${pathlibPath}`;

    // A fake executeParameterized — should never be reached because the
    // out-of-repo containment guard short-circuits before the DB query.
    const fakeExecute = async () => [];

    // Python adapter path: out-of-repo → external:true (I-2, I-8).
    const mapperResult = await mapLocationToNodeId(
      {
        uri: stdlibUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
      'smoke-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        classifyUri: (uri) => PYTHON_ADAPTER.classifyUri(uri),
        adapterId: 'python',
        repoPath: fixtureDir, // B-7: repoPath threaded → containment guard fires
      },
    );

    expect(mapperResult.kind).toBe('NO_NODE');
    expect((mapperResult as { kind: string; external?: boolean }).external).toBe(true);

    // TS path: same URI, no adapterId → bare NO_NODE (I-1 byte-identical invariant).
    const tsMapperResult = await mapLocationToNodeId(
      {
        uri: stdlibUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
      'smoke-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        // No classifyUri, no adapterId — TS path
        repoPath: fixtureDir,
      },
    );
    expect(tsMapperResult.kind).toBe('NO_NODE');
    expect((tsMapperResult as { kind: string; external?: boolean }).external).toBeUndefined();
  });

  /**
   * B-6 Part B: real server returns stdlib URI for `Path()` call-site →
   * feed through mapper → external:true.
   *
   * Spawns LspClient with PYTHON_ADAPTER. Requires the production fix for
   * `PYTHON_ADAPTER.spawnArgs` (must return `[]`, NOT `['--stdio']` —
   * pylsp uses stdio by default with no argument; `--stdio` is unrecognized
   * and causes pylsp to exit with code 2, failing `client.start()`).
   *
   * See specMismatch note: WI-2's spawnArgs spec is incorrect. This test
   * correctly reveals that bug.
   */
  it('real pylsp: Path() call-site → stdlib URI → external:true through mapper (B-6 Part B)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    const fakeExecute = async () => [];
    const simpleUri = `file://${path.join(fixtureDir, 'simple.py')}`;

    const client = new LspClient({
      workspaceRoot: fixtureDir,
      binaryPath: pylspBinary.path,
      adapter: PYTHON_ADAPTER,
    });

    try {
      await client.start();
      await client.didOpen(simpleUri, SIMPLE_PY, 'python');

      const result = await client.request<unknown[]>(
        'textDocument/definition',
        {
          textDocument: { uri: simpleUri },
          position: { line: STDLIB_CALL_LINE, character: STDLIB_CALL_COL },
        },
        10_000,
      );

      // B-6 AC: pylsp MUST return a non-null, non-empty Location[] for the
      // `Path(".")` call-site, and the URI MUST be a file:// stdlib path outside
      // workspaceRoot. If pylsp returns null/[] or an in-fixture URI, the
      // end-to-end wiring of the containment guard is untested (plan B-6 AC).
      //
      // If pylsp cannot resolve `Path` at this position (e.g. workspace is not
      // fully indexed) the test fails explicitly rather than passing vacuously —
      // a vacuous pass means the critical external-refusal path is never exercised.
      expect(
        result !== null && Array.isArray(result) && result.length > 0,
        'B-6 Part B: pylsp must return a non-empty Location[] for Path() call-site. ' +
        'If pylsp returned null/[]: check that the workspace is indexed (pyproject.toml present) ' +
        'and STDLIB_CALL_COL points to "P" of Path in `p = Path(".")` on line 7. ' +
        'A vacuous pass here means the end-to-end stdlib external-refusal is untested.',
      ).toBe(true);

      const loc = (result as unknown[])[0] as { uri?: string; range?: unknown };

      expect(
        loc.uri !== undefined && loc.uri.startsWith('file://'),
        `B-6 Part B: expected a file:// URI from pylsp for Path() definition; got: ${loc.uri}`,
      ).toBe(true);

      const lspMapResult = await mapLocationToNodeId(
        {
          uri: loc.uri!,
          range: (loc.range as { start: { line: number; character: number }; end: { line: number; character: number } }) ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
        'smoke-repo-id',
        {
          executeParameterized: fakeExecute,
          generateId: (label, name) => `${label}:${name}`,
          normalizeFilePath: (p) => p,
          classifyUri: (uri) => PYTHON_ADAPTER.classifyUri(uri),
          adapterId: 'python',
          repoPath: fixtureDir,
        },
      );

      const isOutsideFixture = !loc.uri!.includes(fixtureDir);
      // URI MUST be outside workspaceRoot: pathlib is a stdlib module, not in the fixture.
      expect(
        isOutsideFixture,
        `B-6 Part B: pylsp returned a URI inside the fixture dir for stdlib Path — ` +
        `expected a stdlib/site-packages path outside ${fixtureDir}; got: ${loc.uri}`,
      ).toBe(true);

      // Containment guard MUST fire: stdlib URI → external:true (I-2).
      expect(lspMapResult.kind).toBe('NO_NODE');
      expect((lspMapResult as { kind: string; external?: boolean }).external).toBe(true);
    } finally {
      await client.stop();
    }
    // Timeout must exceed PYLSP_READY_DEADLINE_MS (spec alignment — finding B-2/B-3).
  }, PYLSP_READY_DEADLINE_MS + 5_000);

  /**
   * B-8 (cleanup regression guard):
   * `LspClient.stop()` after a successful start disposes cleanly.
   *
   * This test also covers the discoverServers() regression guard —
   * when pylsp is on PATH, `discoverServers()` MUST include the `python`
   * key with `path` set and `version` set (not undefined). The pre-fix
   * pattern (jdtls Bug-#1) dropped the binary on --version parse failure;
   * the WI-4 fix preserves the entry with `version: 'unknown'` instead.
   */
  it('RC: discoverServers includes python when pylsp is on PATH (B-8)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    const servers = await discoverServers();
    expect(servers.python).not.toBeNull();
    expect(servers.python).not.toBeUndefined();
    expect(servers.python!.path).toBeTruthy();
    // version is '1.14.0' or 'unknown' — must be a non-empty string.
    expect(servers.python!.version).toBeTruthy();
  });

  /**
   * B-9 + B-10 + B-11: `analyze --lsp` on crawl4ai.
   *
   * Gated on:
   *   1. pylsp binary present (outer guard).
   *   2. crawl4ai repo present at `CRAWL4AI_REPO` path.
   *   3. Opt-in env flag `GITNEXUS_PYTHON_HEAVY_IT=1` (avoids long
   *      pipeline run in standard dev loops; runs in CI/nightly).
   *
   * What we assert:
   *   B-9: Mode-A confirm+correct augmentation count ≥ 1 (ruling R2-8 clause a).
   *   B-10: external-refusal mechanism confirmed: known site-packages URIs
   *         map to `{ kind: 'NO_NODE', external: true }` under the Python adapter
   *         with crawl4ai as repoPath. Independently asserted (ruling R2-8 clause b).
   *   B-11: mis-map oracle (I-8): every `lsp-confirmed`/`lsp-corrected`/`lsp-recall`
   *         edge in the result graph has a target node whose file path is strictly
   *         inside crawl4ai repoPath.
   *
   * Technique: Flow-Based (repoPath threading → external:true bucketing) +
   *            State Transition aggregate (see ruling R2-8 independence).
   *
   * B-10 (external-refusal) strategy:
   * ESM live-binding semantics mean `vi.spyOn` on a named export is not
   * reliable for interception of calls made by already-imported modules
   * (pipeline.ts binds `mapLocationToNodeId` at import time; the spy does
   * not intercept that binding). Instead, we verify the mechanism directly:
   * call `mapLocationToNodeId` with real site-packages/stdlib URIs and
   * crawl4ai's repoPath, asserting `{ kind: 'NO_NODE', external: true }`.
   * This proves the wiring (adapterId threading) is correct without
   * relying on spy interception.
   *
   * B-11 (mis-map oracle, I-8):
   * After the pipeline run, iterate all graph relationships with
   * source `lsp-confirmed` / `lsp-corrected` / `lsp-recall`. The target
   * node's path (derivable from the nodeId or graph node lookup) MUST
   * be inside crawl4ai repoPath. A node whose path is outside would be
   * a mis-map — a site-packages symbol incorrectly indexed as a
   * workspace symbol.
   *
   * Timeout: 300 s (cold-cache pylsp + full Python repo analyze).
   */
  it('analyze --lsp on crawl4ai: augmentation ≥ 1, external-refusal > 0, mis-map = 0 (B-9, B-10, B-11)', async () => {
    if (isWindows) return;
    if (!pylspBinary) return; // guarded skip

    // Security: CRAWL4AI_REPO must be provided via env var, not hardcoded.
    // Set CRAWL4AI_REPO=/path/to/crawl4ai before running this test.
    const CRAWL4AI_REPO = process.env['CRAWL4AI_REPO'] ?? '';
    if (!CRAWL4AI_REPO || !fs.existsSync(CRAWL4AI_REPO)) {
      // eslint-disable-next-line no-console
      console.log('[IT:python-pylsp-real:crawl4ai] SKIP — CRAWL4AI_REPO env var not set or path does not exist');
      return;
    }

    if (!process.env['GITNEXUS_PYTHON_HEAVY_IT']) {
      // eslint-disable-next-line no-console
      console.log('[IT:python-pylsp-real:crawl4ai] SKIP — set GITNEXUS_PYTHON_HEAVY_IT=1 to enable');
      return;
    }

    // ── Pinned-commit assertion (WI-7 / ruling R2-8) ─────────────────
    // WI-7 mandates a fixed crawl4ai commit SHA so AUGMENTATION_FLOOR is a
    // reproducible regression guard, not a local-machine artifact.
    //
    // The CRAWL4AI_PINNED_SHA env var carries the SHA pinned during the WI-7
    // scouting run. When not set, the test fails explicitly rather than
    // proceeding with an unpinned floor (review finding B-9).
    //
    // To pin: run `git rev-parse HEAD` in crawl4ai, export the result as
    // CRAWL4AI_PINNED_SHA in CI, and record it in the job environment.
    const PINNED_CRAWL4AI_SHA = process.env['CRAWL4AI_PINNED_SHA'] ?? '';
    expect(
      PINNED_CRAWL4AI_SHA.length,
      'B-9: CRAWL4AI_PINNED_SHA env var must be set to the 40-char SHA from the WI-7 scouting run. ' +
      'Run `git rev-parse HEAD` in crawl4ai, record it, and export CRAWL4AI_PINNED_SHA=<sha> in CI. ' +
      'Without a pinned commit, AUGMENTATION_FLOOR is a local-machine artifact with no reproducibility ' +
      'guarantee (ruling R2-8 / WI-7).',
    ).toBeGreaterThan(0);

    const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CRAWL4AI_REPO }).toString().trim();
    expect(
      actualSha,
      `B-9: crawl4ai is not at the pinned scouting commit. ` +
      `Expected ${PINNED_CRAWL4AI_SHA}, got ${actualSha}. ` +
      `Check out the pinned commit before running this test (ruling R2-8).`,
    ).toBe(PINNED_CRAWL4AI_SHA);

    // ── B-10 (clause b): external-refusal mechanism — direct probe ────
    // We do NOT rely on spy interception (ESM live-binding semantics prevent
    // reliable interception of pipeline-internal mapper calls). Instead,
    // we prove the mechanism is wired by calling the mapper directly with
    // known out-of-repo URIs and crawl4ai as the repoPath.
    // This is the I-2 / I-8 oracle: any out-of-repo `file://` URI with
    // `adapterId==='python'` must produce `{ kind:'NO_NODE', external:true }`.
    const realCrawl4aiRoot = fs.realpathSync(CRAWL4AI_REPO);
    const fakeExecute = async () => [];

    // Derive stdlib and site-packages paths at runtime from the Python prefix
    // so the test is not tied to any specific Python installation prefix.
    // Security: never hardcode machine-specific paths (review finding).
    const pythonBin = pylspBinary.path.includes('python')
      ? pylspBinary.path
      : 'python3';
    const pythonPaths = execFileSync(
      pythonBin.endsWith('pylsp') ? 'python3' : pythonBin,
      ['-c', 'import sysconfig, json; p=sysconfig.get_paths(); print(json.dumps({"stdlib": p["stdlib"], "purelib": p["purelib"]}))'],
    ).toString().trim();
    const { stdlib: stdlibDir, purelib: sitePackagesDir } = JSON.parse(pythonPaths) as { stdlib: string; purelib: string };

    // stdlib (pathlib): always outside crawl4ai
    const stdlibUri = `file://${stdlibDir}/pathlib/__init__.py`;
    // site-packages (requests): always outside crawl4ai
    const sitePackagesUri = `file://${sitePackagesDir}/requests/__init__.py`;

    for (const externalUri of [stdlibUri, sitePackagesUri]) {
      const r = await mapLocationToNodeId(
        { uri: externalUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
        'crawl4ai-repo-id',
        {
          executeParameterized: fakeExecute,
          generateId: (label, name) => `${label}:${name}`,
          normalizeFilePath: (p) => p,
          classifyUri: (uri) => PYTHON_ADAPTER.classifyUri(uri),
          adapterId: 'python',
          repoPath: realCrawl4aiRoot,
        },
      );
      // B-10: external-refusal fires for out-of-repo Python file:// URIs (ruling R2-8 b).
      expect(r.kind).toBe('NO_NODE');
      expect((r as { kind: string; external?: boolean }).external).toBe(true);
    }

    // ── Full analyze --lsp run (B-9 + B-11) ──────────────────────────
    const pipelineResult = await runPipelineFromRepo(
      CRAWL4AI_REPO,
      () => {}, // progress callback
      {
        skipGraphPhases: true,
        lsp: { enabled: true, dryRun: false },
      },
    );

    const lspReport = pipelineResult.lspReport;

    // ── B-9: Mode-A augmentation count ≥ AUGMENTATION_FLOOR ─────────
    // `confirmed + corrected` is the augmentation count (clause a of ruling R2-8).
    //
    // Floor rationale (ruling R2-8 / WI-7 scouting requirement):
    //   The floor must be sourced from a scouting run on the pinned crawl4ai
    //   commit rather than guessed. Scouting runs behind the
    //   GITNEXUS_PYTHON_HEAVY_IT=1 gate (this test cannot run in standard CI).
    //
    //   Scouting run (analyze --lsp --force crawl4ai, pylsp 1.14.0): observed
    //   confirmed 2 + corrected 1 = 3 augmentations. NOTE: the metric is
    //   confirm+correct only (clause a) — recall (+3) is deliberately excluded,
    //   so the floor derives from 3, NOT 6. floor = floor(3*0.8) = 2 per ruling
    //   R2-8. (Cross-checked against the wf-implement Gate-3 E2E: augmentation=3.)
    const AUGMENTATION_FLOOR = 2;
    expect(lspReport).not.toBeNull();
    expect(lspReport).not.toBeUndefined();
    const augmentationCount = (lspReport?.confirmed ?? 0) + (lspReport?.corrected ?? 0);
    expect(
      augmentationCount,
      `Expected ≥${AUGMENTATION_FLOOR} Mode-A augmentation (confirm+correct) on crawl4ai; got ${augmentationCount}. ` +
      `Full report: confirmed=${lspReport?.confirmed}, corrected=${lspReport?.corrected}, ` +
      `recall=${lspReport?.recall}, refused=${lspReport?.refused}`,
    ).toBeGreaterThanOrEqual(AUGMENTATION_FLOOR);
    // Staleness advisory (ruling R2-8): the floor is a lower-bound regression
    // guard, not an exact target. It is stale only when a meaningfully TIGHTER
    // floor is warranted — i.e. floor(observed*0.8) has risen above the current
    // constant. Emit a console warning (never a failure) so the developer knows
    // to tighten the floor; a run at the expected count keeps the recommended
    // floor equal to the current one and stays quiet.
    if (Math.floor(augmentationCount * 0.8) > AUGMENTATION_FLOOR) {
      const recommended = Math.floor(augmentationCount * 0.8);
      // eslint-disable-next-line no-console
      console.warn(
        `[B-9 SCOUTING ADVISORY] AUGMENTATION_FLOOR (${AUGMENTATION_FLOOR}) is below observed ` +
        `augmentation count (${augmentationCount}). Consider updating AUGMENTATION_FLOOR to ` +
        `${recommended} (= floor(${augmentationCount} * 0.8)) to tighten the regression guard ` +
        `(ruling R2-8). This is a maintenance advisory, not a failure.`,
      );
    }

    // ── B-11: mis-map oracle — zero LSP edges target out-of-repo nodes ─
    // Every lsp-confirmed / lsp-corrected / lsp-recall relationship in the
    // result graph MUST have its target node (the `to`) inside crawl4ai.
    // We derive the target path from the graph node's `filePath` attribute.
    //
    // Implementation: iterate all relationships with lsp source stamps.
    // For each, look up the target node in the graph. If the node has a
    // `filePath` property, verify it's inside realCrawl4aiRoot.
    //
    // NodeId format: the reconciler uses `generateId(label, name)` which
    // produces a label:name string. The actual file path isn't embedded in
    // the nodeId — it's on the node object in the graph. We read from the
    // in-memory graph.
    const lspSources = new Set(['lsp-confirmed', 'lsp-corrected', 'lsp-recall']);
    let misMaps = 0;

    for (const rel of pipelineResult.graph.iterRelationships()) {
      // Guard: rel.source is typed as EdgeSource | undefined. The empty-string
      // fallback `?? ''` would cause the Set lookup to always miss for
      // undefined-sourced edges, silently excluding them from the oracle.
      // Instead, skip undefined-sourced edges explicitly — they are not LSP edges.
      if (rel.source === undefined || !lspSources.has(rel.source)) continue;

      // Look up the target node in the graph.
      const targetNode = pipelineResult.graph.getNode(rel.targetId);
      if (!targetNode) continue; // node not in graph — cannot verify; skip

      // Get the file path from the node. The graph node stores filePath
      // under `properties.filePath` (GraphNode shape: { id, label, properties }).
      const nodePath = targetNode.properties.filePath;
      if (!nodePath || typeof nodePath !== 'string') continue; // no path attr

      // Resolve to absolute for containment check.
      // nodePath is repo-relative (e.g. 'crawl4ai/crawler.py') if it doesn't
      // start with '/'. Join with repoPath to get absolute.
      const absNodePath = path.isAbsolute(nodePath)
        ? nodePath
        : path.resolve(realCrawl4aiRoot, nodePath);

      const rel2 = path.relative(realCrawl4aiRoot, absNodePath);
      if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
        // The target node's file path is OUTSIDE crawl4ai — this is a mis-map.
        misMaps++;
        // eslint-disable-next-line no-console
        console.error(
          `[IT:python-pylsp-real] MIS-MAP: nodeId=${rel.targetId} ` +
          `filePath=${nodePath} is outside crawl4ai (rel=${rel2})`,
        );
      }
    }

    expect(
      misMaps,
      `I-8 mis-map oracle violated: ${misMaps} lsp-edge target(s) resolve to paths outside crawl4ai repoPath`,
    ).toBe(0);
  }, 300_000);

});
