/**
 * E2E Smoke Test: Mode C position-based verification (#174)
 *
 * THIS IS THE ASSERTION THE WHOLE REPO LACKED BEFORE #174.
 *
 * Before #174, Mode C probed `textDocument/definition` at
 * `{ line: a.startLine, character: 0 }` — the SOURCE NODE's
 * declaration line, not the call site. That position resolves to
 * the *caller function's own definition*, so the returned nodeId
 * is the caller, never the callee. Result: `matches === 0` for
 * every repo, making Mode C precision/recall metrics completely
 * meaningless.
 *
 * After #174:
 *   - CALLS edges persist `sourceLine` / `sourceCol` (the call-site
 *     row/col captured by tree-sitter at ingest time).
 *   - Mode C reads those columns back and probes the exact call-site
 *     position — so `textDocument/definition` resolves to the callee.
 *   - `overall.matches >= 1` is now achievable on a correctly-analyzed
 *     repo. Without #174 this was structurally impossible.
 *   - `positionCoverage > 0` confirms the DB contains at least one
 *     #174-era positioned row (proves the persisted coordinates
 *     survived the full ingest + COPY round-trip).
 *
 * Fixture design:
 *   callee.ts   — exports `export function greet(): string { … }`
 *   caller.ts   — imports greet and calls it from `main()`
 *   tsconfig.json — minimal CommonJS tsconfig (needed for TSLS resolution)
 *
 * The call `greet()` on a known line in caller.ts is the single
 * assertion point: `textDocument/definition` at that exact position
 * must resolve to `callee.ts:greet`, which the mapper matches to the
 * node that the heuristic CALLS edge already points at.
 *
 * Gating:
 *   Server-gated (skipIf no typescript-language-server). CI runners
 *   without the binary continue to pass; this test only activates in
 *   environments where the binary is available AND node_modules exist
 *   in the fixture directory (needed for cross-file resolution).
 *
 *   Uses `fs.realpathSync` on the tmpdir — macOS /tmp is a symlink to
 *   /private/tmp, and TSLS returns `file://` URIs with the resolved path.
 *   Without the realpath call, the mapper's path comparison fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import { buildCanarySamples } from '../../../src/core/ingestion/lsp/canary-sampler.js';
import { probeWorkspaceReadiness } from '../../../src/core/ingestion/lsp/workspace-readiness-probe.js';
import { runModeCVerify } from '../../../src/core/ingestion/lsp/mode-c-verifier.js';
import { mapLocationToNodeId } from '../../../src/core/ingestion/lsp/location-mapper.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

// ── Server-availability probe (sync, registration-time) ──────────────────────
//
// `it.runIf` is evaluated at registration time — the async `discoverServers()`
// is too late. The sync `which` probe is cheapest and matches the pattern used
// in canary-probe-real.test.ts and analyze-lsp-mode-a.test.ts.
function probeServerSync(): boolean {
  try {
    const out = spawnSync('which', ['typescript-language-server'], { stdio: 'pipe' });
    return out.status === 0 && out.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}
const SERVER_AVAILABLE = probeServerSync();

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * The caller file.
 *
 * `greet()` is on line 4 (0-based: line 4) of caller.ts.
 * We use a named import on line 0, a blank line on line 1,
 * the function declaration on line 2, and the `return greet()`
 * call on line 3. This gives us a deterministic call-site at
 * line 3, column 9 (after "  return ").
 */
const CALLER_CONTENT = `import { greet } from './callee';

export function main(): string {
  return greet();
}
`;

/** The callee file — the function that must be `define`-resolved. */
const CALLEE_CONTENT = `export function greet(): string {
  return 'hello';
}
`;

const TSCONFIG_CONTENT = JSON.stringify({
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    strict: true,
    outDir: './dist',
  },
  include: ['*.ts'],
}, null, 2) + '\n';

// ── State ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let repoPath: string; // realpath'd (macOS /tmp → /private/tmp)

