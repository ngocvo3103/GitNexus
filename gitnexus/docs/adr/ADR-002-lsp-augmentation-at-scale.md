# ADR-002: Scaling LSP Augmentation to Large Repos and Monorepos

**Status:** Proposed
**Date:** 2026-06-15
**Deciders:** repository maintainers, arch
**Context source:** all-language LSP benchmark (2026-06-15) on real TCBS bond-trading repos + scout audit of the Mode-A engine.

---

## Context

GitNexus's Mode-A LSP augmentation works well on small/medium repos but **collapses on the user's real workload** — production services of 760–1490 Java files, with monorepos of millions of LOC on the horizon. The 2026-06-15 benchmark + a code audit pinned six root causes; the exact cap value differs across runs but the *shape* of every problem is verified in source.

| # | Problem | Evidence | Current design (file:line) |
|---|---|---|---|
| **P1** | **Premature readiness** (correctness) | `tcbs-bond-trading`: 30 s phase, 0.86 %, 57 k *instant* empty responses — reproduced byte-identically | jdtls `awaitReady` settles on `language/status` `ServiceReady` = **server-up, not index-complete**; Maven import/classpath indexing continues after (`language-adapter.ts:318`) |
| **P2** | **Wasted external probes** (efficiency) | 57,583 refusals = 57,583 wasted round-trips on one repo | Only `isUnindexablePath` pre-filter; external targets (jdt://, site-packages, cargo registry) are probed, then tagged `external:true` *after* the round-trip (`mode-a-reconciler.ts:654`, `location-mapper.ts:591`) |
| **P3** | **Serial probing** (throughput) | `tcbs-bond-trading-core`: 2,985 s for ~3 k probes ≈ 0.92 s/probe | pool=8 is bookkeeping only; `LspClient` serializes all requests through a one-in-flight promise chain (`lsp-client.ts:296`) |
| **P4** | **Value-blind cap** (coverage) | huge `skipped(cap)`; arbitrary slice augmented | cap = deterministic *prefix* after stable-sort by `(sourceId, calledName, line, character)` — no correlation to value (`mode-a-reconciler.ts:409,539`) |
| **P5** | **No incrementality** (steady state) | full re-probe every run | provenance (`source` column) persisted but never reused; no changed-files path (`pipeline.ts:307`, `analyze.ts:173`) |
| **P6** | **Per-call-site, not per-symbol** (redundancy) | 100 calls to `foo()` = 100 probes | no symbol-level definition memoization (`mode-a-reconciler.ts:705`) |

**The reframe that drives the decision:** the benchmark proved `corrected` ≈ 0 (the heuristic is rarely *wrong*), so *confirmation* of confident edges has low marginal value, and the bulk of candidates on real services are external-framework calls the LSP **correctly refuses**. The high-value LSP questions — **ambiguous internal calls** and **internal calls the heuristic missed (recall)** — are a small subset of the feed. The current engine spends ~100× of its budget on low/zero-value probes. **Scaling the brute force is the wrong goal; shrinking the question set is the right one.**

---

## Decision

Adopt a **tiered, evolutionary architecture**, sequenced so each phase is independently shippable and the cheapest, highest-leverage correctness/efficiency work lands first. Right-size to the *current* workload (single large repos) before building the monorepo tier; gate the expensive batch-indexing bet behind a spike.

- **Live-LSP, fixed** — for small / medium / large *single* repos (the user's typical world). Phases 0–3.
- **Batch index (SCIP/LSIF) + module decomposition** — for huge / monorepo (millions of LOC), where a per-query model is fundamentally infeasible. Phase 4, **spike-gated**.

### Phased roadmap

| Phase | Goal | Fixes | Size | Why this order |
|---|---|---|---|---|
| **0 — Correct & honest** | stop silently-wrong augmentation | P1 readiness (jdtls: wait for project-import/index-complete, not `ServiceReady`; per-adapter audit) · P4-lite: replace silent `skip(cap)` with a **budget + coverage report** (never silently drop) | **S** (days) | no point optimizing throughput of garbage; restores trust on every large repo |
| **1 — Shrink the question set** ⭐ | probe only high-value candidates | P2: **pre-filter provably-external callees** before probing (reuse the heuristic's import resolution) · P4: **value-prioritized ordering** (fan-in/out, ambiguity, critical-path) so the budget buys the best edges · target **ambiguous-internal + internal-recall**, skip confident-confirmations · P6: per-symbol definition memoization | **M** (1–2 wk) | **highest leverage** — collapses the 113 k feed to its few-k valuable core; makes everything downstream cheap |
| **2 — Make it fast** | 4–10× throughput | P3: **pipelined/multiplexed JSON-RPC** (bounded in-flight concurrency, deterministic result assembly) | **M** (2–3 wk) | once the feed is small *and* high-value, concurrency turns minutes into seconds |
| **3 — Scale over time** | steady-state cost ∝ change size | P5: **incremental augmentation** — persist a probe manifest (callsite-hash, commit); on re-analyze re-probe only changed files + dependents, reuse persisted `lsp-*` edges | **M–L** (3–4 wk) | the ongoing-use scaler; first index expensive, re-index cheap |
| **4 — Monorepo tier** | million-LOC tractable | **batch SCIP/LSIF** (`scip-java`/`scip-typescript`/`scip-go` + `rust-analyzer scip`) for the initial full index instead of N live probes · **module-aware decomposition** (per build-root LSP/index) | **L** (months) | **decision-gated**: a 1-wk spike on the largest monorepo measures SCIP index-time + coverage vs live-LSP before committing |

**Recommended commit now:** Phases **0 → 1 → 2** (they compound: correct → small → fast) and likely lift `tcbs-bond-trading` from 0.86 %/garbage to meaningful augmentation in bounded time. Then **3** for steady state. **Spike 4** to choose the monorepo strategy with data, not speculation.

---

## Options Considered

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A — Patch readiness only** | fix the jdtls `ServiceReady` bug, nothing else | tiny; fixes the headline symptom | large repos become *correct but still infeasibly slow* (P2/P3/P4/P5 untouched); monorepos still impossible |
| **B — Fix the live model** | Phases 0–3 | makes single large repos fast, correct, incremental; no new heavy toolchain | per-query model still has a ceiling; truly huge monorepos may remain impractical |
| **C — Batch SCIP wholesale** | replace live-LSP with SCIP indexers everywhere | scales to millions of LOC; complete xref | heavy per-language toolchains; loses live/incremental ergonomics on small repos; big up-front build before any value |
| **D — Tiered (chosen)** | B for single repos + spike-gated C for monorepos | right tool per scale; value lands incrementally; the expensive bet is data-gated | two code paths to maintain long-term; cross-tier consistency to manage |

**Chosen: D.** B alone leaves the monorepo case unsolved; C alone over-builds for the common case and delays all value. D delivers correctness + 10–100× efficiency for the *typical* repo immediately (Phases 0–2) while de-risking the monorepo bet with a spike before any heavy investment.

---

## Consequences

**Positive**
- Large single repos go from ~1 % silently-wrong augmentation to meaningful, bounded-time, *honestly-reported* coverage.
- The candidate-set reduction (Phase 1) is multiplicative with concurrency (Phase 2) and incrementality (Phase 3): a small, high-value feed, probed concurrently, only on what changed.
- Every phase is independently shippable and individually valuable; no big-bang.
- The monorepo decision is made with spike data, not a speculative months-long build.

**Negative / costs**
- Two resolution backends long-term (live-LSP + SCIP) if Phase 4 proceeds — cross-backend determinism and the byte-identical golden contract must hold across both.
- Incremental augmentation (P5) adds an invalidation-correctness burden (stale cache when a callee moves) — a classic incremental-compiler hazard; needs dependency-aware invalidation + a periodic full-rebuild safety net.
- Value-prioritized ordering (P4) changes which edges land first under a budget — the deterministic golden tests must pin the new ordering.

**Risks mitigated**
- Silent degradation on large repos (the current trap — looks like "LSP ran," actually ~1 %).
- Unbounded analyze time on big repos (budget + coverage reporting makes it predictable and honest).

---

## Fitness Functions

1. **No silent large-repo collapse.** On `tcbs-bond-trading` (the repro), post-Phase-0 the run must report coverage and not return 57 k instant empties from a half-indexed server. CI/benchmark gate.
2. **External-probe waste ≤ 5 %.** Post-Phase-1, `refused-external / total-probes` on a framework-heavy repo must drop from ~99 % toward ≤ 5 % (we stopped *asking* the external questions). Benchmark metric.
3. **Throughput.** Post-Phase-2, probes/second up ≥ 4× on a real repo; golden outputs remain byte-identical (determinism preserved).
4. **Incremental steady state.** Post-Phase-3, re-analyze after a 1-file change completes in seconds (≪ full-index time).
5. **Budget honesty.** Augmentation never silently drops candidates — coverage (`augmented X of N, prioritized by P`) is always surfaced in the funnel.
6. **Monorepo decision is data-backed.** Phase-4 gate: a written spike comparing SCIP index-time + coverage vs live-LSP on the largest available monorepo, before any backend build.

---

## Implementation notes (for the eventual plans)
- **Reuse-first:** P2's external pre-filter reuses the heuristic's existing import resolution (it already knows external vs internal); P5 reuses the persisted `source` provenance column and `analyze.ts`'s `lastCommit` check.
- **Determinism contract:** every change touching candidate ordering or concurrency must keep the mode-a golden byte-identity tests green (the I-9 invariant) — value-only updates, never coalesced.
- **Per-adapter readiness audit (Phase 0):** Go's `$/progress` "Setting up workspace" end is the closest-to-correct model; Rust's `serverStatus quiescent` is good; jdtls needs an index-complete signal (wait on `$/progress` "Importing…"/"Building…" end + a settle-until-stable canary); TS/Python no-op `awaitReady` is acceptable (fast servers) but should be re-validated on large repos.
- **Confirm the effective cap path** in the large-repo run (the reconciler default is 2 000 but the observed feed reached ~113 k) — the cap redesign (P4) supersedes it regardless.

---

## Phase 0 + Phase 1 Implementation Plan (adr002-java-large-repo-augmentation)

**Status:** Design-complete, pending implementation. Full plan: `docs/plans/adr002-p0-lsp-large-repo-readiness.md`. Prior plan: `docs/designs/adr002-p0-lsp-large-repo-readiness.md`.
**Scope:** P1 (jdtls readiness — settle-until-quiet) + P4-lite (coverage honesty) + P2-partial (external pre-filter). All other phases deferred.

### Spike outcome — settle-until-quiet (supersedes title-matching)

Spike executed 2026-06-15 against `tcbs-bond-trading` (760 files) with real jdtls at `/opt/homebrew/bin/jdtls`:
- `language/status` ServiceReady fires at ~3.5 s — server-up only.
- `$/progress` "Building…" tokens run 3.6–7.8 s; "Searching…" runs 7.8–19.3 s.
- Token titles are **generic and multi-instance** — AND-over-named-titles matching (R2-5) is fragile and environment-dependent.
- jdtls is **quiet after ~19.3 s** and canary textDocument/definition returns non-empty at that point.

**Decision:** Replace title-matching with **SETTLE-UNTIL-QUIET**: resolve ready when `$/progress` has been silent for a configurable quiet interval (5 s default) AND the canary returns non-empty. `JDTLS_IMPORT_PROGRESS_TITLES` is not needed; WI-0 spike gate is eliminated. Expected ready time: ~24–27 s — well under the 600 s deadline.

### Design

Phase 0 has two file-disjoint work-streams (A: jdtls readiness; B: coverage honesty). Phase 1 adds Work-stream C (external-callee pre-filter). All three land in one PR.

**Work-stream A — jdtls awaitReady — settle-until-quiet (P1)**

Root cause: `JAVA_ADAPTER.awaitReady` settles on `language/status ServiceReady`, which fires when jdtls's JVM is up (~3.5 s) but before Maven project import and classpath indexing finish (spike: ~19.3 s on `tcbs-bond-trading`). On `tcbs-bond-trading` this produced 0.86% augmentation and 57,583 instant refusals.

Fix:

Add `clientCapabilities: { window: { workDoneProgress: true } }` to `JAVA_ADAPTER`. This activates the `$/progress` seam (`progressTokenTitles` Map, `progressEndedTokens` Set, `onProgressEnd` subscriber) that already exists in `LspClient` (capability-gated) and is already used by `GO_ADAPTER`. `TS_SERVER_CAPABILITIES` is never touched (C0-2 / I-1 invariant).

The `awaitReady` body implements **settle-until-quiet**:

1. **Quiet-interval timer:** on each `$/progress` end event (via `ctx.onProgressEnd`), reset a `setTimeout` for the quiet interval (5 s). When the timer fires, run a canary probe; if non-empty, settle true immediately.
2. **Periodic self-rescheduling canary:** the quiet-interval callback is self-rescheduling — it does NOT fire only once at the hard deadline. Canary fires every quiet_interval/2 (2.5 s) independently as a liveness check so a server that emits zero `$/progress` events still gets probed periodically.
3. **No title matching required.** The `onProgressEnd` callback simply resets the quiet timer regardless of title; no `JDTLS_IMPORT_PROGRESS_TITLES` list.
4. Register a **no-op consumer** for `language/status` to consume-and-ignore ServiceReady — arrival MUST NOT settle `awaitReady`.
5. On deadline (`JDTLS_READY_DEADLINE_MS = 600_000`): settle false; dispose all handlers and timers. `awaitReady` never rejects.

Disposition of `language/status ServiceReady`: **removed entirely** as a settlement gate. ServiceReady fires before index-complete; keeping it as any fallback re-introduces the race.

Key constants:
- `JDTLS_READY_DEADLINE_MS = 600_000` (10 min) — exported named constant, overridable via `ctx.deadlineMs`. Differs from `GOPLS_READY_DEADLINE_MS = 30_000`.
- `JDTLS_QUIET_INTERVAL_MS = 5_000` — single fixed constant; unit tests pin it with fake timers.
- Canary reschedule interval = `JDTLS_QUIET_INTERVAL_MS / 2 = 2_500`.

`AdapterReadyCtx` comment annotations (currently "Go only") updated to reflect Java also populates the `$/progress` seam fields.

**Work-stream B — coverage honesty (P4-lite)**

Gaps: `SessionMeta` lacks `totalCandidates` (N before cap slice); `ReconciliationReport` lacks `probed` (true dispatch count, distinct from `selected.length`); the funnel line never reports N vs B; no `--lsp-budget` CLI flag; the funnel line is silent on gate-failure, error, dry-run, and `awaitReady=false` paths.

Fixes:
- Add `totalCandidates: number` to `SessionMeta` (captured as `sorted.length` before `sorted.slice(0, cap)`). Additive — no call-site breaks. Note: `totalCandidates >= cap` is FALSE when N < B (small repos) — do not assert it.
- Add `probed: number` to `ReconciliationReport` — count of candidates for which `textDocument/definition` was actually dispatched. P=0 on probe-refusal; P=selected.length on all-probed.
- Capture N (`dedupedCandidates.length`) and B (`options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP`) in pipeline scope BEFORE `withReconciliationSession` so they survive gate-failure and error paths.
- Extend the existing `pipeline.ts:962` line **in-place** (NOT a second line): `lsp: confirmed C, corrected X, recall +R, refused F, skipped S (budget B of N candidates)`.
- Emit the funnel line on dry-run, gate-failure (`sessionResult===null`), and error path before rethrow. On `awaitReady(false)` emit: `"LSP augmentation skipped: jdtls not ready after <deadline>s"`.
- Register `--lsp-budget <n>` on the analyze command in `src/cli/index.ts` (commander, NOT yargs; NOT `analyze.ts`). Three wiring edits required: (1) `budget?: number` on `PipelineOptions.lsp`; (2) `AnalyzeOptions.lspBudget → PipelineOptions.lsp.budget`; (3) `cap: options?.lsp?.budget` in the deps literal at `pipeline.ts:815`. Reject `--lsp-budget <= 0` at the commander action with a descriptive error (`0 ?? DEFAULT` does NOT coalesce on zero).

I-9 safety: these changes add fields and expand a log line. They do NOT touch `sortCandidates`, `candidateCompare`, or `sorted.slice(0, cap)`. Mode-A golden byte-identity tests are unaffected.

**Work-stream B — coverage honesty (P4-lite)**

Gaps: `ReconciliationReport` lacks `probed` (true dispatch count, distinct from `selected.length`); the funnel line never reports N vs B; no `--lsp-budget` CLI flag; the funnel line is silent on gate-failure, error, dry-run, and `awaitReady=false` paths.

Fixes:
- Add `probed: number` to `ReconciliationReport` — count of candidates for which `textDocument/definition` was actually dispatched. Incremented inside the `runWithConcurrency` dispatch loop (after `canSkipCandidate` check, not inside `fetchDefinitionForCandidate`). Defaults to 0 when no dispatch occurs.
- Add `preFilteredExternal: number` to `ReconciliationReport` — count of candidates skipped by the external pre-filter. Distinct from `refused`.
- Capture N (`dedupedCandidates.length`) and B (`options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP`) in pipeline scope BEFORE `withReconciliationSession` so they survive gate-failure and error paths.
- Extend the existing `pipeline.ts:962` line **in-place** (NOT a second line): `lsp: confirmed C, corrected X, recall +R, refused F, pre-filtered-external E, skipped S (budget B of N candidates)`.
- Emit the funnel line on dry-run, gate-failure (`sessionResult===null`), and error path before rethrow. On `awaitReady(false)` emit: `"LSP augmentation skipped: jdtls not ready after <deadline>s"`.
- Register `--lsp-budget <n>` on the analyze command in `src/cli/index.ts` (commander, NOT yargs; NOT `analyze.ts`). Three wiring edits required: (1) `budget?: number` on `PipelineOptions.lsp`; (2) `AnalyzeOptions.lspBudget → PipelineOptions.lsp.budget`; (3) `cap: options?.lsp?.budget` in the deps literal at `pipeline.ts:815`. Reject `--lsp-budget <= 0` at the commander action with a descriptive error (`0 ?? DEFAULT` does NOT coalesce on zero).

**Work-stream C — external-callee pre-filter (P2-partial)**

Before each `textDocument/definition` dispatch, classify the callee as PROVABLY EXTERNAL and skip (conservative: uncertain = probe, no false skips).

- Add optional `canSkipCandidate?: (candidate: Candidate) => boolean` to `WithReconciliationSessionDeps`. The dispatch loop in `withReconciliationSession` checks it per-candidate before `fetchDefinitionForCandidate`. When absent, default per-import classification runs.
- For **correction candidates**: check `oldTargetId` via `JAVA_ADAPTER.classifyUri` — `jdt://` prefix → `'external'` → skip. O(1) string prefix, conservative.
- For **recall candidates**: check whether the callee/receiver name binds to an external import. External classification uses `isUnindexablePath` on the resolved path (already gates `node_modules`/`.d.ts`/`dist`). For Java, where `namedImportMap` is empty (Java uses FQN imports, not named-binding extractor), the `jdt://`-based classifyUri path is not applicable at recall time — classify on candidate.file via `isUnindexablePath` only; uncertain = probe.
- Classify on `candidate.file` (raw, not realpath'd) per macOS symlink hazard (`location-mapper.ts:490–510`).
- The `canSkipCandidate` closure in `pipeline.ts` captures `lspAdapter.classifyUri` and `ctx.namedImportMap` — no new field on `WithReconciliationSessionDeps` for those (closure injection is cleaner and keeps the reconciler decoupled).

### Work Items

| WI | Title | Files | Size | Risk | Sequence |
|----|-------|-------|------|------|----------|
| WI-1 | Add `JDTLS_READY_DEADLINE_MS`, `JDTLS_QUIET_INTERVAL_MS` + `JAVA_ADAPTER.clientCapabilities` | `language-adapter.ts` | S | MEDIUM | First (WS-A foundation) |
| WI-2 | Replace `JAVA_ADAPTER.awaitReady` body — settle-until-quiet + no-op language/status | `language-adapter.ts` | M | MEDIUM | After WI-1 |
| WI-3 | Update `AdapterReadyCtx` JSDoc + stale "Go only" comments | `language-adapter.ts`, `lsp-client.ts` | S | LOW | After WI-1, parallel with WI-2 |
| WI-4 | Tests: rewrite ~29 Java `awaitReady` unit tests for settle-until-quiet; update C0-4, C0-10; update `java-jdtls-real.test.ts` AC-4 | `language-adapter-java.test.ts`, `language-adapter-java-canary-backstop.test.ts`, `language-adapter.test.ts`, `lsp-client.test.ts`, `java-jdtls-real.test.ts` | L | MEDIUM | After WI-2 + WI-3 |
| WI-5 | Add `ReconciliationReport.probed` + `ReconciliationReport.preFilteredExternal` + expand funnel line (all paths) | `mode-a-reconciler.ts`, `pipeline.ts` | S | LOW | Independent (WS-B) |
| WI-6 | Add `--lsp-budget` CLI flag + three threading edits | `src/cli/index.ts`, `analyze.ts`, `pipeline.ts` | S | LOW | After WI-5 |
| WI-7 | Tests: `--lsp-budget` wiring + funnel line format + I-9 golden non-regression | `mode-a-session.test.ts` | S | LOW | After WI-6 |
| WI-8 | Add `canSkipCandidate` seam + external pre-filter default impl | `mode-a-reconciler.ts`, `pipeline.ts` | M | MEDIUM | After WI-5 (WS-C) |
| WI-9 | Tests: pre-filter unit tests (correction jdt:// skip; recall isUnindexablePath skip; uncertain = probe; canary symlink safety) | new test file under `test/unit/lsp/` | M | LOW | After WI-8 |
| WI-VER | Verification: full suite gate + real-binary E2E (guarded) | full vitest suite, real jdtls (opt-in) | — | — | After all |

### Key Design Decisions (post-spike adjudication)

1. **Settle-until-quiet supersedes title-matching** — spike confirmed jdtls tokens are generic/multi-instance; `JDTLS_IMPORT_PROGRESS_TITLES` eliminated. WI-0 gate removed. Expected ready: ~24 s on `tcbs-bond-trading` (well under 600 s deadline).
2. **`ServiceReady` removed entirely** — no dual-signal, no fast-path fallback. ServiceReady fires before index-complete; keeping it re-introduces the race on every large repo.
3. **Periodic self-rescheduling canary** — canary fires every `JDTLS_QUIET_INTERVAL_MS / 2` (2.5 s) independently of `$/progress` events so a never-progressing server settles false in bounded time, not after a full 600 s wait.
4. **`--lsp-budget` via commander in `src/cli/index.ts`** — codebase uses commander, not yargs. Three explicit threading edits required or the flag is a silent no-op.
5. **Single funnel line extended in-place** — the existing `pipeline.ts:962` line already prints skipped; a second line would double-report. Only N, B, and pre-filtered-external are new signal; appended in-place.
6. **Funnel emitted on ALL paths** — gate-failure, error before rethrow, dry-run, and `awaitReady(false)`. N and B captured in pipeline scope before `withReconciliationSession` so they survive a null result.
7. **Conservative external pre-filter** — uncertain = probe; false skips of internal candidates are prohibited. Java recall candidates use `isUnindexablePath` (not namedImportMap, which is empty for Java FQN imports).
8. **`canSkipCandidate` closure captures classifyUri** — no new typed field on `WithReconciliationSessionDeps` for `classifyUri`; pipeline.ts closure closes over `lspAdapter.classifyUri` directly, keeping the reconciler decoupled from adapter specifics.
9. **Validation thresholds** — smoke floors: augmented% ≥ 4.3% (5× baseline); instant-refusals ≤ 28,791 (50% baseline); `pre-filtered-external` high on `tcbs-bond-trading` (57 k recall vs external Spring/JDK targets); `bond-exception-handler` confirmed+recall ≥ baseline (66%). E2E gate is manual / opt-in CI.

### Fitness Functions (Phase 0 + Phase 1 specific)

1. `cd gitnexus && npm test` — all mode-a golden byte-identity tests pass with zero modification (I-9). Re-run with NO `--lsp-budget` flag as a positive test (WI-7).
2. `npx tsc --noEmit` — zero type errors.
3. Unit: settle-until-quiet resolves true after `JDTLS_QUIET_INTERVAL_MS` of `$/progress` silence AND non-empty canary; resolves false at `JDTLS_READY_DEADLINE_MS`.
4. Unit: `ServiceReady` notification does NOT settle `awaitReady` (negative AC).
5. Unit: periodic canary invoked ≥2× before deadline when no `$/progress` events arrive (fake timers, interval = `JDTLS_QUIET_INTERVAL_MS / 2`).
6. Unit: `--lsp-budget 0` or negative rejected with descriptive error; `--lsp-budget 500` with N=5000 → `selected.length === 500`.
7. Unit: funnel line emitted on gate-failure with `N > 0, P = 0, pre-filtered-external = 0`.
8. Unit: `canSkipCandidate` returning true increments `preFilteredExternal`; candidate is not dispatched.
9. Unit: uncertain classification returns false from `canSkipCandidate` → candidate is probed.
10. E2E (guarded): `awaitReady` resolves true at ~24 s (not at 3.5 s) on `tcbs-bond-trading`; augmented% ≥ 4.3%; `pre-filtered-external` high for Spring/JDK calls; `bond-exception-handler` confirmed+recall ≥ 66% baseline.
