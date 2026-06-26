/**
 * Mode A — LSP reconciliation (WI-4a session + WI-4b engine).
 *
 * The session funnel is the *single refuse path* for Mode A, the
 * write half of the #159 cycle. It is structurally identical to
 * `withReferenceProvider` (P2, foundation) but the work fn
 * receives a **reconciler session** instead of a read-only
 * `ReferenceProvider` — the session's job is to:
 *
 *   1. Discover the TypeScript language server (KD-1).
 *   2. Start a warm `LspClient` and run the readiness probe
 *      (I-6, sole gate).
 *   3. Merge the correction + recall feeds, stable-sort by
 *      `(sourceId, calledName, line, character)`, and take the
 *      first N (cap 2000) — KD-9.
 *   4. For each candidate: issue ONE
 *      `textDocument/definition` request (5000ms timeout,
 *      KD-10) at the **callee identifier** position. Normalize
 *      `Location | Location[]` (bare `Location` → array) and
 *      hand each normalized payload to the engine (this file,
 *      WI-4b).
 *   5. Stop the client in `finally` — I-5 (no leaks on any
 *      exit path).
 *
 * **Why the session lives outside `lsp/`:** I-7. The
 * `no-write-invariant.test.ts` forbids any file in
 * `core/ingestion/lsp/` from importing a graph-write API. The
 * reconciler mutates the in-memory graph (`addRelationship`,
 * `removeRelationship`) — that mutation cannot live in `lsp/`.
 * This module lives at `core/ingestion/mode-a-reconciler.ts`,
 * OUTSIDE `lsp/`, and reads from `lsp/` (foundation is
 * read-only).
 *
 * **Why a deps bag (not a class):** the test surface needs to
 * inject fakes for every external surface
 * (`discoverServers`, `LspClient`, `probe`). A bag of functions
 * with real-wiring defaults is the same pattern as
 * `withReferenceProvider`'s `WithReferenceProviderDeps`. The
 * production path uses zero overrides; the test path swaps in
 * `vi.fn()`s.
 *
 * **WI-4b (decision engine) — same file:** the pure decision
 * table (gate, atomic correction, collapse, dry-run) lives here
 * too. The engine exposes `decideForCandidate` (pure, no graph
 * writes) and `applyDecisions` (graph mutator) and
 * `reconcileDecisions` (top-level, wires the in-memory adapter
 * into the existing `mapLocationToNodeId`). The session wires
 * `reconcileDecisions` via the `handToEngine` seam. The engine
 * reads `CALLABLE_SYMBOL_TYPES` from `call-processor.ts` (KD-3)
 * and the in-memory `executeParameterized` adapter from
 * `in-memory-node-query.ts` (KD-2).
 */

import { LspClient } from './lsp/lsp-client.js';
import type { ProbeResult, Sample } from './lsp/workspace-readiness-probe.js';
import { type MapperResult, isUnindexablePath } from './lsp/location-mapper.js';
import { definitionCacheKey, type DefinitionCache } from './lsp-definition-cache.js';
import { type LanguageAdapter, TYPESCRIPT_ADAPTER } from './lsp/language-adapter.js';
import type { DiscoveredServers } from './lsp/server-discovery.js';
import type { GraphRelationship, KnowledgeGraph, EdgeSource } from '../graph/types.js';
import { CALLABLE_SYMBOL_TYPES } from './call-processor.js';
import { generateId } from '../../lib/utils.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from 'node:path';

// ─── Public types ──────────────────────────────────────────────────────

/**
 * One element of the candidate feed passed into the session.
 *
 * `line` + `character` are the **callee identifier** position
 * (per WI-2 prerequisite), NOT the call-expression start. For
 * `a.b.c()`, this is the position of the `c` token, not `a` —
 * member-call recall depends on this.
 *
 * `relType` (WI-5) discriminates the heritage edge family
 * (IMPLEMENTS / EXTENDS). When absent, the candidate is a
 * CALLS candidate — the default behavior, byte-identical to
 * PR #168. Producers that emit heritage candidates set this
 * field; the existing CALLS producers are untouched and
 * produce identical keys/decisions.
 */
export interface Candidate {
  /** Source node id (the caller). */
  sourceId: string;
  /** Callee name as written at the call site (e.g. `c` in `a.b.c()`). */
  calledName: string;
  /** Heuristic target id (empty string for recall candidates). */
  oldTargetId?: string;
  /**
   * The id of the existing heuristic edge the candidate
   * corresponds to. Populated for heritage candidates
   * (WI-4 design contract) and CALLS correction candidates
   * that need a site-precise `correct`. The engine passes
   * this to `applyDecisions` so the `correct` action can
   * `removeRelationship(oldRelId)` for the exact row even
   * when the (source, target) pair has multiple edges (the
   * WI-1 line-aware multiplicity). Absent on CALLS recall
   * candidates (no heuristic edge to remove).
   */
  oldRelId?: string;
  /** Repo-relative POSIX file path. */
  file: string;
  /** 0-indexed line of the callee identifier. */
  line: number;
  /** 0-indexed character offset of the callee identifier start. */
  character: number;
  /**
   * Edge family discriminator (WI-5). Absent ⇒ CALLS. Present
   * ⇒ one of the heritage families. The candidate-location
   * key helper appends `|${relType}` only when this is set so
   * the CALLS key shape stays byte-identical to PR #168.
   */
  relType?: 'IMPLEMENTS' | 'EXTENDS';
}

/**
 * Minimal LSP `Location` shape — narrowed to the fields the
 * engine consumes. Mirrors the foundation's `Location` type
 * (kept structurally compatible with `location-mapper.ts`).
 */
export type Location = {
  /** LSP URI, e.g. `file:///abs/path/to/foo.ts`. */
  uri: string;
  /** Range — `start.line` is the 0-indexed position the mapper uses. */
  range: { start: { line: number; character: number } };
};

/**
 * Per-session metadata handed to the work fn as the second
 * argument. Carries the version of the server we connected to
 * (forwarded into the summary line) and the per-request timeout
 * actually used (so the engine can reason about latency in
 * dry-run output).
 */
export interface SessionMeta {
  /** Server version as reported by discovery (may be `"unknown"`). */
  serverVersion: string;
  /** Per-request timeout in milliseconds forwarded to the client. */
  requestTimeoutMs: number;
  /** Cap actually applied (default 2000; overridable via deps). */
  cap: number;
  /**
   * Count of candidates for which a `textDocument/definition` request
   * was actually issued (i.e. passed the `isUnindexablePath` pre-filter
   * and the `line`/`character` bounds gate). Populated by the dispatch
   * loop BEFORE calling the work fn; zero if no requests were issued.
   */
  probed: number;
  /**
   * Count of candidates skipped by the `isUnindexablePath` pre-filter
   * inside `fetchDefinitionForCandidate`. Distinct from `refused`
   * (post-probe refusal when LSP returns no node or a non-callable
   * node) and from `skipped` (cap-trimmed candidates that never
   * entered the dispatch loop). Populated before calling the work fn.
   */
  preFilteredExternal: number;
  /**
   * Count of candidates skipped because adaptive early-bail had already
   * tripped (LSP_EARLY_BAIL_SAMPLE probed with 0 resolutions). These keep
   * their heuristic edge — identical to probing-and-getting-empty under the
   * observed 0-hit rate. 0 when bail never triggers (the common case).
   */
  bailed?: number;
  /** True once early-bail tripped during this session. */
  earlyBailed?: boolean;
}

/**
 * Minimal `LspClient` surface the session consumes. Mirrors
 * `withReferenceProvider`'s narrow seam — tests can construct
 * plain-object fakes without inheriting the concrete class.
 */
export type ReconciliationLspClient = Pick<
  LspClient,
  'start' | 'stop' | 'request' | 'getState'
>;

/** Minimal `RepoLike` — the session reads only `id` and `repoPath`. */
export type ReconciliationRepo = {
  id: string;
  repoPath: string;
};

/**
 * The readiness probe contract. Default wires
 * `probeWorkspaceReadiness` with an empty `samples` list (which
 * refuses); production callers MUST override with a real probe.
 */
export type ReconciliationProbeFn = (
  client: ReconciliationLspClient,
) => Promise<ProbeResult>;

/**
 * Factory for producing a `ReconciliationLspClient`. The default
 * constructs a real `LspClient` with `repo.repoPath` as the
 * workspaceRoot. Tests inject a `vi.fn(() => mockClient)`.
 */
export type CreateReconciliationLspClientFn = (repo: ReconciliationRepo) => ReconciliationLspClient;

/**
 * The signature of the work fn. Receives:
 *   - the deterministic-prefix candidate slice (already sorted
 *     + cap-trimmed),
 *   - session meta (server version, timeouts, applied cap),
 *   - the count of candidates SKIPPED by the cap (`feed.length -
 *     selected.length`).
 */
export type ReconciliationFn<T> = (
  selected: Candidate[],
  meta: SessionMeta,
  skipped: number,
) => Promise<T>;

/**
 * The dispatch seam for the WI-4b engine. The session calls this
 * once per candidate with the (normalized) `Location[]` payload.
 *
 * The default wires a no-op collector (the engine is the
 * subject of WI-4b; until then, the session is a transport
 * shim and the unit tests verify normalization, not the
 * engine).
 */
export type HandToEngineFn = (
  candidate: Candidate,
  locations: Location[],
) => Promise<void>;

/**
 * Dependency bag for `withReconciliationSession`. Mirrors the
 * shape of `WithReferenceProviderDeps`. Every field has a
 * production default; the unit tests pass a hand-built bag of
 * `vi.fn()`s to bypass subprocess spawning.
 */
export interface WithReconciliationSessionDeps {
  /**
   * Language adapter to use for this session (WI-6).
   *
   * - `undefined` (not set)  → backward-compatible default: `TYPESCRIPT_ADAPTER`.
   *   This preserves the pre-WI-6 behaviour for all existing tests that inject
   *   `discoverServers` / `createLspClient` without specifying a language.
   * - `null` → caller explicitly signals no supported language; the session
   *   short-circuits and returns `null` without spawning anything.
   * - A `LanguageAdapter` → use the supplied adapter (e.g. `JAVA_ADAPTER`).
   *
   * Production callers (pipeline.ts) always pass the result of
   * `selectAdapter(repoPath)` — which may be `null` for repos with no
   * supported language files — so the null-short-circuit fires correctly.
   */
  adapter?: LanguageAdapter | null;
  /**
   * Override the `discoverServers` call (default: real one).
   * Returns a `DiscoveredServers` map with one entry per supported language.
   * Existing tests that return `{ typescript: … }` are structurally
   * compatible (the `java` field is optional on `DiscoveredServers`).
   */
  discoverServers?: () => Promise<DiscoveredServers>;
  /**
   * Override the `LspClient` factory (default: real one with
   * `repo.repoPath` as the workspaceRoot). Called ONCE per
   * session, AFTER `discoverServers` succeeds, BEFORE
   * `start()`.
   */
  createLspClient?: CreateReconciliationLspClientFn;
  /**
   * Override the readiness probe (default: real
   * `probeWorkspaceReadiness` with empty `samples` — which
   * refuses). Production callers MUST override with a real
   * probe that exercises the canary positions.
   */
  probe?: ReconciliationProbeFn;
  /**
   * Override the engine dispatch (default: no-op collector).
   * Production callers wire the WI-4b engine here.
   */
  handToEngine?: HandToEngineFn;
  /** Override the per-request timeout in ms (default 5000). */
  requestTimeoutMs?: number;
  /** Override the candidate cap (default 2000). */
  cap?: number;
  /**
   * Lever 13: max concurrent in-flight LSP requests (default 1 = serial).
   * Threaded into the default `LspClient` factory. Ignored when the caller
   * supplies its own `createLspClient`.
   */
  maxInFlight?: number;
  /**
   * Lever 14: persisted definition cache. When present, the dispatch consults
   * it before each `textDocument/definition` request and stores live results.
   * The cache owns its own correctness (commit-namespaced, clean-tree-gated);
   * the session just reads/writes the interface. Absent → no caching.
   */
  definitionCache?: DefinitionCache;
  /**
   * Adaptive early-bail. `false` forces exhaustive probing; otherwise
   * (default, undefined) the dispatch stops after probing
   * LSP_EARLY_BAIL_SAMPLE candidates with 0 resolutions and keeps the
   * heuristic for the rest. Only trips on a strict 0-hit sample → resolving
   * repos are byte-identical.
   */
  earlyBail?: boolean;
  /**
   * Server version, captured upstream (production may pass the
   * discovered version here so the summary line can attribute
   * results to a specific binary). When omitted, the session
   * reads it from the discover result.
   */
  serverVersion?: string;
  /**
   * External pre-filter seam (WI-8 / ADR-002 WI-A3).
   *
   * Called once per candidate BEFORE `fetchDefinitionForCandidate`.
   * Return `true` when the candidate is PROVABLY EXTERNAL and LSP
   * dispatch can be safely skipped.  Two branches apply:
   *
   * **Correction candidates** (`oldTargetId` present — original WI-8):
   *   Return `true` only when `graph.getNode(candidate.oldTargetId)`
   *   returns a node with `properties.isExternal === true`.
   *
   * **Recall candidates** (`oldTargetId` absent — ADR-002 WI-A3):
   *   Return `true` when the candidate's `candidateLocationKey` is
   *   present in the `recallExternalFqnMap` populated by
   *   import-processor (via `RecallFeedItem.calleeExternalFqn`).
   *   A non-null entry means the callee was provably external at
   *   import-analysis time; skipping LSP dispatch is safe.
   *   Return `false` when the key is absent (conservative probe —
   *   never guess on missing FQN evidence).
   *
   * Invariants (I-2c — no false skips):
   *   - NOTE (WI-8 correction branch only): the original contract
   *     stated recall candidates MUST return `false`.  That invariant
   *     still holds for the *correction* code path and for any recall
   *     candidate whose FQN is absent from `recallExternalFqnMap`.
   *   - MUST return `false` for ambiguous/uncertain correction candidates.
   *   - MUST return `false` when the lookup result is inconclusive.
   *   - MUST return `false` for recall candidates whose
   *     `candidateLocationKey` is absent from `recallExternalFqnMap`.
   *   - Return `true` for correction candidates with a graph node
   *     that is definitively external-zone (WI-8).
   *   - Return `true` for recall candidates whose FQN is present in
   *     `recallExternalFqnMap` (ADR-002 WI-A3 recall pre-filter).
   *
   * When absent from the deps bag, the session defaults to `() => false`
   * (never-skip) — preserving pre-WI-8 behaviour exactly (backward compat).
   *
   * Skipped candidates increment `meta.preFilteredExternal` (not `meta.probed`);
   * they are NOT handed to `handToEngine` and do NOT receive an LSP request.
   */
  canSkipCandidate?: (candidate: Candidate) => boolean;
  /**
   * WS-B / I-2d: discriminated gate-failure side-channel.
   *
   * Called (at most once) when the session refuses WITHOUT running the
   * work fn. The `reason` distinguishes the three failure modes so the
   * caller (pipeline.ts) can emit the correct per-path funnel message:
   *
   *   'no-server'      — `discoverServers` returned no entry for this adapter,
   *                      OR `client.start()` threw.
   *   'not-ready'      — probe returned `{ ready: false }`.
   *   'dispatch-error' — an error was thrown inside the try block
   *                      (per-candidate dispatch or fn threw) BEFORE
   *                      the work fn completed.
   *
   * `elapsedS` is the formatted elapsed seconds string (e.g. `'2.5'`)
   * measured from session entry to the gate failure, so the caller can
   * embed it in messages like `'jdtls not ready after Xs'` without a
   * separate timer.
   *
   * Optional — omitting it preserves the existing null-return contract
   * exactly, so all existing tests that never pass this dep are unaffected.
   */
  onGateFailure?: (reason: 'no-server' | 'not-ready' | 'dispatch-error', elapsedS: string) => void;
  /**
   * WI-1 (heartbeat): forwarded to `LspClientOptions.onHeartbeat` so the
   * language adapter can emit live readiness progress. Absent → no heartbeat.
   */
  onHeartbeat?: (elapsedMs: number) => void;
  /**
   * WI-2 (candidate progress): called after each `handToEngine` completion,
   * throttled to every 25 calls. `done` is the number of completed
   * `handToEngine` calls; `total` is `selected.length`. Absent → no callback.
   */
  onCandidateProgress?: (done: number, total: number) => void;
}

