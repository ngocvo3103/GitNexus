/**
 * LanguageAdapter — per-language delta for the LSP-augmentation stack.
 *
 * A value-object carrying every per-language variation:
 *   - server binary name and spawn arguments
 *   - didOpen `languageId`
 *   - LSP `initializationOptions`
 *   - post-`initialized` warm-up gate (`awaitReady`, KD-1)
 *   - canary sampling strategy (`LanguageCanaryStrategy`, KD-5)
 *   - URI classification (`classifyUri`, KD-3)
 *
 * Design: value-object + two strategy methods. Languages share
 * *shape*, not *behavior* — an inheritance hierarchy would be
 * abstraction without reuse. Selected once per run by extension
 * census (`selectAdapter`, KD-4) and threaded through the existing
 * DI seams in `mode-a-reconciler.ts` / `LspClient`.
 *
 * TS adapter invariant: `TYPESCRIPT_ADAPTER` reproduces today's
 * literals from `lsp-client.ts` exactly — the default TS-repo
 * funnel is byte-identical to pre-change (golden tests stay green).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type MessageConnection } from 'vscode-languageserver-protocol/node';

import { getGlobalDir } from '../../../storage/repo-manager.js';
import { TYPESCRIPT_LANGUAGE_SERVER_BIN } from './server-discovery.js';
// WI-2: import canary strategies. canary-sampler.ts only `import type`s from this
// file (LanguageCanaryStrategy), so the import is erased at runtime — no cycle.
import { TS_CANARY_STRATEGY, JAVA_CANARY_STRATEGY, buildCanarySamples } from './canary-sampler.js';

// ─── Forward-declared types (filled in by WI-2/WI-4) ─────────────────

/**
 * Per-language canary sampling strategy.
 * Defined here as a forward-declaration; WI-2 fills in the TS/Java
 * implementations. The type lives here (not in `canary-sampler.ts`)
 * to break the circular dependency: `LanguageAdapter` needs
 * `LanguageCanaryStrategy`; `canary-sampler.ts` needs `LanguageAdapter`
 * (for its default-arg). Placing the type here severs the cycle.
 *
 * `tryExtractSample` returns the Sample shape consumed by
 * `workspace-readiness-probe.ts` — intentionally kept as a structural
 * type alias here to avoid a circular import.
 */
export interface LanguageCanaryStrategy {
  isCandidateFile(name: string): boolean;
  tryExtractSample(
    absPath: string,
    content: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null;
}

/**
 * Context passed to `LanguageAdapter.awaitReady` after the LSP
 * `initialized` notification is sent. The adapter may:
 *   - register a `language/status` / `ServiceReady` handler, OR
 *   - probe the canary set to establish readiness, OR
 *   - no-op immediately (TS adapter).
 *
 * `connection` is the active JSON-RPC message connection. Typed
 * as `unknown` here to avoid a circular import with `lsp-client.ts`
 * (which imports this file). WI-4 narrows it to `MessageConnection`
 * at the call site via a cast.
 */
export interface AdapterReadyCtx {
  /** The live JSON-RPC connection (cast to `MessageConnection` in WI-4). */
  connection: unknown;
  /** Workspace root — used by Java adapter to probe `.java` canary files. */
  workspaceRoot: string;
  /**
   * Hard deadline for the warm-up gate (milliseconds from call time).
   * Defaults to 120 000ms (2 min) for jdtls; TS adapter ignores this.
   */
  deadlineMs?: number;
  /**
   * Optional backstop probe injected by callers of `awaitReady`.
   * Called by `JAVA_ADAPTER.awaitReady` on hard deadline if the server
   * has not yet emitted `ServiceReady`.
   *
   * Resolves `true` if the server is judged ready by an out-of-band check
   * (e.g. a `textDocument/definition` request on a canary sample);
   * `false` if not. Must never reject — callers wrap it in `.catch(() => false)`.
   *
   * When absent, the deadline branch falls through to the inline path (B):
   * `buildCanarySamples` + `textDocument/didOpen` + `textDocument/definition`
   * on the raw `MessageConnection`. This is the production path —
   * `LspClient.spawnAndInitialize` does not currently inject `backstopProbe`.
   * The inline path issues `didOpen` before the definition request so jdtls
   * can serve it (jdtls requires an open file before resolving definitions).
   */
  backstopProbe?: () => Promise<boolean>;
}

// ─── LanguageAdapter interface ────────────────────────────────────────

/**
 * Per-language delta. A single instance is selected per run and
 * threaded through all LSP-stack entry points.
 */
export interface LanguageAdapter {
  /** Closed union; grows for go/python in future slices. */
  readonly id: 'typescript' | 'java';

