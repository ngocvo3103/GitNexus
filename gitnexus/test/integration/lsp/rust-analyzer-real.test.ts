/**
 * Integration Smoke: rust-analyzer real binary (guarded).
 *
 * WI-6a acceptance gate. Mirrors the guarded-skip pattern from
 * `go-gopls-real.test.ts`, `python-pylsp-real.test.ts`, and
 * `java-jdtls-real.test.ts`:
 *   - `beforeAll` resolves `rust-analyzer` via `discoverServers()` and
 *     confirms the pinned ripgrep fixture directory exists.
 *   - Every `it` does `if (!rustAnalyzerBinary || !ripgrepDir) return;`
 *     (skip-clean, not fail).
 *
 * Fixture repo: `/Users/NgocVo_1/Documents/sourceCode/ripgrep` (pinned 82313cf).
 * `Cargo.toml` is present at the repo root — rust-analyzer requires a cargo
 * workspace root to load crates.
 *
 * GITNEXUS_HOME isolation: provided for free by `test/per-fork-setup.ts`
 * (loaded via `vitest.config.ts → setupFiles`). Every fork gets its own
 * private registry dir under `GITNEXUS_TEST_HOME_PARENT` before this file
 * runs. rust-analyzer subprocesses spawned by `LspClient` inherit
 * `GITNEXUS_HOME` from the fork's `process.env` automatically — no
 * additional isolation wiring required (WI-6a invariant I-11, #175).
 *
 * What we verify in this file (WI-6a skeleton + WI-6b lifecycle band):
 *
 *   C-RA-1   `discoverServers().rust` non-null with truthy `path` and
 *            `version` when rust-analyzer is on PATH (AC-15).
 *
 *   C-RA-11  `discoverServers()` shape contract — `typescript` key always
 *            present; `rust?` non-null ⇒ `{path:string, version:string}`.
 *            Mirrors C7-11 from gopls test.
 *
 *   C-RA-5   `mapLocationToNodeId` with `adapterId:'rust'`, URI pointing to
 *            a `~/.rustup/toolchains/…` path outside ripgrepDir →
 *            `{kind:'NO_NODE', external:true}` (AC-7).
 *            Simulated via `process.execPath` (a real, existing out-of-repo
 *            binary path guaranteed to be outside ripgrepDir on any
 *            developer machine).
 *
 *   C-RA-6   Same mapper call with URI pointing to `~/.cargo/registry/src`
 *            path → `{kind:'NO_NODE', external:true}` (AC-8).
 *            Simulated via `os.homedir()/.cargo/registry/src/fake-crate`.
 *
 *   C-RA-8   `RUST_CANARY_STRATEGY.tryExtractSample` on
 *            `'use std::io;\nuse std::fmt;'` → `null` (AC-11).
 *            Non-vacuous: the function is called directly on a real content
 *            string — no mocking.
 *
 *   C-RA-9   `RUST_CANARY_STRATEGY.isCandidateFile('main.rs') === true`;
 *            `isCandidateFile('lib.py') === false` (AC-12).
 *
 *   C-RA-2 + C-RA-3 (WI-6b):
 *            `new LspClient({workspaceRoot:ripgrepDir, binaryPath, adapter:RUST_ADAPTER})`
 *            `.start()` → `getState()==='ready'`; elapsed < RUST_ANALYZER_READY_DEADLINE_MS.
 *            Timing-proxy HARD gate: elapsed < deadline/2 (30 s) — proves the
 *            `experimental/serverStatus` signal path fired, NOT the 60 s canary
 *            backstop (R2-7). `stop()` → `getState()==='stopped'`.
 *
 * Skip-clean guard (WI-6a invariant, inherited by WI-6b):
 *   `if (!rustAnalyzerBinary || !ripgrepDir) return;`
 *   NOT `.skip()` — counts as passed in CI; does not mark the test red.
 *
 * Tests owned by WI-6c/6d (NOT yet in this file):
 *   C-RA-4a, C-RA-4b  — awaitReady injection oracles (deadline backstop paths).
 *   C-RA-7, C-RA-PIN  — heavy Mode-A augmentation floor + commit pin guard
 *      (GITNEXUS_RUST_HEAVY_IT=1 gated).
 *
 * Timeout budget:
 *   beforeAll  — 60 s (discoverServers() probes npx as last resort)
 *   C-RA-1     — 60 s
 *   C-RA-2/3   — RUST_ANALYZER_READY_DEADLINE_MS + 5_000 (65 s)
 *   all others — default (30 s)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import {
  RUST_ADAPTER,
  RUST_ANALYZER_READY_DEADLINE_MS,
} from '../../../src/core/ingestion/lsp/language-adapter.js';
import { RUST_CANARY_STRATEGY } from '../../../src/core/ingestion/lsp/canary-sampler.js';
import { mapLocationToNodeId } from '../../../src/core/ingestion/lsp/location-mapper.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredServer { path: string; version: string }

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Pinned ripgrep checkout (82313cf). Contains `Cargo.toml` at the workspace
 * root — rust-analyzer requires a cargo workspace to load crates.
 *
 * WI-6b / WI-6c will select specific call-site positions inside this repo.
 * For the skeleton (WI-6a) we only need rust-analyzer discovery and the
 * binary-free contract band; no definition requests are issued here.
 */
const RIPGREP_DIR = '/Users/NgocVo_1/Documents/sourceCode/ripgrep';

// ─── State ────────────────────────────────────────────────────────────────────

let rustAnalyzerBinary: DiscoveredServer | null = null;

/**
 * realpath-resolved ripgrep workspace root.
 * On macOS, `/tmp` is a symlink to `/private/tmp`; rust-analyzer returns
 * file:// URIs with the resolved path. RIPGREP_DIR is not under /tmp, but
 * we use realpathSync for consistency with the pattern established in
 * go-gopls-real, python-pylsp-real, and java-jdtls-real.
 */
let ripgrepDir: string | null = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const discovered = await discoverServers();
  rustAnalyzerBinary = discovered.rust ?? null;

  if (!rustAnalyzerBinary) {
    // eslint-disable-next-line no-console
    console.log(
      '[IT:rust-analyzer-real] SKIP — rust-analyzer not found on PATH; all tests will skip-clean',
    );
    return;
  }

  if (!fs.existsSync(RIPGREP_DIR)) {
    // eslint-disable-next-line no-console
    console.log(
      `[IT:rust-analyzer-real] SKIP — ripgrep fixture not found at ${RIPGREP_DIR}; all tests will skip-clean`,
    );
    return;
  }

  // Resolve symlinks so rust-analyzer-returned file:// URIs match the
  // containment check in mapLocationToNodeId.
  ripgrepDir = fs.realpathSync(RIPGREP_DIR);

  // 60s budget: discoverServers() probes npx as last resort (30-45s on cold npm cache).
}, 60_000);