// ─── Defaults (KD-9, KD-10) ────────────────────────────────────────────

/** Per-request timeout (ms) for `textDocument/definition`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Max candidates accepted into the session per call (KD-9). */
export const DEFAULT_CANDIDATE_CAP = 2_000;

/**
 * Max in-flight `textDocument/definition` requests during the
 * per-candidate dispatch. The underlying `LspClient.request`
 * serializes all JSON-RPC traffic through a per-client promise
 * chain (see `lsp-client.ts` `queue` field), so the pool does
 * NOT actually parallelize the wall-clock work — the wall-time
 * bound is `cap × serialLatency` (≈ `cap × timeoutMs` in the
 * worst case). The cap still bounds memory and in-flight
 * concurrent-futures bookkeeping, which is its real purpose.
 * If a future client version makes `request` truly concurrent
 * (e.g. multiplexes over the JSON-RPC stream), the 8-way pool
 * delivers on the wall-time promise as a free side effect.
 */
export const CONCURRENT_DEFINITION_REQUESTS = 8;

/** Probe request method — kept as a constant for clarity. */
const TEXT_DOCUMENT_DEFINITION = 'textDocument/definition';

/**
 * Vendor/stdlib path segments. A `textDocument/definition` that resolves INTO
 * one of these (e.g. pylsp answering a numpy call with a path under
 * site-packages, or the Python stdlib under `lib/python3.x/`) never maps to an
 * indexed node, so it is NOT a useful resolution for early-bail purposes.
 */
const VENDOR_SEGMENT_RE = /[/\\](?:site-packages|dist-packages|node_modules|__pycache__|\.venv|venv|lib[/\\]python[0-9.]*)[/\\]/;

/**
 * Early-bail "useful resolution" predicate. Returns true if the probe resolved
 * to at least one NON-vendor location (a plausible in-repo definition). This is
 * a PERFORMANCE heuristic only — it decides WHEN to stop probing, never graph
 * correctness (bailed candidates keep their heuristic edge regardless). Errs
 * toward "useful" (no bail) on anything it can't parse, so it never bails a repo
 * the server is actually resolving.
 */
function resolvesUseful(locations: Location[]): boolean {
  for (const loc of locations) {
    let p: string;
    try { p = fileURLToPath(loc.uri); } catch { return true; }
    if (!VENDOR_SEGMENT_RE.test(p)) return true;
  }
  return false;
}

/**
 * Adaptive early-bail sample size. Once the dispatch loop has probed this many
 * candidates with ZERO resolutions (every `textDocument/definition` came back
 * empty), the server is demonstrably not resolving this repo — continuing would
 * only add latency, not edges. We stop and keep the heuristic for the rest.
 * Set high enough to be representative; only a strict 0-hit sample bails, so any
 * repo the server resolves at all is never affected (byte-identical).
 */
export const LSP_EARLY_BAIL_SAMPLE = 150;

// ─── Defaults: real-foundation wiring ─────────────────────────────────

/** Real `discoverServers` indirection. Lazy-imported for cold-start cost. */
async function defaultDiscoverServers(): Promise<DiscoveredServers> {
  const { discoverServers } = await import('./lsp/server-discovery.js');
  return discoverServers();
}

/**
 * Real `LspClient` factory (adapter-aware, WI-6).
 *
 * Passing `adapter` ensures the client spawns the correct binary
 * (`typescript-language-server` or `jdtls`) with the correct
 * `spawnArgs`, `languageId`, and `initializationOptions`.
 * Defaults to `TYPESCRIPT_ADAPTER` when called from the legacy
 * `undefined`-adapter code path (backward compat).
 *
 * No cast needed: the concrete `LspClient` is structurally a
 * `ReconciliationLspClient` (it has the four required members:
 * `start`, `stop`, `request`, `getState`). The narrow seam lets
 * the session accept test fakes that don't inherit the concrete
 * class.
 */
function defaultCreateLspClient(
  repo: ReconciliationRepo,
  adapter: LanguageAdapter,
  maxInFlight?: number,
  onHeartbeat?: (elapsedMs: number) => void,
): ReconciliationLspClient {
  return new LspClient({ workspaceRoot: repo.repoPath, adapter, maxInFlight, onHeartbeat });
}

/**
 * Real probe default. Mirrors
 * `withReferenceProvider`'s degenerate input contract — empty
 * samples → refuse. Production callers MUST override this dep
 * with a real probe; otherwise the session is a structural
 * no-op.
 */
async function defaultProbe(_client: ReconciliationLspClient): Promise<ProbeResult> {
  const { probeWorkspaceReadiness } = await import('./lsp/workspace-readiness-probe.js');
  // The probe signature wants the full `LspClient`; the session
  // narrows it for the work-fn seam. The narrowing is
  // *behavior-preserving* (the four picked members are the only
  // ones the probe touches in this codepath) — a structural cast
  // is sound but TS can't prove it without the double-as.
  return probeWorkspaceReadiness(_client as unknown as LspClient, [] as Sample[]);
}

