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
import { fileURLToPath } from 'node:url';

import { type MessageConnection } from 'vscode-languageserver-protocol/node';

import { getGlobalDir } from '../../../storage/repo-manager.js';
import { TYPESCRIPT_LANGUAGE_SERVER_BIN } from './server-discovery.js';
// WI-2: import canary strategies. canary-sampler.ts only `import type`s from this
// file (LanguageCanaryStrategy), so the import is erased at runtime — no cycle.
import { TS_CANARY_STRATEGY, JAVA_CANARY_STRATEGY, PYTHON_CANARY_STRATEGY, GO_CANARY_STRATEGY, RUST_CANARY_STRATEGY, buildCanarySamples } from './canary-sampler.js';

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

  // ── WI-2: progress read-seam (Go + Java) ────────────────────────────
  //
  // The three fields below are OPTIONAL. TS/Python adapters receive an
  // `AdapterReadyCtx` where all three are `undefined` — their `awaitReady`
  // implementations must not touch them. Both `GO_ADAPTER.awaitReady` and
  // `JAVA_ADAPTER.awaitReady` read them; `LspClient.spawnAndInitialize`
  // populates them by reference when the adapter has
  // `clientCapabilities?.window?.workDoneProgress` set (truthy).
  //
  // Go: `workDoneProgress: true` (WI-2a — gopls progress gate).
  // Java: `workDoneProgress: true` (WI-1 — jdtls settle-until-quiet gate).
  //
  // Design: threaded by reference (same Map/Set instance as `LspClient`) so
  // `awaitReady` can observe tokens buffered BEFORE it is called (the
  // begin-before-awaitReady race). The `onProgressEnd` subscribe seam lets
  // `awaitReady` be notified when a new `end` arrives after it starts.

  /**
   * Live reference to `LspClient.progressTokenTitles` (populated by the
   * pre-`initialize` `$/progress` handler). Keys are progress token ids;
   * values are the stored `begin.value.title` strings.
   *
   * Populated for Go and Java (both set `clientCapabilities?.window?.workDoneProgress`).
   * `undefined` for TS/Python.
   */
  progressTokenTitles?: ReadonlyMap<string | number, string>;

  /**
   * Live reference to `LspClient.progressEndedTokens` (populated by the
   * pre-`initialize` `$/progress` handler). Contains every token that has
   * received its `end` notification.
   *
   * Populated for Go and Java. `undefined` for TS/Python.
   */
  progressEndedTokens?: ReadonlySet<string | number>;

  /**
   * Subscribe to future `$/progress end` events. The callback `cb` is invoked
   * with the ended token each time the pre-`initialize` `$/progress` handler
   * processes a new `end` notification. The returned disposable removes `cb`
   * from the registry.
   *
   * Populated for Go and Java. `undefined` for TS/Python.
   *
   * Usage pattern in `GO_ADAPTER.awaitReady` / `JAVA_ADAPTER.awaitReady`:
   *   const sub = ctx.onProgressEnd?.((token) => { … });
   *   // …
   *   sub?.dispose();
   */
  onProgressEnd?: (cb: (token: string | number) => void) => { dispose(): void };

  // ── WI-3b2: experimental/serverStatus read-seam (Rust only) ──────────────
  //
  // The two fields below are OPTIONAL. TS/Java/Python/Go adapters receive an
  // `AdapterReadyCtx` where both are `undefined` — their `awaitReady`
  // implementations must not touch them. Only `RUST_ADAPTER.awaitReady` reads
  // them; `LspClient.spawnAndInitialize` populates them by reference when the
  // adapter has `clientCapabilities?.experimental?.serverStatusNotification`
  // set (truthy).
  //
  // Design: threaded by reference (same holder/Set instance as `LspClient`) so
  // `awaitReady` can observe a notification buffered BEFORE it is called (the
  // begin-before-awaitReady timing class, #172). The `onServerStatus` subscribe
  // seam lets `awaitReady` be notified when a new status arrives after it starts.

  /**
   * Latest `experimental/serverStatus` payload buffered by the pre-`initialize`
   * handler (registered in `spawnAndInitialize`). Shape: `{ quiescent: boolean;
   * health: string }`. `undefined` until the first notification arrives.
   *
   * Populated only for Rust (Rust adapter sets
   * `clientCapabilities?.experimental?.serverStatusNotification`).
   * `undefined` for TS/Java/Python/Go.
   *
   * `awaitReady` reads this field first (buffer-hit path): if the notification
   * already arrived before `awaitReady` is called, it can resolve immediately
   * without subscribing.
   */
  serverStatusLatest?: { quiescent: boolean; health: string };

  /**
   * Subscribe to future `experimental/serverStatus` notifications. The callback
   * `cb` is invoked with the latest `{ quiescent, health }` payload each time
   * the pre-`initialize` handler processes a new notification. The returned
   * disposable removes `cb` from the registry.
   *
   * Populated only for Rust. `undefined` for TS/Java/Python/Go.
   *
   * Usage pattern in `RUST_ADAPTER.awaitReady`:
   *   const sub = ctx.onServerStatus?.((payload) => { … });
   *   // …
   *   sub?.dispose();
   */
  onServerStatus?: (cb: (payload: { quiescent: boolean; health: string }) => void) => { dispose(): void };
}

// ─── ClientCapabilities ───────────────────────────────────────────────