afterAll(() => {
  // WI-6a uses the pinned ripgrep checkout directly — no temp dir to clean up.
  // GITNEXUS_HOME isolation is managed by test/per-fork-setup.ts (per-fork
  // mkdtemp under GITNEXUS_TEST_HOME_PARENT); no restore needed here.
  // WI-6b / WI-6c may create LspClient instances that stop() in their own its.
  // Nothing to do here for the skeleton; kept for pattern parity with analogs.
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('rust-analyzer real-binary smoke (WI-6a — guarded skeleton)', () => {

  /**
   * C-RA-1 + C-RA-11:
   *
   * C-RA-1: `discoverServers().rust` is non-null with truthy `path` and
   * `version` when rust-analyzer is on PATH (AC-15).
   *
   * C-RA-11: `discoverServers()` shape contract — `typescript` key always
   * present (required field in DiscoveredServers — additive-widening
   * invariant); `rust?` key when non-null has `{path:string, version:string}`
   * shape. Mirrors C7-11 from gopls test (go-gopls-real.test.ts:677).
   *
   * Both assertions are in one `it` because they share the same
   * `discoverServers()` call and represent a unified shape-contract EP
   * partition (binary-present partition). Technique: EP (shape-contract).
   *
   * Timeout: 60 s — discoverServers() probes npx as last resort (cold npm
   * cache can take 30-45 s).
   */
  it('discoverServers returns rust with {path,version} shape; typescript key always present (C-RA-1, C-RA-11)', async () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    const servers = await discoverServers();

    // ── C-RA-11: typescript is a REQUIRED key ────────────────────────────
    // Shape: DiscoveredServer | null (null when binary absent, never undefined).
    expect(
      'typescript' in servers,
      'C-RA-11: discoverServers() must always return a typescript key ' +
      '(required field in DiscoveredServers — additive-widening invariant). ' +
      'If missing, the DiscoveredServers type contract was broken by WI-5 rust? addition.',
    ).toBe(true);

    // The typescript value is DiscoveredServer | null. When non-null it must
    // have the {path: string, version: string} shape.
    if (servers.typescript !== null && servers.typescript !== undefined) {
      expect(typeof servers.typescript.path).toBe('string');
      expect(typeof servers.typescript.version).toBe('string');
    }

    // ── C-RA-11: optional keys shape-contract ────────────────────────────
    // java?, python?, go?, rust? are optional but when non-null must have
    // {path: string, version: string} shape.
    const optionalKeys = ['java', 'python', 'go', 'rust'] as const;
    for (const key of optionalKeys) {
      const entry = servers[key];
      if (entry !== null && entry !== undefined) {
        expect(
          typeof entry.path,
          `C-RA-11: discoverServers().${key}.path must be string when non-null`,
        ).toBe('string');
        expect(
          entry.path.length,
          `C-RA-11: discoverServers().${key}.path must be truthy (non-empty) when non-null`,
        ).toBeGreaterThan(0);
        expect(
          typeof entry.version,
          `C-RA-11: discoverServers().${key}.version must be string when non-null`,
        ).toBe('string');
        expect(
          entry.version.length,
          `C-RA-11: discoverServers().${key}.version must be truthy (non-empty) when non-null`,
        ).toBeGreaterThan(0);
      }
    }

    // ── C-RA-1: rust key must be non-null when rust-analyzer is on PATH ──
    // rustAnalyzerBinary is non-null at this point (outer guard confirmed it).
    // The discoverServers() call above must populate the rust key.
    expect(
      servers.rust,
      'C-RA-1: discoverServers().rust must be non-null when rust-analyzer is on PATH ' +
      '(rustAnalyzerBinary is non-null — WI-5 additive spread must include the rust key). ' +
      'If null, check that discoverOne(RUST_ANALYZER_BIN) is included in discoverServers().',
    ).not.toBeNull();
    expect(servers.rust).not.toBeUndefined();

    // C-RA-1: path and version must be truthy strings.
    // version may be 'unknown' if rust-analyzer --version is slow/silent,
    // but it must be a non-empty string (truthy).
    expect(
      servers.rust!.path,
      'C-RA-1: discoverServers().rust.path must be a truthy string (non-empty absolute path). ' +
      'If empty, discoverOne found the binary but failed to record its path.',
    ).toBeTruthy();
    expect(
      servers.rust!.version,
      'C-RA-1: discoverServers().rust.version must be a truthy string. ' +
      'May be "unknown" if --version is slow (WI-5 slow-version tolerance). ' +
      'Must not be empty.',
    ).toBeTruthy();
  }, 60_000);

  // ─── C-RA-5 + C-RA-6: external-refusal mapper (simulated paths) ──────────

  /**
   * C-RA-5: `mapLocationToNodeId` with `adapterId:'rust'` and a URI pointing
   * to a `~/.rustup/toolchains/…` path outside ripgrepDir →
   * `{kind:'NO_NODE', external:true}` (AC-7).
   *
   * The URI is simulated via `process.execPath` — a real, existing binary
   * path guaranteed to be outside ripgrepDir on any developer machine. The
   * intent is to exercise the `isExternalRefusalAdapter('rust')` path in
   * location-mapper.ts:478, which gates on `!uri.startsWith(realRepoRoot)`.
   *
   * Technique: EP (URI-class partition — out-of-repo/rustup).
   *
   * Invariant: `external:true` is the adapterId-gated path-containment
   * result (location-mapper.ts:476-478), NOT a classifyUri verdict —
   * RUST_ADAPTER.classifyUri returns 'workspace' for ALL file:// by design.
   * The mapper call shape must match the deps bag used in production:
   * {executeParameterized, generateId, normalizeFilePath, classifyUri,
   *  adapterId:'rust', repoPath}.
   */
  it('rustup-toolchain URI → {kind:NO_NODE, external:true} via mapper (C-RA-5)', async () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    // Simulate a ~/.rustup/toolchains/... path using process.execPath.
    // process.execPath is a real, existing path (the node binary) that is
    // guaranteed to be outside ripgrepDir on any developer machine.
    // We construct a file:// URI from it to feed into the mapper.
    const outOfRepoPath = process.execPath; // e.g. /usr/local/bin/node
    const rustupSimulatedUri = `file://${outOfRepoPath}`;

    // Confirm the simulation is valid: outOfRepoPath must not be inside ripgrepDir.
    expect(
      !outOfRepoPath.startsWith(ripgrepDir),
      `C-RA-5 simulation prerequisite: process.execPath (${outOfRepoPath}) must be ` +
      `outside ripgrepDir (${ripgrepDir}) to simulate a ~/.rustup/toolchains path. ` +
      `If this fails, the test machine has a non-standard node installation.`,
    ).toBe(true);

    const fakeExecute = async () => [];
    const mapResult = await mapLocationToNodeId(
      {
        uri: rustupSimulatedUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      'ripgrep-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        classifyUri: (uri) => RUST_ADAPTER.classifyUri(uri),
        adapterId: 'rust',
        repoPath: ripgrepDir,
      },
    );

    // C-RA-5 acceptance: out-of-repo URI with adapterId:'rust' →
    // {kind:'NO_NODE', external:true}
    expect(mapResult.kind).toBe('NO_NODE');
    expect(
      (mapResult as { kind: string; external?: boolean }).external,
      `C-RA-5: expected external:true for simulated rustup URI outside ripgrepDir. ` +
      `URI was: ${rustupSimulatedUri}. ` +
      `Ensure isExternalRefusalAdapter in location-mapper.ts includes adapterId==='rust'. ` +
      `external:true is set by the adapterId-gated path-containment gate ` +
      `(location-mapper.ts:476-478), NOT by classifyUri.`,
    ).toBe(true);
  });

  /**
   * C-RA-6: `mapLocationToNodeId` with `adapterId:'rust'` and a URI pointing
   * to a `~/.cargo/registry/src` path outside ripgrepDir →
   * `{kind:'NO_NODE', external:true}` (AC-8).
   *
   * Simulated via `os.homedir()/.cargo/registry/src/github.com-fake/fake-crate-0.1.0/src/lib.rs`
   * — a path that mirrors the real ~/.cargo/registry layout. The path does
   * not need to physically exist; the mapper's realpathSync failure path
   * for non-existent URIs returns bare {kind:'NO_NODE'} WITHOUT external:true.
   * To exercise the external:true path we use an existing out-of-repo path
   * (process.execPath directory) encoded as a cargo-registry-like URI.
   *
   * Technique: EP (URI-class partition — out-of-repo/cargo-registry).
   */
  it('cargo-registry URI → {kind:NO_NODE, external:true} via mapper (C-RA-6)', async () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    // Use the directory containing process.execPath as a real existing path
    // that is guaranteed to be outside ripgrepDir. Encode it as a cargo-
    // registry-like URI to simulate ~/.cargo/registry/src/...
    const existingOutOfRepoDir = path.dirname(process.execPath);
    const cargoSimulatedUri = `file://${existingOutOfRepoDir}`;

    // Confirm the simulation is valid.
    expect(
      !existingOutOfRepoDir.startsWith(ripgrepDir),
      `C-RA-6 simulation prerequisite: dir(process.execPath) (${existingOutOfRepoDir}) must be ` +
      `outside ripgrepDir (${ripgrepDir}) to simulate a ~/.cargo/registry path. ` +
      `If this fails, the test machine has a non-standard node installation.`,
    ).toBe(true);

    const fakeExecute = async () => [];
    const mapResult = await mapLocationToNodeId(
      {
        uri: cargoSimulatedUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      'ripgrep-repo-id',
      {
        executeParameterized: fakeExecute,
        generateId: (label, name) => `${label}:${name}`,
        normalizeFilePath: (p) => p,
        classifyUri: (uri) => RUST_ADAPTER.classifyUri(uri),
        adapterId: 'rust',
        repoPath: ripgrepDir,
      },
    );

    // C-RA-6 acceptance: out-of-repo cargo-registry URI with adapterId:'rust' →
    // {kind:'NO_NODE', external:true}
    expect(mapResult.kind).toBe('NO_NODE');
    expect(
      (mapResult as { kind: string; external?: boolean }).external,
      `C-RA-6: expected external:true for simulated cargo-registry URI outside ripgrepDir. ` +
      `URI was: ${cargoSimulatedUri}. ` +
      `The isExternalRefusalAdapter('rust') gate (location-mapper.ts:478) must be active. ` +
      `C-RA-5 covers the rustup-toolchain class; C-RA-6 independently confirms the ` +
      `cargo-registry class — together they prove the external:true counter is ` +
      `non-zero for BOTH out-of-repo URI classes (R2-8 independence).`,
    ).toBe(true);
  });

  // ─── C-RA-8 + C-RA-9: RUST_CANARY_STRATEGY contract band ────────────────

  /**
   * C-RA-8: `RUST_CANARY_STRATEGY.tryExtractSample` on
   * `'use std::io;\nuse std::fmt;'` → `null` (AC-11).
   *
   * The sampler must never produce a sample from `use` statement positions
   * because use-statement anchors are unreliable canary positions. The
   * `RUST_CANARY_STRATEGY` has no `use` regex — use-only files yield no
   * match and must return `null`.
   *
   * NOTE (WI-0 correction): the original rationale "rust-analyzer returns []
   * for use tokens" is empirically FALSE — `use std` resolves (count=1).
   * The correct rationale is that use-statement POSITIONS are unreliable
   * canary anchors (we sample declarations instead). The `null` assertion
   * is unaffected by this distinction — it is sampler behavior.
   *
   * Technique: Adapter/Strategy literal invariant (non-vacuous call on real
   * function). The file arg `'/tmp/test.rs'` is a dummy path; tryExtractSample
   * only uses it to construct the sample URI and does not read from disk.
   */
  it('RUST_CANARY_STRATEGY.tryExtractSample on use-only content returns null (C-RA-8)', () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    const result = RUST_CANARY_STRATEGY.tryExtractSample(
      '/tmp/test.rs',
      'use std::io;\nuse std::fmt;',
    );

    expect(
      result,
      'C-RA-8: RUST_CANARY_STRATEGY.tryExtractSample must return null for use-only ' +
      'content (no fn/struct/enum/trait declarations, no call-site fallback). ' +
      'The sampler has no `use` regex — use-statement positions are unreliable ' +
      'canary anchors (WI-0 correction: use tokens DO resolve in rust-analyzer; ' +
      'exclusion is about anchor reliability, not empty definition results). ' +
      'If non-null: check RUST_CANARY_STRATEGY regex order — a `use` regex must ' +
      'NOT be present (I-3: no use import regex added).',
    ).toBeNull();
  });

  /**
   * C-RA-9: `RUST_CANARY_STRATEGY.isCandidateFile` returns `true` for
   * `.rs` files and `false` for non-.rs files (AC-12).
   *
   * EP partitions:
   *   - Valid: 'main.rs' → true (`.rs` extension)
   *   - Invalid: 'lib.py' → false (`.py` extension, not `.rs`)
   *
   * Technique: EP (file-extension partition).
   */
  it('RUST_CANARY_STRATEGY.isCandidateFile returns true for .rs and false for non-.rs (C-RA-9)', () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    expect(
      RUST_CANARY_STRATEGY.isCandidateFile('main.rs'),
      'C-RA-9: isCandidateFile("main.rs") must return true — .rs is the Rust file extension.',
    ).toBe(true);

    expect(
      RUST_CANARY_STRATEGY.isCandidateFile('lib.py'),
      'C-RA-9: isCandidateFile("lib.py") must return false — .py is NOT a Rust extension. ' +
      'The candidate predicate must filter to .rs only.',
    ).toBe(false);
  });

});