  /**
   * Binary basename passed to server discovery.
   * `'typescript-language-server'` | `'jdtls'`
   */
  readonly serverBinary: string;

  /**
   * `languageId` for `textDocument/didOpen` notifications.
   * `'typescript'` | `'java'`
   */
  readonly languageId: string;

  /**
   * Build the subprocess spawn arguments.
   * TS: `['--stdio']`
   * Java: `['-data', <per-run metadata dir>]`
   */
  spawnArgs(ctx: { workspaceRoot: string }): string[];

  /**
   * LSP `initialize` request `initializationOptions`.
   * Must be stable across runs for a given workspace (golden safety).
   */
  readonly initializationOptions: unknown;

  /**
   * Post-`initialized` warm-up gate (KD-1).
   *
   * Called by `LspClient` immediately after sending the `initialized`
   * notification. Resolves `true` when the server is ready to serve
   * definitions; `false` on timeout/error → `spawnAndInitialize`
   * returns false → funnel skips gracefully.
   *
   * TS adapter: no-ops and returns `true` immediately.
   * Java adapter (WI-4): waits for `language/status`/`ServiceReady`
   * with a canary-probe backstop.
   */
  awaitReady(ctx: AdapterReadyCtx): Promise<boolean>;

  /**
   * Per-language canary sampling strategy (KD-5).
   * TS_CANARY_STRATEGY and JAVA_CANARY_STRATEGY are both fully implemented
   * (WI-2 is done). Every `LanguageAdapter` must supply a real strategy;
   * the non-nullable type matches the spec contract declared in `## Specs`.
   */
  readonly canary: LanguageCanaryStrategy;

  /**
   * Classify a definition URI for the location-mapper (KD-3).
   *
   * - `'workspace'`   → a `file://` URI inside the workspace; map normally.
   * - `'external'`    → a `jdt://` decompiled URI (jdtls's canonical scheme
   *                     for stdlib/jar definitions); short-circuit to
   *                     `{kind:'NO_NODE', external:true}`.
   * - `'unmappable'`  → any other scheme (including `classpath://`); treat as
   *                     NO_NODE (no `external` flag).
   *
   * TS adapter: `file://` → `'workspace'`; anything else → `'unmappable'`.
   * Java adapter: `file://` → `'workspace'`; `jdt://` → `'external'`;
   * anything else (including `classpath://`) → `'unmappable'`.
   *
   * IMPORTANT: `'workspace'` is a SCHEME-ONLY signal. Callers MUST perform
   * their own workspaceRoot containment check (realpath + path.relative) before
   * trusting that the URI falls inside the workspace. See
   * `location-mapper.ts:451-493` for the canonical guard.
   */
  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable';
}

// ─── TS initialization options ────────────────────────────────────────
//
// `lsp-client.ts` now exports `TS_INITIALIZATION_OPTIONS` (WI-4 done).
// We intentionally keep a local copy here rather than importing it,
// because `lsp-client.ts` imports this file (for `TYPESCRIPT_ADAPTER`),
// creating a circular ESM dependency that would leave `TS_INITIALIZATION_OPTIONS`
// as `undefined` at module init time in Node.js. The
// `ts-initialization-options-golden.test.ts` detects any drift between the two
// copies. If the circular dependency is ever resolved (e.g. by extracting the
// constant to a shared module), replace this copy with a direct import.

const TS_INITIALIZATION_OPTIONS: Record<string, unknown> = {
  hostInfo: 'gitnexus-lsp-client',
  tsserver: {
    path: '', // empty -> bundled tsserver
  },
};

// ─── TYPESCRIPT_ADAPTER ───────────────────────────────────────────────

/**
 * The TypeScript language adapter. Wraps today's hardcoded literals
 * from `lsp-client.ts` — every field is byte-identical to the pre-
 * adapter code so the TS-repo funnel is unchanged.
 *
 * Invariants (tested):
 *   - `spawnArgs()` === `['--stdio']`
 *   - `classifyUri('file://…')` === `'workspace'`
 *   - `classifyUri('jdt://…')` === `'unmappable'` (TS adapter never
 *     sees `jdt://`; Java adapter returns `'external'`)
 *   - `awaitReady()` resolves `true` immediately (no-op)
 */
export const TYPESCRIPT_ADAPTER: LanguageAdapter = {
  id: 'typescript',
  serverBinary: TYPESCRIPT_LANGUAGE_SERVER_BIN,
  languageId: 'typescript',

  spawnArgs(_ctx: { workspaceRoot: string }): string[] {
    return ['--stdio'];
  },

  initializationOptions: TS_INITIALIZATION_OPTIONS,

  async awaitReady(_ctx: AdapterReadyCtx): Promise<boolean> {
    // TS server answers requests immediately after the `initialized`
    // handshake — no warm-up gate needed.
    return true;
  },

  // WI-2: wired — TS_CANARY_STRATEGY is fully implemented in canary-sampler.ts.
  canary: TS_CANARY_STRATEGY,

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    if (uri.startsWith('file://')) return 'workspace';
    return 'unmappable';
  },
};