/**
 * Structural type for the LSP `initialize` request's `clientCapabilities`
 * payload (WI-0 R2-1).
 *
 * Non-literal members are intentional: the module-private
 * `TS_SERVER_CAPABILITIES` const in `lsp-client.ts` has a literal
 * `window.workDoneProgress: false` field (due to `as const`).  If
 * `InitializeParams.capabilities` stayed typed as `typeof TS_SERVER_CAPABILITIES`,
 * any adapter supplying `{window:{workDoneProgress:true}}` would fail `tsc`.
 * Widening to this structural type (with `boolean`, not `false | true`) makes
 * both the existing const and the Go override assignable.
 *
 * Defined here (not in `lsp-client.ts`) to avoid a circular ESM dependency:
 * `lsp-client.ts` imports `LanguageAdapter` from this file; importing
 * `ClientCapabilities` back from `lsp-client.ts` would create a cycle that
 * leaves one side `undefined` at module init time in Node.js.  `lsp-client.ts`
 * re-exports this type for callers that need to import from there.
 *
 * Expand-contract rule: add new optional fields here; never remove or rename
 * existing fields. Callers may depend on any field being present by name —
 * removing one is a breaking change even if all current callers are updated
 * (downstream tools may consume serialised JSON). Widen additively instead.
 */
export interface ClientCapabilities {
  textDocument?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  window?: { workDoneProgress?: boolean };
  /**
   * Experimental capabilities negotiated outside the LSP core spec.
   * Language servers that advertise `serverStatusNotification` (e.g.
   * rust-analyzer) read this field from the initialize request.
   * Typed as `Record<string, unknown>` to remain open for future keys
   * without requiring interface updates (I-13).
   */
  experimental?: Record<string, unknown>;
}

// ─── LanguageAdapter interface ────────────────────────────────────────

/**
 * Per-language delta. A single instance is selected per run and
 * threaded through all LSP-stack entry points.
 */
export interface LanguageAdapter {
  /**
   * Discriminant for the adapter instance.
   *
   * Expand-contract rule: widen this union additively (add a new literal);
   * NEVER add an exhaustive switch/discriminant over `.id` in production code.
   * Union members must only be added, never removed or renamed — callers may
   * hold string-typed adapter ids at runtime (e.g. from serialised config) and
   * a removed literal would silently produce a type error on assignment.
   */
  readonly id: 'typescript' | 'java' | 'python' | 'go' | 'rust';

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
   * Per-adapter LSP client capabilities (WI-0 seam, R2-1).
   *
   * When present, this value is used verbatim as the `capabilities` field of
   * the LSP `initialize` request, instead of the default `TS_SERVER_CAPABILITIES`
   * const from `lsp-client.ts`. Adapters that do NOT set this field (TS, Java,
   * Python) receive the byte-identical `TS_SERVER_CAPABILITIES` payload —
   * `lsp-client.ts` uses `adapter.clientCapabilities ?? TS_SERVER_CAPABILITIES`.
   *
   * Go adapter: `{ window: { workDoneProgress: true } }` — tells gopls the
   * client supports progress notifications, enabling the `$/progress` stream
   * required by the `awaitReady` background-load gate (R2-2 / KD-1).
   *
   * MUST NOT be the same object reference as `TS_SERVER_CAPABILITIES` — that
   * const is module-private and must never be mutated (C0-2 invariant).
   */
  readonly clientCapabilities?: ClientCapabilities;

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

  /**
   * WI-1: tells jdtls the client supports `$/progress` notifications,
   * enabling the progress-based readiness heuristic used by the WI-4
   * `awaitReady` implementation (ADR-002).
   *
   * This object is a FRESH literal — it does NOT reference or spread the
   * module-private `TS_SERVER_CAPABILITIES` const (C0-2 / I-1 identity
   * discipline). `lsp-client.ts` uses
   * `adapter.clientCapabilities ?? TS_SERVER_CAPABILITIES` so adapters
   * that omit this field still send the byte-identical TS payload.
   */
  clientCapabilities: { window: { workDoneProgress: true } },

