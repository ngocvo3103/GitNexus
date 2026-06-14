/**
 * `gitnexus verify` — LSP read-only foundation, WI-#8.
 *
 * A read-only CLI command that compares the heuristic CALLS
 * graph to LSP-resolved definitions (Mode C, see
 * `docs/designs/159-lsp-readonly-foundation.md` §#sd-verify-mode-c).
 *
 * Flags:
 *   --lsp           Run Mode C (heuristic vs LSP)
 *   --strict        Exit non-zero when LSP is unavailable (CI use)
 *   --sample <n>    Sample size (default 200)
 *   -r, --repo <n>  Target repository (multi-repo selector)
 *
 * Behavior table (the WI's decision table):
 *
 *   | index | --lsp | server    | --strict | exit | message                     |
 *   |-------|-------|-----------|----------|------|-----------------------------|
 *   | no    | *     | *         | *        | 1    | "No indexed repository..."  |
 *   | yes   | no    | *         | *        | 0    | "verify: nothing to do"     |
 *   | yes   | yes   | absent    | no       | 0    | "LSP unavailable... (heuristic only)" |
 *   | yes   | yes   | absent    | yes      | 1    | "LSP unavailable..."        |
 *   | yes   | yes   | not-ready | no       | 0    | "LSP unavailable... (heuristic only)" |
 *   | yes   | yes   | not-ready | yes      | 1    | "LSP unavailable..."        |
 *   | yes   | yes   | ready     | *        | 0    | per-tier + overall report   |
 *
 * Invariants upheld:
 *   1. Read-only — no graph write; the only DB surface touched
 *      is `executeParameterized` (read-only MATCH…RETURN).
 *   2. Degrade-not-throw — server absent / workspace not built
 *      becomes a printed report, never a stack trace.
 *   3. Determinism — the verifier uses the seeded PRNG
 *      (`runModeCVerify`'s default seed) so two runs against the
 *      same index + server version produce byte-identical
 *      reports.
 *   4. The `source: lsp | heuristic | both` label is rendered
 *      on every report so operators can see at a glance which
 *      run produced the numbers.
 *
 * `writeSync(1, ...)` is used for stdout (not `process.stdout`
 * or `console.log`) because LadybugDB's native module captures
 * `process.stdout` during init; the underlying fd 1 remains
 * intact. This matches the `tool.ts` pattern (#324).
 */