// ─── JAVA_ADAPTER ─────────────────────────────────────────────────────

/**
 * Java language adapter (WI-4c implementation).
 *
 * `spawnArgs`: returns `['-data', <per-run metadata dir>]` where the dir
 * is derived under the per-fork `GITNEXUS_HOME` (I-5 / #175 isolation).
 *
 * `awaitReady`: waits for the jdtls `language/status`/`ServiceReady`
 * notification (KD-1). Falls back to canary re-probe on hard deadline
 * (canary is always non-null — WI-2 is done). The inline probe (path B)
 * sends `textDocument/didOpen` before the definition request so jdtls
 * can answer it. Always disposes the handler; never rejects.
 *
 * `classifyUri`: `file://` → workspace; `jdt://` → external (KD-3);
 * anything else → unmappable.
 */
export const JAVA_ADAPTER: LanguageAdapter = {
  id: 'java',
  serverBinary: 'jdtls',
  languageId: 'java',

  spawnArgs(ctx: { workspaceRoot: string }): string[] {
    // Derive a per-run metadata dir under the per-fork GITNEXUS_HOME (I-5 / #175).
    // getGlobalDir() reads process.env.GITNEXUS_HOME which is unique per fork/run.
    // The workspaceRoot SHA-1 prefix makes the path filesystem-safe while keeping
    // it workspace-specific (avoids collisions between concurrent repos).
    const wsHash = crypto.createHash('sha1').update(ctx.workspaceRoot).digest('hex').slice(0, 16);
    const dataDir = path.join(getGlobalDir(), 'jdtls', wsHash);
    return ['-data', dataDir];
  },

  initializationOptions: {},

  awaitReady(ctx: AdapterReadyCtx): Promise<boolean> {
    // KD-1: wait for jdtls `language/status` / `ServiceReady` notification.
    // On hard deadline: attempt one canary re-probe (KD-1 backstop).
    // Contract: never rejects; always disposes the notification handler (no leak).
    //
    // Capture canary at call time (not via JAVA_ADAPTER self-reference) so
    // tests and clones can patch the adapter copy and observe the backstop.
    const capturedCanary = JAVA_ADAPTER.canary;
    const capturedWorkspaceRoot = ctx.workspaceRoot;

    return new Promise<boolean>((resolve) => {
      const deadline = ctx.deadlineMs ?? 120_000;
      const conn = ctx.connection as MessageConnection;

      let settled = false;
      let handler: { dispose(): void } | null = null;
      // Hoisted before `settle` to avoid TDZ when onNotification throws synchronously.
      let timer: ReturnType<typeof setTimeout> | null = null;

      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        try {
          handler?.dispose();
        } catch {
          // ignore dispose errors — best-effort cleanup
        }
        resolve(value);
      }

      // Register a one-shot notification handler for language/status.
      try {
        handler = conn.onNotification(
          'language/status',
          (params: unknown) => {
            // jdtls sends { type: 'ServiceReady', message: '...' } when ready.
            // Accept any truthy ServiceReady type regardless of extra fields.
            if (
              params !== null &&
              typeof params === 'object' &&
              (params as Record<string, unknown>)['type'] === 'ServiceReady'
            ) {
              settle(true);
            }
            // Non-ready notifications (Starting, Error, etc.) are ignored;
            // the handler stays registered until ready or deadline.
          },
        );
      } catch {
        // Connection already disposed or registration failed — degrade gracefully.
        settle(false);
        return;
      }

      // Hard deadline: fall back to one canary re-probe (KD-1 backstop).
      timer = setTimeout(() => {
        if (settled) return;
        // KD-1 backstop: invoke the probe and settle based on its result.
        // Never assume readiness without verification (AC-4 / Invariant I-2).
        //
        // Two paths to the probe — both must call settle() exactly once:
        //
        // (A) Injected probe via ctx.backstopProbe — used in unit tests to
        //     supply a controlled readiness verdict without a real server.
        //     The injected function is authoritative; if present, it is the
        //     only probe invoked.
        //
        // (B) Inline probe via buildCanarySamples + conn.sendNotification +
        //     conn.sendRequest — the production path when no injected probe is
        //     provided. MUST send `textDocument/didOpen` before the definition
        //     request: jdtls requires a file to be open in the workspace before
        //     it will serve definitions for it; a request on an unopened file
        //     returns an empty array, which we would incorrectly interpret as
        //     not-ready even when the workspace IS indexed.
        void (async () => {
          try {
            if (ctx.backstopProbe) {
              // (A) Injected probe — caller is responsible for the full
              // probe logic (build samples, issue definition request, etc.).
              const ready = await ctx.backstopProbe();
              settle(ready);
              return;
            }
            // (B) Inline probe.
            const samples = await buildCanarySamples(capturedWorkspaceRoot, {
              strategy: capturedCanary,
              maxFiles: 1,
            });
            if (samples.length === 0) {
              // No candidate files found — cannot verify; degrade.
              settle(false);
              return;
            }
            const sample = samples[0];
            // Open the file in the workspace BEFORE requesting its definition.
            // jdtls will return an empty array for an unopened file, which
            // would be misread as not-ready. Best-effort: if didOpen fails
            // we still proceed with the definition request.
            try {
              let fileContent = '';
              try {
                fileContent = await fs.promises.readFile(
                  sample.textDocument.uri.replace(/^file:\/\//, ''),
                  'utf8',
                );
              } catch { /* unreadable — send empty content */ }
              await conn.sendNotification('textDocument/didOpen', {
                textDocument: {
                  uri: sample.textDocument.uri,
                  languageId: JAVA_ADAPTER.languageId,
                  version: 1,
                  text: fileContent,
                },
              });
            } catch { /* best-effort: proceed even if didOpen fails */ }
            const result = await conn.sendRequest<unknown>(
              'textDocument/definition',
              { textDocument: sample.textDocument, position: sample.position },
            );
            // A non-null, non-empty response means the server resolved the
            // definition — the workspace is ready.
            const ready =
              result !== null &&
              result !== undefined &&
              !(Array.isArray(result) && result.length === 0);
            settle(ready);
          } catch {
            // Any error during the backstop probe — degrade gracefully.
            settle(false);
          }
        })();
      }, deadline);

      // Prevent the timer from keeping the Node.js event loop alive past teardown.
      if (typeof (timer as unknown) === 'object' && timer !== null && typeof (timer as NodeJS.Timeout).unref === 'function') {
        (timer as NodeJS.Timeout).unref();
      }
    });
  },

  // WI-2: wired — JAVA_CANARY_STRATEGY is fully implemented in canary-sampler.ts.
  canary: JAVA_CANARY_STRATEGY,

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    if (uri.startsWith('file://')) return 'workspace';
    // jdt:// is jdtls's canonical scheme for decompiled stdlib/jar definitions
    // (KD-3). classpath:// is NOT a real jdtls response URI — jdtls exclusively
    // uses jdt:// for external defs. classpath:// falls through to 'unmappable'
    // (NO_NODE without external flag) rather than 'external', keeping the contract
    // narrow and testable. If a future jdtls version emits classpath:// URIs,
    // add it here with a failing test first.
    if (uri.startsWith('jdt://')) return 'external';
    return 'unmappable';
  },
};