  awaitReady(ctx: AdapterReadyCtx): Promise<boolean> {
    // WI-2: settle-until-quiet strategy for jdtls.
    //
    // Algorithm:
    //   1. Register a no-op consumer for `language/status` — jdtls sends
    //      `ServiceReady` here but we intentionally IGNORE it (I-2: ServiceReady
    //      MUST NOT trigger settle(true)). The handler is registered to consume
    //      the notification and prevent unhandled-message warnings; it disposes
    //      on settle.
    //   2. Subscribe to `ctx.onProgressEnd` (populated by lsp-client.ts because
    //      JAVA_ADAPTER.clientCapabilities.window.workDoneProgress = true).
    //      Each `$/progress end` event resets a JDTLS_QUIET_INTERVAL_MS (5 s)
    //      quiet timer. When the quiet timer fires, run a canary probe:
    //        - non-empty Location[] → settle(true)
    //        - empty → keep waiting (reset pending next event)
    //   3. Self-rescheduling periodic canary (fires at JDTLS_QUIET_INTERVAL_MS/2
    //      intervals). Guards the zero-progress-events path: if jdtls never emits
    //      any `$/progress end`, the canary still fires ≥2× before deadline,
    //      allowing non-empty results to settle(true) without the quiet path.
    //   4. Hard deadline: ctx.deadlineMs ?? JDTLS_READY_DEADLINE_MS → settle(false).
    //
    // All four resources {language/status handler, progressEnd sub, quiet timer,
    // deadline timer, canary rescheduler} are disposed under a single `settled`
    // guard on EVERY settle path (I-2e). The settled boolean prevents double-
    // resolution on concurrent timer races.
    //
    // Never rejects — all throws caught; degrade to settle(false).
    //
    // Capture canary at call time (not via JAVA_ADAPTER self-reference) so
    // tests and clones can patch the adapter copy and observe the backstop.
    const capturedCanary = JAVA_ADAPTER.canary;
    const capturedWorkspaceRoot = ctx.workspaceRoot;
    const conn = ctx.connection as MessageConnection;

    return new Promise<boolean>((resolve) => {
      const deadline = ctx.deadlineMs ?? JDTLS_READY_DEADLINE_MS;
      const CANARY_INTERVAL_MS = JDTLS_QUIET_INTERVAL_MS / 2; // 2 500 ms

      let settled = false;
      let langStatusHandler: { dispose(): void } | null = null;
      let progressSub: { dispose(): void } | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let canaryTimer: ReturnType<typeof setTimeout> | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      function dispose(): void {
        if (langStatusHandler !== null) {
          try { langStatusHandler.dispose(); } catch { /* ignore */ }
          langStatusHandler = null;
        }
        if (progressSub !== null) {
          try { progressSub.dispose(); } catch { /* ignore */ }
          progressSub = null;
        }
        if (quietTimer !== null) { clearTimeout(quietTimer); quietTimer = null; }
        if (canaryTimer !== null) { clearTimeout(canaryTimer); canaryTimer = null; }
        if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      }

      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        dispose();
        resolve(value);
      }

      /**
       * Run a single canary probe. Resolves settle(true) when the probe
       * returns a non-empty result. Otherwise a no-op (caller decides what
       * to do next — quiet path resets the timer; periodic path reschedules).
       * Returns true iff the probe produced a non-empty result.
       */
      async function runCanary(): Promise<boolean> {
        try {
          if (ctx.backstopProbe) {
            // Injected probe — used in tests to supply a controlled verdict.
            const ready = await ctx.backstopProbe();
            return ready;
          }
          // Inline probe: build samples + didOpen + textDocument/definition.
          const samples = await buildCanarySamples(capturedWorkspaceRoot, {
            strategy: capturedCanary,
            maxFiles: 1,
          });
          if (samples.length === 0) return false;
          const sample = samples[0];
          // Open the file before requesting definition — jdtls requires an
          // open document to resolve definitions (returns empty otherwise).
          try {
            let fileContent = '';
            try {
              fileContent = await fs.promises.readFile(
                fileURLToPath(sample.textDocument.uri),
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
          return (
            result !== null &&
            result !== undefined &&
            !(Array.isArray(result) && result.length === 0)
          );
        } catch {
          return false;
        }
      }

      /**
       * Quiet-interval handler: fires JDTLS_QUIET_INTERVAL_MS after the last
       * `$/progress end` event. Runs the canary; settles true on non-empty,
       * otherwise waits for the next progress event (quiet timer not reset here
       * — the progressEnd subscriber resets it on the next end event).
       */
      function onQuietInterval(): void {
        quietTimer = null;
        if (settled) return;
        void runCanary().then((ready) => {
          if (settled) return;
          if (ready) {
            settle(true);
          }
          // Empty canary — do not settle; wait for next $/progress end event
          // or the periodic canary backstop.
        });
      }

      /**
       * Self-rescheduling periodic canary — guards the zero-progress-events path.
       * Fires at CANARY_INTERVAL_MS intervals. On a non-empty probe result,
       * settle(true). Otherwise reschedule.
       */
      function schedulePeriodicCanary(): void {
        if (settled) return;
        canaryTimer = setTimeout(() => {
          canaryTimer = null;
          if (settled) return;
          void runCanary().then((ready) => {
            if (settled) return;
            if (ready) {
              settle(true);
            } else {
              // Reschedule — keep polling until deadline or quiet-path settles.
              schedulePeriodicCanary();
            }
          });
        }, CANARY_INTERVAL_MS);
        canaryTimer.unref?.();
      }

      // ── Step 1: no-op language/status consumer ─────────────────────────
      // ServiceReady MUST NOT trigger settle (I-2). Register a consumer so
      // jdtls's notification is acknowledged and not logged as unhandled.
      try {
        langStatusHandler = conn.onNotification(
          'language/status',
          (_params: unknown) => {
            // Intentional no-op — ServiceReady must not settle awaitReady.
            // All other types (Starting, Building, Error) also ignored here;
            // the quiet-timer / canary path governs readiness.
          },
        );
      } catch {
        // Connection already disposed or registration failed — degrade.
        settle(false);
        return;
      }

      // ── Step 2: subscribe to $/progress end events ─────────────────────
      // Each end event resets the JDTLS_QUIET_INTERVAL_MS quiet timer.
      if (ctx.onProgressEnd) {
        try {
          progressSub = ctx.onProgressEnd((_token) => {
            if (settled) return;
            // Reset the quiet timer — silence must persist for the full interval
            // after the LAST end event before we probe.
            if (quietTimer !== null) { clearTimeout(quietTimer); }
            quietTimer = setTimeout(onQuietInterval, JDTLS_QUIET_INTERVAL_MS);
            quietTimer.unref?.();
          });
        } catch {
          // Subscribe failed — quiet path unavailable; periodic canary backstop
          // will still fire ≥2× before deadline.
        }
      }

      // ── Step 3: periodic canary backstop ───────────────────────────────
      // Fires at CANARY_INTERVAL_MS even when no progress events arrive.
      // Ensures ≥2 canary invocations before the deadline (I-2b).
      schedulePeriodicCanary();

      // ── Step 4: hard deadline ──────────────────────────────────────────
      deadlineTimer = setTimeout(() => {
        settle(false);
      }, deadline);
      deadlineTimer.unref?.();
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

// ─── PYTHON_ADAPTER ───────────────────────────────────────────────────

/**
 * Hard deadline for `PYTHON_ADAPTER.awaitReady` (milliseconds from call time).
 *
 * 30 s is the R2-10 unmeasured-fallback default; a scouting run on crawl4ai
 * observed pylsp connecting within the funnel's 17.3 s phase, so 30 s is safe
 * with margin.
 *
 * Exported so callers and tests can override via environment config or
 * `AdapterReadyCtx.deadlineMs`.
 */
export const PYLSP_READY_DEADLINE_MS = 30_000;

/**
 * Python language adapter (WI-2 implementation — full awaitReady).
 *
 * `awaitReady`: PRIMARY multi-sample canary round-trip (ruling R2-11).
 * pylsp emits NO `language/status`/`ServiceReady` notification, so there
 * is no notification wait — the probe is the primary and only readiness
 * signal. Iterates `buildCanarySamples` results; resolves `true` on the
 * first non-empty `Location[]`; resolves `false` if all samples are
 * exhausted OR deadline elapses (never rejects).
 *
 * `classifyUri` returns `'workspace'` for ALL `file://` URIs by design —
 * scheme-only signal. Out-of-repo containment is owned by location-mapper
 * gated on `adapterId` (ruling R2-13; ADR-001). Do NOT relocate
 * containment into `classifyUri`.
 *
 * `serverBinary`: `'pylsp'` — confirmed v1.14.0 at /Users/NgocVo_1/.local/bin/pylsp.
 * `spawnArgs`: `[]` — pylsp uses stdio by default; v1.14.0 rejects `--stdio` (exit 2). No `-data` dir; no GITNEXUS_HOME (no JVM state).
 * `initializationOptions`: `{}` — pylsp accepts the LSP default.
 */
export const PYTHON_ADAPTER: LanguageAdapter = {
  id: 'python',
  serverBinary: 'pylsp',
  languageId: 'python',

  spawnArgs(_ctx: { workspaceRoot: string }): string[] {
    // pylsp uses stdio transport by default (no --stdio flag required or accepted).
    // pylsp v1.14.0 does not recognize --stdio and exits with code 2 if passed.
    // Returning [] lets LspClient spawn pylsp without any extra arguments,
    // which is the correct invocation for stdio mode.
    return [];
  },

  initializationOptions: {},

  awaitReady(ctx: AdapterReadyCtx): Promise<boolean> {
    // KD-1 (Python variant): PRIMARY multi-sample canary round-trip.
    //
    // pylsp emits no `language/status`/`ServiceReady` notification —
    // DO NOT register a notification handler. The canary round-trip
    // is the only readiness signal.
    //
    // Algorithm:
    //   1. Build canary samples from `ctx.workspaceRoot` using PYTHON_ADAPTER.canary.
    //   2. If no samples: resolve false immediately (no candidate files).
    //   3. Otherwise, for each sample (until deadline):
    //      a. Send `textDocument/didOpen` (pylsp needs the file open to serve defs).
    //      b. Send `textDocument/definition` at the sample position.
    //      c. Non-empty Location[]: resolve true (server is ready).
    //      d. Empty/null: try next sample.
    //   4. If deadline elapses or all samples exhausted without a hit: resolve false.
    //
    // Contract: never rejects; always disposes the timer (no leak).
    // The inline probe shape mirrors Java path-B (lines 344–400) minus the
    // `language/status` notification registration and the notification-wait
    // outer shell. See ruling R2-11 for the structural rationale.
    const capturedCanary = PYTHON_ADAPTER.canary;
    const capturedWorkspaceRoot = ctx.workspaceRoot;

    return new Promise<boolean>((resolve) => {
      const deadline = ctx.deadlineMs ?? PYLSP_READY_DEADLINE_MS;
      const conn = ctx.connection as MessageConnection;

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      }

      // Set the hard deadline — resolves false if the probe loop does not
      // produce a ready signal before it elapses.
      timer = setTimeout(() => {
        settle(false);
      }, deadline);

      // Prevent the timer from keeping the Node.js event loop alive past teardown.
      timer.unref?.();

      // Run the probe loop asynchronously so we do not block the event loop.
      void (async () => {
        try {
          // Optional injected backstop probe (seam for unit tests — same as Java path A).
          // When present, use it as the authoritative readiness verdict and skip
          // the inline loop. Production code never injects this.
          if (ctx.backstopProbe) {
            const ready = await ctx.backstopProbe();
            settle(ready);
            return;
          }

          // Build canary samples from the workspace root using the Python strategy.
          const samples = await buildCanarySamples(capturedWorkspaceRoot, {
            strategy: capturedCanary,
            maxFiles: 3,
          });

          if (samples.length === 0) {
            // No candidate .py files found — cannot verify readiness; degrade gracefully.
            settle(false);
            return;
          }

          // Iterate samples; resolve true on the first non-empty Location[].
          for (const sample of samples) {
            if (settled) return; // deadline fired while we were iterating

            // Open the file in the workspace BEFORE requesting its definition.
            // pylsp (like jdtls) may return an empty array for an unopened file.
            // Best-effort: if didOpen fails we still proceed with the definition request.
            try {
              let fileContent = '';
              try {
                fileContent = await fs.promises.readFile(
                  fileURLToPath(sample.textDocument.uri),
                  'utf8',
                );
              } catch { /* unreadable — send empty content */ }
              await conn.sendNotification('textDocument/didOpen', {
                textDocument: {
                  uri: sample.textDocument.uri,
                  languageId: PYTHON_ADAPTER.languageId,
                  version: 1,
                  text: fileContent,
                },
              });
            } catch { /* best-effort: proceed even if didOpen fails */ }

            if (settled) return; // deadline fired during didOpen

            const result = await conn.sendRequest<unknown>(
              'textDocument/definition',
              { textDocument: sample.textDocument, position: sample.position },
            );

            // A non-null, non-empty response means the server resolved the
            // definition — workspace is ready.
            const ready =
              result !== null &&
              result !== undefined &&
              !(Array.isArray(result) && result.length === 0);

            if (ready) {
              settle(true);
              return;
            }
            // Empty result: try the next sample.
          }

          // All samples exhausted without a positive result.
          settle(false);
        } catch {
          // Any unhandled error during the probe (e.g. connection disposed) — degrade.
          settle(false);
        }
      })();
    });
  },

  // PYTHON_CANARY_STRATEGY is fully implemented in canary-sampler.ts (WI-2/WI-3).
  canary: PYTHON_CANARY_STRATEGY,

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    // Returns 'workspace' for ALL file:// URIs by design — scheme-only signal.
    // Out-of-repo containment is owned by location-mapper gated on adapterId
    // (ruling R2-13; ADR-001). Do NOT add path-based logic here.
    if (uri.startsWith('file://')) return 'workspace';
    return 'unmappable';
  },
};

// ─── JDTLS_READY_DEADLINE_MS / JDTLS_QUIET_INTERVAL_MS ──────────────

/**
 * Hard deadline for `JAVA_ADAPTER.awaitReady` (milliseconds from call time).
 *
 * 600 s (10 min) — jdtls performs Maven/Gradle workspace indexing on cold
 * start which is significantly slower than other LSPs. ADR-002 spike data:
 * Maven indexing runs to ~19.3 s on a mid-size repo; 600 s provides ample
 * margin for large enterprise Java codebases.
 *
 * Exported so callers and tests can override via `AdapterReadyCtx.deadlineMs`.
 */
export const JDTLS_READY_DEADLINE_MS = 600_000;

/**
 * Quiet-interval for jdtls `$/progress` readiness heuristic (milliseconds).
 *
 * After the last `$/progress` end notification, jdtls is considered ready
 * when no new progress events have arrived within this interval. 5 s is
 * sufficient to distinguish the Maven-indexing burst from true idle.
 *
 * Exported for use by the WI-4 `awaitReady` implementation and its tests.
 */
export const JDTLS_QUIET_INTERVAL_MS = 5_000;

// ─── GOPLS_READY_DEADLINE_MS ─────────────────────────────────────────

/**
 * Hard deadline for `GO_ADAPTER.awaitReady` (milliseconds from call time).
 *
 * 30 s is sufficient for gopls cold-load on gin (spike-confirmed: 247–916ms
 * warm; generous margin for cold JIT start). WI-2 fills in the full
 * `awaitReady` implementation; this constant is exported here so callers
 * and tests can reference it without importing the WI-2 module.
 *
 * Exported so callers and tests can override via `AdapterReadyCtx.deadlineMs`.
 */
export const GOPLS_READY_DEADLINE_MS = 30_000;

// ─── GO_ADAPTER ───────────────────────────────────────────────────────

/**
 * Go language adapter (WI-1 stub — WI-2 fills in full `awaitReady`).
 *
 * `spawnArgs`: `[]` — spike-confirmed: bare `gopls` serves (init resp +87ms).
 *   WI-7 will assert `['serve']` if the bare form proves insufficient, but
 *   the spike shows `[]` as the correct invocation for stdio mode.
 *
 * `awaitReady`: stub that resolves `true` immediately. WI-2 replaces this
 *   with the `$/progress` notification-wait pattern (pre-`initialize`
 *   handler reads the token-correlation buffer populated by WI-0).
 *
 * `classifyUri`: `file://` → `'workspace'`; anything else → `'unmappable'`.
 *   Out-of-repo `file://` containment (Go stdlib / mod-cache) is handled
 *   by `location-mapper.ts` via `isExternalRefusalAdapter` path-containment
 *   check — NOT here (same pattern as Python, ruling R2-13 / ADR-001).
 *
 * `serverBinary`: `'gopls'` — the canonical gopls binary name.
 * `languageId`: `'go'` — LSP-spec language identifier for Go source.
 * `initializationOptions`: `{}` — gopls accepts the LSP default for now.
 * `canary`: `GO_CANARY_STRATEGY` stub — WI-3 fleshes out the `.go` sampling.
 */
export const GO_ADAPTER: LanguageAdapter = {
  id: 'go',
  serverBinary: 'gopls',
  languageId: 'go',

  spawnArgs(_ctx: { workspaceRoot: string }): string[] {
    // SPIKE-CONFIRMED: bare gopls (no args) serves stdio correctly.
    // WI-7 will revisit if ['serve'] is needed.
    return [];
  },

  initializationOptions: {},

  /**
   * WI-0 seam: tells gopls the client supports progress notifications,
   * enabling the `$/progress` stream used by `awaitReady` (R2-1 / R2-2).
   *
   * This object is distinct from the module-private `TS_SERVER_CAPABILITIES`
   * const (C0-2 invariant). `lsp-client.ts` uses
   * `adapter.clientCapabilities ?? TS_SERVER_CAPABILITIES` so TS/Java/Python
   * adapters (which omit this field) send the byte-identical TS payload.
   */
  clientCapabilities: { window: { workDoneProgress: true } },

  awaitReady(ctx: AdapterReadyCtx): Promise<boolean> {
    // WI-2a: $/progress notification-wait pattern (spike-confirmed).
    //
    // Algorithm:
    //   1. Scan the pre-buffered `ctx.progressEndedTokens` for any token
    //      whose stored `ctx.progressTokenTitles` title matches
    //      "Setting up workspace". If found, resolve true immediately
    //      (begin+end arrived BEFORE awaitReady — the buffering guarantee).
    //   2. Otherwise, subscribe via `ctx.onProgressEnd` to be notified when
    //      future `end` events arrive and apply the same title match.
    //   3. On hard deadline: fall back to canary backstop
    //      (backstopProbe if injected, otherwise buildCanarySamples +
    //      didOpen + textDocument/definition). Never reject.
    //
    // The match title ("Setting up workspace") is spike-confirmed against
    // gopls v0.22.0 on the gin fixture. The `end` notification carries an
    // EMPTY title — MUST use the stored `begin` title from the map.
    //
    // `ctx.progressTokenTitles` / `ctx.progressEndedTokens` / `ctx.onProgressEnd`
    // are populated by `LspClient.spawnAndInitialize` for Go adapters only.
    // Non-Go adapters never call this implementation.
    const GOPLS_WORKSPACE_TITLE = 'Setting up workspace';
    const capturedCanary = GO_ADAPTER.canary;
    const capturedWorkspaceRoot = ctx.workspaceRoot;
    const conn = ctx.connection as MessageConnection;

    return new Promise<boolean>((resolve) => {
      const deadline = ctx.deadlineMs ?? GOPLS_READY_DEADLINE_MS;

      let settled = false;
      let progressSub: { dispose(): void } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        try { progressSub?.dispose(); } catch { /* ignore */ }
        resolve(value);
      }

      // Step 1: check buffer for a token that already ended with matching title.
      // Use settle() — not resolve() directly — so the idempotency guard
      // (settled flag) is set before returning. If an onProgressEnd callback
      // fires synchronously on the same microtask tick after this point it
      // will see settled=true and short-circuit, preventing double-resolution.
      if (ctx.progressTokenTitles && ctx.progressEndedTokens) {
        for (const token of ctx.progressEndedTokens) {
          if (ctx.progressTokenTitles.get(token) === GOPLS_WORKSPACE_TITLE) {
            settle(true);
            return; // settled synchronously — no timer, no sub needed
          }
        }
      }

      // Step 2: subscribe to future end events.
      if (ctx.onProgressEnd) {
        try {
          progressSub = ctx.onProgressEnd((token) => {
            if (settled) return;
            const title = ctx.progressTokenTitles?.get(token);
            if (title === GOPLS_WORKSPACE_TITLE) {
              settle(true);
            }
          });
        } catch {
          // Subscribe failed — fall through to deadline backstop.
        }
      }

      // Step 3: deadline backstop — canary probe (mirrors JAVA_ADAPTER path B).
      timer = setTimeout(() => {
        if (settled) return;
        void (async () => {
          try {
            if (ctx.backstopProbe) {
              const ready = await ctx.backstopProbe();
              settle(ready);
              return;
            }
            // Inline canary probe: build samples + didOpen + definition.
            const samples = await buildCanarySamples(capturedWorkspaceRoot, {
              strategy: capturedCanary,
              maxFiles: 1,
            });
            if (samples.length === 0) { settle(false); return; }
            const sample = samples[0];
            try {
              let fileContent = '';
              try {
                fileContent = await fs.promises.readFile(
                  fileURLToPath(sample.textDocument.uri),
                  'utf8',
                );
              } catch { /* unreadable — send empty content */ }
              await conn.sendNotification('textDocument/didOpen', {
                textDocument: {
                  uri: sample.textDocument.uri,
                  languageId: GO_ADAPTER.languageId,
                  version: 1,
                  text: fileContent,
                },
              });
            } catch { /* best-effort */ }
            const result = await conn.sendRequest<unknown>(
              'textDocument/definition',
              { textDocument: sample.textDocument, position: sample.position },
            );
            const ready =
              result !== null &&
              result !== undefined &&
              !(Array.isArray(result) && result.length === 0);
            settle(ready);
          } catch {
            settle(false);
          }
        })();
      }, deadline);

      // Prevent the timer from keeping the Node.js event loop alive past teardown.
      timer.unref?.();
    });
  },

  canary: GO_CANARY_STRATEGY,

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    // Returns 'workspace' for ALL file:// URIs by design — scheme-only signal.
    // Out-of-repo containment for Go (stdlib / mod-cache) is path-containment
    // gated on adapterId in location-mapper.ts (isExternalRefusalAdapter),
    // NOT here. Do NOT add GOROOT or mod-cache special-casing here.
    if (uri.startsWith('file://')) return 'workspace';
    return 'unmappable';
  },
};

// ─── RUST_ANALYZER_READY_DEADLINE_MS ─────────────────────────────

/**
 * Hard deadline for `RUST_ADAPTER.awaitReady` (milliseconds from call time).
 *
 * 60 s — deliberately higher than the 30_000 ms GOPLS/PYLSP constants because
 * rust-analyzer performs a cold metadata load (Cargo workspace, proc-macro
 * expansion) that is significantly slower than gopls or pylsp on first startup.
 * Spike-deferred; will be tuned in WI-3b3 once real cold-start data is
 * available.
 *
 * Exported so callers and tests can override via `AdapterReadyCtx.deadlineMs`.
 */
export const RUST_ANALYZER_READY_DEADLINE_MS = 60_000;

// ─── RUST_ADAPTER ─────────────────────────────────────────────────

/**
 * Rust language adapter (WI-3b1 literal surface; `awaitReady` stubbed for WI-3b3).
 *
 * `id`: `'rust'` — already admitted by the `LanguageAdapter.id` union (line 201).
 *
 * `spawnArgs`: always returns `[]` (fresh array literal per call). rust-analyzer
 *   uses stdio by default — no `--stdio` flag is required (spike-deferred;
 *   WI-3b3 will confirm on a real Rust workspace). Each call returns a new
 *   array so two successive calls never share a reference (I-2).
 *
 * `classifyUri`: scheme-only signal mirroring GO_ADAPTER exactly.
 *   `file://` → `'workspace'`; anything else → `'unmappable'`.
 *   No `.rs`/cargo-registry/sysroot special-casing here — out-of-repo
 *   containment is gated in `location-mapper.ts` (ruling R2-13 / ADR-001).
 *
 * `initializationOptions`: `{}` — spike-deferred safe default. rust-analyzer
 *   accepts the LSP default; server-specific options (e.g. `cargo.features`)
 *   will be wired in a later WI if needed.
 *
 * `clientCapabilities`: distinct literal (C0-2 discipline — does NOT reference
 *   the module-private `TS_SERVER_CAPABILITIES` const). Tells rust-analyzer the
 *   client supports both progress notifications and the experimental
 *   `serverStatusNotification` (I-13). Type-compatible with `ClientCapabilities`
 *   (lines 170-182) which carries both `window` and `experimental` optional fields.
 *
 * `awaitReady`: stubbed — returns `true` immediately. WI-3b3 will replace this
 *   with the real rust-analyzer `experimental/serverStatus` notification wait.
 *
 * `canary`: `RUST_CANARY_STRATEGY` (real WI-2 export from canary-sampler.ts).
 */
export const RUST_ADAPTER: LanguageAdapter = {
  id: 'rust',
  serverBinary: 'rust-analyzer',
  languageId: 'rust',

  spawnArgs(_ctx: { workspaceRoot: string }): string[] {
    // rust-analyzer uses stdio by default (no --stdio flag required).
    // Returns a fresh array literal on every call so successive calls never
    // share a reference (I-2 invariant; mirrors PYTHON_ADAPTER / GO_ADAPTER).
    return [];
  },

  initializationOptions: {},

  /**
   * WI-3b1 stub: resolves `true` immediately.
   * WI-3b3 will replace this with the `experimental/serverStatus` wait.
   * The stub satisfies the `LanguageAdapter` contract and prevents any
   * caller that constructs a `RUST_ADAPTER` session from hanging.
   */
  awaitReady(ctx: AdapterReadyCtx): Promise<boolean> {
    // WI-3b3: real experimental/serverStatus notification-wait pattern.
    //
    // Algorithm:
    //   1. Check the pre-buffered ctx.serverStatusLatest. If quiescent:true
    //      and health:'ok' or health:'warning', resolve true immediately.
    //      (uses settle() so the idempotency flag is set before return)
    //   2. Subscribe via ctx.onServerStatus for future status events.
    //      Resolve true on {quiescent:true, health:'ok'|'warning'}.
    //      {quiescent:true, health:'error'} is NOT ready — keep waiting.
    //      {quiescent:false, any health} is NOT ready — keep waiting.
    //   3. On hard deadline: fall back to canary backstop.
    //      Zero samples in workspace → true (deliberate GO_ADAPTER deviation:
    //      zero-edges no-op, nothing to verify, proceed with ingestion).
    //      Samples present + empty/null textDocument/definition → false.
    //      ctx.backstopProbe if injected → delegate entirely to it.
    //   Any path: never rejects (I-7) — settle(false) on any throw.
    //
    // No $/progress arm (WI-0 spike: rust-analyzer has no single
    // load-complete progress title; serverStatus is the sole readiness signal).
    //
    // serverStatus handler is NOT registered here. It lives in
    // LspClient.spawnAndInitialize (WI-3b2). awaitReady only READS
    // ctx.serverStatusLatest and subscribes via ctx.onServerStatus.

    function isReady(payload: { quiescent: boolean; health: string }): boolean {
      return payload.quiescent === true &&
        (payload.health === 'ok' || payload.health === 'warning');
    }

    const capturedCanary = RUST_ADAPTER.canary;
    const capturedWorkspaceRoot = ctx.workspaceRoot;
    const conn = ctx.connection as MessageConnection;

    return new Promise<boolean>((resolve) => {
      const deadline = ctx.deadlineMs ?? RUST_ANALYZER_READY_DEADLINE_MS;

      let settled = false;
      let statusSub: { dispose(): void } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        try { statusSub?.dispose(); } catch { /* ignore */ }
        resolve(value);
      }

      // Step 1: check buffer for an already-arrived quiescent status.
      // Use settle() — not resolve() directly — so the idempotency guard
      // (settled flag) is set before returning. If an onServerStatus callback
      // fires synchronously on the same microtask tick after this point it
      // will see settled=true and short-circuit, preventing double-resolution.
      if (ctx.serverStatusLatest !== undefined) {
        if (isReady(ctx.serverStatusLatest)) {
          settle(true);
          return; // settled synchronously — no timer, no sub needed
        }
      }

      // Step 2: subscribe to future serverStatus events.
      if (ctx.onServerStatus !== undefined) {
        try {
          statusSub = ctx.onServerStatus((payload) => {
            if (settled) return;
            if (isReady(payload)) {
              settle(true);
            }
            // health:'error' or quiescent:false → keep waiting (fall to deadline)
          });
        } catch {
          // Subscribe failed — fall through to deadline backstop.
        }
      }

      // Step 3: deadline backstop — canary probe (mirrors GO_ADAPTER path B,
      // but zero samples → true is a deliberate deviation from GO_ADAPTER).
      timer = setTimeout(() => {
        if (settled) return;
        void (async () => {
          try {
            if (ctx.backstopProbe) {
              const ready = await ctx.backstopProbe();
              settle(ready);
              return;
            }
            // Inline canary probe: build samples + didOpen + definition.
            const samples = await buildCanarySamples(capturedWorkspaceRoot, {
              strategy: capturedCanary,
              maxFiles: 1,
            });
            // Zero samples: deliberate deviation from GO_ADAPTER (which returns
            // false). Zero samples in a Rust workspace means nothing to verify —
            // proceed with no-op augmentation rather than blocking ingestion.
            if (samples.length === 0) { settle(true); return; }
            const sample = samples[0];
            try {
              let fileContent = '';
              try {
                fileContent = await fs.promises.readFile(
                  fileURLToPath(sample.textDocument.uri),
                  'utf8',
                );
              } catch { /* unreadable — send empty content */ }
              await conn.sendNotification('textDocument/didOpen', {
                textDocument: {
                  uri: sample.textDocument.uri,
                  languageId: RUST_ADAPTER.languageId,
                  version: 1,
                  text: fileContent,
                },
              });
            } catch { /* best-effort */ }
            const result = await conn.sendRequest<unknown>(
              'textDocument/definition',
              { textDocument: sample.textDocument, position: sample.position },
            );
            const ready =
              result !== null &&
              result !== undefined &&
              !(Array.isArray(result) && result.length === 0);
            settle(ready);
          } catch {
            settle(false);
          }
        })();
      }, deadline);

      // Prevent the timer from keeping the Node.js event loop alive past teardown.
      timer.unref?.();
    });
  },

  /**
   * WI-3b1: real RUST_CANARY_STRATEGY from canary-sampler.ts.
   * `isCandidateFile` accepts `.rs` files; `tryExtractSample` extracts
   * fn/struct/enum/trait declarations and call-site positions.
   */
  canary: RUST_CANARY_STRATEGY,

  /**
   * Distinct literal — does NOT reference the module-private
   * `TS_SERVER_CAPABILITIES` const (C0-2 discipline).
   *
   * `window.workDoneProgress: true` — rust-analyzer supports LSP progress
   * notifications (WI-3b3 will use them for readiness detection).
   * `experimental.serverStatusNotification: true` — tells rust-analyzer
   * the client handles `experimental/serverStatus` (I-13).
   */
  clientCapabilities: {
    window: { workDoneProgress: true },
    experimental: { serverStatusNotification: true },
  },

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    // Scheme-only signal — mirrors GO_ADAPTER exactly (ruling R2-13 / ADR-001).
    // Out-of-repo containment (cargo-registry, sysroot, toolchain dirs) is
    // path-containment gated on adapterId in location-mapper.ts.
    // Do NOT add cargo-registry or sysroot special-casing here.
    if (uri.startsWith('file://')) return 'workspace';
    return 'unmappable';
  },
};

