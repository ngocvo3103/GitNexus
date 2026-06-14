/**
 * Integration Smoke: gopls real binary (guarded).
 *
 * WI-7a acceptance gate. Mirrors the guarded-skip pattern from
 * `python-pylsp-real.test.ts` and `java-jdtls-real.test.ts`:
 *   - `beforeAll` resolves `gopls` via `discoverServers()` and confirms the
 *     pinned gin fixture directory exists.
 *   - Every `it` does `if (!goplsBinary || !ginDir) return;`
 *     (skip-clean, not fail).
 *
 * Fixture repo: `/Users/NgocVo_1/Documents/sourceCode/gin` (pinned d75fcd4).
 * No temp dir is created — gopls is pointed directly at the pinned checkout.
 * `go.mod` is present (`go 1.25.0`), which gopls requires to load packages.
 *
 * What we verify (WI-7a skeleton + guard + lifecycle/awaitReady band):
 *
 *   C7-1  Skip-clean: gopls binary absent OR gin dir absent → every `it`
 *         exits immediately. No assertion failure, no SKIP status.
 *
 *   C7-2  `LspClient` constructed with `workspaceRoot: ginDir`,
 *         `binaryPath: goplsBinary.path`, `adapter: GO_ADAPTER` →
 *         `start()` resolves; `getState() === 'ready'`.
 *
 *   C7-3  `start()` / `awaitReady` resolves within `GOPLS_READY_DEADLINE_MS`
 *         (30 s).  Vitest timeout = `GOPLS_READY_DEADLINE_MS + 5_000` so the
 *         harness does not cancel before the production deadline fires.
 *
 *   C7-4  TIMING proxy for notification path (I-16):
 *         `start()` wall-clock elapsed < 2 000 ms on a warm gopls run.
 *         2 s << 30 s canary deadline proves that `awaitReady` settled via the
 *         `$/progress` notification path, NOT the 30 s canary backstop.
 *         There is NO `resolutionPath` observable on `GO_ADAPTER` or
 *         `AdapterReadyCtx`; wall-clock timing is the only observable proxy
 *         for I-16 at integration level.
 *
 *   C7-9  `GO_ADAPTER.spawnArgs({ workspaceRoot: ginDir })` deep-equals `[]`
 *         (SPIKE-confirmed: bare gopls serves without any arg).  A real
 *         `start()` with these empty args reaches `'ready'` (proved by C7-2).
 *
 *   C7-8  `stop()` → `getState() === 'stopped'`; no dangling gopls process.
 *         `afterAll` removes any temp state (none in this skeleton — gin is a
 *         pinned checkout, not a temp dir).
 *
 * Invariants:
 *   - NOT a skip-stub: when gopls + gin are present, the full
 *     spawn → initialize → awaitReady → ready chain runs.
 *   - The guard `if (!goplsBinary || !ginDir) return;` authored here is
 *     inherited by WI-7b / WI-7c (definition + external-refusal cases).
 *   - No production code is edited; TS/Java/Python funnels are untouched.
 *
 * Timeout budget:
 *   beforeAll  — 60 s (discoverServers() probes npx as last resort)
 *   start its  — GOPLS_READY_DEADLINE_MS + 5_000 ms (35 s) so the Vitest
 *                harness does not cancel before the production deadline fires.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import {
  GO_ADAPTER,
  GOPLS_READY_DEADLINE_MS,
} from '../../../src/core/ingestion/lsp/language-adapter.js';
import { mapLocationToNodeId } from '../../../src/core/ingestion/lsp/location-mapper.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredServer { path: string; version: string }

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Pinned gin checkout (d75fcd4). Already contains `go.mod` (declares
 * `go 1.25.0`) — gopls requires a module root to load packages.
 *
 * WI-7b / WI-7c will select specific call-site positions inside this repo.
 * For the skeleton (WI-7a) we only need gopls to reach 'ready' state; we do
 * not issue any definition requests here.
 */
const GIN_DIR = '/Users/NgocVo_1/Documents/sourceCode/gin';

// ─── State ────────────────────────────────────────────────────────────────────

let goplsBinary: DiscoveredServer | null = null;

/**
 * realpath-resolved gin workspace root.
 * On macOS, `/tmp` is a symlink to `/private/tmp`; gopls returns file:// URIs
 * with the resolved path. GIN_DIR is not under /tmp, but we use realpathSync
 * for consistency with the pattern established in python-pylsp-real and
 * java-jdtls-real.
 */
let ginDir: string | null = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const discovered = await discoverServers();
  goplsBinary = discovered.go ?? null;

  if (!goplsBinary) {
    // eslint-disable-next-line no-console
    console.log(
      '[IT:go-gopls-real] SKIP — gopls not found on PATH; all tests will skip-clean',
    );
    return;
  }

  if (!fs.existsSync(GIN_DIR)) {
    // eslint-disable-next-line no-console
    console.log(
      `[IT:go-gopls-real] SKIP — gin fixture not found at ${GIN_DIR}; all tests will skip-clean`,
    );
    return;
  }

  // Resolve symlinks so gopls-returned file:// URIs match the containment check.
  ginDir = fs.realpathSync(GIN_DIR);

  // 60s budget: discoverServers() probes npx as last resort (30-45s on cold npm cache).
}, 60_000);