/** No-op engine collector. Replaced by the WI-4b dispatch in production. */
async function defaultHandToEngine(_candidate: Candidate, _locations: Location[]): Promise<void> {
  // Intentionally empty: the session's job is to NORMALIZE +
  // DISPATCH. The engine (WI-4b) owns decision logic. Until WI-4b
  // lands, the session is structurally a no-op on the engine
  // side and the test suite verifies normalization only.
  return;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * `withReconciliationSession` — the single refuse funnel for
 * Mode A.
 *
 * Lifecycle (single try/finally, I-5):
 *   1. `discoverServers()`            → null if no TS server
 *   2. `client.start()`                → null if start throws
 *   3. (in try) `probe(client)`        → null if not ready
 *   4. (in try) `fn(candidates, meta, skipped)` → fn's result
 *   5. (in finally) `client.stop()`    — runs on every post-start exit
 *
 * Return value:
 *   - The exact value `fn` resolves to on the happy path.
 *   - `null` on any gate failure (no server, start failed, probe
 *     not ready, or `fn` threw).
 *
 * Crash isolation (KD-9, AC-3): a `null` return from this funnel
 * is the caller's signal that the heuristic index stands
 * untouched. There is no "partial reconcile" path.
 *
 * @param repo       The repo handle (read `id` + `repoPath`).
 * @param candidates The merged correction+recall feed
 *                   (the caller's caller is responsible for
 *                   merging — the session expects a single
 *                   stream of `Candidate` rows).
 * @param fn         The user work. Receives the
 *                   deterministic-prefix candidate slice + meta
 *                   + skipped count.
 * @param deps       Optional dependency overrides.
 */
export async function withReconciliationSession<T>(
  repo: ReconciliationRepo,
  candidates: Candidate[],
  fn: ReconciliationFn<T>,
  deps: WithReconciliationSessionDeps = {},
): Promise<T | null> {
  // ── 0) Adapter selection (WI-6 / KD-4) ──────────────────────────
  // Three-way semantics on `deps.adapter`:
  //   undefined → backward-compatible default: TYPESCRIPT_ADAPTER.
  //     Preserves pre-WI-6 behaviour for all existing tests that
  //     inject `discoverServers` / `createLspClient` without naming
  //     a language. `??` cannot express this because it also coalesces
  //     `null`, so we use an explicit `!== undefined` check.
  //   null      → caller explicitly signals no supported language
  //     (e.g. pipeline.ts called `selectAdapter(repoPath)` and got
  //     null). Short-circuit: no server, no client, return null.
  //   LanguageAdapter → use the supplied adapter (TS, Java, …).
  const adapter: LanguageAdapter | null =
    deps.adapter !== undefined ? deps.adapter : TYPESCRIPT_ADAPTER;
  // WS-B / I-2d: gate-failure side-channel. Extract early so all failure
  // branches below can call it. Callers that need per-reason funnel messages
  // (e.g. pipeline.ts) pass this dep; others (existing unit tests) omit it —
  // preserving the null-return contract exactly.
  const onGateFailure = deps.onGateFailure;
  if (adapter === null) {
    // No supported language detected — skip the funnel cleanly.
    return null;
  }

  // ── 0b) Prepare feeds (deterministic-prefix selection, KD-9) ───────
  // Stable-sort the merged feed by (sourceId, calledName, line,
  // character) — the four-tuple identifies a call site
  // uniquely within a repo. JS `Array.prototype.sort` is
  // stable as of ES2019 (the spec guarantees it), and Node 18+
  // honors that. The sort runs BEFORE the cap so the cap is
  // applied to a *stable prefix* (KD-9: deterministic-prefix
  // selection).
  const cap = deps.cap ?? DEFAULT_CANDIDATE_CAP;
  const sorted = sortCandidates(candidates ?? []);
  // Roadmap lever 6: partition the cap between heritage (IMPLEMENTS/EXTENDS)
  // and CALLS so the high-volume CALLS feed cannot starve the small-but-
  // high-value heritage feed out of the deterministic prefix. Byte-identical
  // to `sorted.slice(0, cap)` when the repo has no heritage candidates.
  const selected = partitionCandidatesByRelType(sorted, cap);
  const skipped = Math.max(0, sorted.length - selected.length);

  // ── 1) Discovery gate (G1) ────────────────────────────────────────
  // `discoverServers` is a pure async function — never throws,
  // never installs. Absence is the most common case and the
  // funnel treats it as "refuse → null" with zero side effects.
  // WI-6: pick the discovered entry for this adapter's language
  // (`adapter.id` is `'typescript'` | `'java'`), not hardcoded
  // `.typescript`. This is the sole wiring change in the funnel —
  // the language-agnostic session body (`:353-464`) is untouched.
  const discover = deps.discoverServers ?? defaultDiscoverServers;
  const discovered = await discover();
  const serverEntry = (discovered as Record<string, { path: string; version: string } | null | undefined>)[adapter.id] ?? null;
  if (!serverEntry) {
    // No server for this adapter's language. No client was created → no stop needed.
    // I-2d: notify with 'no-server' so callers can emit the correct funnel message.
    onGateFailure?.('no-server', '0.0');
    return null;
  }
  const serverVersion = deps.serverVersion ?? serverEntry.version;

  // ── 2) Client construction + start (G2) ───────────────────────────
  // The factory is called AFTER discovery succeeds so a missing
  // binary doesn't waste a client object.
  // WI-6: inline the adapter-aware default so the factory closes
  // over the selected adapter (TS or Java) — the module-level
  // `defaultCreateLspClient` now accepts adapter as second arg.
  const factory = deps.createLspClient ?? ((r: ReconciliationRepo) => defaultCreateLspClient(r, adapter, deps.maxInFlight, deps.onHeartbeat));
  const client = factory(repo);
  try {
    await client.start();
  } catch {
    // start() threw (e.g. spawn failed). We have no client we
    // can stop — the client was either never constructed or
    // was torn down internally. Return null.
    // I-2d: classify as 'no-server' (the server binary is unavailable or
    // crashed on start — indistinguishable from "no binary found" at this level).
    onGateFailure?.('no-server', '0.0');
    return null;
  }

  // ── 3) Probe gate + dispatch + fn execution in a single
  //    try/finally (I-5 + I-6) ───────────────────────────────────────
  // The probe is the SOLE LSP authorization gate (I-6). A
  // non-ready verdict means we must not even *try* to use the
  // LSP surface — but the client is still alive and must be
  // stopped (I-5). The same try/finally covers the per-
  // candidate dispatch + fn call.
  const probe = deps.probe ?? defaultProbe;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handToEngine = deps.handToEngine ?? defaultHandToEngine;
  // WI-8: external pre-filter seam. Defaults to () => false (never-skip)
  // when not injected — preserving pre-WI-8 behaviour exactly.
  const canSkipCandidate = deps.canSkipCandidate ?? (() => false);
  // WI-5: probed/preFilteredExternal start at 0 and are incremented
  // in the dispatch loop below. meta is built here so the fields
  // exist; values are written before fn() is called.
  const meta: SessionMeta = { serverVersion, requestTimeoutMs, cap, probed: 0, preFilteredExternal: 0, bailed: 0 };
  // Adaptive early-bail state. Once we have probed `earlyBailThreshold`
  // candidates with `hits === 0` (every definition came back empty), stop
  // dispatching: the server is not resolving this repo. `Infinity` disables it.
  const earlyBailThreshold = deps.earlyBail === false ? Infinity : LSP_EARLY_BAIL_SAMPLE;
  let lspHits = 0;
  let earlyBailed = false;
  // Measure elapsed time from here so the not-ready message can carry
  // a meaningful duration (the probe itself may spin for up to 600s on
  // a slow jdtls workspace build).
  const sessionStart = Date.now();
  try {
    const probeResult = await probe(client);
    if (!probeResult.ready) {
      const elapsedS = ((Date.now() - sessionStart) / 1000).toFixed(1);
      onGateFailure?.('not-ready', elapsedS);
      return null;
    }
    // Per-candidate dispatch loop. Each iteration issues ONE
    // `textDocument/definition` request at the callee-identifier
    // position and hands the normalized `Location[]` to the
    // engine seam. A throw inside the dispatch or fn propagates
    // to the outer `catch` → null + stop in finally.
    //
    // Bounded-concurrency pool (concurrency=8). The
    // underlying `LspClient.request` serializes requests
    // through a per-client promise chain (see
    // `lsp-client.ts`), so this pool does NOT actually
    // parallelize the wall-clock work — the wall-time
    // bound is `cap × serialLatency`. The cap still
    // bounds memory + in-flight bookkeeping, and it
    // would deliver real wall-time savings if a future
    // client version makes `request` truly concurrent.
    // Order preservation: the pool writes into a
    // pre-sized array keyed by source-order index — the
    // engine sees the same order it would have seen
    // sequentially, which matters for the dry-run print
    // shape. Per-candidate throws are swallowed (one slow
    // candidate must not abort the whole run); the engine
    // gets `[]` and treats it as NO_NODE.
    // Per-session URI cache — a `pathToFileURL` call is not
    // free, and a single repo often has thousands of
    // candidates pointing at a much smaller set of distinct
    // files. Cache the file→uri mapping for the lifetime of
    // this dispatch loop; the cache dies with the session.
    const uriCache = new Map<string, string>();
    let _candidateDone = 0;
    await runWithConcurrency(
      selected,
      CONCURRENT_DEFINITION_REQUESTS,
      async (candidate) => {
        // Adaptive early-bail: once tripped, skip every remaining candidate.
        // No probe, no handToEngine → locs=[] → NO_NODE → KEEP heuristic,
        // identical to probing-and-getting-empty under the observed 0-hit rate.
        if (earlyBailed) {
          meta.bailed = (meta.bailed ?? 0) + 1;
          return;
        }
        // WI-8: external pre-filter seam fires BEFORE the LSP request.
        // Return true ONLY for provably-external correction candidates
        // (I-2c: no false skips). Recall candidates must always probe.
        if (canSkipCandidate(candidate)) {
          meta.preFilteredExternal++;
          // Do NOT call handToEngine — the candidate is excluded from
          // the locations map; reconcileDecisions will see locs=[] →
          // NO_NODE → keep (I-8-replay invariant preserved).
          return;
        }
        // Lever 14: consult the persisted definition cache before issuing a
        // live request. A hit replays a prior run's answer (valid because the
        // cache is commit-namespaced + clean-tree-gated). Absent cache → undefined.
        const cacheKey = definitionCacheKey(candidate.file, candidate.line, candidate.character);
        const cached = deps.definitionCache?.get(cacheKey);
        let result: { locations: Location[]; preFiltered: boolean };
        if (cached !== undefined) {
          result = { locations: cached, preFiltered: false };
          // A cached candidate was answered (no live request); count as probed.
          meta.probed++;
        } else {
          result = await fetchDefinitionForCandidate(client, candidate, requestTimeoutMs, uriCache, repo.repoPath);
          if (result.preFiltered) {
            // WI-5: isUnindexablePath pre-filter fired — count as
            // preFilteredExternal (NOT probed).
            meta.preFilteredExternal++;
          } else {
            // WI-5: a `textDocument/definition` request was actually
            // issued (or would have been, before a position/URI error
            // short-circuit — those are still not pre-filter).
            meta.probed++;
            // Lever 14: cache the live (non-pre-filtered) result for re-runs.
            deps.definitionCache?.set(cacheKey, result.locations);
          }
        }
        await handToEngine(candidate, result.locations);
        _candidateDone++;
        if (deps.onCandidateProgress && _candidateDone % 25 === 0) {
          try { deps.onCandidateProgress(_candidateDone, selected.length); } catch { /* progress callback must never break the session */ }
        }
        // Adaptive early-bail accounting: a non-empty Location[] is a "hit".
        // After a full 0-hit sample, trip the bail so the remaining candidates
        // are skipped (kept). Only fires on probed candidates (preFiltered ones
        // never reach here with a probe). `>=` + the `!earlyBailed` guard make
        // the trip idempotent under concurrency (a few in-flight probes past
        // the threshold are harmless — they just add to the sample).
        if (resolvesUseful(result.locations)) lspHits++;
        // Only trip when candidates actually remain to skip (so a feed sized
        // exactly at the threshold never bails pointlessly).
        const processed = meta.probed + (meta.preFilteredExternal ?? 0) + (meta.bailed ?? 0);
        if (!earlyBailed && lspHits === 0 && meta.probed >= earlyBailThreshold && processed < selected.length) {
          earlyBailed = true;
          meta.earlyBailed = true;
          const bailS = ((Date.now() - sessionStart) / 1000).toFixed(1);
          console.warn(
            `  LSP early-bail: 0/${meta.probed} candidates resolved after ${bailS}s — ` +
            `server not resolving this repo; keeping heuristic for the remaining ` +
            `~${Math.max(0, selected.length - meta.probed - (meta.preFilteredExternal ?? 0))} candidates ` +
            `(disable with --lsp-no-early-bail).`,
          );
        }
      },
    );
    return await fn(selected, meta, skipped);
  } catch {
    // Probe-threw OR dispatch-threw OR fn-threw. In every case
    // the funnel refuses (the probe is the gate; a dispatch
    // crash must not abort the index — it must yield a coherent
    // heuristic result). The finally below still runs to stop
    // the client.
    // I-2d: classify as 'dispatch-error' so callers can log the error path.
    const elapsedS = ((Date.now() - sessionStart) / 1000).toFixed(1);
    onGateFailure?.('dispatch-error', elapsedS);
    return null;
  } finally {
    // I-5: once we have a started client, we ALWAYS stop it on
    // every post-start exit. `client.stop()` is idempotent and
    // never throws per its contract, so no try/catch is needed.
    await client.stop();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Stable-sort the candidate feed by the canonical four-tuple.
 * Exposed via `__test__` for unit tests that pin the sort key.
 *
 * The sort is *not* the kind that benefits from a total order
 * beyond the natural string/number compare — `sourceId` and
 * `calledName` are strings, `line` and `character` are numbers.
 * JS's default `Array.prototype.sort` uses the natural
 * lexicographic order for strings (UTF-16 code units), which
 * is deterministic for our 7-bit-ASCII-shaped inputs (ids
 * are `Label:filePath:name[:overloadIndex]`).
 */
function sortCandidates(cands: Candidate[]): Candidate[] {
  // Defensive: shallow-copy the caller's array — the cap
  // selection runs on a snapshot so the input stays untouched.
  return [...cands].sort(candidateCompare);
}

/**
 * Roadmap lever 6 — partition the deterministic-prefix cap between the
 * heritage feed (candidates with `relType` = IMPLEMENTS/EXTENDS) and the
 * CALLS feed (no `relType`). Without this, a large repo's CALLS volume
 * (tens of thousands) crowds the small-but-high-value heritage feed
 * (hundreds) out of the `cap`-sized prefix entirely.
 *
 * Policy: heritage is reserved up to `floor(cap/2)`; any reserve it does
 * not use flows to CALLS, and any CALLS slack flows back to heritage — so
 * the cap is always fully utilized and neither feed starves the other.
 * `input` is already stable-sorted; we re-sort the chosen union to keep a
 * deterministic processing order. When there are no heritage candidates
 * the result is byte-identical to `input.slice(0, cap)` (no regression on
 * CALLS-only repos).
 */
function partitionCandidatesByRelType(input: Candidate[], cap: number): Candidate[] {
  if (cap <= 0) return [];
  if (input.length <= cap) return input.slice(); // nothing trimmed
  const heritage = input.filter((c) => c.relType);
  if (heritage.length === 0) return input.slice(0, cap); // legacy path
  const calls = input.filter((c) => !c.relType);
  const heritageReserve = Math.floor(cap / 2);
  let heritageTake = Math.min(heritage.length, heritageReserve);
  let callsTake = Math.min(calls.length, cap - heritageTake);
  // Reuse leftover budget (e.g. CALLS smaller than its share) for heritage.
  const leftover = cap - heritageTake - callsTake;
  if (leftover > 0) heritageTake += Math.min(heritage.length - heritageTake, leftover);
  const chosen = [...heritage.slice(0, heritageTake), ...calls.slice(0, callsTake)];
  return sortCandidates(chosen);
}

/**
 * Total ordering for `Candidate`. The four-tuple order is
 * `(sourceId, calledName, line, character)` per the spec.
 */
function candidateCompare(a: Candidate, b: Candidate): number {
  if (a.sourceId < b.sourceId) return -1;
  if (a.sourceId > b.sourceId) return 1;
  if (a.calledName < b.calledName) return -1;
  if (a.calledName > b.calledName) return 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.character !== b.character) return a.character - b.character;
  return 0;
}

/**
 * Run `worker(item)` over `items` with bounded concurrency.
 *
 * Why a hand-rolled pool (not a library): the per-item work
 * is one `await` against a per-client promise chain, so the
 * only correctness need is "no more than N in flight at
 * once." A 30-line queue suffices. No new dependency.
 *
 * Why preserve order: the dry-run print in `pipeline.ts`
 * expects the same dispatch order the sequential `for…await`
 * would have produced. We don't need the worker results
 * (`runWithConcurrency` returns `void`); the worker writes
 * side-effects into a shared map (the `handToEngine` seam
 * already does this with the canonical key). If a future
 * caller needs ordered results, switch to `Promise.all` over
 * a pre-sized array.
 *
 * Error policy: a worker throw is captured and re-thrown
 * AFTER the pool drains, so the funnel's outer
 * `try { ... } catch { return null }` (failure-isolation,
 * I-5) catches it and the funnel refuses. The sequential
 * form previously let the throw bubble mid-loop, which had
 * the same effect; we preserve that contract.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let firstError: unknown = null;

  async function pump(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        await worker(item);
      } catch (err) {
        // Capture only the first error. Subsequent errors
        // are dropped — the funnel is going to refuse
        // anyway, and we don't want a noisy multi-error
        // composite masking the root cause.
        if (firstError === null) firstError = err;
      }
    }
  }

  const pumps: Promise<void>[] = [];
  for (let k = 0; k < limit; k++) {
    pumps.push(pump());
  }
  await Promise.all(pumps);
  if (firstError !== null) throw firstError;
}

/**
 * Issue ONE `textDocument/definition` request for the given
 * candidate, race it against the timeout, and normalize the
 * response to `Location[]`.
 *
 * Normalization rules (KD-4, AC-1):
 *   - `null`             → `[]` (refused / timeout / crash)
 *   - `[]`               → `[]` (server says "no definition")
 *   - `[Location, ...]`  → passthrough
 *   - bare `Location`    → `[Location]` (single-object form some
 *                          servers return)
 *   - other shapes       → `[]` (refuse over guess)
 *
 * The character offset is set to the candidate's callee
 * identifier position. The session hands the response to the
 * engine without ever trusting its shape — any non-`Location`
 * payload is treated as a refusal.
 *
 * URI construction uses `pathToFileURL` (Node stdlib) so
 * paths with spaces, non-ASCII characters, or Windows drive
 * letters all serialize correctly. A candidate pointing at
 * an `isUnindexablePath` (node_modules, `.d.ts`, dist/)
 * short-circuits to `[]` — there is no node there to look up
 * and we refuse over guess.
 */
async function fetchDefinitionForCandidate(
  client: ReconciliationLspClient,
  candidate: Candidate,
  timeoutMs: number,
  // T2: `uriCache` is REQUIRED. The session (the only call
  // site) always constructs a fresh `new Map<string, string>()`
  // per dispatch; making it required removes the per-call
  // `?.` optional-chaining at the read site and the
  // `uriCache?.set(...)` write — the cache is now invariant:
  // always a real Map.
  uriCache: Map<string, string>,
  // Bug F4-forward fix: the repo root the candidate's
  // repo-relative `file` is anchored to when building the
  // `file://` URI. Required — the session always has
  // `repo.repoPath`. Without it a relative `candidate.file`
  // resolves against `process.cwd()` and the LSP server (rooted
  // at the repo) sees a non-existent / out-of-workspace path.
  repoRoot: string,
): Promise<{ locations: Location[]; preFiltered: boolean }> {
  // M8: validate the file path is one the engine would ever
  // index. Vendored / declaration / dist paths are
  // unindexable per the location-mapper's predicate; we
  // refuse before we spend a request budget.
  // WI-5: callers that hit this branch are counted as
  // `preFilteredExternal` (NOT `probed`) — see dispatch loop.
  if (isUnindexablePath(candidate.file)) {
    return { locations: [], preFiltered: true };
  }

  // security-3 (polish MAJOR): gate `line` / `character`
  // BEFORE the `textDocument/definition` request. An
  // attacker-controlled (or upstream-buggy) heritage feed
  // could pass a negative, non-integer, or otherwise
  // out-of-range position; the LSP server would either
  // crash, hang, or return garbage, and a malicious
  // server response could be coerced into a node-id we
  // never intended to map. Refuse over guess: a bad
  // position is treated as `NO_NODE` and the engine
  // emits `keep` for the existing edge. Per the polish
  // review: `Number.isInteger` rejects `NaN`, `Infinity`,
  // fractional floats, and string-encoded numbers. The
  // `< 0` clause rejects negative offsets. Both are
  // cheap (constant time) and run before any I/O.
  // WI-5: bad-position candidates are NOT pre-filtered and
  // NOT probed — they contribute to `refused` via NO_NODE.
  if (
    !Number.isInteger(candidate.line) ||
    !Number.isInteger(candidate.character) ||
    candidate.line < 0 ||
    candidate.character < 0
  ) {
    return { locations: [], preFiltered: false };
  }

  // Build the `textDocument/definition` params. The file
  // path becomes a `file://` URI via `pathToFileURL` (Node
  // stdlib) — handles spaces, non-ASCII, and Windows drive
  // letters correctly. The position is the callee
  // identifier's (line, character) — NOT the call-expression
  // start. This is the load-bearing piece for member-call
  // recall (WI-2 prerequisite).
  //
  // A per-session `uriCache` short-circuits the conversion
  // for repeats — most candidates point at one of a small
  // set of files in a typical repo.
  let uri: string;
  if (candidate.file.startsWith('file://')) {
    uri = candidate.file;
  } else {
    const cached = uriCache.get(candidate.file);
    if (cached !== undefined) {
      uri = cached;
    } else {
      try {
        // Bug F4-forward fix: `candidate.file` is a
        // repo-relative POSIX path (e.g. `src/db.ts`) — the same
        // form the graph stores. `pathToFileURL` on a relative
        // path resolves it against `process.cwd()`, NOT the
        // analyzed repo, so the resulting URI points at a file
        // that does not exist in the LSP workspace and every
        // `textDocument/definition` returns null → every
        // candidate becomes NO_NODE. We MUST anchor the relative
        // path to the repo root before building the URI. Absolute
        // inputs (a producer that already resolved the path) are
        // passed through untouched.
        const absFile = pathIsAbsolute(candidate.file)
          ? candidate.file
          : pathResolve(repoRoot, candidate.file);
        uri = pathToFileURL(absFile).toString();
        uriCache.set(candidate.file, uri);
      } catch {
        // `pathToFileURL` can throw on bizarre inputs (e.g.
        // a relative path with a NUL byte). Refuse over
        // guess: skip the candidate.
        return { locations: [], preFiltered: false };
      }
    }
  }
  const params = {
    textDocument: { uri },
    position: { line: candidate.line, character: candidate.character },
  };
  let raw: unknown;
  try {
    // The LspClient contract: `request` resolves to value or
    // `null`. We do not expect a throw — the try/catch is
    // belt-and-braces.
    raw = await client.request(TEXT_DOCUMENT_DEFINITION, params, timeoutMs);
  } catch {
    return { locations: [], preFiltered: false };
  }
  return { locations: normalizeLocations(raw), preFiltered: false };
}

/**
 * Normalize the `request` response into `Location[]`. See
 * `fetchDefinitionForCandidate` for the full rule set.
 *
 * `Location` validation is intentionally lenient: a payload
 * that has `uri: string` + `range.start.line: number` is
 * accepted. Anything else is dropped (refuse over guess).
 *
 * We do NOT validate `range.start.character` — the engine
 * only consumes `start.line` (per the location-mapper
 * contract). A non-numeric character is silently coerced to
 * `0` for the engine's downstream use.
 */
function normalizeLocations(raw: unknown): Location[] {
  if (raw === null || raw === undefined) return [];
  // Bare `Location` (single object, not in an array).
  if (!Array.isArray(raw)) {
    const loc = coerceLocation(raw);
    return loc ? [loc] : [];
  }
  const out: Location[] = [];
  for (const item of raw) {
    const loc = coerceLocation(item);
    if (loc) out.push(loc);
  }
  return out;
}

/** Type guard: `item` has the shape of a single `Location`. */
function isLocationLike(item: unknown): item is Location {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as { uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } };
  if (typeof candidate.uri !== 'string' || candidate.uri.length === 0) return false;
  const range = candidate.range;
  if (!range || typeof range !== 'object') return false;
  const start = range.start;
  if (!start || typeof start !== 'object') return false;
  return typeof start.line === 'number' && Number.isInteger(start.line) && start.line >= 0;
}

/** Coerce a single value to a `Location`; return `null` on malformed input. */
function coerceLocation(item: unknown): Location | null {
  if (!isLocationLike(item)) return null;
  // Coerce character defensively (the engine only needs `line`,
  // but we carry a sane default for downstream consumers).
  const start = item.range.start;
  const character = typeof start.character === 'number' ? start.character : 0;
  return { uri: item.uri, range: { start: { line: start.line, character } } };
}

// ─── Re-exports for tests ──────────────────────────────────────────────
//
// The session's internal helpers (sortCandidates, fetchDefinitionForCandidate,
// normalizeLocations, coerceLocation) are covered by the unit tests through
// the public `withReconciliationSession` funnel. The previous `__test__`
// export in this slot was unreferenced and has been removed.

// ═══════════════════════════════════════════════════════════════════════
// WI-4b — Decision engine (table + gate + atomic correct + collapse)
// ═══════════════════════════════════════════════════════════════════════
//
// The engine half lives in the SAME file as the session half
// (I-7: must be outside `lsp/`, so the funnel is one read
// surface for the pipeline that wires `--lsp`). The engine is a
// pure layer on top of the session:
//
//   decideForCandidate(candidate, lspNodeId, existingRelId?)
//     → Decision  (immutable, no graph writes)
//
//   applyDecisions(graph, decisions, { dryRun })
//     → ApplyResult  (mutates the graph unless dryRun; runs
//        the final (from,to,type) collapse)
//
//   reconcileDecisions(graph, candidates, locations, deps)
//     → ReconciliationReport
//        (top-level: maps every Location through the mapper +
//        adapter, then dispatches each result through
//        `decideForCandidate` + `applyDecisions`)
//
// The engine reads no graph-write API from `lsp/` (I-7). It
// writes ONLY against the `KnowledgeGraph` passed in. The CSV→
// COPY serialization is the only path that touches the DB
// (per the plan: in-memory writes only; no live-DB edge
// mutation).

// ─── WI-4b public types ───────────────────────────────────────────────

/**
 * The provenance tag the engine writes — see `EdgeSource` in
 * `graph/types.ts` for the source of truth.
 */
export type ModeARelationSource = EdgeSource;

/**
 * Confidence assigned to `lsp-confirmed` / `lsp-corrected` edges.
 *
 * Promoted 0.70 → 0.90 (#159 backlog item ③) on the campaign-159 v3
 * evidence (2026-06-12): Mode C positionally valid for the first time
 * (#174, positionCoverage ≥ 0.999), deterministic same-seed reports,
 * and a Mode A funnel of confirmed:corrected = 237:1 across
 * GitNexus/hono/zod — direct `textDocument/definition` evidence at the
 * exact call site, corroborated by (confirm) or replacing (correct)
 * the heuristic verdict. See the #159 thread for the decision record.
 */
export const LSP_CONFIDENCE = 0.9;

/**
 * Confidence assigned to `lsp-recall` edges. A recall edge has no
 * heuristic agreement (the heuristics missed the site entirely); the
 * LSP `textDocument/definition` answer is the sole evidence. Promoted
 * 0.70 → 0.90 (#159) after the dedicated recall-precision check:
 * structural call-site corroboration measured 99.4% (310/312) across
 * GitNexus + hono + zod with 0 dynamic-dispatch false-positives — the
 * one-legged LSP answer is as reliable in practice as the two-method
 * `lsp-confirmed` / `lsp-corrected` edges, so it shares LSP_CONFIDENCE's
 * tier. Recall edges now clear the 0.85 WILL_BREAK impact floor.
 */
export const LSP_RECALL_CONFIDENCE = 0.9;

/** Confidence carried by the heuristic `global` tier (WI-2 feed). */
export const HEURISTIC_GLOBAL_CONFIDENCE = 0.5;

/** Engine reason tag for re-stamping (KD-5). */
export const REASON_LSP_CONFIRMED = 'lsp-confirmed';
export const REASON_LSP_CORRECTED = 'lsp-corrected';
export const REASON_LSP_RECALL = 'lsp-recall';
/** Refusal reason: a recall candidate whose call-site token does not
 *  textually corroborate the LSP-resolved target name (roadmap lever 1). */
export const REASON_UNCORROBORATED_RECALL = 'uncorroborated_recall';

/**
 * Name-corroboration gate for `lsp-recall` edges (roadmap lever 1).
 *
 * A recall edge is minted from a SINGLE `textDocument/definition` answer
 * with no heuristic agreement to corroborate it. The structural recall
 * audit (`scripts/audit-recall-precision.ts`) showed this single-method
 * trust is reliable on Go/Java (~100%) but over-trusts on TS (65.5%) and
 * Python (28.6%): the LSP target's name frequently does NOT match the
 * identifier actually written at the call site. We already hold both
 * names at decision time — `candidate.calledName` is the call-site token
 * and the resolved node carries its `name` — so we can gate without any
 * extra LSP round-trip or file read (unlike the post-hoc audit).
 *
 * Returns true iff the call-site token corroborates the target name.
 * Exact match wins; we additionally tolerate trivial alias artifacts
 * (leading `_`/`$`, case) the audit observed to be true positives. When
 * the target name is unknown (empty/missing) the caller skips the gate —
 * unknown ≠ refuted (mirrors the `targetLabel` null-is-unknown rule).
 *
 * Pure; exported for unit tests.
 */
export function namesCorroborate(calledName: string, targetName: string): boolean {
  if (!calledName || !targetName) return false;
  if (calledName === targetName) return true;
  const norm = (s: string): string => s.replace(/^[_$]+/, '').toLowerCase();
  return norm(calledName) === norm(targetName);
}

/**
 * WI-5 — heritage target-label gates. The decision table
 * reads `deps.callableLabels` and refuses any resolved
 * target whose label is not in the set. For heritage
 * candidates, the gate is keyed by the candidate's
 * `relType`:
 *
 *   IMPLEMENTS  → { Interface }   (TS legal: `class A implements I` only)
 *   EXTENDS     → { Class }       (TS legal: `class B extends C`)
 *
 * Anything outside the gate is refused (`non_callable`
 * reason) and the heuristic edge (if any) is kept. This
 * covers:
 *   - `class A implements SomeClass` (legal but rare in TS)
 *     — refused; the heuristic edge stands.
 *   - `class B extends SomeInterface` (legal in TS) — refused;
 *     the heuristic edge stands.
 *   - A self-loop (`B === A`) — refused earlier by the
 *     self-loop guard.
 *
 * The sets are derived from the spec, not from the graph;
 * the engine does NOT query the in-memory node list to
 * build them. `type-env.ts:has` is reused inside the
 * decision-table's callee-gate check, not here.
 */
export const HERITAGE_TARGET_LABELS: Readonly<
  Record<'IMPLEMENTS' | 'EXTENDS', ReadonlySet<string>>
> = {
  // Roadmap lever 5: generalized beyond TS's Interface/Class so the
  // un-gated multi-language heritage feed (lever 4) resolves correctly.
  // IMPLEMENTS targets a contract: a TS/Java/Go `Interface` or a Rust
  // `Trait`. EXTENDS targets a supertype: a `Class` (TS/Java/Python) or
  // an `Interface` (Java `interface B extends A`). Any other resolved
  // label (e.g. a Go `Struct` embed) is refused by the gate and the
  // heuristic edge is kept — so widening here is safe-by-refusal.
  IMPLEMENTS: new Set(['Interface', 'Trait']),
  EXTENDS: new Set(['Class', 'Interface']),
};

/**
 * The action enum the engine emits per candidate. Mirrors the
 * decision table in `docs/designs/159-lsp-mode-a-calls.md`:
 *
 *   confirm | correct | add | keep | refuse
 *
 *   confirm  — LSP agreed with the heuristic target → re-stamp
 *              the existing edge at 0.70 with `lsp-confirmed`.
 *   correct  — LSP disagreed → atomic remove+insert at 0.70
 *              with `lsp-corrected`.
 *   add      — Heuristic had no edge → add a fresh edge at
 *              0.70 with `lsp-recall`.
 *   keep     — Heuristic had an edge, LSP refused →
 *              no mutation, edge retains its `heuristic` tag
 *              and 0.50 confidence.
 *   refuse   — Heuristic had no edge, LSP refused →
 *              no mutation.
 */
export type DecisionAction = 'confirm' | 'correct' | 'add' | 'keep' | 'refuse';

/**
 * A single decision tuple. Pure data — no graph references.
 * The dry-run mode returns a `Decision[]` and writes nothing
 * (KD-11, AC-6).
 */
export interface Decision {
  /** The candidate this decision is for. */
  candidate: Candidate;
  /** The action the engine selected. */
  action: DecisionAction;
  /** The caller nodeId (the `from` of the edge). */
  from: string;
  /**
   * The callee nodeId (the `to` of the edge). `null` for
   * `keep` and `refuse` (no mutation).
   */
  to: string | null;
  /** The `source` value to stamp (null only for `keep`/`refuse`). */
  source: ModeARelationSource | null;
  /**
   * The id of the EXISTING edge this decision replaces.
   * Present only for `correct` and `confirm` (the engine uses
   * it to find + remove the old row during atomic correction).
   * `null` for `add` / `keep` / `refuse`.
   */
  oldTargetId?: string;
  /**
   * The id of the OLD relationship object (used by
   * `applyDecisions` to look up the actual `GraphRelationship`
   * to remove). The session hands this in via the
   * `findExistingRel` dep; if absent, the engine derives it
   * from the graph.
   */
  oldRelId?: string;
  /**
   * Engine reason for logging / dry-run output. Pinned to the
   * exact value the production summary line emits. For
   * `keep` and `refuse` this is the refusal reason
   * (`no_node`, `ambiguous`, `non_callable`, `self_loop`,
   * `null_response`).
   */
  reason: string;
}

/**
 * The report returned by `reconcileDecisions`. The pipeline
 * summary line uses these counters; the dry-run report dumps
 * the `decisions` array.
 */
/**
 * Diagnostic-only mapped-vs-dropped tally (0-edge lever). Attributes a
 * 253s/0-edge run: probe never fired (probed≈0), every Location rebased
 * out-of-repo (outOfRepo dominant → path-mapping bug), every call external
 * (external dominant → benign), or LSP answered but no node covers the line
 * (dbMiss → index gap). Without this, all three look identical in the summary.
 */
export interface DropReasonTally {
  /** Location resolved to a graph node. */
  mapped: number;
  /** LSP returned no Location at all (empty answer). */
  noLocation: number;
  /** Multi-/zero-corroboration AMBIGUOUS refusal. */
  ambiguous: number;
  /** NO_NODE: external (stdlib / site-packages / mod-cache). */
  external: number;
  /** NO_NODE: containment guard refused (path rebased out-of-repo). */
  outOfRepo: number;
  /** NO_NODE: mapped to a repo path but no node covers the line. */
  dbMiss: number;
  /** NO_NODE: URI/line uninterpretable. */
  unmappable: number;
}

export interface ReconciliationReport {
  /** Every decision the engine made, in dispatch order. */
  decisions: Decision[];
  /** Count of `confirm` actions. */
  confirmed: number;
  /** Count of `correct` actions. */
  corrected: number;
  /** Count of `add` actions. */
  recall: number;
  /**
   * Count of `keep` AND `refuse` actions. The pipeline
   * surfaces this as the `refused` counter on the `lsp:`
   * summary line. (Previously two fields — `refused` and
   * `refusedTotal` — carried the same value; they have
   * been collapsed into one.)
   */
  refused: number;
  /** Number of candidates skipped by the cap. */
  skipped: number;
  /**
   * Count of candidates for which a `textDocument/definition` request
   * was actually issued (passed the `isUnindexablePath` pre-filter and
   * the `line`/`character` bounds gate). The engine receives this from
   * the pipeline via `ReconcileDecisionsDeps.probed`; `reconcileDecisions`
   * itself always returns 0 (the dispatch is the session's concern).
   * The pipeline builds `lspReport` by combining this value from the
   * `SessionMeta` the work-fn received.
   */
  probed: number;
  /**
   * Count of candidates skipped by the `isUnindexablePath` pre-filter
   * inside the dispatch loop. Distinct from `refused` (post-probe LSP
   * refusal) and from `skipped` (cap-trimmed). Always 0 when returned
   * by `reconcileDecisions` — populated by the pipeline from
   * `SessionMeta.preFilteredExternal`.
   */
  preFilteredExternal: number;
  /**
   * Diagnostic-only mapped-vs-dropped tally (0-edge lever). Populated by
   * `reconcileDecisions` from the per-candidate mapper results; surfaced on
   * the `lsp:` summary line so a 0-edge run is attributable. Optional so
   * legacy test-path report literals stay valid.
   */
  dropReasons?: DropReasonTally;
  /**
   * NOTE: The engine does NOT carry the LSP server version — the
   * session passes it through `SessionMeta` and the pipeline
   * surfaces it on the report externally (see `pipeline.ts:702`).
   * Including it here would have required the engine to either
   * thread it through `ReconcileDecisionsDeps` or fake a default
   * ('') that masked the real source. The pipeline already has
   * the authoritative value; do not re-introduce this field.
   */
}

/**
 * The dependency bag for the engine.
 *
 * `mapLocationToNodeId` is REQUIRED — every caller must inject
 * the location→nodeId resolver (production wires the real mapper
 * with the in-memory adapter; tests inject a fake). The previous
 * default silently hit the live DB on the read-only path, which
 * is a hidden coupling the engine refuses to carry. If you are
 * a new caller, pass an explicit `mapLocationToNodeId` — the
 * pipeline always has one ready (it threads the in-memory
 * adapter it built for the session).
 */
export interface ReconcileDecisionsDeps {
  /**
   * Map a single `Location` to a `MapperResult`. REQUIRED —
   * the engine has no default. Production wires the real
   * `mapLocationToNodeId` with the in-memory
   * `executeParameterized` adapter; tests inject a fake.
   */
  mapLocationToNodeId: (
    loc: Location,
    repoId: string,
  ) => Promise<MapperResult>;
  /**
   * Look up the existing `global`-tier edge from
   * `sourceId` → `oldTargetId` of the given `relType` in
   * the in-memory graph. Default: real scan of
   * `graph.relationships` filtered by `relType` (so a CALLS
   * row never matches a heritage candidate and vice
   * versa). Per security-2 (polish BLOCKER): `relType`
   * became a parameter when heritage candidates began
   * using the same `(sourceId, oldTargetId)` pair shape as
   * CALLS — the dependency was widened to filter
   * cross-type. Caller-supplied overrides MUST honor
   * `relType` (the default does; tests that pin CALLS
   * behavior should ignore the new arg).
   */
  findExistingRel?: (
    graph: KnowledgeGraph,
    sourceId: string,
    oldTargetId: string,
    relType: string,
  ) => GraphRelationship | undefined;
  /**
   * Override the callable-label set (KD-3). Default: the
   * production set imported from `call-processor.ts`.
   */
  callableLabels?: ReadonlySet<string>;
  /**
   * The repo id used by the mapper (signature parity with
   * `mapLocationToNodeId`). Default: `'default'` (the
   * pipeline supplies a real value at WI-5).
   */
  repoId?: string;
  /**
   * Number of candidates the cap rejected. The engine doesn't
   * compute it (the session owns the cap); the pipeline threads
   * the session's real `feed.length - selected.length` value
   * through here so the report surfaces a truthful count. Default:
   * 0 (tests that don't care pass nothing).
   */
  skipped?: number;
}

/**
 * The options bag for `applyDecisions`. `dryRun: true` skips
 * every mutation (per-edge + collapse) but still returns the
 * full `Decision[]` for the report.
 */
export interface ApplyDecisionsOptions {
  dryRun?: boolean;
  /**
   * Roadmap lever 2: confidence to stamp on `lsp-recall` edges. The
   * structural recall audit found single-method recall is ~100% reliable
   * on Go/Java but only 65.5% (TS) / 28.6% (Python); the language adapter
   * supplies a per-language value so weak-recall languages sit below the
   * 0.85 WILL_BREAK impact floor. Defaults to `LSP_RECALL_CONFIDENCE`
   * (0.90) when omitted, preserving prior behavior.
   */
  recallConfidence?: number;
}

/**
 * The return value of `applyDecisions`. Reports the actual
 * mutation count (so the test suite can pin the dry-run
 * invariant) and the duplicate row count the collapse
 * resolved.
 */
export interface ApplyResult {
  /** The decisions that were applied (a copy of the input). */
  decisions: Decision[];
  /** Number of `addRelationship` calls the engine issued. */
  added: number;
  /** Number of `removeRelationship` calls the engine issued. */
  removed: number;
  /** Number of duplicate `(from,to,type)` rows the collapse deleted. */
  collapsed: number;
  /** True when `dryRun` was set; the test suite pins this. */
  dryRun: boolean;
}

// ─── WI-4b decision table (pure) ──────────────────────────────────────

/**
 * P1∧P2 gate + decision table — the SPEC-DEFINING function of
 * the engine. Pure: takes the candidate, the LSP verdict
 * (mapped to a nodeId or refused), and an optional existing
 * edge; returns a `Decision`. No graph writes; no I/O.
 *
 *   P1: the LSP verdict MUST resolve to a single graph node
 *       (`MapperResult.kind === 'node'`). NO_NODE / AMBIGUOUS
 *       are explicit refusals.
 *   P2: the resolved node's label MUST be in
 *       `CALLABLE_SYMBOL_TYPES` (KD-3). A type-position
 *       `definition` that hits a `Class` is refused — it
 *       must never mint a CALLS→Class edge.
 *
 * The table is in `docs/designs/159-lsp-mode-a-calls.md`:
 *
 *   | Heuristic state | LSP verdict            | Action   |
 *   |-----------------|------------------------|----------|
 *   | global-0.50→A   | callable B==A          | confirm  |
 *   | global-0.50→A   | callable B≠A           | correct  |
 *   | global-0.50→A   | NO_NODE/AMBIGUOUS/null | keep     |
 *   |                 |   /non-callable        |          |
 *   | no edge         | callable B (B≠source)  | add      |
 *   | no edge         | NO_NODE/AMBIGUOUS/null | refuse   |
 *   |                 |   /non-callable/self   |          |
 *
 * The `kind` of `MapperResult` plus the candidate's
 * `oldTargetId` plus the resolved `targetLabel` are the three
 * inputs that drive the table.
 */
export function decideForCandidate(
  candidate: Candidate,
  mapper: MapperResult,
  deps: {
    existingRel?: GraphRelationship;
    callableLabels: ReadonlySet<string>;
    targetLabel?: string | null;
    /**
     * Roadmap lever 1: the resolved target node's name. When provided
     * (non-empty), a `lsp-recall` `add` is refused unless the call-site
     * token (`candidate.calledName`) corroborates it — defusing the
     * single-method over-trust the recall audit found on TS/Python.
     * Undefined/null/empty ⇒ gate skipped (unknown ≠ refuted), so every
     * existing caller that omits it stays byte-identical.
     */
    targetName?: string | null;
  },
): Decision {
  const from = candidate.sourceId;

  // ── Short-circuit: LSP refused outright (no `Location` hit) ────────
  if (mapper.kind === 'NO_NODE') {
    return decideRefusalOrKeep(candidate, 'no_node', from, deps.existingRel);
  }
  if (mapper.kind === 'AMBIGUOUS') {
    return decideRefusalOrKeep(candidate, 'ambiguous', from, deps.existingRel);
  }

  // mapper.kind === 'node'
  const to = mapper.nodeId;

  // ── Self-loop guard (AC-5 / I-8 / EdgeCases self-loop row) ────────
  // A self-loop is technically a "callable B" hit — but it
  // means the callee resolved to the caller. Refuse: never
  // mint a node→itself edge.
  if (to === from) {
    return decideRefusalOrKeep(candidate, 'self_loop', from, deps.existingRel);
  }

  // ── P2: callee-label precondition (AC-4 / I-3 / KD-3) ─────────────
  // The mapper returned a node but we don't yet have its label.
  // We use the `existingRel` (if any) as the only label source
  // we can trust — a confirmed/corrected relationship carries
  // the target's existing relationship to the caller, but the
  // label of the *target* node isn't on the relationship.
  //
  // For the `add` path (no existing rel), we need a separate
  // signal. The caller (the production dispatch) threads the
  // resolved node's label through `deps.existingRel`? — no, it
  // cannot. So the engine exposes a separate seam: the mapper
  // result may carry the label via the `__label` field. To
  // stay structurally compatible with `MapperResult`, we
  // accept the label through an optional second member of the
  // input via the `mapper` shape — but the real mapper does
  // NOT return the label.
  //
  // Resolution: the engine exposes an OPTIONAL
  // `targetLabel` parameter (resolved upstream by the adapter
  // through a second read against the in-memory node list).
  // For tests, the engine accepts a `labelHint` field on the
  // `decideForCandidate` second positional arg via a closure
  // seam.
  //
  // To keep the public surface narrow, the callee-label
  // precondition is enforced at a higher level: the
  // `reconcileDecisions` top-level function looks up the
  // resolved node's label from the in-memory node list and
  // refuses BEFORE calling `decideForCandidate`. The pure
  // `decideForCandidate` accepts an explicit `targetLabel`
  // through its `deps` (null = unknown; if known and not
  // callable, refuse).
  const targetLabel = deps.targetLabel ?? null;
  if (targetLabel !== null && !deps.callableLabels.has(targetLabel)) {
    return decideRefusalOrKeep(candidate, 'non_callable', from, deps.existingRel);
  }

  // ── P1 satisfied, P2 satisfied (or label unknown) ─────────────────
  // Now: does the candidate carry a heuristic edge?
  if (candidate.oldTargetId && deps.existingRel) {
    if (to === candidate.oldTargetId) {
      // LSP agreed with the heuristic.
      return {
        candidate,
        action: 'confirm',
        from,
        to,
        source: 'lsp-confirmed',
        oldTargetId: candidate.oldTargetId,
        oldRelId: deps.existingRel.id,
        reason: REASON_LSP_CONFIRMED,
      };
    }
    // LSP disagreed → atomic correction.
    return {
      candidate,
      action: 'correct',
      from,
      to,
      source: 'lsp-corrected',
      oldTargetId: candidate.oldTargetId,
      oldRelId: deps.existingRel.id,
      reason: REASON_LSP_CORRECTED,
    };
  }

  // ── No existing edge (recall path) ────────────────────────────────
  // P1∧P2 already enforced above. The candidate had no
  // heuristic edge → LSP found a new target → recall.
  //
  // Roadmap lever 1: name-corroboration gate. A recall edge rests on a
  // single `textDocument/definition` answer with nothing to corroborate
  // it. When we know the resolved target's name, require the call-site
  // token to corroborate it before minting — otherwise refuse (the
  // edge would clear the 0.85 WILL_BREAK impact floor on single-method
  // evidence the audit showed is only ~29-66% reliable on TS/Python).
  // `targetName` empty/absent ⇒ gate skipped (unknown ≠ refuted).
  if (deps.targetName && !namesCorroborate(candidate.calledName, deps.targetName)) {
    return makeRefuse(candidate, REASON_UNCORROBORATED_RECALL, from);
  }
  return {
    candidate,
    action: 'add',
    from,
    to,
    source: 'lsp-recall',
    reason: REASON_LSP_RECALL,
  };
}

/** Internal: a `keep` decision (heuristic stays; LSP refused). */
function makeKeep(
  candidate: Candidate,
  why: string,
  from: string,
  oldTargetId: string,
  existingRel: GraphRelationship | undefined,
): Decision {
  return {
    candidate,
    action: 'keep',
    from,
    to: null,
    source: null,
    oldTargetId,
    oldRelId: existingRel?.id,
    reason: why,
  };
}

/** Internal: a `refuse` decision (no heuristic edge + LSP refused). */
function makeRefuse(
  candidate: Candidate,
  why: string,
  from: string,
): Decision {
  return {
    candidate,
    action: 'refuse',
    from,
    to: null,
    source: null,
    reason: why,
  };
}

/**
 * Internal: dispatch a refusal-or-keep pair. The four short-circuit
 * branches in `decideForCandidate` (NO_NODE / AMBIGUOUS / self-loop /
 * non_callable) all reduce to the same shape: if the candidate has a
 * heuristic edge (`oldTargetId` set) it's a `keep`; otherwise a `refuse`.
 * The `why` string is test-pinned — it carries the precise refusal
 * reason (no_node | ambiguous | self_loop | non_callable).
 */
function decideRefusalOrKeep(
  candidate: Candidate,
  why: string,
  from: string,
  existingRel: GraphRelationship | undefined,
): Decision {
  return candidate.oldTargetId
    ? makeKeep(candidate, why, from, candidate.oldTargetId, existingRel)
    : makeRefuse(candidate, why, from);
}

/**
 * WI-2 / #159 — line-aware collapse key.
 *
 * `sourceId|targetId|type|line` (line suffixed). Edges without a
 * `line` (synthetic route/tool rows, heritage edges from sources
 * that did not capture a position, legacy emitters) collapse
 * byte-identically to the pre-WI-2 shape via the `''` suffix.
 * The collapse is therefore:
 *   - byte-identical for edges without a `line` (the `''` suffix
 *     is the new tail; there is no longer a `${type}`-only key,
 *     so a CALLS and an IMPLEMENTS edge for the same
 *     (sourceId, targetId) now sit in distinct buckets — this
 *     matches the WI-5 production design where heritage edges
 *     live in their own type and never collide with CALLS);
 *   - per-site distinct for edges WITH a `line` (`:L10` and `:L12`
 *     are two buckets, BOTH survive).
 */
function collapseKey(rel: GraphRelationship): string {
  return `${rel.sourceId}|${rel.targetId}|${rel.type}|${rel.line ?? ''}`;
}

// ─── WI-4b apply (mutator) ────────────────────────────────────────────

/**
 * Apply a batch of `Decision`s to the in-memory graph.
 *
 * Atomic-correction contract (KD-8 / I-4 / AC-5):
 *   1. The new relationship is BUILT (with a fresh id) BEFORE
 *      any mutation.
 *   2. `addRelationship(new)` runs first; if the graph
 *      refuses (e.g. duplicate id — defensive, shouldn't
 *      happen with `generateId`), the old edge is NOT
 *      removed. We never net-delete.
 *   3. `removeRelationship(oldRelId)` runs second.
 *   4. `confirm` and `add` are single-step mutations; `keep`
 *      and `refuse` are no-ops.
 *
 * After per-decision application, the final collapse runs
 * (one edge per `(from,to,type)`, conf-DESC → source-
 * precedence → id-ASC). The collapse NEVER removes an edge
 * unless a duplicate `(from,to,type)` exists; it keeps the
 * higher-confidence (and within ties, the higher-precedence
 * `source`) row.
 *
 * `dryRun: true` short-circuits every mutation step and
 * returns the `Decision[]` unchanged. The collapse is also
 * skipped (KD-11 / AC-6). The test suite pins both invariants.
 */
export function applyDecisions(
  graph: KnowledgeGraph,
  decisions: Decision[],
  options: ApplyDecisionsOptions = {},
): ApplyResult {
  const dryRun = options.dryRun === true;
  // Roadmap lever 2: per-language recall confidence (default 0.90).
  const recallConf = options.recallConfidence ?? LSP_RECALL_CONFIDENCE;
  let added = 0;
  let removed = 0;

  // m1: build the indexes ONLY when we are about to mutate.
  // dryRun skips both the per-decision pass and the collapse
  // — neither path uses the indexes, so building them in
  // dryRun is wasted work proportional to the graph size.
  // The previous code built them unconditionally, which
  // doubled the dryRun cost on a 10⁵-edge graph. The
  // per-decision path needs a lookup-by-id (O(n) without an
  // index); the collapse re-buckets every row by
  // (from,to,type) (also O(n) without an index). Both are
  // dominated by `decisions` length × graph size, so the
  // pre-pass turns them into O(decisions + graph).
  let byId: Map<string, GraphRelationship> = new Map();
  let byKey: Map<string, GraphRelationship[]> = new Map();
  if (!dryRun) {
    for (const rel of graph.iterRelationships()) {
      byId.set(rel.id, rel);
      const key = collapseKey(rel);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = [];
        byKey.set(key, bucket);
      }
      bucket.push(rel);
    }
  }

  if (!dryRun) {
    for (const d of decisions) {
      switch (d.action) {
        case 'add': {
          // The graph's `addRelationship` is a no-op on duplicate
          // id; the collapse reconciles the (from,to,type)
          // collision that would create. We always stamp the
          // new id into the in-memory indexes so the post-add
          // belt-and-braces lookup below stays O(1).
          const rel = makeLspRelationship(d, recallConf);
          graph.addRelationship(rel);
          addToIndex(byId, byKey, rel);
          added++;
          break;
        }
        case 'correct': {
          // Atomic correction. Order: add the new edge FIRST;
          // only remove the old edge if the add succeeded. The
          // add is "succeeded" if the graph records it — we
          // can't introspect that directly, so we use the
          // graph's lookup-by-id contract: a post-add lookup
          // that finds the new id means success.
          const newRel = makeLspRelationship(d, recallConf);
          // Belt-and-braces: a brand-new id from
          // `generateId` should never collide, but if the
          // graph's `addRelationship` ever no-ops on
          // duplicate id (a defensive future-proofing), the
          // pre-built `byId` index tells us. We must read
          // `byId` BEFORE the add — and the in-memory graph
          // would have refused the add, so `byId` still has
          // whatever was already there (which may include
          // the new id if it was a pre-existing duplicate).
          const wasPresent = byId.has(newRel.id);
          // AC-5 / KD-8 (never net-delete) is enforced
          // transactionally: the new edge is added to the
          // graph + indexes first, and ONLY if every step
          // succeeds do we touch the old edge. If any step
          // throws, the catch block below rolls the indexes
          // (and, when feasible, the graph) back to its
          // pre-add state so the relationship is not lost.
          let addCommitted = false;
          try {
            graph.addRelationship(newRel);
            addToIndex(byId, byKey, newRel);
            addCommitted = true;
          } catch {
            // The new edge could not be installed (e.g. the
            // graph rejected it on a duplicate id, or the
            // in-memory index helper threw). Best-effort
            // rollback: undo the index insertion if it ran,
            // and ask the graph to remove the new edge if
            // it was added. Either way, the old edge must
            // be untouched — AC-5 / KD-8: never net-delete.
            if (byId.has(newRel.id)) {
              removeFromIndex(byKey, newRel);
              byId.delete(newRel.id);
            }
            // `graph.addRelationship` is all-or-nothing in
            // the current backend (it either inserts the row
            // or throws before mutating), but we still issue
            // a defensive `removeRelationship` to handle a
            // future backend that buffers-then-commits. The
            // call is a no-op when the id was never inserted.
            try {
              graph.removeRelationship(newRel.id);
            } catch {
              /* noop — old edge is the safe default */
            }
            // Skip the remove-old branch below — the old
            // edge stays in place by construction.
            break;
          }
          // `addedOk` = the id WAS NOT in the pre-built
          // index (so the add was new, not a no-op
          // duplicate-id collision). The `addCommitted`
          // guard is the actual success check: it is only
          // true when `addRelationship` returned without
          // throwing. Belt-and-braces — if a future backend
          // buffers-then-throws after the in-memory index
          // was already touched, the catch above has already
          // rolled things back.
          const addedOk = addCommitted && !wasPresent;
          if (addedOk && d.oldRelId) {
            // Remove the old row from the indexes too —
            // otherwise the collapse at the end would see a
            // phantom entry and the byKey bucket would carry
            // a dead reference.
            const oldRel = byId.get(d.oldRelId);
            if (oldRel) {
              removeFromIndex(byKey, oldRel);
            }
            graph.removeRelationship(d.oldRelId);
            byId.delete(d.oldRelId);
            removed++;
            added++;
          }
          // If the add did NOT take (e.g. duplicate id from a
          // future refactor), we leave the old edge in place
          // — AC-5 / KD-8: never net-delete. The catch block
          // above is the transactional counterpart for the
          // throw path: it rolls back the new edge AND
          // preserves the old one.
          break;
        }
        case 'confirm': {
          // Re-stamp the existing edge in place. We remove +
          // re-add with the new `source` and confidence. The
          // id is preserved so the collapse key is stable.
          //
          // The `oldRelId` is typed `string | undefined` — the
          // `add` path explicitly omits it, so a confirm
          // decision without `oldRelId` is malformed (a
          // construct-time bug). Refuse rather than coerce
          // with `!` (which would silently call
          // `removeRelationship(undefined)` and crash the
          // graph). AC-5 / KD-8: never net-delete; refusing
          // leaves the heuristic edge untouched, which is the
          // safe default.
          if (!d.oldRelId) {
            // No-op: the heuristic edge stands as-is. The
            // caller can inspect `decisions[i].action` +
            // the absence of a mutation to detect this.
            break;
          }
          const existing = byId.get(d.oldRelId);
          if (!existing) break;
          removeFromIndex(byKey, existing);
          graph.removeRelationship(d.oldRelId);
          byId.delete(d.oldRelId);
          const restamped = {
            ...existing,
            confidence: LSP_CONFIDENCE,
            source: 'lsp-confirmed' as const,
          };
          graph.addRelationship(restamped);
          addToIndex(byId, byKey, restamped);
          removed++;
          added++;
          break;
        }
        case 'keep':
        case 'refuse':
          // No-op: LSP refused and the heuristic edge (if any)
          // stands as-is.
          break;
      }
    }
  }

  // ── Final collapse (one edge per (from,to,type)) ─────────────────
  // Skipped in dryRun. Group all current relationships by
  // the collapse key, then keep the winner of each group
  // (highest confidence, then best `source`, then lowest id)
  // and `removeRelationship` the rest. Reuses the
  // per-decision-pass `byKey` index to skip a second full
  // graph scan; falls back to a fresh scan if dryRun
  // skipped the index build.
  let collapsed = 0;
  if (!dryRun) {
    collapsed = collapseDuplicates(graph, byKey);
  }

  return { decisions, added, removed, collapsed, dryRun };
}