// ─── Extension census for KD-4 adapter selection ─────────────────────

/** Extensions that indicate a TypeScript/JavaScript LSP project. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Extensions that indicate a Java LSP project. */
const JAVA_EXTENSIONS = new Set(['.java']);

/**
 * Directories to skip during the extension census walk. Skipping
 * these prevents counting generated/vendored files that don't
 * reflect the project's primary language.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.gitnexus',
  'dist',
  'build',
  'out',
  'target', // Maven/Gradle build output
  '.mvn',
  '.gradle',
  '__pycache__',
  '.venv',
  'vendor',
]);

/**
 * Maximum files to inspect during census (prevents event-loop blocking on
 * large monorepos). Kept at 2 000 — enough to detect a dominant language
 * in any non-trivial project while bounding the synchronous syscall count
 * to ~200ms on spinning disk (well within the acceptable gate budget).
 */
const CENSUS_FILE_LIMIT = 2_000;

/**
 * Walk `dir` recursively, counting LSP-relevant file extensions.
 * Bails out once `CENSUS_FILE_LIMIT` files have been inspected.
 *
 * Returns `{ tsCount, javaCount }`.
 */
function censusExtensions(dir: string): { tsCount: number; javaCount: number } {
  let tsCount = 0;
  let javaCount = 0;
  let inspected = 0;

  function walk(current: string): void {
    if (inspected >= CENSUS_FILE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (inspected >= CENSUS_FILE_LIMIT) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        // Only count regular files. Symlinked files are excluded: `Dirent.isFile()`
        // returns false for symlinks (Dirent methods do not follow them), and
        // counting symlinked files risks inflating the census with aliases that
        // point outside the repo root. The census only needs a rough dominant-
        // language signal — missing a handful of symlinked source files does not
        // affect correctness.
        inspected++;
        const ext = path.extname(entry.name).toLowerCase();
        if (TS_EXTENSIONS.has(ext)) {
          tsCount++;
        } else if (JAVA_EXTENSIONS.has(ext)) {
          javaCount++;
        }
      }
    }
  }

  walk(dir);
  return { tsCount, javaCount };
}