afterAll(() => {
  // WI-7a uses the pinned gin checkout directly — no temp dir to clean up.
  // WI-7b / WI-7c may create LspClient instances that stop() in their own its.
  // Nothing to do here for the skeleton; kept for pattern parity with analogs.
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('gopls real-binary smoke (WI-7a — guarded skeleton)', () => {

  /**
   * C7-1: skip-clean when gopls or gin is absent.
   *
   * This `it` exits immediately when `goplsBinary === null` OR `ginDir === null`.
   * The guard is the ONLY assertion — we verify that absence of the binary
   * or fixture directory doesn't cause a test failure.
   *
   * The `return;` pattern mirrors java-jdtls-real.test.ts:221.
   * Unlike `.skip()`, early return counts as passed (no red mark in CI).
   */
  it('skip-clean when gopls or gin is absent (C7-1)', () => {
    if (!goplsBinary || !ginDir) return; // guarded skip — passes silently
    // If we reach here, both gopls AND gin are present.
    expect(goplsBinary.path).toBeTruthy();
    expect(goplsBinary.version).toBeTruthy();
    expect(ginDir).toBeTruthy();
    expect(fs.existsSync(ginDir)).toBe(true);
  });

  /**
   * C7-9: `GO_ADAPTER.spawnArgs()` deep-equals `[]`.
   *
   * Spike-confirmed: bare gopls (no args) serves stdio. The adapter must
   * never mutate the array between calls. This is a pure-function assertion
   * that runs before any server is spawned — it validates the contract that
   * makes C7-2 / C7-3 meaningful.
   */
  it('GO_ADAPTER.spawnArgs() deep-equals [] (C7-9)', () => {
    if (!goplsBinary || !ginDir) return; // guarded skip

    // First call: must return [].
    const args1 = GO_ADAPTER.spawnArgs({ workspaceRoot: ginDir });
    expect(args1).toEqual([]);

    // Second call: still []; the adapter must not mutate state between calls.
    const args2 = GO_ADAPTER.spawnArgs({ workspaceRoot: ginDir });
    expect(args2).toEqual([]);

    // Distinct array references on each call (no shared reference).
    expect(args1).not.toBe(args2);
  });

  /**
   * C7-2 + C7-3 + C7-4 + C7-8:
   *   C7-2  LspClient reaches state='ready' via start().
   *   C7-3  awaitReady resolves within GOPLS_READY_DEADLINE_MS (30 s).
   *   C7-4  TIMING PROXY: start() wall-clock < 2 000 ms << 30 s canary
   *          deadline — proves the notification path settled awaitReady,
   *          NOT the deadline backstop.  There is no resolutionPath
   *          observable on GO_ADAPTER or AdapterReadyCtx; wall-clock is
   *          the only externally visible proxy for I-16 at this level.
   *   C7-8  stop() → state='stopped'; no dangling gopls process.
   *
   * The 2 s wall-clock threshold is deliberate:
   *   - Spike-confirmed warm latency: 247–916 ms.
   *   - Even 3× headroom (2.75 s) is << the 30 s canary backstop.
   *   - If start() takes > 2 s, awaitReady settled via the DEADLINE
   *     path (canary backstop), not the notification path — a regression
   *     against the #172 pre-`initialize` handler ordering invariant.
   *
   * Timeout: GOPLS_READY_DEADLINE_MS + 5_000 ms so the Vitest harness
   * does not cancel before the production deadline fires (spec C7-3).
   */
  it('client starts and reaches state=ready within GOPLS_READY_DEADLINE_MS (C7-2, C7-3, C7-4, C7-8)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip

    const client = new LspClient({
      workspaceRoot: ginDir,
      binaryPath: goplsBinary.path,
      adapter: GO_ADAPTER,
    });

    // C7-4: record wall-clock before start().
    const t0 = Date.now();

    try {
      // C7-2 + C7-3: start() must complete within 30 s (GOPLS_READY_DEADLINE_MS).
      // If awaitReady never resolves, start() throws → test fails → not a skip.
      await client.start();

      const elapsedMs = Date.now() - t0;

      // C7-2: state must be 'ready' after start().
      expect(client.getState()).toBe('ready');

      // C7-4: notification-path timing proxy.
      // If this assertion fails, it means awaitReady fell through to the
      // 30 s canary backstop (elapsedMs ≈ 30 000). That is the #172 bug:
      // the pre-`initialize` $/progress handler was not registered in time
      // or the "Setting up workspace" title matching is broken.
      expect(
        elapsedMs,
        `C7-4 timing proxy failed: start() took ${elapsedMs} ms (>= 2 000 ms). ` +
        'awaitReady likely settled via the 30 s canary backstop (deadline path), ' +
        'NOT the $/progress notification path. ' +
        'Check: (1) LspClient registers $/progress handler BEFORE initialize; ' +
        '(2) GO_ADAPTER.awaitReady reads pre-buffered progressEndedTokens; ' +
        '(3) "Setting up workspace" title match uses stored begin title, not end.title. ' +
        'Spike-confirmed warm latency: 247–916 ms; 2 000 ms threshold is 2× that.',
      ).toBeLessThan(2_000);
    } finally {
      // C7-8: stop() must resolve cleanly; state must be 'stopped'.
      await client.stop();
      expect(client.getState()).toBe('stopped');
    }
  }, GOPLS_READY_DEADLINE_MS + 5_000);

});

// ─── WI-7b: resolution + external-refusal ────────────────────────────────────

/**
 * WI-7b acceptance gate: definition + external-refusal band.
 *
 * Technique: State Transition (definition request) + Flow-Based Coverage
 * (URI → mapper → external-refusal verdict).
 *
 * Cases implemented:
 *   C7-5  In-repo definition: didOpen(gin.go) + textDocument/definition at
 *         the `New` call-site (gin.go:238, 0-based line 237 char 11 inside
 *         `Default()`) → Location[] length ≥1, first uri contains ginDir,
 *         GO_ADAPTER.classifyUri(uri) === 'workspace'.
 *
 *   C7-6  Stdlib URI (mod-cache toolchain): gopls resolves `http.Handler`
 *         return type in gin.go:243 → file:// URI under
 *         ~/go/pkg/mod/golang.org/toolchain@.../src/ →
 *         mapLocationToNodeId({adapterId:'go', repoPath:ginDir}) →
 *         {kind:'NO_NODE', external:true}.
 *         Non-vacuous guard: null/[] response fails with explicit diagnostic.
 *
 *   C7-7  Third-party dep URI: gopls resolves `http2.Server` in gin.go:248
 *         (the `golang.org/x/net/http2` dep) → file:// URI under
 *         ~/go/pkg/mod/ (not toolchain) →
 *         mapLocationToNodeId({adapterId:'go', repoPath:ginDir}) →
 *         {kind:'NO_NODE', external:true}.
 *         Non-vacuous guard: null/[] response fails with explicit diagnostic.
 *
 *   R2-8  external:true counter non-zero for C7-6 AND C7-7 independently
 *         (not just their sum). Both counters checked in separate assertions.
 *
 *   C7-RC discoverServers().go is present with truthy path + version
 *         when gopls is on PATH (mirrors python B-8).
 *
 *   C7-NV non-vacuous guard: a null/[] gopls definition at the
 *         stdlib/dep positions fails explicitly rather than passing silently
 *         (mirrors python B-6 Part B diagnostic pattern).
 *
 * Invariants:
 *   - external:true is the adapterId-gated path-containment result
 *     (location-mapper.ts:470-471), NOT a classifyUri verdict —
 *     classifyUri returns 'workspace' for ALL file:// by design.
 *   - Mapper call shape: {executeParameterized, generateId,
 *     normalizeFilePath, classifyUri, adapterId:'go', repoPath}.
 *   - No production code edited; WI-7a guard inherited.
 *
 * Gin fixture positions (0-based line, char):
 *   New call-site (C7-5):   gin.go line 237 char 11  ("engine := New()")
 *   http.Server (C7-6):     gin.go line 549 char 17  ("&http.Server{") — net/http stdlib
 *   h2c.NewHandler (C7-7):  gin.go line 248 char 12  ("h2c.NewHandler(...)") — golang.org/x/net/http2/h2c
 *
 * Timeout budget:
 *   definition its — GOPLS_READY_DEADLINE_MS + 5_000 ms each (35 s).
 */
describe('gopls real-binary — resolution + external-refusal (WI-7b)', () => {

  // ── Shared client lifecycle ──────────────────────────────────────────────

  /**
   * A single LspClient is shared across C7-5 / C7-6 / C7-7 to avoid
   * paying the gopls start cost 3×. The client is started in beforeAll
   * and stopped in afterAll. Individual `it` blocks guard with
   * `if (!goplsBinary || !ginDir) return;` — if gopls is absent,
   * `client` is null and every test exits skip-clean.
   */
  let client: LspClient | null = null;
  let ginFileUri: string;

  beforeAll(async () => {
    if (!goplsBinary || !ginDir) return;

    client = new LspClient({
      workspaceRoot: ginDir,
      binaryPath: goplsBinary.path,
      adapter: GO_ADAPTER,
    });

    await client.start();

    // Pre-open gin.go so gopls can answer definition requests on it.
    ginFileUri = `file://${path.join(ginDir, 'gin.go')}`;
    const ginGoContent = fs.readFileSync(path.join(ginDir, 'gin.go'), 'utf8');
    await client.didOpen(ginFileUri, ginGoContent, 'go');
  }, GOPLS_READY_DEADLINE_MS + 60_000);

  afterAll(async () => {
    if (client) {
      await client.stop();
      client = null;
    }
  });

  // ── C7-RC: discoverServers().go ──────────────────────────────────────────

  /**
   * C7-RC: discoverServers includes `go` key when gopls is on PATH.
   *
   * Mirrors python-pylsp-real.test.ts B-8: the discovery probe runs
   * `gopls --version` which gopls rejects (exit 2, no semver) — the
   * WI-4 fix preserves the entry with `version:'unknown'` instead of
   * dropping it (R2-3). Both `path` and `version` must be truthy.
   */
  it('RC: discoverServers includes go when gopls is on PATH (C7-RC)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip

    const servers = await discoverServers();
    expect(servers.go).not.toBeNull();
    expect(servers.go).not.toBeUndefined();
    expect(servers.go!.path).toBeTruthy();
    // version is 'unknown' (R2-3: gopls --version exits 2; only `gopls version`
    // subcommand emits the banner). Must be a non-empty string.
    expect(servers.go!.version).toBeTruthy();
    // 60 s: discoverServers() probes npx as last resort (30-45 s on cold npm cache).
  }, 60_000);

  // ── C7-5: in-repo definition ─────────────────────────────────────────────

  /**
   * C7-5: textDocument/definition on an in-repo Go symbol returns a Location[]
   * whose first URI is inside ginDir and classifies as 'workspace'.
   *
   * Call-site: gin.go line 237 (0-based), char 11 — `engine := New()`
   * inside `Default()`. This is the `New` identifier; gopls resolves it
   * to the `func New(...)` declaration on gin.go:202 (1-based), which is
   * inside ginDir.
   *
   * classifyUri invariant: GO_ADAPTER.classifyUri returns 'workspace' for
   * ALL file:// URIs — the out-of-repo PATH-CONTAINMENT decision is owned
   * by location-mapper.ts, NOT classifyUri. This assertion enforces that
   * invariant: an in-repo URI gets 'workspace', which is what we want.
   */
  it('definition on in-repo New call-site returns Location[] inside ginDir (C7-5)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip
    if (!client || client.getState() !== 'ready') return; // guarded skip

    const result = await client.request<unknown[]>(
      'textDocument/definition',
      {
        textDocument: { uri: ginFileUri },
        // gin.go line 237 (0-based), char 11: `New` in `engine := New()`
        position: { line: 237, character: 11 },
      },
      10_000,
    );

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(
      (result as unknown[]).length,
      'C7-5: textDocument/definition on `New` call-site must return ≥1 Location. ' +
      'If empty: confirm gopls loaded the gin workspace (go.mod present, gin fixture at d75fcd4) ' +
      'and that line 237 char 11 points to the `New` identifier in `engine := New()`.',
    ).toBeGreaterThanOrEqual(1);

    const loc0 = (result as unknown[])[0] as { uri?: string; range?: unknown };
    expect(loc0).toHaveProperty('uri');
    expect(loc0).toHaveProperty('range');

    // URI must be a file:// URI inside ginDir (in-repo definition).
    expect(loc0.uri).toMatch(/^file:\/\//);
    expect(
      loc0.uri!.includes(ginDir),
      `C7-5: definition uri must be inside ginDir (${ginDir}); got: ${loc0.uri}`,
    ).toBe(true);

    // classifyUri invariant: ALL file:// URIs return 'workspace' (not path-containment).
    // This is by design — out-of-repo containment is owned by location-mapper.
    expect(GO_ADAPTER.classifyUri(loc0.uri!)).toBe('workspace');
  }, GOPLS_READY_DEADLINE_MS + 5_000);

  // ── C7-6 + C7-NV (stdlib): external-refusal via mod-cache toolchain ──────

  /**
   * C7-6: gopls stdlib URI (mod-cache toolchain src/) →
   * mapLocationToNodeId(adapterId:'go', repoPath=ginDir) → {kind:'NO_NODE', external:true}.
   *
   * Probes `http.Server` struct type in gin.go line 549 (0-based), char 17.
   * gin.go:550 (1-based) is `\tserver := &http.Server{ // #nosec G112` inside Run().
   * `Server` at char 17 is a reference to net/http.Server (stdlib).
   * gin's `go 1.25.0` puts stdlib in ~/go/pkg/mod/golang.org/toolchain@.../src/
   * (mod-cache toolchain, NOT system GOROOT). The external-refusal is
   * path-containment (`!uri.startsWith(realRepoRoot)`), NOT a GOROOT check.
   *
   * Non-vacuous guard (C7-NV): if gopls returns null/[] at this position,
   * the test fails with an explicit diagnostic rather than passing silently.
   * A vacuous pass means the critical external-refusal path is never exercised.
   *
   * Invariant (location-mapper.ts:470-471): external:true is set by the
   * isExternalRefusalAdapter gate (adapterId==='go'), NOT by classifyUri —
   * classifyUri returns 'workspace' for ALL file:// by design.
   */
  it('stdlib URI (mod-cache toolchain) → external:true via mapper (C7-6, C7-NV)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip
    if (!client || client.getState() !== 'ready') return; // guarded skip

    const result = await client.request<unknown[]>(
      'textDocument/definition',
      {
        textDocument: { uri: ginFileUri },
        // gin.go line 549 (0-based), char 17: `Server` in `&http.Server{`
        // inside Run() at gin.go:550 (1-based). This is a struct literal for
        // the stdlib net/http.Server type — gopls resolves it to the toolchain src.
        position: { line: 549, character: 17 },
      },
      10_000,
    );

    // C7-NV non-vacuous guard: gopls MUST return a non-empty Location[] for
    // this position. null/[] means gopls didn't index stdlib — the containment
    // guard is then never exercised and this test would pass vacuously (wrong).
    expect(
      result !== null && Array.isArray(result) && (result as unknown[]).length > 0,
      'C7-6 / C7-NV: gopls must return a non-empty Location[] for `http.Server` at ' +
      'gin.go line 549 char 17. If empty: confirm gin.go:550 (1-based) is ' +
      '`\tserver := &http.Server{ // #nosec G112`, gopls indexed the workspace, ' +
      'and gin declares go 1.25.0 so stdlib lives in ~/go/pkg/mod/golang.org/toolchain@.../src/. ' +
      'A vacuous pass here means the stdlib external-refusal path is never tested.',
    ).toBe(true);

    const loc0 = (result as unknown[])[0] as { uri?: string; range?: unknown };

    // The URI must be a file:// URI outside ginDir (stdlib, mod-cache toolchain).
    expect(
      loc0.uri !== undefined && loc0.uri.startsWith('file://'),
      `C7-6: expected file:// URI from gopls for http.Server definition; got: ${loc0.uri}`,
    ).toBe(true);

    // Feed through mapper with adapterId:'go'. The path-containment check
    // (uri outside repoPath) + isExternalRefusalAdapter gate must fire.
    const fakeExecute = async () => [];
    const mapResult = await mapLocationToNodeId(
      {
        uri: loc0.uri!,
        range: (loc0.range as { start: { line: number; character: number }; end: { line: number; character: number } })
          ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      'gin-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        classifyUri: (uri) => GO_ADAPTER.classifyUri(uri),
        adapterId: 'go',
        repoPath: ginDir,
      },
    );

    // C7-6 acceptance: stdlib URI outside ginDir → {kind:'NO_NODE', external:true}
    expect(mapResult.kind).toBe('NO_NODE');
    expect(
      (mapResult as { kind: string; external?: boolean }).external,
      `C7-6: expected external:true for stdlib URI outside ginDir. ` +
      `URI was: ${loc0.uri}. ` +
      `Ensure the URI is actually outside ${ginDir} (it should be under ~/go/pkg/mod/... or GOROOT). ` +
      `external:true is set by the isExternalRefusalAdapter path-containment gate in location-mapper.ts, ` +
      `NOT by classifyUri (which returns 'workspace' for all file://).`,
    ).toBe(true);
  }, GOPLS_READY_DEADLINE_MS + 5_000);

  // ── C7-7 + R2-8: third-party dep URI ─────────────────────────────────────

  /**
   * C7-7: gopls third-party dep URI ($GOPATH/pkg/mod/...) →
   * mapLocationToNodeId(adapterId:'go', repoPath=ginDir) → {kind:'NO_NODE', external:true}.
   *
   * Probes `h2c.NewHandler` in gin.go line 248 (0-based), char 12 —
   * `\treturn h2c.NewHandler(engine, h2s)` in Handler(). gin imports
   * `golang.org/x/net/http2/h2c` which gopls resolves to a file:// URI under
   * ~/go/pkg/mod/golang.org/x/net@v.../http2/h2c/... (third-party pkg/mod, NOT toolchain).
   *
   * R2-8: external:true counter is independently non-zero for BOTH C7-6
   * (stdlib toolchain) AND C7-7 (third-party dep). Asserted by checking
   * that this test's mapResult also carries external:true — combined with
   * C7-6, both paths are individually confirmed (not just their union).
   *
   * Non-vacuous guard (C7-NV): null/[] gopls response fails with diagnostic.
   */
  it('third-party dep URI (pkg/mod) → external:true via mapper; R2-8 non-zero for both (C7-7, R2-8)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip
    if (!client || client.getState() !== 'ready') return; // guarded skip

    const result = await client.request<unknown[]>(
      'textDocument/definition',
      {
        textDocument: { uri: ginFileUri },
        // gin.go line 248 (0-based), char 12: `NewHandler` in `h2c.NewHandler(engine, h2s)`
        // inside Handler(). This references golang.org/x/net/http2/h2c (third-party dep).
        position: { line: 248, character: 12 },
      },
      10_000,
    );

    // C7-NV non-vacuous guard: gopls MUST return a non-empty Location[] for
    // `h2c.NewHandler`. null/[] means gopls didn't resolve the dep — vacuous pass.
    expect(
      result !== null && Array.isArray(result) && (result as unknown[]).length > 0,
      'C7-7 / C7-NV: gopls must return a non-empty Location[] for `h2c.NewHandler` at ' +
      'gin.go line 248 char 12. If empty: confirm gopls loaded the module cache ' +
      '(gin imports golang.org/x/net/http2/h2c) and that gin.go:249 (1-based) is ' +
      '`\treturn h2c.NewHandler(engine, h2s)` inside Handler(). ' +
      'A vacuous pass here means the third-party dep external-refusal path is never tested.',
    ).toBe(true);

    const loc0 = (result as unknown[])[0] as { uri?: string; range?: unknown };

    expect(
      loc0.uri !== undefined && loc0.uri.startsWith('file://'),
      `C7-7: expected file:// URI from gopls for h2c.NewHandler definition; got: ${loc0.uri}`,
    ).toBe(true);

    // The URI must be outside ginDir (third-party pkg/mod dep, not in-repo).
    const isOutsideGin = !loc0.uri!.includes(ginDir);
    expect(
      isOutsideGin,
      `C7-7: expected dep URI to be outside ginDir (${ginDir}); ` +
      `got: ${loc0.uri}. If this points inside gin, the call-site position may ` +
      `be wrong — check that gin.go:249 (1-based) is \`\treturn h2c.NewHandler(engine, h2s)\`.`,
    ).toBe(true);

    const fakeExecute = async () => [];
    const mapResult = await mapLocationToNodeId(
      {
        uri: loc0.uri!,
        range: (loc0.range as { start: { line: number; character: number }; end: { line: number; character: number } })
          ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      'gin-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        classifyUri: (uri) => GO_ADAPTER.classifyUri(uri),
        adapterId: 'go',
        repoPath: ginDir,
      },
    );

    // C7-7 acceptance: third-party dep URI outside ginDir → {kind:'NO_NODE', external:true}
    expect(mapResult.kind).toBe('NO_NODE');
    expect(
      (mapResult as { kind: string; external?: boolean }).external,
      `C7-7: expected external:true for third-party dep URI outside ginDir. ` +
      `URI was: ${loc0.uri}. ` +
      `This is the R2-8 non-zero check for the golang.org/x/net/http2/h2c (non-toolchain) path. ` +
      `C7-6 covers the toolchain stdlib path — together they confirm the ` +
      `external:true counter is non-zero for BOTH URI classes (R2-8 independence).`,
    ).toBe(true);

    // R2-8: Both C7-6 and C7-7 independently produce external:true.
    // C7-6 is asserted in the preceding test; this assertion confirms the
    // THIRD-PARTY path also produces external:true (not just the stdlib path).
    // Together: the external:true counter is non-zero for both URI classes,
    // not just their sum (ruling R2-8 independence).
    expect(
      (mapResult as { kind: string; external?: boolean }).external === true &&
      isOutsideGin,
      'R2-8: third-party dep counter (external:true AND outside ginDir) must be non-zero. ' +
      'This independently confirms the pkg/mod path, distinct from the toolchain stdlib path in C7-6.',
    ).toBe(true);
  }, GOPLS_READY_DEADLINE_MS + 5_000);

});