/**
 * Stamp a freshly-added relationship into the in-memory
 * indexes (`byId` for O(1) lookup; `byKey` for the collapse
 * pass). Mirrors the pre-pass at the top of `applyDecisions`.
 */
function addToIndex(
  byId: Map<string, GraphRelationship>,
  byKey: Map<string, GraphRelationship[]>,
  rel: GraphRelationship,
): void {
  byId.set(rel.id, rel);
  const key = collapseKey(rel);
  let bucket = byKey.get(key);
  if (!bucket) {
    bucket = [];
    byKey.set(key, bucket);
  }
  bucket.push(rel);
}

/**
 * Remove a relationship from the `byKey` collapse index. The
 * `byId` entry is removed by the caller (the helper leaves
 * that to the call site because the caller often wants to
 * check the lookup result first). When the bucket empties
 * the key is deleted so the final collapse doesn't iterate
 * a dead group.
 */
function removeFromIndex(
  byKey: Map<string, GraphRelationship[]>,
  rel: GraphRelationship,
): void {
  const key = collapseKey(rel);
  const bucket = byKey.get(key);
  if (!bucket) return;
  const idx = bucket.indexOf(rel);
  if (idx >= 0) bucket.splice(idx, 1);
  if (bucket.length === 0) byKey.delete(key);
}