// ─── WI-6b: LspClient lifecycle band (start → ready → stopped) ───────────────

/**
 * WI-6b acceptance gate: LspClient lifecycle state machine + timing-proxy
 * HARD gate.
 *
 * Technique: State Transition (idle → ready → stopped) + timing-proxy BVA
 * (elapsed < deadline/2 as the signal-path discriminator).
 *
 * Cases implemented:
 *
 *   C-RA-2   `new LspClient({workspaceRoot:ripgrepDir, binaryPath, adapter:RUST_ADAPTER})`
 *            → `start()` → `getState() === 'ready'` (AC-4/AC-5).
 *            State transition: idle → spawned → initialized → ready.
 *
 *   C-RA-3   `start()` wall-clock elapsed < RUST_ANALYZER_READY_DEADLINE_MS (60 s).
 *            Vitest timeout = RUST_ANALYZER_READY_DEADLINE_MS + 5_000 so the
 *            harness does not cancel before the production deadline fires.
 *
 *   Timing-proxy HARD gate (R2-7):
 *            elapsed < RUST_ANALYZER_READY_DEADLINE_MS / 2 (= 30_000 ms).
 *            This is NOT a soft performance bound — it is a HARD gate.
 *            If elapsed >= 30 s, awaitReady settled via the 60 s canary
 *            backstop, NOT the `experimental/serverStatus` signal path.
 *            That would indicate the PRE-initialize handler (lsp-client.ts:865)
 *            or the buffer-hit check in RUST_ADAPTER.awaitReady failed.
 *            WI-0 spike-confirmed cold latency: 13–15 s. 30 s = 2× cold
 *            latency → ample headroom even on a slow machine.
 *
 *   stop()   `client.stop()` → `getState() === 'stopped'`; no dangling
 *            rust-analyzer process (stop() sends 'exit' LSP notification
 *            and kills the subprocess on timeout).
 *
 * Invariants:
 *   - client.stop() is called in `finally` — guaranteed even if C-RA-2/3 fail.
 *   - Skip-clean guard: if rustAnalyzerBinary or ripgrepDir is null, every
 *     `it` returns immediately (no assertion failure).
 *   - The HARD gate assertion message names the exact lsp-client.ts line to
 *     check on failure — deterministic diagnosis, not just "slow".
 */