// ─── WI-7c: Mode-A augmentation floor + funnel regression ────────────────────

/**
 * WI-7c acceptance gate: Mode-A augmentation floor + TS/Java/Python funnel
 * green-suite regression band.
 *
 * Technique:
 *   - Flow-Based Coverage (C7-10): runPipelineFromRepo → Mode-A confirm/correct
 *     counters; scouting advisory when floor(count*0.8) > AUGMENTATION_FLOOR.
 *   - EP + additive-widening invariant (C7-11): discoverServers() shape
 *     contract — typescript key always present; java/python/go optional but
 *     must match shape when non-null.
 *   - Decision Table (C7-PIN): gin HEAD pin guard — if gin not at d75fcd4,
 *     explicit failure (not skip). Mirrors CRAWL4AI_PINNED_SHA gate in Python.
 *
 * Gate conditions (ALL must be satisfied for C7-10):
 *   1. GITNEXUS_GO_HEAVY_IT=1 env var (heavy opt-in — never runs in standard
 *      CI/dev loop).
 *   2. gopls binary discoverable (goplsBinary non-null).
 *   3. gin fixture present at GIN_DIR (ginDir non-null).
 *   4. gin HEAD === d75fcd4 (C7-PIN — enforced inside the test, explicit
 *      failure when present-but-wrong, not a guarded skip).
 *
 * C7-11 (funnel green-suite) runs whenever gopls is discoverable and gin is
 * present, regardless of GITNEXUS_GO_HEAVY_IT. It is a shape contract check
 * (additive-widening invariant), NOT a byte-diff (no stored baseline artifact
 * exists — documented divergence from WI-7c spec note "realized form of
 * zero-diff since no stored baseline artifact exists").
 *
 * AUGMENTATION_FLOOR = 184:
 *   Scouting run (gin@d75fcd4, gopls v0.22.0, 2026-06-14):
 *   confirmed=208, corrected=22, total=230.
 *   Floor = floor(230 * 0.8) = 184 (ruling R2-8 calibration from Python B-9).
 *   The Default→New edge in gin.go (func Default calls func New) is the
 *   minimal guarantee; the scouting run confirmed 230 edges total on the
 *   pinned fixture, so the floor is tightened to 184.
 *
 * Scouting advisory (non-failing):
 *   When floor(count*0.8) > AUGMENTATION_FLOOR, a console.warn is emitted
 *   to prompt tightening the floor. This is maintenance guidance, not a
 *   failure — consistent with the Python B-9 pattern.
 *
 * Timeout: 300 s (full analyze --lsp on a real Go repo, cold-cache gopls).
 */