/**
 * Build the canonical `GraphRelationship` object for an
 * `lsp-*` decision. The id is generated by the same call the
 * indexer uses (`generateId`) so the id shape matches the
 * `Label:filePath:name[:overloadIndex]` form the rest of the
 * graph expects.
 *
 * For CALLS edges, the `type` is hard-coded and the id is
 * `` `${from}->${to}` `` — byte-identical to PR #168
 * (438600e). The `:L${line}` suffix is a separate
 * dependency (WI-2 / line-aware reconciler) and is NOT
 * applied here so this WI is independently landable.
 *
 * For heritage edges (WI-5), the type and id prefix follow
 * `d.candidate.relType` — IMPLEMENTS / EXTENDS — and the
 * id is `IMPLEMENTS:${from}->${to}` / `EXTENDS:${from}->${to}`,
 * byte-identical to the heuristic template minted at
 * `heritage-processor.ts:403` (format-consistent).
 */
function makeLspRelationship(
  d: Decision,
  recallConfidence: number = LSP_RECALL_CONFIDENCE,
): GraphRelationship {
  if (d.to === null) {
    throw new Error(`makeLspRelationship: 'to' is null for action=${d.action}`);
  }
  // WI-5: heritage edges carry their own relType; CALLS is
  // the default when no relType is set on the candidate.
  // The `type` value flows into the generateId prefix AND
  // the relationship's `type` field — they MUST match the
  // heuristic pipeline's shape for the collapse to behave
  // correctly on collisions (a CALLS and an IMPLEMENTS
  // edge for the same (from,to) pair are distinct
  // collapse-keys and will both survive).
  const relType = d.candidate.relType ?? 'CALLS';
  // WI-2 / #159: line-aware id for CALLS. The reconciler
  // mints the same `:L${line}` shape the heuristic uses
  // (call-processor.ts:668/:1537) so confirm/correct edges
  // carry the line suffix and the per-site multiplicity
  // survives the collapse. Heritage edges do NOT get the
  // suffix — they keep the byte-identical
  // `${from}->${to}` template from PR #168 (their `line`
  // is the parent-identifier position, semantically
  // distinct, and the heritage-processor.ts:403 template
  // has no suffix). Position-less CALLS candidates (no
  // `line` on the candidate) get `:L0` — collapse-safe
  // with other L0 edges, distinct from any L>0 edge.
  const idPayload =
    relType === 'CALLS' && typeof d.candidate.line === 'number'
      ? `${d.from}->${d.to}:L${d.candidate.line}`
      : `${d.from}->${d.to}`;
  return {
    // Id is the canonical (Type, payload) tuple — the
    // heritage template (`IMPLEMENTS:${from}->${to}`)
    // matches the heuristic processor's output
    // (`heritage-processor.ts:403`); the CALLS template
    // preserves the heuristic `:L` shape (call-processor.ts
    // :668/:1537).
    id: generateId(relType, idPayload),
    sourceId: d.from,
    targetId: d.to,
    type: relType,
    // ③ promotion split: corrected edges carry the promoted 0.90
    // (call-site definition evidence replacing a wrong heuristic);
    // recall edges stay at 0.70 (one-legged evidence — see the
    // LSP_RECALL_CONFIDENCE doc block).
    confidence:
      d.source === 'lsp-recall' ? recallConfidence : LSP_CONFIDENCE,
    reason: d.reason,
    source: d.source ?? 'heuristic',
    line: d.candidate.line,
    // #174: thread call-site column through so LSP-minted edges carry the
    // same position data as heuristic edges. The candidate's `character`
    // field (0-based LSP column) is already threaded from the parse-worker
    // via the correction feed in call-processor.ts.
    column: d.candidate.character,
  };
}

