# ADR-001: Rust Language Adapter (rust-analyzer) for LSP Augmentation Stack

**Status**: Proposed  
**Date**: 2026-06-14  
**Deciders**: arch, backend-dev, repository maintainers  
**Feature**: #159 — Rust/rust-analyzer LSP adapter

---

## Context

GitNexus's LSP augmentation pipeline resolves `textDocument/definition` edges for
TypeScript, Java, Python, and Go repositories. The adapter stack is a value-object
DI seam: one `LanguageAdapter` is selected per run by `selectAdapter()` (extension
census), injected into `LspClient`, and consumed polymorphically at every lifecycle
junction — binary spawn, `initialize` capabilities, post-`initialized` warm-up gate
(`awaitReady`), canary sampling, and URI classification.

Rust repositories are not currently detected or served. The `selectAdapter()` census
counts `.ts/.java/.py/.go` but no `.rs` files, so Rust-dominant repos fall through
to `null` (LSP funnel not entered). Adding Rust support requires wiring a fifth
adapter into the same DI seam without disturbing any existing adapter path.

The key design tension is `awaitReady`: rust-analyzer emits both
`experimental/serverStatus {quiescent:true, health:'ok'/'warning'}` (an extension
notification) and `$/progress` tokens (`"Indexing"`, `"Roots Scanned"`,
`"Building CrateGraph"`) during workspace load. Which signal(s) arrive, and in what
order relative to `initialized`, was a spike-only question — **resolved by WI-0
(executed 2026-06-14, rust-analyzer 1.95.0 vs ripgrep@82313cf)**: `experimental/serverStatus`
fires early (≈20 ms after spawn, `health:'ok'`) and is the authoritative readiness
signal; the `$/progress` tokens are phase markers with **no single load-complete
title**, so the `$/progress` arm is **dropped**. `awaitReady` is **serverStatus-only +
canary backstop**.

The critical architectural constraint: `experimental/serverStatus` fires EARLY during
rust-analyzer startup — before the `initialized` ACK. Registering the handler inside
`awaitReady` (which runs post-initialize at lsp-client.ts:893) guarantees the
notification is missed. This is the same bug class that the `$/progress` pre-registration
(lsp-client.ts:773-815) was designed to prevent (see comment at :766-768).

---

## Decision

Implement `RUST_ADAPTER` as a pure-additive value object mirroring `GO_ADAPTER`'s
structure. The `experimental/serverStatus` notification handler is registered
**PRE-initialize** in `LspClient.spawnAndInitialize`, capability-gated on
`clientCapabilities?.experimental?.serverStatusNotification`, buffering the last
`{quiescent, health}` payload into an additive `AdapterReadyCtx` seam
(`serverStatusLatest?` / `onServerStatus?`). `RUST_ADAPTER.awaitReady` reads this
seam — it never calls `connection.onNotification` directly for an inbound early signal.

This design makes `lsp-client.ts` a **d1 MODIFIED** file (additive seam fields +
PRE-initialize handler). The seam is architecturally analogous to the existing
`progressEndedTokens` / `onProgressEnd` pair.

**WI-0 (spike) was the blocking prerequisite** for the signal-path code; it is now
**DONE (2026-06-14)**. Confirmed outcomes: (a) `experimental/serverStatus` fires (early,
≈20 ms post-spawn), so it is the readiness signal; (b) there is **no reliable single
`$/progress` load-complete title** (only phase markers) → the `$/progress` arm is
**dropped** and `awaitReady` is **serverStatus-only + canary backstop**; (c) cold
quiescent ≈13–15 s, so `RUST_ANALYZER_READY_DEADLINE_MS = 60_000` is a safe ceiling and
the R2-7 timing gate (`< deadline/2`) passes; (d) `initializationOptions={}` resolves
`textDocument/definition` identically to `{buildScripts,procMacro}` (no delta) → `{}` kept.