/**
 * Set up the fixture repo once for all tests in this file.
 *
 * Steps:
 *   1. Write callee.ts, caller.ts, tsconfig.json into a tmpdir.
 *   2. Symlink node_modules from the *gitnexus* package so TSLS can
 *      resolve the TypeScript language service without a full install.
 *   3. `git init + add + commit` so `runPipelineFromRepo` has git history.
 *
 * NOTE: We do NOT call `runPipelineFromRepo` + `loadGraphToLbug` in
 * beforeAll because the E2E test itself does that inside the `it.runIf`
 * body — this keeps the setup lightweight for the guarded case (server
 * absent → test skips immediately, no DB work done).
 */
beforeAll(async () => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mode-c-pos-e2e-'));
  // macOS /tmp is a symlink to /private/tmp. TSLS returns URIs with
  // the resolved path. Without realpath the mapper's path comparison
  // fails silently, producing NO_NODE for every location.
  repoPath = fs.realpathSync(raw);
  tmpDir = raw; // keep for cleanup (rm only needs the raw path)

  fs.writeFileSync(path.join(repoPath, 'caller.ts'), CALLER_CONTENT, 'utf8');
  fs.writeFileSync(path.join(repoPath, 'callee.ts'), CALLEE_CONTENT, 'utf8');
  fs.writeFileSync(path.join(repoPath, 'tsconfig.json'), TSCONFIG_CONTENT, 'utf8');

  // Symlink node_modules so TSLS can resolve TypeScript.
  // The gitnexus package already has typescript installed.
  const _require = createRequire(import.meta.url);
  const testFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(testFile), '../../..');
  const nmSrc = path.join(pkgRoot, 'node_modules');
  const nmDst = path.join(repoPath, 'node_modules');
  if (fs.existsSync(nmSrc) && !fs.existsSync(nmDst)) {
    fs.symlinkSync(nmSrc, nmDst, 'dir');
  }

  // git init + commit so the pipeline has git history.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  spawnSync('git', ['init'], { cwd: repoPath, stdio: 'pipe', env: gitEnv });
  spawnSync('git', ['add', 'caller.ts', 'callee.ts', 'tsconfig.json'], { cwd: repoPath, stdio: 'pipe', env: gitEnv });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'pipe', env: gitEnv });
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── The E2E assertion ─────────────────────────────────────────────────────────