/**
 * Collapse duplicate `(from,to,type)` rows to one. Keeps the
 * winner (highest confidence, then best `source` precedence,
 * then lowest id) and `removeRelationship`s the rest.
 *
 * Source precedence (best→worst): lsp-corrected > lsp-recall >
 * lsp-confirmed > heuristic. The reasoning:
 *   - `lsp-corrected` is the most-specific LSP verdict (LSP
 *     looked at the call site and disagreed with the
 *     heuristic — that disagreement carries information the
 *     other rows lack).
 *   - `lsp-recall` is a fresh LSP-augmented edge.
 *   - `lsp-confirmed` is a re-stamp of the heuristic.
 *   - `heuristic` is the baseline.
 *
 * When the caller already has a `(from,to,type)` index (the
 * `applyDecisions` hot path), it can pass it in via
 * `prebuiltByKey` to skip the second full graph scan.
 * Otherwise the function builds its own.
 *
 * Returns the number of duplicate rows removed.
 */
function collapseDuplicates(
  graph: KnowledgeGraph,
  prebuiltByKey?: Map<string, GraphRelationship[]>,
): number {
  // Bucket: "from|to|type|line" → GraphRelationship[].
  // WI-2 / #159: the key now embeds the per-site `line` so
  // two same-name CALLS edges (`:L10`, `:L12`) end up in
  // distinct buckets and BOTH survive the collapse. Edges
  // without a `line` (synthetic route/tool rows) keep the
  // old byte-identical key shape via `''` (empty suffix).
  const groups = prebuiltByKey ?? new Map<string, GraphRelationship[]>();
  if (!prebuiltByKey) {
    for (const rel of graph.iterRelationships()) {
      const key = collapseKey(rel);
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(rel);
    }
  }
  let removed = 0;
  for (const bucket of groups.values()) {
    if (bucket.length <= 1) continue;
    // Sort: keep[0] is the winner.
    bucket.sort(compareForCollapse);
    const winner = bucket[0];
    for (let i = 1; i < bucket.length; i++) {
      graph.removeRelationship(bucket[i].id);
      removed++;
    }
    // `winner` is the survivor; nothing to do.
    void winner;
  }
  return removed;
}