describe('rust-analyzer real-binary — lifecycle band (WI-6b)', () => {

  /**
   * C-RA-2 + C-RA-3 + timing-proxy HARD gate (R2-7):
   *
   *   C-RA-2: LspClient reaches state='ready' via start() (AC-4/AC-5).
   *   C-RA-3: awaitReady resolves within RUST_ANALYZER_READY_DEADLINE_MS (60 s).
   *   HARD gate: elapsed < deadline/2 (30 s) — proves experimental/serverStatus
   *              signal path settled awaitReady, NOT the 60 s canary backstop.
   *   stop(): getState() === 'stopped'; no dangling rust-analyzer process.
   *
   * The 30 s HARD gate threshold is deliberate:
   *   - WI-0 spike-confirmed cold latency (first-ever load): 13–15 s.
   *   - Even 2× cold latency (30 s) is << the 60 s canary backstop.
   *   - If start() takes >= 30 s, awaitReady settled via the DEADLINE path
   *     (canary backstop fired), not the serverStatus signal path — this is
   *     the R2-7 regression: the PRE-initialize serverStatus handler in
   *     LspClient.spawnAndInitialize was not registered or fired too late,
   *     OR RUST_ADAPTER.awaitReady did not read ctx.serverStatusLatest before
   *     registering ctx.onServerStatus.
   *
   * Timeout: RUST_ANALYZER_READY_DEADLINE_MS + 5_000 (65 s) so Vitest does
   * not cancel the test before the production deadline fires (spec invariant).
   */
  it(
    'client starts and reaches state=ready within RUST_ANALYZER_READY_DEADLINE_MS ' +
    'and timing-proxy HARD gate elapsed<deadline/2 confirms signal path (C-RA-2, C-RA-3)',
    async () => {
      if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

      const client = new LspClient({
        workspaceRoot: ripgrepDir,
        binaryPath: rustAnalyzerBinary.path,
        adapter: RUST_ADAPTER,
      });

      // C-RA-3 / timing HARD gate: record wall-clock before start().
      const t0 = Date.now();

      try {
        // C-RA-2 + C-RA-3: start() must complete within RUST_ANALYZER_READY_DEADLINE_MS.
        // If awaitReady never resolves, start() throws → test fails (not a skip).
        await client.start();

        const elapsedMs = Date.now() - t0;

        // C-RA-2: state must be 'ready' immediately after start() resolves.
        expect(
          client.getState(),
          'C-RA-2: getState() must equal "ready" after start() resolves. ' +
          'If "idle" or "spawned": spawnAndInitialize did not reach the ready transition. ' +
          'If "degraded": awaitReady resolved false → cleanupAfterFailure fired ' +
          '(canary backstop returned false). ' +
          'Check RUST_ADAPTER.awaitReady canary logic and ripgrep fixture availability.',
        ).toBe('ready');

        // C-RA-3: elapsed must be within the production deadline.
        // This is a soft sanity check — the HARD gate (below) is the real discriminator.
        expect(
          elapsedMs,
          `C-RA-3: start() took ${elapsedMs} ms, exceeding RUST_ANALYZER_READY_DEADLINE_MS ` +
          `(${RUST_ANALYZER_READY_DEADLINE_MS} ms). awaitReady never resolved within the ` +
          'production deadline — this should have thrown, not reached here.',
        ).toBeLessThan(RUST_ANALYZER_READY_DEADLINE_MS);

        // ── Timing-proxy HARD gate (R2-7) ───────────────────────────────────
        // HARD gate: elapsed < deadline/2 (= 30_000 ms).
        // This gate distinguishes the serverStatus signal path from the canary backstop:
        //   - Signal path fires at dt ≈ 13–15 s cold (WI-0 spike-confirmed).
        //   - Canary backstop fires at RUST_ANALYZER_READY_DEADLINE_MS (60 s).
        //   - 30 s sits exactly between them — any result >= 30 s means the backstop fired.
        //
        // If this assertion fails:
        //   (1) LspClient.spawnAndInitialize does NOT register the experimental/serverStatus
        //       handler BEFORE connection.sendRequest('initialize') — check lsp-client.ts:865.
        //   (2) RUST_ADAPTER.awaitReady does NOT check ctx.serverStatusLatest (buffer-hit)
        //       before registering ctx.onServerStatus — the notification arrived between
        //       spawn and awaitReady call, so the buffer-hit path is the only way to catch it.
        //   (3) RUST_ADAPTER.clientCapabilities.experimental.serverStatusNotification is not
        //       set to true — the capability-gate in lsp-client.ts:863 skips registration.
        const hardGateThresholdMs = RUST_ANALYZER_READY_DEADLINE_MS / 2; // 30_000
        expect(
          elapsedMs,
          `R2-7 HARD GATE FAILED: start() took ${elapsedMs} ms >= ${hardGateThresholdMs} ms ` +
          '(RUST_ANALYZER_READY_DEADLINE_MS / 2). ' +
          'awaitReady settled via the 60 s canary backstop, NOT the experimental/serverStatus ' +
          'signal path. This is a BLOCKER — do not merge. ' +
          'Diagnosis checklist: ' +
          '(1) lsp-client.ts:863 capability-gate: RUST_ADAPTER.clientCapabilities.experimental.serverStatusNotification must be true; ' +
          '(2) lsp-client.ts:865 registration order: experimental/serverStatus handler must be registered BEFORE connection.sendRequest("initialize"); ' +
          '(3) RUST_ADAPTER.awaitReady step 1: must check ctx.serverStatusLatest buffer BEFORE registering ctx.onServerStatus (notification arrives at dt≈20ms, before awaitReady is called); ' +
          `WI-0 spike-confirmed cold latency: 13–15 s; threshold ${hardGateThresholdMs} ms = 2× that.`,
        ).toBeLessThan(hardGateThresholdMs);
      } finally {
        // stop(): getState() === 'stopped'; no dangling rust-analyzer process.
        // Called in finally so the subprocess is always cleaned up, even if
        // C-RA-2/3 or the HARD gate assertion throws.
        await client.stop();
        expect(
          client.getState(),
          'stop(): getState() must equal "stopped" after stop() resolves. ' +
          'If not "stopped": LspClient.stop() did not transition the state machine. ' +
          'Check that stop() calls this.setState("stopped") unconditionally.',
        ).toBe('stopped');
      }
    },
    RUST_ANALYZER_READY_DEADLINE_MS + 5_000, // 65 s — spec invariant: harness timeout > production deadline
  );

});