Ready condition: `quiescent:true AND health ∈ {'ok', 'warning'}`.
Only `health:'error'` falls to canary backstop. (WI-0 observed `health:'ok'` exclusively
on ripgrep under both `{}` and `{buildScripts,procMacro}`; `'warning'` is accepted
defensively for build-script/proc-macro repos that may report it.)

**Zero-samples canary deviation**: when the canary backstop fires and zero `.rs`
samples are found in the workspace, `awaitReady` resolves `true` (no-op augmentation;
zero edges; no subprocess teardown). This is a deliberate deviation from `GO_ADAPTER`
(which resolves `false` on empty samples) and is documented in code.

All six file changes are purely additive. No existing adapter path is altered.

---

## Options Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A — Additive AdapterReadyCtx seam (chosen)** | Register `experimental/serverStatus` handler PRE-initialize in `LspClient.spawnAndInitialize` via additive seam fields (`serverStatusLatest?` / `onServerStatus?`); `awaitReady` reads the seam only. **WI-0 confirmed serverStatus-only** (no reliable `$/progress` title) + canary backstop | Captures early notification before `initialized` ACK; spike-confirmed signal; architecturally consistent with `progressEndedTokens`/`onProgressEnd` | `lsp-client.ts` must be modified (d1) |
| **B — `connection.onNotification` cast inside `awaitReady`** | Register the handler inside `awaitReady` using the `ctx.connection as MessageConnection` cast pattern (same as Java/Go adapters) | Less code; no lsp-client.ts change | **Architecturally broken**: `awaitReady` runs post-initialize (:893); `experimental/serverStatus` fires early during load; handler is registered too late and will always miss the notification. Go/Java casts are OUTBOUND `sendRequest`/`sendNotification` — not applicable to an inbound early signal. Produces a dead serverStatus arm. |
| **C — `$/progress` only (mirror Go exactly)** | Use `$/progress` with spike-confirmed Rust token titles; no serverStatus handler | Zero new code in `lsp-client.ts`; already-proven path | `$/progress` begin title is not spike-confirmed; ripgrep workspace may emit different titles; same miss risk if title wrong |
| **D — Canary-backstop-only (pre-spike default)** | Skip all signal registration; rely on deadline + canary backstop for every run | Simplest; no spike dependency for first landing | Guaranteed 60 s wait per run; cannot detect signal-path failure; AUGMENTATION_FLOOR floor=1 non-discriminating without signal-path timing proof |

**Chosen: Option A** — seam-based PRE-initialize handler is the only option that
can capture the early notification correctly. Option B is architecturally broken.
WI-0 (done) confirmed `experimental/serverStatus` fires early and reliably while no
single `$/progress` load-complete title exists, so the shipped `awaitReady` is
**serverStatus-only + canary backstop** (the `$/progress` arm of the original
dual-signal hedge is dropped). Option C/D are subsumed: the canary backstop remains
as the safety net behind the confirmed serverStatus signal.

---

## Consequences

**Positive**
- Rust-dominant repositories enter the LSP augmentation funnel without any changes
  to existing TypeScript/Java/Python/Go paths.
- `RUST_ADAPTER` is a plain object implementing the existing `LanguageAdapter`
  interface — additive seam only, no new lifecycle hook, no new config file.
- `target/` exclusion added to `EXCLUDED_DIRS` (canary-sampler.ts) — consistent with
  `censusExtensions` SKIP_DIRS; benefits Maven/Gradle canary walks as a side effect.
- `health:'warning'` treated as ready — `initializationOptions={}` (which disables
  build scripts/proc-macros and causes rust-analyzer to report warning) does not
  force the 60 s canary-backstop path on every run.
- Signal-path timing assertion (C-RA-2: wall-clock < deadline/2) is a HARD gate —
  first landing proves augmentation arrived via the signal path, not the backstop.

**Negative**
- `LanguageAdapter.id` union widens from 4 to 5 members. Any future exhaustive
  switch on `.id` will silently fall through without a new `'rust'` arm (mitigated
  by interface doc comment that explicitly documents the expand-contract rule and by
  confirmed absence of any switch in production code at time of writing).