import { writeSync, realpathSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { runModeCVerify } from '../core/ingestion/lsp/mode-c-verifier.js';
import { probeWorkspaceReadiness } from '../core/ingestion/lsp/workspace-readiness-probe.js';
import { buildCanarySamples } from '../core/ingestion/lsp/canary-sampler.js';
import { discoverServers } from '../core/ingestion/lsp/server-discovery.js';
import { mapLocationToNodeId } from '../core/ingestion/lsp/location-mapper.js';
import { LspClient } from '../core/ingestion/lsp/lsp-client.js';
import { selectAdapter } from '../core/ingestion/lsp/language-adapter.js';
import { initLbug, isLbugReady, executeParameterized } from '../mcp/core/lbug-adapter.js';

export interface VerifyCommandOptions {
  lsp?: boolean;
  strict?: boolean;
  sample?: string;
  repo?: string;
}

/**
 * Print a single line on stdout using the fd 1 path (see
 * module docstring). A helper instead of a bare `writeSync(1, ...)`
 * so the format and trailing newline are consistent.
 */
function out(line: string): void {
  writeSync(1, line + '\n');
}

/**
 * Render the verifier's per-tier + overall counters as a text
 * report. The shape mirrors the design's example output
 * (see `docs/designs/159-lsp-readonly-foundation.md` §#sd-verify-mode-c):
 *
 *   Mode C verify — sample N, server vX.Y.Z
 *
 *   same-file (n=N):
 *     precision: 95.0%
 *     recall:    90.0%
 *     false-confident: 5.0% (1/N)
 *
 *   ...
 *   overall (n=N):
 *     ...
 *
 *   source: lsp | heuristic | both
 */
function renderReport(report: {
  perTier: Record<string, {
    precision: number;
    recall: number;
    falseConfidentRate: number;
    falseConfident: number;
    n: number;
  }>;
  overall: {
    precision: number;
    recall: number;
    falseConfidentRate: number;
    falseConfident: number;
    n: number;
  };
  positionCoverage?: number;
  sampleSize: number;
  serverVersion: string | null;
}): void {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const ver = report.serverVersion ?? '?';

  out(`Mode C verify — sample ${report.sampleSize}, server v${ver}`);
  out('');

  const tierOrder = ['same-file', 'import-scoped', 'global', 'external'] as const;
  for (const tier of tierOrder) {
    const m = report.perTier[tier];
    if (!m || m.n === 0) continue;
    out(`${tier} (n=${m.n}):`);
    out(`  precision: ${pct(m.precision)}`);
    out(`  recall:    ${pct(m.recall)}`);
    out(`  false-confident: ${pct(m.falseConfidentRate)} (${m.falseConfident}/${m.n})`);
  }
  out(`overall (n=${report.overall.n}):`);
  out(`  precision: ${pct(report.overall.precision)}`);
  out(`  recall:    ${pct(report.overall.recall)}`);
  out(`  false-confident: ${pct(report.overall.falseConfidentRate)} (${report.overall.falseConfident}/${report.overall.n})`);
  if (report.positionCoverage !== undefined) {
    const totalEdges = report.overall.n > 0
      ? Math.round(report.overall.n / report.positionCoverage)
      : 0;
    const positionedEdges = Math.round(report.positionCoverage * totalEdges);
    out(`  position coverage: ${pct(report.positionCoverage)} (${positionedEdges}/${totalEdges})`);
  }
  out('');
  out('source: lsp | heuristic | both');
}

/**
 * Run `gitnexus verify`. The contract is documented at the top
 * of this file. Exported for tests (so a unit suite can drive
 * it without spawning a subprocess).
 *
 * @param options Parsed CLI flags. Undefined values fall through
 *                to the spec's defaults.
 */
export async function verifyCommand(options?: VerifyCommandOptions): Promise<void> {
  // ── 1) Precondition: indexed repo must exist ────────────────────
  // Reuse `LocalBackend.init()` exactly like `tool.ts` does — the
  // same `init` -> resolve -> "not found" path. Failure here is
  // a hard error (no graceful degradation: the user's intent is
  // to verify *something*, and without an index there's nothing
  // to verify).
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    out('No indexed repository found. Run: gitnexus analyze');
    process.exit(1);
  }

  // ── 2) Resolve repo (explicit `--repo` or default) ──────────────
  // `resolveRepo` throws on miss with a helpful "Available: …"
  // message. We propagate the throw as a non-zero exit — the
  // user's intent is explicit, so a wrong name is a user error,
  // not a degraded mode.
  let repoHandle: Awaited<ReturnType<typeof backend.resolveRepo>>;
  try {
    repoHandle = await backend.resolveRepo(options?.repo);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    out(`Error: repository not found: ${msg}`);
    process.exit(1);
  }

  // ── 3) Without `--lsp`: nothing to do ───────────────────────────
  // The spec's "verify: nothing to do (pass --lsp to run Mode C)"
  // branch. We intentionally exit 0 — this is a non-error.
  if (!options?.lsp) {
    out('verify: nothing to do (pass --lsp to run Mode C)');
    process.exit(0);
  }

  // ── 4) Parse --sample (BVA: must be a positive integer) ─────────
  // BVA: `--sample 0` and `--sample 1` are the boundaries. `0`
  // is invalid (we want at least one sample). Non-integer or
  // negative inputs are also invalid. We accept strings (the
  // CLI default comes in as a string) and parse defensively.
  const DEFAULT_SAMPLE = 200;
  const sampleSize = options?.sample !== undefined ? parseInt(options.sample, 10) : DEFAULT_SAMPLE;
  if (!Number.isFinite(sampleSize) || sampleSize < 1) {
    out('Error: --sample must be a positive integer');
    process.exit(1);
  }

  // ── 4b) Ensure the LadybugDB adapter is initialized for the repo ─
  // `runModeCVerify` calls `executeParameterized` which requires the
  // pool entry for `repoHandle.id` to exist. Other CLI commands that
  // query the graph (e.g. `query`, `context`) go through
  // `LocalBackend.ensureInitialized` (private) before every DB call.
  // Verify bypasses LocalBackend for the actual query work
  // (it delegates to `runModeCVerify` directly), so we must
  // trigger the same lazy-init here — otherwise
  // `executeParameterized` throws "LadybugDB not initialized for
  // repo …. Call initLbug first."
  if (!isLbugReady(repoHandle.id)) {
    try {
      await initLbug(repoHandle.id, repoHandle.lbugPath);
    } catch (e: any) {
      out(`Error: failed to initialize graph database: ${e?.message ?? String(e)}`);
      process.exit(1);
    }
  }

  // ── 5) Select the language adapter + discover the LSP server ───
  // KD-4: the adapter is selected once per run by extension census.
  // `null` means no supported language — degrade identically to
  // "server absent". The adapter drives discovery (which binary to
  // look for), LspClient construction, and the mapper's `classifyUri`
  // (so `jdt://` Java defs are explicitly refused as external-refusal,
  // not silently returned as NO_NODE — WI-7/KD-3).
  const repoPath = repoHandle.repoPath;
  // Pre-resolve the repo root once so the mapper's hot path skips
  // realpathSync(repoPath) on every invocation (10k+ syscalls for a
  // large Python repo). Mirrors the same pattern in pipeline.ts:776-784.
  let resolvedRepoPath: string | undefined;
  try {
    resolvedRepoPath = realpathSync(repoPath);
  } catch {
    resolvedRepoPath = undefined;
  }
  const adapter = selectAdapter(repoPath);
  if (!adapter) {
    const msg = 'LSP unavailable: no supported language detected in repository';
    if (options?.strict) {
      out(msg);
      process.exit(1);
    }
    out(`${msg} — using heuristic only`);
    return;
  }

  // Server discovery never throws (per WI-#2 contract). A null
  // result is the "absent" verdict. We treat absent and
  // not-ready symmetrically: both yield a "LSP unavailable"
  // message, with strict controlling the exit code.
  const servers = await discoverServers();
  const serverEntry = servers[adapter.id as keyof typeof servers];
  if (!serverEntry) {
    const msg = `LSP unavailable: ${adapter.serverBinary} not found (install to enable --lsp)`;
    if (options?.strict) {
      out(msg);
      process.exit(1);
    }
    out(`${msg} — using heuristic only`);
    return;
  }

  // ── 6) Start the LSP client + probe workspace readiness ─────────
  // The client is per-invocation (per the warm-singleton contract
  // of WI-#3). We MUST stop it on every code path, including the
  // error paths — hence the try/finally. The probe uses canary
  // samples built from real files in the repo root via
  // `buildCanarySamples`. Adapter carries its canary strategy
  // (WI-2); null canary falls back to the TS strategy default.
  const client = new LspClient({
    binaryPath: serverEntry.path,
    workspaceRoot: repoPath,
    adapter,
  });

  try {
    await client.start();
    const samples = await buildCanarySamples(repoPath, { strategy: adapter.canary });
    const probe = await probeWorkspaceReadiness(client, samples, {
      perRequestTimeoutMs: 3000,
    });
    if (!probe.ready) {
      const msg = `LSP unavailable: ${probe.reason ?? 'workspace not ready'}`;
      if (options?.strict) {
        out(msg);
        process.exit(1);
      }
      out(`${msg} — using heuristic only`);
      return;
    }

    // ── 7) Run Mode C ───────────────────────────────────────────
    // We hand the verifier the real `mapLocationToNodeId` and
    // the real `executeParameterized` — both are read-only. The
    // `probe` we already ran is reused (we don't double-probe).
    // The seed is the verifier's default, which keeps the
    // report byte-stable across runs (Invariant 7).
    //
    // Bug B fix (#F4): pass `repoPath` so the mapper can rebase
    // the absolute LSP `file://` URIs to repo-relative paths
    // that match the graph's stored `filePath` values.
    //
    // WI-7: thread `adapter.classifyUri` into the mapper so that
    // language-specific URIs (`jdt://` for Java decompiled/stdlib
    // defs) are explicitly refused as external-refusal (KD-3),
    // not silently returned as NO_NODE (which would wrongly count
    // as a recall-miss when the heuristic target was null).
    const report = await runModeCVerify({
      repoId: repoHandle.id,
      client,
      adapter,
      // Bug F4-forward fix: `classifyEdge` anchors each edge's
      // repo-relative `sourceFile` to this root when building the
      // `textDocument/definition` URI. Without it, `file://src/x.ts`
      // is malformed (host=`src`) and every request returns null →
      // 0% across all tiers.
      repoPath,
      resolvedRepoPath,
      mapLocationToNodeId: (loc, repoId) =>
        mapLocationToNodeId(loc, repoId, { repoPath, resolvedRepoPath, classifyUri: (uri) => adapter.classifyUri(uri), adapterId: adapter.id }),
      executeParameterized,
      probe: async () => probe, // already probed above
      sampleSize,
      serverVersion: serverEntry.version,
    });

    // ── 8) Render the report + exit 0 ───────────────────────────
    renderReport(report);
  } finally {
    // The LspClient's stop is idempotent + non-throwing; the
    // try/finally guarantees we never leak a subprocess even
    // on the success / render-error paths.
    try {
      await client.stop();
    } catch {
      /* swallow — `stop` is contractually non-throwing */
    }
  }
}