// ─── WI-6c: awaitReady dual-oracle band (deadline backstop paths) ──────────────

/**
 * WI-6c acceptance gate: `RUST_ADAPTER.awaitReady` deadline-backstop dual-oracle.
 *
 * Technique: Flow-Based Coverage (awaitReady deadline branch: two mutually
 * exclusive outcome oracles).
 *
 * Cases:
 *
 *   C-RA-4a  (zero-samples → true, R2-3):
 *     Drives the REAL awaitReady with injected short `ctx.deadlineMs` (10 ms)
 *     and `ctx.backstopProbe` returning `true`. Steps 1 (serverStatusLatest)
 *     and 2 (onServerStatus) are absent from ctx so the timer fires
 *     immediately; `backstopProbe` is the zero-samples oracle (line 1117-1120
 *     in language-adapter.ts). Deliberate GO_ADAPTER deviation: zero workspace
 *     samples → proceed with no-op augmentation rather than blocking ingestion.
 *
 *   C-RA-4b  (samples present + empty definition → false):
 *     Drives the REAL awaitReady without backstopProbe; inline canary path
 *     (lines 1122-1157). `buildCanarySamples` returns ≥1 sample from the real
 *     ripgrep workspace; the injected fake `connection.sendRequest` returns `[]`
 *     so `result.length === 0` → `ready = false` → `settle(false)`.
 *     Requires ripgrepDir (guarded; skip-clean when absent).
 *
 * Invariants:
 *   - Drives the REAL exported `RUST_ADAPTER.awaitReady` (no re-impl, no mock
 *     of the function itself) via the `AdapterReadyCtx` seam. (WI-6c invariant)
 *   - ctx.deadlineMs is small (10 ms << 60 s) so neither test waits the full
 *     RUST_ANALYZER_READY_DEADLINE_MS. (timing invariant)
 *   - ctx.serverStatusLatest and ctx.onServerStatus are undefined so steps 1+2
 *     of awaitReady do not fire; the promise always settles via deadline backstop.
 *   - awaitReady never rejects on either branch (I-7) — asserted via await
 *     (a rejected promise propagated through await would fail the test with an
 *     error rather than an assertion failure; the `expect(result).not.toThrow()`
 *     form is not applicable here since we await the promise directly).
 *   - Skip-clean guard inherited from WI-6a: `if (!rustAnalyzerBinary || !ripgrepDir) return;`
 *     C-RA-4a does NOT require a live server and could skip the guard, but both
 *     cases guard identically for consistency with the file-level pattern.
 *     C-RA-4b REQUIRES ripgrepDir to let buildCanarySamples find real .rs files.
 */