/**
 * Select the appropriate `LanguageAdapter` for a repository by
 * performing an extension census (KD-4).
 *
 * Algorithm:
 *   1. Count TS-family files (`.ts`, `.tsx`, `.mts`, `.cts`,
 *      `.js`, `.jsx`, `.mjs`, `.cjs`) and Java files (`.java`)
 *      under `repoPath` (skipping `node_modules`, `dist`, `target`, …).
 *   2. The dominant count wins. Ties go to TypeScript (more common
 *      in practice; TS adapter is the proven-stable one).
 *   3. If both counts are zero, return `null` — the funnel is not
 *      entered for unsupported repos (no LSP server will be spawned).
 *
 * @param repoPath  Absolute path to the repository root.
 * @returns The selected adapter, or `null` if no supported language
 *          was detected.
 */
export function selectAdapter(repoPath: string): LanguageAdapter | null {
  const { tsCount, javaCount } = censusExtensions(repoPath);

  if (tsCount === 0 && javaCount === 0) {
    // No supported LSP language detected — funnel not entered.
    return null;
  }

  // Ties go to TS (safe default — TS adapter is the proven path).
  if (tsCount >= javaCount) {
    return TYPESCRIPT_ADAPTER;
  }

  // Java is dominant.
  return JAVA_ADAPTER;
}