// ─── Extension census for KD-4 adapter selection ─────────────────────

/** Extensions that indicate a TypeScript/JavaScript LSP project. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Extensions that indicate a Java LSP project. */
const JAVA_EXTENSIONS = new Set(['.java']);

/** Extensions that indicate a Python LSP project. */
const PY_EXTENSIONS = new Set(['.py']);

/** Extensions that indicate a Go LSP project. */
const GO_EXTENSIONS = new Set(['.go']);

/** Extensions that indicate a Rust LSP project. */
const RUST_EXTENSIONS = new Set(['.rs']);

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
  // Python virtualenv / package installation dirs — excluded to avoid
  // inflating pyCount with installed third-party packages (I-7).
  'site-packages',
  'dist-packages',
  '.tox',
  'eggs',
  '.eggs',
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
 * Returns `{ tsCount, javaCount, pyCount, goCount, rustCount }`.
 */
function censusExtensions(dir: string): { tsCount: number; javaCount: number; pyCount: number; goCount: number; rustCount: number } {
  let tsCount = 0;
  let javaCount = 0;
  let pyCount = 0;
  let goCount = 0;
  let rustCount = 0;
  let inspected = 0;

  function walk(current: string): void {
    if (inspected >= CENSUS_FILE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort entries lexicographically for determinism — the order of entries
    // from readdirSync is filesystem-dependent and can vary across runs.
    // Without sorting, the first CENSUS_FILE_LIMIT files inspected may differ,
    // leading to different language counts and potentially different adapter
    // selection (AC-5 determinism contract). Mirrors buildCanarySamples line 332.
    entries.sort((a, b) => a.name.localeCompare(b.name));
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
        } else if (PY_EXTENSIONS.has(ext)) {
          pyCount++;
        } else if (GO_EXTENSIONS.has(ext)) {
          goCount++;
        } else if (RUST_EXTENSIONS.has(ext)) {
          rustCount++;
        }
      }
    }
  }

  walk(dir);
  return { tsCount, javaCount, pyCount, goCount, rustCount };
}