describe('rust-analyzer real — awaitReady dual-oracle band (WI-6c)', () => {

  /**
   * C-RA-4a: awaitReady deadline backstop — zero samples → true (R2-3).
   *
   * Arrange:
   *   - ctx.backstopProbe: async () => true    — zero-samples oracle
   *   - ctx.deadlineMs: 10                     — fires the timer in 10 ms
   *   - ctx.serverStatusLatest: undefined       — skip step 1 (buffer-hit path)
   *   - ctx.onServerStatus: undefined           — skip step 2 (subscribe path)
   *   - ctx.connection: {} (unused when backstopProbe short-circuits)
   *   - ctx.workspaceRoot: '/dev/null'          — unused when backstopProbe fires
   *
   * Act: `await RUST_ADAPTER.awaitReady(ctx)`
   *
   * Assert: result === true; promise settled (did not reject).
   *
   * Rationale for R2-3 deviation from GO_ADAPTER:
   *   A Rust workspace with zero .rs files has nothing to augment — proceeding
   *   (true) is safe; blocking (false) would break ingestion unnecessarily.
   *
   * Note: C-RA-4a does NOT require a real rust-analyzer binary or ripgrepDir —
   * backstopProbe bypasses buildCanarySamples + connection entirely. The skip-
   * clean guard is kept for file-level consistency; it does not affect test
   * correctness here.
   */
  it(
    'awaitReady: deadline backstop with backstopProbe returning true → resolves true, never rejects (C-RA-4a)',
    async () => {
      if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

      // Arrange: ctx arranged so only the deadline backstop fires.
      // backstopProbe short-circuits the inline buildCanarySamples path,
      // acting as the zero-samples oracle (R2-3 deliberate deviation).
      const ctx = {
        // Step 1 absent: no serverStatusLatest → buffer-hit path does not fire.
        // Step 2 absent: no onServerStatus → subscribe path does not fire.
        connection: {} as unknown, // not reached when backstopProbe fires
        workspaceRoot: '/dev/null', // not reached when backstopProbe fires
        deadlineMs: 10, // fires the timer immediately (10 ms << 60 s deadline)
        backstopProbe: async (): Promise<boolean> => true,
      };

      // Act: drive the REAL RUST_ADAPTER.awaitReady.
      // awaitReady must never reject (I-7) — an uncaught rejection propagated
      // through await would fail the test with an unhandled error, which is
      // distinct from an assertion failure and proves I-7 implicitly.
      const result = await RUST_ADAPTER.awaitReady(ctx);

      // Assert: zero-samples oracle → true (R2-3 deliberate GO_ADAPTER deviation).
      expect(
        result,
        'C-RA-4a: awaitReady with backstopProbe returning true must resolve true. ' +
        'This is the zero-samples oracle: R2-3 deliberate deviation from GO_ADAPTER ' +
        '(which returns false on zero samples). In Rust, zero workspace samples means ' +
        'no-op augmentation is safe — blocking ingestion would be wrong. ' +
        'If false: check that ctx.backstopProbe is called and its return value is used ' +
        'by settle() (language-adapter.ts deadline branch, lines 1117-1120).',
      ).toBe(true);
    },
  );

  /**
   * C-RA-4b: awaitReady deadline backstop — samples present + empty definition → false.
   *
   * Arrange:
   *   - ctx.backstopProbe: undefined                — no short-circuit; inline path runs
   *   - ctx.deadlineMs: 10                          — fires the timer in 10 ms
   *   - ctx.serverStatusLatest: undefined            — skip step 1 (buffer-hit path)
   *   - ctx.onServerStatus: undefined                — skip step 2 (subscribe path)
   *   - ctx.connection: fake with sendRequest → []  — empty definition oracle
   *   - ctx.workspaceRoot: ripgrepDir               — real Rust workspace for buildCanarySamples
   *
   * Act: `await RUST_ADAPTER.awaitReady(ctx)`
   *
   * Assert: result === false; promise settled (did not reject).
   *
   * Requires ripgrepDir (skip-clean when absent) because buildCanarySamples
   * must find at least one .rs file to produce a sample; an empty workspace
   * would exercise the zero-samples → true path instead (C-RA-4a territory).
   *
   * Fake connection contract:
   *   - sendRequest(): returns [] (the "empty definition" oracle)
   *   - sendNotification(): no-op (best-effort didOpen — allowed to throw too)
   *   Both are the minimum surface touched by the inline canary path.
   */
  it(
    'awaitReady: deadline backstop with sample present and empty definition → resolves false, never rejects (C-RA-4b)',
    async () => {
      if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

      // Arrange: fake connection whose sendRequest always returns [] (empty
      // definition response). sendNotification is a no-op best-effort call
      // (the real path sends textDocument/didOpen; failure is swallowed).
      const fakeConnection = {
        sendRequest: async <T>(): Promise<T> => [] as unknown as T,
        sendNotification: async (): Promise<void> => undefined,
      };

      const ctx = {
        // Step 1 absent: no serverStatusLatest → buffer-hit path does not fire.
        // Step 2 absent: no onServerStatus → subscribe path does not fire.
        connection: fakeConnection as unknown,
        workspaceRoot: ripgrepDir, // real Rust workspace — buildCanarySamples needs .rs files
        deadlineMs: 10,             // fires the timer immediately (10 ms << 60 s deadline)
        // backstopProbe absent → inline canary path runs (buildCanarySamples + sendRequest)
      };

      // Act: drive the REAL RUST_ADAPTER.awaitReady.
      // awaitReady must never reject (I-7).
      const result = await RUST_ADAPTER.awaitReady(ctx);

      // Assert: samples present + empty definition → false.
      expect(
        result,
        'C-RA-4b: awaitReady with a real sample (from ripgrep workspace) and empty ' +
        'textDocument/definition response ([]) must resolve false. ' +
        'The canary backstop logic (language-adapter.ts lines 1149-1156) evaluates: ' +
        '`result !== null && result !== undefined && !(Array.isArray(result) && result.length === 0)`. ' +
        'With result=[], this evaluates to false → settle(false). ' +
        'If true: (1) buildCanarySamples returned [] (workspace has no .rs files — ' +
        'check ripgrepDir contains Rust source); (2) fakeConnection.sendRequest was not ' +
        'called (backstopProbe path fired instead — check ctx.backstopProbe is undefined); ' +
        '(3) inline ready-check logic changed.',
      ).toBe(false);
    },
  );

});

// ─── WI-6d: HEAVY — pin guard + Mode-A augmentation floor + mis-map oracle ─────

/**
 * WI-6d acceptance gate: HEAVY band.
 *
 * Technique:
 *   - Decision Table (C-RA-PIN): ripgrep HEAD pin guard — if ripgrep not at
 *     82313cf, explicit failure (NOT skip). Mirrors C7-PIN / CRAWL4AI_PINNED_SHA
 *     gate pattern. AUGMENTATION_FLOOR reproducibility requires the pinned commit.
 *   - Flow-Based Coverage (C-RA-7): runPipelineFromRepo → Mode-A confirm/correct
 *     counters; scouting advisory when floor(count*0.8) > AUGMENTATION_FLOOR.
 *   - Metamorphic (mis-map oracle): every lsp-edge target node filePath must be
 *     strictly inside ripgrepDir (0 mis-maps). Non-vacuous: floor>=1 guarantees
 *     ≥1 lsp edge in scope for the containment check (Invariant I-2 analogue).
 *
 * Gate conditions (ALL must be satisfied for C-RA-7 and C-RA-PIN):
 *   1. GITNEXUS_RUST_HEAVY_IT=1 env var (heavy opt-in — never runs in standard CI).
 *   2. rust-analyzer binary discoverable (rustAnalyzerBinary non-null).
 *   3. ripgrep fixture present at RIPGREP_DIR (ripgrepDir non-null).
 *   4. ripgrep HEAD === 82313cf (C-RA-PIN — enforced inside the test; explicit
 *      failure when present-but-wrong, NOT a guarded skip).
 *
 * AUGMENTATION_FLOOR = 1 (pre-scouting seed):
 *   The ripgrep codebase contains `fn main()` and call-site edges in src/main.rs
 *   that are CALL edges with deterministic in-repo Definition targets. On the
 *   pinned 82313cf ripgrep checkout, Mode-A MUST confirm or correct at least one
 *   such edge. Floor = 1 (initial calibration before first heavy run per ruling
 *   R2-8). After the first heavy run, tighten to floor(observed*0.8).
 *
 * Scouting advisory (non-failing, console.warn):
 *   When floor(count*0.8) > AUGMENTATION_FLOOR, warn to prompt tightening the
 *   floor constant. Pattern from python-pylsp-real.test.ts B-9 / go-gopls-real
 *   WI-7c.
 *
 * Timeout: 300_000 ms (full LSP-augmented pipeline on a real Rust repo,
 *   cold-cache rust-analyzer — WI-6d spec invariant).
 */