/**
 * Sort order for the collapse (best→worst). Conf-DESC first;
 * on confidence tie, source-precedence best→worst; final tie-
 * break is `id` ASC for determinism.
 */
function compareForCollapse(a: GraphRelationship, b: GraphRelationship): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const sa = sourcePrecedence(a.source ?? 'heuristic');
  const sb = sourcePrecedence(b.source ?? 'heuristic');
  if (sa !== sb) return sb - sa; // higher precedence first
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Source precedence: higher = wins. */
function sourcePrecedence(s: string): number {
  switch (s) {
    case 'lsp-corrected':
      return 4;
    case 'lsp-recall':
      return 3;
    case 'lsp-confirmed':
      return 2;
    case 'heuristic':
    default:
      return 1;
  }
}

// ─── WI-4b top-level reconcileDecisions ────────────────────────────────

/**
 * The production dispatch. Given a graph, the candidate feed,
 * the per-candidate `Location[]` payloads (already normalized
 * by the session), and an optional dep bag, returns a
 * `ReconciliationReport`. The `applyDecisions` step is
 * controlled by the dep bag (the pipeline wires `dryRun` from
 * `PipelineOptions.lspDryRun`).
 *
 * Step-by-step:
 *   1. For each candidate, iterate the `Location[]`; the
 *      first non-`NO_NODE` / non-`AMBIGUOUS` hit wins.
 *      (Multi-Location → first single-resolution; otherwise
 *      AMBIGUOUS.) This is the same multi-Location handling
 *      mode-c uses (refuse over guess).
 *   2. Look up the resolved node's label from the in-memory
 *      node list (the engine cannot query the DB; the label
 *      gate is enforced by a synchronous closure over the
 *      in-memory node set).
 *   3. Run `decideForCandidate` to produce a `Decision`.
 *   4. Run `applyDecisions` (skipped entirely in dryRun).
 *   5. Aggregate counts.
 *
 * Multi-Location handling: a `Location[]` of > 1 entries
 * means LSP returned a multi-candidate answer (e.g. overload
 * set). For Mode A we treat this as AMBIGUOUS at the LSP
 * layer (matching mode-c's policy) — we never pick one of the
 * multiple targets, and we never guess.
 */