describe('gopls real-binary — Mode-A augmentation floor + funnel regression (WI-7c)', () => {

  /**
   * C7-11: discoverServers() shape contract — additive-widening invariant.
   *
   * The DiscoveredServers type uses additive optional keys (java?, python?, go?).
   * This test verifies the shape invariant holds after P4:
   *   - `typescript` key is ALWAYS present (required field).
   *   - `java`, `python`, `go` keys are optional but, when non-null, have the
   *     expected { path: string, version: string } shape.
   *
   * Realized form of "zero-diff funnel green-suite" (WI-7c spec):
   *   No byte-diff baseline artifact exists. The contract check verifies the
   *   additive-widening invariant (server-discovery.ts:397-402) is satisfied
   *   without referencing a stored snapshot. The unit suites for
   *   server-discovery, language-adapter, and canary-sampler confirm
   *   zero-regression at the lower level; this test confirms the end-to-end
   *   discoverServers() shape is compatible with the narrower pre-P4 callers
   *   that only typed `typescript` as a required key.
   *
   * Runs whenever gopls is discoverable and gin is present (not heavy-gated).
   * Timeout: 60 s (discoverServers() probes npx as last resort).
   */
  it('discoverServers returns typescript + optional java/python/go with correct shape (C7-11)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip

    const servers = await discoverServers();

    // typescript is a REQUIRED key (non-optional in DiscoveredServers).
    // Shape: DiscoveredServer | null (null when binary absent, never undefined).
    expect(
      'typescript' in servers,
      'C7-11: discoverServers() must always return a typescript key ' +
      '(required field in DiscoveredServers — additive-widening invariant). ' +
      'If missing, the DiscoveredServers type contract was broken.',
    ).toBe(true);

    // The typescript value is DiscoveredServer | null. When non-null it must
    // have the {path: string, version: string} shape.
    if (servers.typescript !== null && servers.typescript !== undefined) {
      expect(typeof servers.typescript.path).toBe('string');
      expect(typeof servers.typescript.version).toBe('string');
    }

    // Optional keys (java?, python?, go?): when present and non-null,
    // must have the {path: string, version: string} shape.
    // This is the additive-widening invariant: existing callers typed only
    // `typescript` as required; the P4 addition of `go?` must not break them.
    const optionalKeys = ['java', 'python', 'go'] as const;
    for (const key of optionalKeys) {
      const entry = servers[key];
      if (entry !== null && entry !== undefined) {
        expect(
          typeof entry.path,
          `C7-11: discoverServers().${key}.path must be string when non-null`,
        ).toBe('string');
        expect(
          entry.path.length,
          `C7-11: discoverServers().${key}.path must be truthy (non-empty) when non-null`,
        ).toBeGreaterThan(0);
        expect(
          typeof entry.version,
          `C7-11: discoverServers().${key}.version must be string when non-null`,
        ).toBe('string');
        expect(
          entry.version.length,
          `C7-11: discoverServers().${key}.version must be truthy (non-empty) when non-null`,
        ).toBeGreaterThan(0);
      }
    }

    // go key MUST be non-null when gopls is on PATH (goplsBinary is non-null
    // at this point — the outer guard already confirmed it). Shape validated
    // above via the optionalKeys loop; this assertion confirms the key is
    // populated (not silently dropped).
    expect(
      servers.go,
      'C7-11: discoverServers().go must be non-null when gopls is on PATH ' +
      '(goplsBinary is non-null — WI-4 additive spread must include the go key). ' +
      'If null, check that discoverOne(GOPLS_BIN) is included in discoverServers().',
    ).not.toBeNull();
    expect(servers.go).not.toBeUndefined();
  }, 60_000);

  /**
   * C7-PIN + C7-10 (heavy, GITNEXUS_GO_HEAVY_IT=1):
   *
   * C7-PIN: pinned-commit guard — if gin is at a different commit than d75fcd4,
   * the test FAILS explicitly (not skip-clean). This mirrors the
   * CRAWL4AI_PINNED_SHA gate in python-pylsp-real.test.ts and ensures
   * AUGMENTATION_FLOOR is reproducible across machines (ruling R2-8).
   * The pin is an INNER guard (inside the heavy opt-in check) because the
   * floor only matters when the heavy run executes.
   *
   * C7-10: Flow-Based Coverage — Mode-A augmentation floor.
   * runPipelineFromRepo(ginDir, () => {}, {skipGraphPhases:true,
   * lsp:{enabled:true, dryRun:false}}) → lspReport present;
   * (confirmed ?? 0) + (corrected ?? 0) >= AUGMENTATION_FLOOR(=1).
   *
   * AUGMENTATION_FLOOR rationale:
   *   The gin.go Default() function calls New() on the same file. This
   *   Default→New edge is a CALL edge with a deterministic in-repo Definition
   *   target. On the pinned d75fcd4 gin checkout, Mode-A MUST confirm or
   *   correct at least this one edge. Floor = 1 (WI-7c invariant).
   *   After the first heavy run, update to floor(observed*0.8) per ruling R2-8.
   *
   * Scouting advisory (non-failing, console.warn):
   *   When floor(count*0.8) > AUGMENTATION_FLOOR, warn that the floor should
   *   be tightened. Consistent with B-9 pattern in python-pylsp-real.test.ts.
   *
   * Timeout: 300 s (cold-cache gopls + full Mode-A reconciliation on gin).
   */
  it('Mode-A augmentation floor >= 1 on gin@d75fcd4 (C7-PIN, C7-10)', async () => {
    if (!goplsBinary || !ginDir) return; // guarded skip

    // ── Heavy opt-in gate ─────────────────────────────────────────────
    // This test MUST NOT run in standard CI or dev loops. Set
    // GITNEXUS_GO_HEAVY_IT=1 to enable (same pattern as GITNEXUS_PYTHON_HEAVY_IT).
    if (!process.env['GITNEXUS_GO_HEAVY_IT']) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:go-gopls-real:WI-7c] SKIP C7-10 — set GITNEXUS_GO_HEAVY_IT=1 to enable Mode-A augmentation heavy run',
      );
      return;
    }

    // ── C7-PIN: pinned-commit guard ───────────────────────────────────
    // The AUGMENTATION_FLOOR is calibrated against gin at d75fcd4. Running
    // against a different commit is an explicit failure (not a skip), to
    // prevent a floor calibrated on one revision from silently passing on
    // a HEAD that has fewer CALL edges.
    //
    // Unlike CRAWL4AI_PINNED_SHA (which is injected as an env var), the gin
    // pin is HARDCODED here because the gin fixture path is also hardcoded
    // and both are on the maintainer's machine. The env-var pattern is only
    // needed when the fixture is not a committed path.
    const GIN_PINNED_SHA = 'd75fcd4';
    const actualGinSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ginDir,
      encoding: 'utf8',
    }).trim();

    expect(
      // git rev-parse --short outputs 7 chars by default; d75fcd4 is 7 chars.
      // Allow either the full 40-char SHA or the 7-char short SHA to match.
      actualGinSha.startsWith(GIN_PINNED_SHA) || GIN_PINNED_SHA.startsWith(actualGinSha),
      `C7-PIN: gin checkout is not at the pinned commit. ` +
      `Expected HEAD starting with ${GIN_PINNED_SHA}, got ${actualGinSha}. ` +
      `Check out the pinned commit before running this test: ` +
      `\`git -C ${ginDir} checkout ${GIN_PINNED_SHA}\`. ` +
      `Without a pinned commit, AUGMENTATION_FLOOR=${1} is a local-machine artifact ` +
      `with no reproducibility guarantee (ruling R2-8 / WI-7c).`,
    ).toBe(true);

    // ── C7-10: Mode-A augmentation floor ─────────────────────────────
    // Run the full LSP-augmented pipeline on the pinned gin fixture.
    // skipGraphPhases:true avoids writing to any persistent DB; we only need
    // the lspReport from the in-memory reconciler.
    const pipelineResult = await runPipelineFromRepo(
      ginDir,
      () => {}, // progress callback (no-op)
      {
        skipGraphPhases: true,
        lsp: { enabled: true, dryRun: false },
      },
    );

    const lspReport = pipelineResult.lspReport;

    // lspReport must be present when lsp.enabled:true (not null/undefined).
    expect(
      lspReport,
      'C7-10: runPipelineFromRepo with lsp:{enabled:true} must produce a non-null lspReport. ' +
      'If null, LSP reconciliation did not run — check that GO_ADAPTER was selected by ' +
      'selectAdapter() for the gin fixture (gin is a Go-dominant repo, go 1.25.0).',
    ).not.toBeNull();
    expect(lspReport).not.toBeUndefined();

    // Mode-A augmentation count: confirmed + corrected edges.
    // Scouting run (gin@d75fcd4, gopls v0.22.0, 2026-06-14):
    //   confirmed=208, corrected=22, total=230, recall=337, refused=7292.
    // Floor = floor(230 * 0.8) = 184 (ruling R2-8; tightened from initial floor=1
    // after the first successful heavy run confirmed the Default→New guarantee).
    const AUGMENTATION_FLOOR = 184;
    const augmentationCount = (lspReport?.confirmed ?? 0) + (lspReport?.corrected ?? 0);

    expect(
      augmentationCount,
      `C7-10: Mode-A augmentation (confirmed+corrected) on gin@${GIN_PINNED_SHA} must be ` +
      `>= ${AUGMENTATION_FLOOR}. Got: confirmed=${lspReport?.confirmed}, ` +
      `corrected=${lspReport?.corrected}, recall=${lspReport?.recall}, ` +
      `refused=${lspReport?.refused}. ` +
      `Scouting baseline: confirmed=208, corrected=22, total=230 (2026-06-14, gopls v0.22.0). ` +
      `Floor = floor(230 * 0.8) = 184. ` +
      `If below floor: (1) confirm GO_ADAPTER.awaitReady resolved via the notification path ` +
      `(not the canary backstop — C7-4 timing proxy); (2) verify gin is at ${GIN_PINNED_SHA} ` +
      `(C7-PIN above); (3) check gopls version matches scouting binary (v0.22.0).`,
    ).toBeGreaterThanOrEqual(AUGMENTATION_FLOOR);

    // ── V-6(d): mis-map oracle — Invariant I-2 (mirrors Python B-11) ─────
    // Every lsp-confirmed / lsp-corrected / lsp-recall relationship in the
    // result graph MUST have a target node whose file path is strictly inside
    // ginDir. A target node whose path is outside ginDir is a mis-map:
    // a mod-cache or GOROOT URI that was incorrectly routed as 'workspace'
    // and resolved to a graph node. The WI-V plan and Invariant I-2 require
    // mis-map count === 0 as a blocking acceptance gate.
    //
    // Implementation mirrors python-pylsp-real.test.ts B-11 (lines 737–791):
    //   1. Iterate all graph relationships with lsp source stamps.
    //   2. Look up the target node in the graph.
    //   3. Derive the absolute file path from node.properties.filePath.
    //   4. Assert path.relative(ginDir, absPath) does NOT start with '..'.
    //
    // NodeId format: the reconciler uses generateId(label, name) which
    // produces a label:name string; the file path lives on the node object
    // under properties.filePath (absolute or repo-relative).
    //
    // The assertion is non-vacuous because AUGMENTATION_FLOOR >= 184 (passed
    // above), so the graph contains at least 184 lsp-augmented edges whose
    // target nodes are in scope for the containment check.
    const lspSources = new Set(['lsp-confirmed', 'lsp-corrected', 'lsp-recall']);
    let misMaps = 0;

    for (const rel of pipelineResult.graph.iterRelationships()) {
      // Skip undefined-sourced edges — they are not LSP edges.
      if (rel.source === undefined || !lspSources.has(rel.source)) continue;

      // Look up the target node in the graph.
      const targetNode = pipelineResult.graph.getNode(rel.targetId);
      if (!targetNode) continue; // node absent from graph — skip

      // The graph node stores filePath under properties.filePath.
      // Shape: GraphNode { id, label, properties: { filePath?: string, ... } }
      const nodePath = targetNode.properties.filePath;
      if (!nodePath || typeof nodePath !== 'string') continue; // no path attr

      // Resolve to absolute for containment check.
      // nodePath may be repo-relative (no leading '/') — join with ginDir.
      const absNodePath = path.isAbsolute(nodePath)
        ? nodePath
        : path.resolve(ginDir, nodePath);

      const relPath = path.relative(ginDir, absNodePath);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        // The target node's file path is OUTSIDE ginDir — this is a mis-map.
        misMaps++;
        // eslint-disable-next-line no-console
        console.error(
          `[IT:go-gopls-real] V-6(d) MIS-MAP: nodeId=${rel.targetId} ` +
          `filePath=${nodePath} is outside ginDir (rel=${relPath}). ` +
          `This means a mod-cache or GOROOT URI was incorrectly routed as ` +
          `'workspace' by the Go LSP adapter and resolved to a graph node. ` +
          `Check: (1) isExternalRefusalAdapter gate in location-mapper.ts; ` +
          `(2) GO_ADAPTER path-containment uses realpathSync-resolved ginDir; ` +
          `(3) adapterId:'go' is threaded through the deps bag.`,
        );
      }
    }

    expect(
      misMaps,
      `V-6(d) / I-2 mis-map oracle violated: ${misMaps} lsp-edge target(s) resolve to ` +
      `file paths outside ginDir (${ginDir}). ` +
      `Every NodeId returned for a Go LSP edge must resolve to a path strictly ` +
      `inside gin's repoPath per Invariant I-2. ` +
      `A mis-map means a mod-cache or GOROOT URI slipped through the external-refusal ` +
      `gate and was incorrectly indexed as a workspace symbol. ` +
      `See WI-V plan step V-6(d) and python-pylsp-real.test.ts B-11 for the oracle pattern.`,
    ).toBe(0);

    // ── Scouting advisory (non-failing) ──────────────────────────────
    // When floor(count*0.8) > AUGMENTATION_FLOOR, emit a console.warn to
    // prompt tightening the floor constant. The advisory is NEVER a failure.
    // Pattern from python-pylsp-real.test.ts B-9 (ruling R2-8).
    if (Math.floor(augmentationCount * 0.8) > AUGMENTATION_FLOOR) {
      const recommended = Math.floor(augmentationCount * 0.8);
      // eslint-disable-next-line no-console
      console.warn(
        `[C7-10 SCOUTING ADVISORY] AUGMENTATION_FLOOR (${AUGMENTATION_FLOOR}) is below ` +
        `observed augmentation count (${augmentationCount}). ` +
        `Consider updating AUGMENTATION_FLOOR to ${recommended} ` +
        `(= floor(${augmentationCount} * 0.8)) to tighten the regression guard ` +
        `(ruling R2-8 / WI-7c). This is a maintenance advisory, not a failure. ` +
        `Record the observed count in a comment next to AUGMENTATION_FLOOR.`,
      );
    }
  }, 300_000);

});