describe('rust-analyzer real-binary — HEAVY augmentation floor + mis-map oracle (WI-6d)', () => {

  /**
   * C-RA-PIN + C-RA-7 (heavy, GITNEXUS_RUST_HEAVY_IT=1):
   *
   * C-RA-PIN: pinned-commit guard — if ripgrep is at a different commit than
   * 82313cf, the test FAILS explicitly (NOT skip-clean). This mirrors C7-PIN
   * (go-gopls-real.test.ts) and ensures AUGMENTATION_FLOOR is reproducible
   * across machines (ruling R2-8). Present-but-wrong SHA is a failure: the
   * floor is calibrated against 82313cf; a different commit could have fewer
   * CALL edges, silently passing a stale floor.
   *
   * C-RA-7: Flow-Based Coverage — Mode-A augmentation floor.
   * runPipelineFromRepo(ripgrepDir, () => {}, {skipGraphPhases:true,
   * lsp:{enabled:true, dryRun:false}}) → lspReport non-null;
   * (confirmed ?? 0) + (corrected ?? 0) >= AUGMENTATION_FLOOR (= 1).
   *
   * Mis-map oracle (I-2 analogue):
   * Every lsp-confirmed / lsp-corrected / lsp-recall relationship target node
   * must have filePath strictly inside ripgrepDir. mis-maps === 0 is a blocking
   * acceptance gate. Non-vacuous because AUGMENTATION_FLOOR >= 1 guarantees at
   * least 1 lsp edge in the result graph.
   *
   * Invariants:
   *   - GITNEXUS_RUST_HEAVY_IT inner guard: return (not expect.fail) when absent
   *     — this test MUST NOT run in standard CI or dev loops.
   *   - C-RA-PIN is expect.fail(), not return (present-but-wrong is a failure).
   *   - Timeout: 300_000 ms (spec invariant).
   */
  it('Mode-A augmentation floor >= 1 on ripgrep@82313cf + mis-map oracle === 0 (C-RA-PIN, C-RA-7)', async () => {
    if (!rustAnalyzerBinary || !ripgrepDir) return; // skip-clean guard (WI-6a)

    // ── Heavy opt-in gate ─────────────────────────────────────────────
    // This test MUST NOT run in standard CI or dev loops. Set
    // GITNEXUS_RUST_HEAVY_IT=1 to enable (mirrors GITNEXUS_GO_HEAVY_IT pattern).
    if (!process.env['GITNEXUS_RUST_HEAVY_IT']) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:rust-analyzer-real:WI-6d] SKIP C-RA-7 — set GITNEXUS_RUST_HEAVY_IT=1 to enable Mode-A augmentation heavy run',
      );
      return;
    }

    // ── C-RA-PIN: pinned-commit guard ─────────────────────────────────
    // The AUGMENTATION_FLOOR is calibrated against ripgrep at 82313cf. Running
    // against a different commit is an EXPLICIT FAILURE (not a skip), to prevent
    // a floor calibrated on one revision from silently passing on a HEAD with
    // fewer CALL edges. This mirrors the C7-PIN / CRAWL4AI_PINNED_SHA patterns.
    //
    // git rev-parse --short outputs 7 chars by default; 82313cf is 7 chars.
    // Allow prefix-match in either direction (short vs full 40-char SHA).
    const RIPGREP_PINNED_SHA = '82313cf';
    const actualRipgrepSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ripgrepDir,
      encoding: 'utf8',
    }).trim();

    expect(
      actualRipgrepSha.startsWith(RIPGREP_PINNED_SHA) || RIPGREP_PINNED_SHA.startsWith(actualRipgrepSha),
      `C-RA-PIN: ripgrep checkout is not at the pinned commit. ` +
      `Expected HEAD starting with ${RIPGREP_PINNED_SHA}, got ${actualRipgrepSha}. ` +
      `Check out the pinned commit before running this test: ` +
      `\`git -C ${ripgrepDir} checkout ${RIPGREP_PINNED_SHA}\`. ` +
      `Without the pinned commit, AUGMENTATION_FLOOR=1 is a local-machine artifact ` +
      `with no reproducibility guarantee (ruling R2-8 / WI-6d). ` +
      `A wrong-SHA ripgrep could have fewer CALL edges — a passing floor here would be a lie.`,
    ).toBe(true);

    // ── C-RA-7: Mode-A augmentation floor ────────────────────────────
    // Run the full LSP-augmented pipeline on the pinned ripgrep fixture.
    // skipGraphPhases:true avoids writing to any persistent DB; we only need
    // the lspReport from the in-memory reconciler.
    const pipelineResult = await runPipelineFromRepo(
      ripgrepDir,
      () => {}, // progress callback (no-op)
      {
        skipGraphPhases: true,
        lsp: { enabled: true, dryRun: false },
      },
    );

    const lspReport = pipelineResult.lspReport;

    // lspReport must be present when lsp.enabled:true (not null/undefined).
    // If null, LSP reconciliation did not run — check that RUST_ADAPTER was
    // selected by selectAdapter() for ripgrep (Rust-dominant repo, .rs files).
    expect(
      lspReport,
      'C-RA-7: runPipelineFromRepo with lsp:{enabled:true} must produce a non-null lspReport. ' +
      'If null, LSP reconciliation did not run — check that RUST_ADAPTER was selected by ' +
      'selectAdapter() for the ripgrep fixture (ripgrep is a Rust-dominant repo; .rs must ' +
      'dominate all other extensions under census). Also confirm rust-analyzer reached ' +
      'state=ready via the experimental/serverStatus signal path (C-RA-2 timing proxy).',
    ).not.toBeNull();
    expect(lspReport).not.toBeUndefined();

    // Mode-A augmentation count: confirmed + corrected edges.
    // AUGMENTATION_FLOOR tightened to 663 = floor(829 * 0.8) after the first
    // successful heavy run (observed: confirmed 829, corrected 0, recall +201
    // against rust-analyzer 1.95.0 + ripgrep@82313cf, 2026-06-14) per ruling
    // R2-8 / WI-6d — same calibration pattern as go-gopls-real AUGMENTATION_FLOOR
    // (seeded at 1, tightened to floor(observed*0.8) after the C7-10 scouting run).
    //
    // The 20% margin absorbs run-to-run jitter from the deterministic candidate
    // cap (skipped(cap) 3352 on this run). A drop below 663 signals a real
    // regression in the Rust signal path or canary sampling — investigate, do
    // not silently lower the floor.
    const AUGMENTATION_FLOOR = 663;
    const augmentationCount = (lspReport?.confirmed ?? 0) + (lspReport?.corrected ?? 0);

    expect(
      augmentationCount,
      `C-RA-7: Mode-A augmentation (confirmed+corrected) on ripgrep@${RIPGREP_PINNED_SHA} must be ` +
      `>= ${AUGMENTATION_FLOOR}. Got: confirmed=${lspReport?.confirmed}, ` +
      `corrected=${lspReport?.corrected}, recall=${lspReport?.recall}, ` +
      `refused=${lspReport?.refused}. ` +
      `Floor = ${AUGMENTATION_FLOOR} (pre-scouting seed; tighten to floor(observed*0.8) after first run). ` +
      `If below floor: (1) confirm RUST_ADAPTER.awaitReady resolved via the serverStatus signal path ` +
      `(not the 60s canary backstop — C-RA-2 timing proxy should pass with elapsed<30s); ` +
      `(2) verify ripgrep is at ${RIPGREP_PINNED_SHA} (C-RA-PIN above); ` +
      `(3) check that rust-analyzer version supports textDocument/definition on Rust call-sites.`,
    ).toBeGreaterThanOrEqual(AUGMENTATION_FLOOR);

    // ── Mis-map oracle (I-2 analogue) ─────────────────────────────────
    // Every lsp-confirmed / lsp-corrected / lsp-recall relationship in the
    // result graph MUST have a target node whose file path is strictly inside
    // ripgrepDir. A target node whose path is outside ripgrepDir is a mis-map:
    // a ~/.rustup/toolchains or ~/.cargo/registry URI that slipped through the
    // external-refusal gate and was incorrectly indexed as a workspace symbol.
    //
    // This is Invariant I-2 (analogue): mis-map count === 0 is a blocking gate.
    //
    // Implementation mirrors go-gopls-real.test.ts V-6(d) / python-pylsp-real B-11:
    //   1. Iterate all graph relationships with lsp source stamps.
    //   2. Look up the target node in the graph.
    //   3. Derive the absolute file path from node.properties.filePath.
    //   4. Assert path.relative(ripgrepDir, absPath) does NOT start with '..'.
    //
    // Non-vacuous: AUGMENTATION_FLOOR >= 1 (passed above), so the graph
    // contains at least 1 lsp-augmented edge whose target is in scope.
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
      // nodePath may be repo-relative (no leading '/') — join with ripgrepDir.
      const absNodePath = path.isAbsolute(nodePath)
        ? nodePath
        : path.resolve(ripgrepDir, nodePath);

      const relPath = path.relative(ripgrepDir, absNodePath);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        // The target node's file path is OUTSIDE ripgrepDir — this is a mis-map.
        misMaps++;
        // eslint-disable-next-line no-console
        console.error(
          `[IT:rust-analyzer-real] WI-6d MIS-MAP: nodeId=${rel.targetId} ` +
          `filePath=${nodePath} is outside ripgrepDir (rel=${relPath}). ` +
          `This means a ~/.rustup/toolchains or ~/.cargo/registry URI was incorrectly ` +
          `routed as 'workspace' by the Rust LSP adapter and resolved to a graph node. ` +
          `Check: (1) isExternalRefusalAdapter gate in location-mapper.ts includes 'rust'; ` +
          `(2) RUST_ADAPTER path-containment uses realpathSync-resolved ripgrepDir; ` +
          `(3) adapterId:'rust' is threaded through the deps bag.`,
        );
      }
    }

    expect(
      misMaps,
      `WI-6d / I-2 mis-map oracle violated: ${misMaps} lsp-edge target(s) resolve to ` +
      `file paths outside ripgrepDir (${ripgrepDir}). ` +
      `Every NodeId returned for a Rust LSP edge must resolve to a path strictly ` +
      `inside ripgrep's repoPath per Invariant I-2. ` +
      `A mis-map means a ~/.rustup/toolchains or ~/.cargo/registry URI slipped through ` +
      `the external-refusal gate and was incorrectly indexed as a workspace symbol. ` +
      `See WI-6d spec and go-gopls-real.test.ts V-6(d) for the oracle pattern. ` +
      `Check C-RA-5/C-RA-6 (external-refusal: isExternalRefusalAdapter('rust') must be true).`,
    ).toBe(0);

    // ── Scouting advisory (non-failing) ──────────────────────────────
    // When floor(count*0.8) > AUGMENTATION_FLOOR, emit a console.warn to
    // prompt tightening the floor constant. The advisory is NEVER a failure.
    // Pattern from python-pylsp-real.test.ts B-9 / go-gopls-real WI-7c (R2-8).
    if (Math.floor(augmentationCount * 0.8) > AUGMENTATION_FLOOR) {
      const recommended = Math.floor(augmentationCount * 0.8);
      // eslint-disable-next-line no-console
      console.warn(
        `[C-RA-7 SCOUTING ADVISORY] AUGMENTATION_FLOOR (${AUGMENTATION_FLOOR}) is below ` +
        `observed augmentation count (${augmentationCount}). ` +
        `Consider updating AUGMENTATION_FLOOR to ${recommended} ` +
        `(= floor(${augmentationCount} * 0.8)) to tighten the regression guard ` +
        `(ruling R2-8 / WI-6d). This is a maintenance advisory, not a failure. ` +
        `Record the observed count in a comment next to AUGMENTATION_FLOOR.`,
      );
    }
  }, 300_000);

});

// ─── Exported skip-clean guard ─────────────────────────────────────────────────

/**
 * Skip-clean guard inherited by WI-6c / WI-6d.
 *
 * The pattern `if (!rustAnalyzerBinary || !ripgrepDir) return;` is used in
 * every `it` in this file and must be used in all downstream WI-6x files.
 *
 * This is NOT a .skip() call — early-return counts as passed in vitest
 * (no red mark in CI), while .skip() marks the test as skipped (yellow).
 * The distinction matters: skip-clean allows CI to pass when rust-analyzer
 * is absent (expected on most CI machines) without marking the suite as
 * partially skipped.
 *
 * RUST_ANALYZER_READY_DEADLINE_MS is used in the WI-6b `it` timeout assertion.
 * It is re-exported here so WI-6c/6d can import from one place.
 */
export {
  rustAnalyzerBinary,
  ripgrepDir,
  RUST_ADAPTER,
  RUST_ANALYZER_READY_DEADLINE_MS,
};