export async function reconcileDecisions(
  graph: KnowledgeGraph,
  candidates: Candidate[],
  locations: Map<string, Location[]>,
  deps: ReconcileDecisionsDeps,
): Promise<ReconciliationReport> {
  const callableLabels = deps.callableLabels ?? CALLABLE_SYMBOL_TYPES;
  const mapFn = deps.mapLocationToNodeId;
  const findExisting = deps.findExistingRel ?? defaultFindExistingRel;
  const repoId = deps.repoId ?? 'default';
  const skipped = deps.skipped ?? 0;
  const decisions: Decision[] = [];

  // P1 (perf): build a `Map<\`${sourceId}|${oldTargetId}\`,
  // GraphRelationship>` ONCE from the in-memory graph when
  // the default `findExistingRel` is in play. The pre-P1
  // code hit `defaultFindExistingRel` (O(n) per candidate)
  // for every candidate with `oldTargetId` set; with
  // cap=2000 and a graph of ~10⁵ edges, that was up to
  // 200M comparisons per dispatch. The index turns the
  // lookup into O(1) per candidate after the O(graph) build.
  // When the caller supplies a custom `findExistingRel`
  // (the test bag may), the index is not built — the test
  // owns its lookup performance.
  const useIndexedLookup = deps.findExistingRel === undefined;
  const relIndex: Map<string, GraphRelationship> = useIndexedLookup
    ? buildExistingRelIndex(graph)
    : new Map();
  // WI-2 / #159: secondary `oldRelId → GraphRelationship`
  // index used for site-precise lookup. Built from the
  // SAME scan — the line-aware `:L` suffix on
  // heuristic/minted ids makes the (sourceId, targetId)
  // pair ambiguous when duplicate call sites exist; the
  // exact id stored in the correction feed is the only
  // way to target the right row. Belt-and-braces beneath
  // the WI-5 type-keyed pair index: the pair index picks
  // a representative (last-writer-wins), the id index
  // picks the exact one.
  const relIdIndex: Map<string, GraphRelationship> = useIndexedLookup
    ? buildRelIdIndex(graph)
    : new Map();

  // 0-edge diagnostic: tally how each candidate's Location resolved.
  const dropReasons: DropReasonTally = {
    mapped: 0,
    noLocation: 0,
    ambiguous: 0,
    external: 0,
    outOfRepo: 0,
    dbMiss: 0,
    unmappable: 0,
  };

  for (const candidate of candidates) {
    const locs = locations.get(candidateLocationKey(candidate)) ?? [];

    let mapperResult: MapperResult;
    if (locs.length === 0) {
      mapperResult = { kind: 'NO_NODE' };
    } else if (locs.length > 1) {
      // Roadmap lever 9: name-aware disambiguation. Rather than blanket-
      // refusing every multi-Location answer as AMBIGUOUS (which drops
      // legitimate overload / multi-target sites), map each Location and
      // keep only targets whose name corroborates the call-site token
      // (reusing lever 1's `namesCorroborate`). Exactly one DISTINCT
      // corroborating node resolves the candidate; 0 or >1 stay AMBIGUOUS
      // (refuse over guess). Locations that point at the same node count
      // once.
      const mappedIds: string[] = [];
      for (const loc of locs) {
        try {
          const r = await mapFn(loc, repoId);
          if (r.kind === 'node') mappedIds.push(r.nodeId);
        } catch {
          /* skip a throwing Location */
        }
      }
      const corroborated = new Set(
        mappedIds.filter((id) => {
          const nm = graph.getNode(id)?.properties?.name;
          return typeof nm === 'string' && namesCorroborate(candidate.calledName, nm);
        }),
      );
      mapperResult =
        corroborated.size === 1
          ? { kind: 'node', nodeId: [...corroborated][0] }
          : { kind: 'AMBIGUOUS' };
    } else {
      try {
        mapperResult = await mapFn(locs[0], repoId);
      } catch {
        // Defensive: a mapper throw is a refusal.
        mapperResult = { kind: 'NO_NODE' };
      }
    }

    // 0-edge diagnostic: bucket this candidate's resolution.
    if (locs.length === 0) {
      dropReasons.noLocation++;
    } else if (mapperResult.kind === 'node') {
      dropReasons.mapped++;
    } else if (mapperResult.kind === 'AMBIGUOUS') {
      dropReasons.ambiguous++;
    } else {
      switch (mapperResult.dropReason) {
        case 'external':
          dropReasons.external++;
          break;
        case 'out-of-repo':
          dropReasons.outOfRepo++;
          break;
        case 'unmappable':
          dropReasons.unmappable++;
          break;
        default:
          // 'db-miss' or untagged NO_NODE.
          dropReasons.dbMiss++;
      }
    }

    // Look up the resolved node's label (P2 gate). The
    // engine cannot query the DB; the label is fetched from
    // the in-memory node list through the graph's node map.
    let targetLabel: string | null = null;
    // Roadmap lever 1: also surface the resolved node's NAME so the
    // recall path can corroborate it against the call-site token.
    let targetName: string | null = null;
    if (mapperResult.kind === 'node') {
      const node = graph.getNode(mapperResult.nodeId);
      targetLabel = node ? node.label : null;
      const nm = node?.properties?.name;
      targetName = typeof nm === 'string' && nm ? nm : null;
    }

    // Look up the existing edge (for confirm/correct paths).
    // WI-2 / #159: prefer the direct `oldRelId` lookup when
    // the correction feed carried the exact heuristic id
    // (CALLS correction / heritage correction). This is the
    // ONLY way to target a specific per-site edge when two
    // same-name CALLS edges share the same (sourceId,
    // targetId) pair. Per security-2 (polish BLOCKER):
    //   - If `oldRelId` is present and the direct index
    //     misses, do NOT fall through to the pair index or
    //     to `findExistingRel`. The `oldRelId` is the
    //     site-precise id; a miss means the row is gone
    //     (delete/rename upstream) and falling through
    //     could match a row that has the same
    //     (sourceId, oldTargetId) pair but a different id
    //     (e.g. a CALLS row instead of the IMPLEMENTS row
    //     the candidate targets) — `applyDecisions` would
    //     then `removeRelationship` the wrong edge.
    //     Refuse over guess; the engine emits `keep` (or
    //     `add` if there is no heuristic row).
    //   - When `oldRelId` is absent, the type-keyed pair
    //     index (WI-5) is the correct fallback — it cannot
    //     cross a relType boundary because the key includes
    //     `|${relType}`.
    //   - The `findExistingRel` dep (callers' escape hatch)
    //     MUST also filter by `relType` to avoid the same
    //     cross-type pickup; `defaultFindExistingRel`
    //     below does so as defense-in-depth.
    let existingRel: GraphRelationship | undefined;
    if (candidate.oldTargetId) {
      if (candidate.oldRelId && useIndexedLookup) {
        existingRel = relIdIndex.get(candidate.oldRelId);
        // Do not fall through on a miss — see comment above.
      } else if (!candidate.oldRelId) {
        // No `oldRelId`: use the type-keyed pair index (or
        // the caller's `findExistingRel` for the test bag).
        existingRel = useIndexedLookup
          ? relIndex.get(`${candidate.sourceId}|${candidate.oldTargetId}|${candidate.relType ?? 'CALLS'}`)
          : findExisting(graph, candidate.sourceId, candidate.oldTargetId, candidate.relType ?? 'CALLS');
      }
      // else: `oldRelId` was provided but the index
      // missed — refuse. `existingRel` stays `undefined`.
    }

    // WI-5: per-candidate label gate. The decision table
    // reads `deps.callableLabels` — that is the field that
    // decides whether a `Class` / `Interface` hit is
    // refused. The CALLS path uses the production set
    // (or whatever the caller supplied via
    // `deps.callableLabels`); a heritage candidate uses the
    // per-`relType` set from `HERITAGE_TARGET_LABELS`. The
    // pure `decideForCandidate` body is UNCHANGED — the
    // `non_callable` refusal reason string is the same, so
    // every test that pins it stays green.
    const labelGate = candidate.relType
      ? HERITAGE_TARGET_LABELS[candidate.relType]
      : callableLabels;
    const decision = decideForCandidate(candidate, mapperResult, {
      existingRel,
      callableLabels: labelGate,
      targetLabel,
      targetName,
    });
    decisions.push(decision);
  }

  // Derive counts in a single pass from the decisions array.
  // Every action maps to exactly one report counter; the
  // type union is closed so a missing branch would be a
  // compile error.
  const counts: Record<DecisionAction, number> = {
    confirm: 0,
    correct: 0,
    add: 0,
    keep: 0,
    refuse: 0,
  };
  for (const d of decisions) counts[d.action]++;

  return {
    decisions,
    confirmed: counts.confirm,
    corrected: counts.correct,
    recall: counts.add,
    refused: counts.keep + counts.refuse,
    // Cap-skip is the session's concern; the pipeline
    // threads the real count (feed.length − selected.length)
    // through `deps.skipped`. The engine never infers it.
    skipped,
    // WI-5: `reconcileDecisions` does NOT perform the dispatch —
    // probed/preFilteredExternal are always 0 here. The pipeline
    // populates these from `SessionMeta` (returned by the work-fn)
    // when assembling the final `lspReport`.
    probed: 0,
    preFilteredExternal: 0,
    dropReasons,
  };
}

/**
 * Default `findExistingRel` — O(n) scan of the in-memory
 * graph, filtered by `relType`. Kept as the externally-
 * overrideable seam (the `findExistingRel` dep) so callers
 * (mostly tests) can pin their own behavior; the
 * production hot path uses the `relIndex` built in
 * `reconcileDecisions` instead.
 *
 * Per security-2 (polish BLOCKER): the `relType` filter is
 * defense-in-depth — the `relIndex` and `relIdIndex` paths
 * never reach this function in production (the lookup
 * chain in `reconcileDecisions` short-circuits on
 * `oldRelId` misses and uses the type-keyed pair index
 * otherwise). But the test bag (and any future caller
 * supplying `findExistingRel` without using the indexes)
 * can still hit this function, and a CALLS row sharing
 * `(sourceId, oldTargetId)` with a heritage candidate
 * would be a graph-poisoning cross-type pickup. Filter
 * by `relType` to refuse that.
 */
function defaultFindExistingRel(
  graph: KnowledgeGraph,
  sourceId: string,
  oldTargetId: string,
  relType: string,
): GraphRelationship | undefined {
  for (const rel of graph.iterRelationships()) {
    if (
      rel.sourceId === sourceId &&
      rel.targetId === oldTargetId &&
      rel.type === relType
    ) {
      return rel;
    }
  }
  return undefined;
}

/**
 * P1 helper: build the `sourceId|oldTargetId|type → GraphRelationship`
 * index used by the default `findExistingRel` lookup.
 *
 * The `|${type}` segment (WI-5) is belt-and-braces beneath the
 * WI-2 `oldRelId` direct lookup: it ensures the index cannot
 * return a CALLS edge when the candidate is a heritage candidate
 * (or vice versa) even if a call site happens to share the same
 * `(sourceId, oldTargetId)` pair. The CALLS-only path is
 * unaffected — keys still uniquely identify a row.
 *
 * On collision (two edges for the same source→target→type
 * triple) the LAST one wins — the engine's confirm/correct
 * path only needs a representative relationship to attach
 * `oldRelId` to; the collapse pass at the end of
 * `applyDecisions` reconciles any duplicate (from,to,type)
 * rows. This matches the prior default behavior (first match
 * was the one found, but the O(n) scan returned the first;
 * the post-collapse dedupe made the choice moot).
 */
function buildExistingRelIndex(
  graph: KnowledgeGraph,
): Map<string, GraphRelationship> {
  const index = new Map<string, GraphRelationship>();
  for (const rel of graph.iterRelationships()) {
    index.set(`${rel.sourceId}|${rel.targetId}|${rel.type}`, rel);
  }
  return index;
}

/**
 * WI-2 / #159 — site-precise `rel.id → GraphRelationship`
 * index. Used for `correct`/`confirm` when the correction
 * feed carried the exact heuristic edge id (the
 * `oldRelId` minted at call-processor.ts:668/:1537 with the
 * `:L${line}` suffix). The (sourceId, targetId) pair index
 * above returns the LAST relationship that matches the
 * pair — wrong-site when duplicate per-site edges exist.
 * The id index is the only path that targets the exact
 * row. Last-writer-wins on id collision is fine: the
 * `addRelationship` in `addRelationship`/`confirm`
 * already de-dups by id, so at most one row carries any
 * given id.
 */
function buildRelIdIndex(
  graph: KnowledgeGraph,
): Map<string, GraphRelationship> {
  const index = new Map<string, GraphRelationship>();
  for (const rel of graph.iterRelationships()) {
    index.set(rel.id, rel);
  }
  return index;
}

/**
 * The single canonical key for `Location[]` lookups in the
 * `reconcileDecisions` dispatch. Exported so the pipeline
 * (which builds the `locations` map from the session's
 * `handToEngine` seam) can use the SAME key shape — a
 * mismatch would silently drop every payload.
 *
 * Key shape: `sourceId|calledName|line|character` plus an
 * OPTIONAL `|${relType}` suffix ONLY when `c.relType` is set
 * (WI-5). CALLS candidates (the default path) produce
 * byte-identical keys to PR #168 — the `|${relType}` segment
 * is appended only for heritage candidates, never for CALLS.
 * `sourceId` and `calledName` cannot contain `|` in practice
 * (node ids are `Label:filePath:name` and the callee name
 * is a TS identifier), so the separator is safe.
 */
export function candidateLocationKey(c: Candidate): string {
  const base = `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`;
  return c.relType ? `${base}|${c.relType}` : base;
}

// ─── Re-exports for tests (extended) ─────────────────────────────────

/**
 * Internal helpers exposed for the unit test suite. The WI-4b
 * engine exports the decision table + apply step. Add to
 * this object only when a test needs to pin internal
 * behavior; do NOT export helpers just because they could be
 * useful.
 */
export const __engineTest__ = {
  // m2: only `collapseDuplicates` is consumed by the test
  // suite (see `mode-a-engine.test.ts` lines 622, 645, 672,
  // 682). The other internals are reachable through the
  // public surface (`decideForCandidate`,
  // `applyDecisions`, `reconcileDecisions`, etc.) — the
  // test bag should mirror actual consumer demand, not be
  // a kitchen-sink backdoor.
  collapseDuplicates,
  // Roadmap lever 6: budget partition between heritage and CALLS.
  partitionCandidatesByRelType,
};
