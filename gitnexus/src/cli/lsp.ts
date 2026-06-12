/**
 * LSP CLI — `gitnexus lsp <action>`
 *
 * WI-#7 of the #159 LSP read-only foundation. P1.
 *
 * Implements a one-shot `doctor` subcommand that:
 *   1. Discovers the `typescript-language-server` binary
 *      (node_modules/.bin → PATH → npx — WI-#2).
 *   2. If absent, prints a NOT FOUND line and exits 0
 *      (informational; the operator decides what to install).
 *   3. If present, starts a per-workspace warm LspClient
 *      (WI-#3) and runs a workspace-readiness probe
 *      (WI-#5) against a single canary sample.
 *   4. Prints a one-line text report (or JSON with
 *      `--format json`) describing the server + workspace state.
 *
 * Invariants
 * ──────────
 *   - Never installs the language server (KD-3: BYO only).
 *   - Always exits 0 (informational; absence is a normal
 *     report, not an error).
 *   - One-shot: detects + reports, then exits (KD-7).
 *   - No graph writes — read-only probe against the
 *     discovered binary.
 *
 * Why a separate command (vs. a flag on `verify`):
 *   `verify --lsp` is the comparator (Mode C, WI-#6 / WI-#8).
 *   `lsp doctor` is the *diagnostic* the operator runs first
 *   to know whether `--lsp` is even usable. Same dependency
 *   surface, different lifecycle (no comparator, no sampling).
 */

import { writeSync } from 'node:fs';
import { LspClient } from '../core/ingestion/lsp/lsp-client.js';
import { discoverServers } from '../core/ingestion/lsp/server-discovery.js';
import { probeWorkspaceReadiness } from '../core/ingestion/lsp/workspace-readiness-probe.js';
import { buildCanarySamples } from '../core/ingestion/lsp/canary-sampler.js';

// ─── Public types ─────────────────────────────────────────────────────

export interface LspCommandOptions {
  format?: 'text' | 'json';
}

/**
 * Shape of the JSON report printed by `--format json`. Stable —
 * any change here is a contract change for downstream tooling
 * that may pipe `gitnexus lsp doctor --format json` into jq.
 */
export interface LspDoctorReport {
  typescript: { path: string; version: string } | null;
  workspace: { ready: boolean; reason?: string };
}

// ─── Entry point ──────────────────────────────────────────────────────

/**
 * `gitnexus lsp <action>` dispatcher.
 *
 * Currently only the `doctor` action is implemented. Unknown
 * actions print a usage line to stderr and exit 1 — the
 * operator's mistake, not ours.
 */
export async function lspCommand(
  action: string,
  options?: LspCommandOptions,
): Promise<void> {
  if (action === 'doctor') {
    return runDoctor(options);
  }
  console.error(`Unknown action: ${action}. Use: gitnexus lsp doctor`);
  process.exit(1);
}

// ─── `doctor` action ──────────────────────────────────────────────────

/**
 * Detect + report, then exit. Mirrors the design-doc sequence
 * `#sd-lsp-doctor` step-by-step:
 *
 *   1. discoverServers()  → `{ typescript: {path, version} | null }`
 *   2. absent branch      → "NOT FOUND" + exit 0
 *   3. present branch     → spawn client, probe readiness
 *   4. report verdict
 *
 * Output is on fd 1 (stdout) via `writeSync` so it survives
 * LadybugDB's stdout capture (#324). The same pattern is
 * used in `cli/tool.ts` and `cli/eval-server.ts`.
 */
async function runDoctor(options?: LspCommandOptions): Promise<void> {
  const format = options?.format ?? 'text';
  const servers = await discoverServers();
  const tsInfo = servers.typescript;

  let ready = false;
  let reason: string | undefined;

  if (tsInfo) {
    // The probe needs real TypeScript canary positions — spots in
    // actual .ts files where a cross-file identifier (an import
    // binding, an exported function name, etc.) lives. A language
    // server that has resolved the module graph can answer a
    // `textDocument/definition` request at such a position with a
    // non-empty Location[]. We use `buildCanarySamples` rather than
    // a hard-coded package.json path because:
    //   (a) typescript-language-server does NOT serve definitions
    //       for JSON files — a package.json canary always returns []
    //       regardless of workspace readiness, so the probe could
    //       NEVER report ready:true with that approach.
    //   (b) A relative-import position is a genuine cross-file
    //       resolution request — the strongest available signal
    //       that the language server has actually built its module
    //       graph for this workspace.
    //
    // `lsp doctor` runs pre-index (the graph doesn't exist yet),
    // so we must use the FS-based sampler rather than a graph query.
    // `buildCanarySamples` uses process.cwd() as the repo root when
    // the command is run from the project root; the probe's own
    // 'no samples provided' reason surfaces if no .ts files are
    // found, which is correct for a TS-less workspace.
    const client = new LspClient({ binaryPath: tsInfo.path, workspaceRoot: process.cwd() });
    try {
      await client.start();
      const samples = await buildCanarySamples(process.cwd());
      const probeResult = await probeWorkspaceReadiness(client, samples, {
        perRequestTimeoutMs: 3000,
      });
      ready = probeResult.ready;
      reason = probeResult.reason;
    } catch (e: unknown) {
      // start() / probe threw — treat as "not ready" with
      // the error message as the diagnostic reason. The
      // contract: never throw out of `lsp doctor` — the
      // operator must always get a printable report.
      const message = e instanceof Error ? e.message : String(e);
      reason = `client start failed: ${message}`;
    } finally {
      // Best-effort shutdown. `client.stop()` is idempotent +
      // never throws (per WI-#3 contract), but we wrap in
      // try/catch so a misbehaving server can never leak a
      // subprocess past this point.
      try {
        await client.stop();
      } catch {
        /* noop */
      }
    }
  }

  const report: LspDoctorReport = {
    typescript: tsInfo ? { path: tsInfo.path, version: tsInfo.version } : null,
    workspace: { ready, ...(reason ? { reason } : {}) },
  };

  if (format === 'json') {
    writeSync(1, JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // Text format. Three branches per the design spec:
  //   - absent  → "NOT FOUND (install to enable --lsp)"
  //   - present + ready    → "found vX.Y · workspace ready ✓"
  //   - present + unready  → "found vX.Y · workspace NOT ready: <reason>"
  if (!tsInfo) {
    writeSync(1, 'typescript-language-server: NOT FOUND (install to enable --lsp)\n');
    return;
  }
  const state = ready
    ? 'ready ✓'
    : reason
      ? `NOT ready: ${reason}`
      : 'unknown';
  writeSync(1, `typescript-language-server: found v${tsInfo.version} · workspace ${state}\n`);
  // Informational exit; never 1.
  process.exit(0);
}