/**
 * Select the appropriate `LanguageAdapter` for a repository by
 * performing an extension census (KD-4).
 *
 * Algorithm:
 *   1. Count TS-family files (`.ts`, `.tsx`, `.mts`, `.cts`,
 *      `.js`, `.jsx`, `.mjs`, `.cjs`), Java files (`.java`),
 *      and Python files (`.py`) under `repoPath` (skipping
 *      `node_modules`, `dist`, `target`, `site-packages`, …).
 *   2. Python must STRICTLY dominate (pyCount > tsCount AND > javaCount)
 *      to win — checked before the TS/Java tie-break so that a pure-
 *      Python repo is not swallowed by the `tsCount >= javaCount` branch
 *      (0 >= 0 is true). Ties go to TypeScript (proven-stable default).
 *   3. If all counts are zero, return `null` — the funnel is not
 *      entered for unsupported repos (no LSP server will be spawned).
 *
 * @param repoPath  Absolute path to the repository root.
 * @returns The selected adapter, or `null` if no supported language
 *          was detected.
 */
export function selectAdapter(repoPath: string): LanguageAdapter | null {
  const { tsCount, javaCount, pyCount, goCount, rustCount } = censusExtensions(repoPath);

  if (tsCount === 0 && javaCount === 0 && pyCount === 0 && goCount === 0 && rustCount === 0) {
    // No supported LSP language detected — funnel not entered.
    return null;
  }

  // Python strict dominance: must beat TS, Java, Go, AND Rust counts.
  // Checked BEFORE the Go/Rust branches and the TS/Java tie-break — otherwise a
  // pure-Python repo (tsCount=0, javaCount=0, pyCount=N) short-circuits to TS
  // via 0 >= 0. The goCount guard ensures Python cannot steal a Go-dominant
  // repo (e.g. 8 .go / 3 .py / 2 .ts / 2 .java → Go wins, not Python).
  if (pyCount > tsCount && pyCount > javaCount && pyCount > goCount && pyCount > rustCount) {
    return PYTHON_ADAPTER;
  }

  // Go strict dominance: must beat ALL other counts (TS, Java, Python, Rust).
  // Positioned AFTER Python strict-dominance (so a Python-dominant repo is
  // never swallowed by this branch) and BEFORE the Rust and TS/Java tie-break
  // (so a pure-Go repo does not short-circuit to TS via the 0 >= 0 guard — I-14).
  // Ties go to the next branch (TS default), consistent with Python's contract.
  if (goCount > tsCount && goCount > javaCount && goCount > pyCount && goCount > rustCount) {
    return GO_ADAPTER;
  }

  // Rust strict dominance: must beat ALL other counts (TS, Java, Python, Go).
  // Positioned AFTER Python and Go strict-dominance checks, BEFORE the TS/Java
  // tie-break. Ties go to the next branch (TS default), consistent with the
  // strict-dominance contract shared by Python and Go.
  if (rustCount > tsCount && rustCount > javaCount && rustCount > pyCount && rustCount > goCount) {
    return RUST_ADAPTER;
  }

  // Ties (including tsCount === pyCount) go to TS (safe default — TS adapter
  // is the proven path; Python wins only on strict dominance).
  if (tsCount >= javaCount) {
    return TYPESCRIPT_ADAPTER;
  }

  // Java is dominant.
  return JAVA_ADAPTER;
}