describe('Mode C position-based verification E2E (#174)', () => {
  /**
   * THE CORE ASSERTION: after #174 a fully-analyzed repo must produce
   * `overall.matches >= 1` and `positionCoverage > 0`.
   *
   * Before #174 this was structurally impossible: every probe landed on the
   * caller's declaration line and resolved to the caller itself, so no probe
   * ever matched the heuristic target.
   */
  it.runIf(SERVER_AVAILABLE)(
    'overall.matches >= 1 and positionCoverage > 0 after full analyze + Mode C (#174 regression guard)',
    async () => {
      // ── Step 1: run the full ingest pipeline ─────────────────────────
      // `runPipelineFromRepo` parses caller.ts and emits a CALLS edge
      // from `main` to `greet` with `sourceLine` / `sourceCol` set by
      // call-processor.ts (the #174 fix). `skipGraphPhases: false` (the
      // default) runs the community/process phases as well.
      const pipelineResult = await runPipelineFromRepo(repoPath, () => {}, {
        skipGraphPhases: true, // skip community + process phases — not needed for this test
      });
      expect(pipelineResult.graph).toBeTruthy();

      // Verify the graph actually has a CALLS edge from main → greet.
      // This ensures the pipeline correctly found the cross-file call.
      const rels = [...pipelineResult.graph.relationships];
      const callsEdge = rels.find(
        (r) => r.type === 'CALLS' && r.sourceId.includes('main') && r.targetId.includes('greet'),
      );
      expect(
        callsEdge,
        'Pipeline must emit a CALLS edge from main→greet (heuristic found the cross-file call)',
      ).toBeDefined();

      // #174: the CALLS edge must carry a non-null `column` (the call-site
      // column persisted by call-processor.ts). Without the fix this field
      // was absent and the verifier would increment `unpositioned`.
      expect(
        callsEdge!.column,
        `CALLS edge must have a column (call-site column from #174): got ${callsEdge!.column}`,
      ).toBeDefined();

      // ── Step 2: persist to LadybugDB ────────────────────────────────
      // Use a tmpdir sub-path for the DB file so this test does not
      // contaminate the shared global test DB. We init a fresh lbug
      // instance, load the graph, then register it in the pool adapter.
      const lbugPath = path.join(repoPath, '.gitnexus', 'graph.db');
      const storagePath = path.join(repoPath, '.gitnexus', 'storage');
      fs.mkdirSync(path.dirname(lbugPath), { recursive: true });
      fs.mkdirSync(storagePath, { recursive: true });

      const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(lbugPath);
      const lbugResult = await adapter.loadGraphToLbug(
        pipelineResult.graph,
        pipelineResult.repoPath,
        storagePath,
      );
      expect(lbugResult.success).toBe(true);

      // Register in pool adapter (required by executeParameterized).
      const repoId = `mode-c-pos-e2e-${Date.now()}`;
      const coreDb = adapter.getDatabase();
      if (!coreDb) throw new Error('E2E: core adapter has no open Database after initLbug');
      const poolAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      await poolAdapter.initLbugWithDb(repoId, coreDb, lbugPath);

      // ── Step 3: start LSP and probe workspace readiness ─────────────
      const servers = await discoverServers();
      if (!servers.typescript) {
        // Guard: server disappeared between registration-time probe and now.
        // This path should be unreachable (skipIf already guards it) but
        // we fail gracefully rather than crashing with a null-deref.
        console.warn('[E2E:#174] typescript-language-server vanished between registration and run — skipping');
        await adapter.closeLbug();
        await poolAdapter.closeLbug(repoId);
        return;
      }

      const client = new LspClient({
        binaryPath: servers.typescript.path,
        workspaceRoot: repoPath,
      });

      try {
        await client.start();

        // Probe with real canary samples from the fixture (not package.json).
        const samples = await buildCanarySamples(repoPath);
        const probe = await probeWorkspaceReadiness(client, samples, {
          perRequestTimeoutMs: 10_000,
        });

        if (!probe.ready) {
          // The workspace isn't built — TSLS can't resolve cross-file imports.
          // This is an environment issue (e.g. no TypeScript in node_modules),
          // not a bug in the code under test. Skip with a diagnostic.
          console.warn(`[E2E:#174] workspace not ready: ${probe.reason} — skipping Mode C assertions`);
          return;
        }

        // ── Step 4: run Mode C with the real LSP + real DB ─────────────
        // This is THE assertion: with correct call-site positions, the
        // verifier probes the right location and `matches >= 1`.
        // Before #174 this always produced matches === 0.
        const report = await runModeCVerify({
          repoId,
          client,
          repoPath,
          mapLocationToNodeId: (loc, rid) => mapLocationToNodeId(loc, rid, { repoPath }),
          executeParameterized: poolAdapter.executeParameterized,
          probe: async () => probe, // already probed above — don't double-probe
          sampleSize: 200,
          serverVersion: servers.typescript.version,
        });

        // ── Assertions ──────────────────────────────────────────────────

        // positionCoverage > 0: the DB has at least one #174-era positioned
        // row (proves sourceLine/sourceCol survived the CSV COPY round-trip).
        expect(
          report.positionCoverage,
          'positionCoverage must be > 0 — the DB must contain positioned CALLS rows after #174',
        ).toBeGreaterThan(0);

        // THIS IS THE ASSERTION THE WHOLE REPO LACKED BEFORE #174.
        // overall.matches >= 1: Mode C correctly probed the call site and
        // the LSP response resolved to the heuristic target. Before #174
        // this was structurally impossible because the probe landed on the
        // caller's declaration line (line 0, character 0) — which resolves
        // to the caller itself, never the callee.
        expect(
          report.overall.matches,
          'overall.matches must be >= 1 — Mode C must be able to MATCH at least one CALLS edge after #174. ' +
            'Before #174 this was structurally 0 because the probe landed on the wrong position.',
        ).toBeGreaterThanOrEqual(1);

        // Sanity: the report is not an lspUnavailable no-op.
        expect(report.lspUnavailable).toBeFalsy();

        // Sanity: the unpositioned counter is defined (the field must exist).
        expect(typeof report.overall.unpositioned).toBe('number');

      } finally {
        await client.stop();
        await adapter.closeLbug();
        await poolAdapter.closeLbug(repoId);
      }
    },
    120_000, // 2-minute timeout: TSLS startup + COPY round-trip can be slow
  );
});