- `lsp-client.ts` is d1 MODIFIED — the PRE-initialize `experimental/serverStatus`
  handler adds additive seam fields to `AdapterReadyCtx`; capability-gated on
  `clientCapabilities?.experimental?.serverStatusNotification`; transparent to all
  existing adapters (TS/Java/Python/Go do not set that capability field).
- `RUST_ANALYZER_READY_DEADLINE_MS = 60_000` is a provisional constant; must be
  tightened to `ceil(observed_quiescent_ms * 2)` after WI-0 spike reveals actual
  load time for ripgrep. Until then, canary-backstop runs impose 60 s per test.
- `discoverServers()` cosmetic gap: `runDoctor` (`cli/lsp.ts`) is NOT updated to
  display `rust-analyzer` — follow-up issue required. The claim "auto-surfaces in
  lsp doctor with zero CLI changes" is false; that change is deferred.

**Risks mitigated**
- External-refusal gate (`isExternalRefusalAdapter`) blocks `~/.rustup/toolchains`
  and `~/.cargo/registry` URIs from being mapped to graph nodes — preventing
  mis-mapped external nodes (AC-9 mis-map oracle === 0).
- Safety property (challenge #17): `realpath` failure on a rust adapterId URI returns
  bare `{kind:'NO_NODE'}` — never a mis-mapped in-repo `NODE` (location-mapper.ts:522).
- `GITNEXUS_HOME=$(mkdtempSync(...))` isolation (per #175) prevents test runs from
  polluting the user-global registry.
- `use` import declarations are excluded from canary sampling because use-statement
  positions are unreliable canary anchors — the sampler emits declaration tokens
  (fn/struct/enum/trait/call) instead. **NOTE:** WI-0 showed the earlier rationale
  ("rust-analyzer returns `[]` for `use` tokens") is FALSE for Rust — `use std` resolves
  (count 1). The exclusion design is unchanged; only its justification is corrected.
- `RUST_IDENT_AFTER` is defined as its own constant (`/[A-Za-z0-9_]/`) — not aliased
  from `GO_IDENT_AFTER`, preventing hidden cross-language coupling.

---

## Fitness Functions

1. **Mode-A golden guard**: all existing golden assertions (TS/Java/Python/Go) must
   remain byte-identical after RUST_ADAPTER lands. CI gate: `npx vitest run test/unit/lsp/`
   with no diff to existing golden cases.
2. **Signal-path HARD gate** (R2-7): C-RA-2 wall-clock elapsed `< RUST_ANALYZER_READY_DEADLINE_MS / 2`
   on the real-binary integration test. If this fails, `awaitReady` settled via 60 s
   canary backstop — the intended signal path is broken. BLOCKER: do not merge.
3. **Non-zero augmentation floor**: AC-9 — `lspReport.confirmed + lspReport.corrected >= 1`
   on ripgrep @ 82313cf. Floor is 1 on first run; tightened to `floor(observed * 0.8)`
   after calibration (mirrors Go adapter C7-10 pattern). Paired with gate 2.
4. **Zero mis-mapped nodes**: AC-9 — all LSP-edge target nodes must have `filePath`
   inside the ripgrep workspace root. Mis-map oracle iterates all `lsp-confirmed` /
   `lsp-corrected` / `lsp-recall` edges.
5. **Type safety**: `npx tsc --noEmit` reports zero errors after all changes. CI gate.
6. **Adapter selection invariants**: unit test EP table covers Rust-dominant,
   Go-dominant-with-some-rs, TS-tie, and all-zero cases (AC-1 through AC-3 + challenge #16).
7. **`target/` exclusion**: canary walk never descends into Cargo build output.
   Verified by `EXCLUDED_DIRS.has('target') === true` unit assertion (I-5).
8. **Issue #159 stays open**: process gate — verify GitHub issue state after merge.
   Deferred backlog items remain tracked there.
