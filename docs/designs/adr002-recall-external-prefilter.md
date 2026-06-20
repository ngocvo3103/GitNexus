---
name: adr002-recall-external-prefilter
type: refactor
risk: med
impacted: [c3_ingestion_r]
status: draft
---

<!--
AI-READERS — load only the sections your task needs.

| Task          | Sections                                                          |
|---------------|-------------------------------------------------------------------|
| implement     | ## Components, ## Contracts, ## Invariants                        |
| code-review   | ## Invariants, ## KeyDecisions, ## Contracts                      |
| qa            | ## Flows, ## EdgeCases                                            |
| scope-impact  | ## BlastRadius, ## CrossCutting                                   |

LikeC4 view definitions: grep '^view ' ./adr002-recall-external-prefilter.likec4
Files touched: import-processor.ts, call-processor.ts, pipeline.ts
Files unchanged: mode-a-reconciler.ts (seam already shipped in WS-C)
New test file: gitnexus/test/unit/lsp/mode-a-external-prefilter.test.ts (EP-G, EP-H)
-->

# Solution Design: adr002-recall-external-prefilter

**Blast** d1=3 files · d2=pipeline recall feed consumers · d3=golden test suites (byte-identical)

## Problem & Approach

**Why:** The `canSkipCandidate` recall branch in `pipeline.ts` (line 946–965) hard-returns `false` for every recall candidate per the I-2c conservative default. This is correct absent any callee-externality signal, but means a large fraction of Spring/JDK call-sites in `tcbs-bond-trading` are dispatched to jdtls even though their targets have no definition in the repo. The root cause is that no FQN binding from the call-processor's import-resolution phase was ever threaded forward to the pre-filter. (Actual skip benefit depends on how many recall candidates carry a populated `receiverTypeName` matching an indexed external import; a pre-impl measurement on bond-exception-handler is required before quoting a headline number — see WI-A4.)

**Solution:** At import-processing time, when `resolveJavaImport` returns `null` for a non-wildcard Java import whose raw path starts with a known-external prefix (JDK, Spring, Jackson), record `simpleClassName → rawFqn` in a new `javaExternalFqnIndex` keyed by caller file. Thread the index to both call-emission sites (`processCallsFromExtracted` and `processCalls`) so that when a recall `RecallFeedItem` is pushed, `receiverTypeName` can be looked up and the resolved FQN stored on the item as `calleeExternalFqn`. A closure-local `recallExternalFqnMap` in `pipeline.ts` carries the FQN from the feed item to `canSkipCandidate`, enabling the recall branch to skip before LSP dispatch. The `Candidate` interface and `mode-a-reconciler.ts` are untouched — the seam (`canSkipCandidate`, `preFilteredKeys`, `preFilteredExternal`) is already shipped (WS-C).

Reuse inventory (corrected r2): the in-scope `result` from `provider.importResolver` is reused without re-invoking the resolver — but population does NOT nest inside the existing branch. The branches at import-processor.ts:407 (slow) / :499 (fast) are `if (!result && crossRepoRegistry)`, gated on `crossRepoRegistry` which is undefined on every single-repo analyze (including both validation targets). Population is a NEW sibling `if (!result && javaExternalFqnIndex && …)` block placed adjacent to that branch in the caller (NOT inside it, and NOT inside `applyImportResult`'s `if (!result) return;` at :166), reading the in-scope `result` directly and independent of crossRepoRegistry. Reused as-is: wildcard guard pattern (`rawImportPath.endsWith('.*')`), `imp.language === SupportedLanguages.Java` gate (fast path only; slow path uses `language = getLanguageFromFilename(file.path)`), `preFilteredKeys.add(key) + return true` pattern at `pipeline.ts:961–965`, `candidateLocationKey` already imported.

## KeyDecisions

| Decision | Options considered | Choice | Rationale |
|----------|--------------------|--------|-----------|
| Index threading path | ResolutionContext field; ProcessCallsOpts field; closure capture | **ProcessCallsOpts optional field** | ResolutionContext has a stable documented factory and test mocks — adding a field there risks a mock-update cascade. ProcessCallsOpts already carries co-lifecycle sinks (`recallFeed`, `correctionFeed`); adding `javaExternalFqnIndex` there is consistent. |
| Candidate interface | Extend with `calleeExternalFqn?`; closure-local map | **Closure-local `recallExternalFqnMap` in pipeline.ts** | `Candidate` is the sort-input interface; any new field risks I-9 byte-identity if a sort key is derived from it. The closure-local map is invisible to `sortCandidates` — a one-way door toward safety. |
| External prefix set | 7 named prefixes; Maven pom.xml scanning | **7 named prefixes constant `JAVA_EXTERNAL_PACKAGE_PREFIXES`** | Covers the JDK + Spring Core/Web/Boot + Jackson + SLF4J + OpenTelemetry import set. (NOTE r2: this is import-SET coverage, NOT skip coverage — the realized skip count is keyed on `receiverTypeName` matching an indexed simpleName and is bounded by the WI-A4 measured floor; do NOT restate as ">95% of refusals".) Named constant is extensible without interface changes. Maven pom.xml scanning adds file I/O on the hot ingestion path — deferred to Phase 2; "configurable allowlist" in EARS R1 is out of scope for Phase 1 (see Autonomous Decisions). |
| Wildcard imports | Include when prefix provably external; always exclude | **Always exclude** | A simpleName derived from `import java.util.*` could collide with a same-package class, violating I-2c. Non-configurable exclusion by construction (`rawImportPath.endsWith('.*')` check at population time). |
| calleeExternalFqn field type | `boolean isCalleeExternal`; `string rawFqn` | **`string rawFqn`** | The FQN string enables future verbose funnel logging at zero additional cost. Boolean flags are unrecoverable; the raw FQN is self-describing. |
| Heritage feed patching | Patch all three push sites; patch call sites only | **Patch `processCallsFromExtracted` and `processCalls` only** | IMPLEMENTS/EXTENDS candidates always resolve to the repo's own symbol table; no external heritage case exists for Java. Heritage feed excluded by design. |
| Index population gating | Gate on `opts.lsp`; always populate | **Gate on `opts.lsp`** | The sole consumer of `javaExternalFqnIndex` is the `calleeExternalFqn`-injection path, which is already gated on `opts.lsp`. Always-populating adds allocation and per-Java-import branch work to the byte-identity-critical default path for zero benefit. Gating on `opts.lsp` shrinks the I-9 blast radius to zero on the default path by construction. Remove the gate only if a non-lsp consumer is added. |

## Components

### Container: Ingestion pipeline

Two new components are added: `javaExternalFqnIndex` (the in-memory structure) and `recallExternalFqnMap closure` (the canSkipCandidate extension). The C3 structural view is embedded below.

<div class="figure">
  <likec4-view view-id="c3_ingestion_r" interactive></likec4-view>
  <div class="caption">C3 — Ingestion pipeline. <span style="color:var(--new)">javaExternalFqnIndex [N]</span> and <span style="color:var(--new)">recallExternalFqnMap closure [N]</span>; <span class="hl-u">import-processor, call-processor, pipeline [~]</span>; mode-a-reconciler unchanged.</div>
</div>

#### Sequence: index build — To-be {#sd-index-build}

Population reuses the in-scope `result` (already computed by `provider.importResolver`) via a **NEW sibling** `if (!result && javaExternalFqnIndex && …)` block placed adjacent to — NOT nested inside — the existing `if (!result && crossRepoRegistry)` branch (import-processor.ts:407 slow, :499 fast). The crossRepo branch is gated on `crossRepoRegistry` (undefined on single-repo runs), so nesting there would silently no-op the feature; the new block is independent of crossRepoRegistry. `provider.importResolver` is NOT re-invoked.

```mermaid
sequenceDiagram
  autonumber
  participant P as pipeline.ts [~]
  participant IP as import-processor.ts [~]
  participant JVI as javaExternalFqnIndex [N]

  alt opts.lsp true
    P->>JVI: allocate Map<filePath, Map<simpleClassName, rawFqn>>()
    P->>IP: processImports(graph, files, astCache, ctx, onProgress?, repoRoot?, allPaths?, crossRepoRegistry?, javaExternalFqnIndex)
    Note over IP: SLOW PATH — language = getLanguageFromFilename(file.path); rawImportPath derived at :398
    loop each import in file
      alt language !== Java OR rawImportPath.endsWith('.*')
        Note over IP: non-Java or wildcard → SKIP index population
      else non-wildcard Java import
        Note over IP: provider.importResolver(rawImportPath) already called; result in scope at :407 (NEW sibling block, NOT inside the crossRepoRegistry branch)
        alt result is null AND rawImportPath starts with known prefix
          Note over IP: simpleClassName = rawImportPath.split('.').at(-1)
          IP->>JVI: .get(filePath).set(simpleClassName, rawImportPath)
        else result non-null (in-repo) OR prefix not external
          Note over IP: skip — not external or uncertain; in-repo resolution always wins
        end
      end
    end
    P->>IP: processImportsFromExtracted(graph, files, extractedImports, ctx, onProgress?, repoRoot?, prebuiltCtx?, crossRepoRegistry?, javaExternalFqnIndex)
    Note over IP: FAST PATH — imp.language from ExtractedImport enum; imp.rawImportPath directly available
    loop each ExtractedImport imp
      alt imp.language !== Java OR imp.rawImportPath.endsWith('.*')
        Note over IP: non-Java or wildcard → SKIP index population
      else non-wildcard Java import
        Note over IP: provider.importResolver(imp.rawImportPath) already called; result in scope at :499 (NEW sibling block, NOT inside the crossRepoRegistry branch)
        alt result is null AND imp.rawImportPath starts with known prefix
          Note over IP: simpleClassName = imp.rawImportPath.split('.').at(-1)
          IP->>JVI: .get(filePath).set(simpleClassName, imp.rawImportPath)
        else result non-null (in-repo) OR prefix not external
          Note over IP: skip — in-repo resolution always wins
        end
      end
    end
  else opts.lsp false
    Note over P: javaExternalFqnIndex not allocated; processImports/processImportsFromExtracted called without index parameter
  end
```

#### Sequence: recall pre-filter — To-be {#sd-recall-prefilter}

```mermaid
sequenceDiagram
  autonumber
  participant P as pipeline.ts [~]
  participant CP as call-processor.ts [~]
  participant JVI as javaExternalFqnIndex [N]
  participant RFM as recallExternalFqnMap closure [N]
  participant MA as mode-a-reconciler.ts

  P->>CP: processCallsFromExtracted(extracted, ctx, opts+javaExternalFqnIndex)
  loop each Java call with receiverTypeName
    CP->>JVI: opts.javaExternalFqnIndex?.get(filePath)?.get(receiverTypeName)
    alt FQN found (receiverType is provably external)
      CP->>CP: push RecallFeedItem { calleeExternalFqn: rawFqn, ... }
    else FQN absent (in-repo, wildcard-derived, non-Java, or uncertain)
      CP->>CP: push RecallFeedItem { calleeExternalFqn: undefined }
    end
  end
  P->>RFM: build from recallFeed: for each item where calleeExternalFqn truthy, set recallExternalFqnMap.get(candidateLocationKey(c)) → fqn
  P->>MA: withReconciliationSession(candidates, {cap, canSkipCandidate: closure})
  loop each candidate in selected
    MA->>MA: canSkipCandidate(candidate)
    alt recall candidate (oldTargetId absent)
      MA->>RFM: recallExternalFqnMap.get(candidateLocationKey(candidate))
      alt FQN present → provably external
        RFM-->>MA: true → preFilteredKeys.add(key); preFilteredExternal++
        Note over MA: LSP dispatch SKIPPED — no fetchDefinitionForCandidate call
      else FQN absent → uncertain
        RFM-->>MA: false → probe
        MA->>MA: fetchDefinitionForCandidate(candidate)
      end
    else correction candidate (oldTargetId present)
      Note over MA: correction branch unchanged (graph.getNode path, WS-C shipped)
      MA->>MA: graph.getNode(oldTargetId) → skip if external-zone node
    end
  end
  MA-->>P: {meta, selectedCount, skipped, probed, preFilteredExternal}
```

## Contracts

```ts
// ── import-processor.ts ───────────────────────────────────────────────────

/** Seven prefixes covering JDK, Spring Core/Web/Boot, Jackson, SLF4J, and OpenTelemetry.
 *  Defined as a named readonly constant — extend here to add more external packages.
 *  Maven pom.xml scanning is explicitly deferred (Phase 2+). */
export const JAVA_EXTERNAL_PACKAGE_PREFIXES: readonly string[] = [
  'java.',
  'javax.',
  'jakarta.',
  'org.springframework.',
  'com.fasterxml.',
  'org.slf4j.',
  'io.opentelemetry.',
];

// REAL SIGNATURES — verbatim from import-processor.ts:292 and :448 (re-verified r2
// against live source by adjudicator; the r1 fast-path shape was WRONG).
// Both are `export const … = async (…)` arrow functions with POSITIONAL params.
// ProcessImportsOpts / `opts` does NOT exist on either function — there is no opts
// object here, so the opts.lsp gate CANNOT be read inside these functions; the
// CALLER (pipeline.ts) conditionally allocates+passes the index based on opts.lsp,
// and population proceeds whenever the index arg is present.
//
// ── PLACEMENT (verified r2) ───────────────────────────────────────────────
// The `!result` reuse signal exists at THREE sites; population goes at NEITHER of
// the wrong two:
//   • applyImportResult():166  → `if (!result) return;`  ✗ WRONG home (no index/
//                                  prefix/language/rawImportPath params in scope).
//   • caller branch :407 (slow) / :499 (fast) → `if (!result && crossRepoRegistry)`
//                                  ✗ DO NOT NEST INSIDE — crossRepoRegistry is
//                                  undefined on every single-repo analyze (incl.
//                                  both validation targets), so nesting silently
//                                  no-ops the whole feature.
// Population MUST go in a NEW SIBLING `if (!result …)` block in the CALLER, placed
// adjacent to (not inside) the crossRepo branch, reading the in-scope `result`
// directly and INDEPENDENT of crossRepoRegistry.

/**
 * Slow / AST path (processImports — import-processor.ts:292).
 * javaExternalFqnIndex is a new 9th trailing optional after crossRepoRegistry.
 * Slow path uses `file.path` (NOT `filePath`) and the loop-local `language` (:332)
 * + `rawImportPath` (:398). `result` is the resolver output already in scope at :407.
 *
 * SLOW-PATH recipe — NEW sibling block in the caller, after applyImportResult() and
 * adjacent to the `if (!result && crossRepoRegistry)` at :407:
 *     if (!result && javaExternalFqnIndex && language === SupportedLanguages.Java
 *         && !rawImportPath.endsWith('.*')
 *         && JAVA_EXTERNAL_PACKAGE_PREFIXES.some(p => rawImportPath.startsWith(p))) {
 *       const simple = rawImportPath.split('.').at(-1)!;
 *       let fileMap = javaExternalFqnIndex.get(file.path);
 *       if (!fileMap) { fileMap = new Map(); javaExternalFqnIndex.set(file.path, fileMap); }
 *       fileMap.set(simple, rawImportPath);
 *     }
 */
function processImports(
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  allPaths?: string[],
  crossRepoRegistry?: CrossRepoRegistry,
  javaExternalFqnIndex?: Map<string, Map<string, string>>,  // [N] new 9th trailing optional
): Promise<void>;

/**
 * Fast / worker path (processImportsFromExtracted — import-processor.ts:448).
 * REAL signature is 8 positional args (graph, files, extractedImports, ctx,
 * onProgress?, repoRoot?, prebuiltCtx?, crossRepoRegistry?). javaExternalFqnIndex
 * is the new 9th trailing optional after crossRepoRegistry.
 * Fast path uses the loop var `filePath` (from `for (const [filePath, fileImports]`)
 * and `imp.language` / `imp.rawImportPath` off the ExtractedImport. `result` is the
 * resolver output already in scope at :499.
 *
 * FAST-PATH recipe — NEW sibling block in the caller, after applyImportResult() and
 * adjacent to the `if (!result && crossRepoRegistry)` at :499:
 *     if (!result && javaExternalFqnIndex && imp.language === SupportedLanguages.Java
 *         && !imp.rawImportPath.endsWith('.*')
 *         && JAVA_EXTERNAL_PACKAGE_PREFIXES.some(p => imp.rawImportPath.startsWith(p))) {
 *       const simple = imp.rawImportPath.split('.').at(-1)!;
 *       let fileMap = javaExternalFqnIndex.get(filePath);
 *       if (!fileMap) { fileMap = new Map(); javaExternalFqnIndex.set(filePath, fileMap); }
 *       fileMap.set(simple, imp.rawImportPath);
 *     }
 *
 * Wildcard imports (endsWith '.*') are NEVER added.
 * Non-Java imports are NEVER added.
 * In-repo results (result non-null) are NEVER added — in-repo wins by construction.
 * No existing return value or output field on ctx is altered.
 */
function processImportsFromExtracted(
  graph: KnowledgeGraph,
  files: { path: string }[],
  extractedImports: ExtractedImport[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  prebuiltCtx?: ImportResolutionContext,
  crossRepoRegistry?: CrossRepoRegistry,
  javaExternalFqnIndex?: Map<string, Map<string, string>>,  // [N] new 9th trailing optional
): Promise<void>;

// Both paths MUST be patched — pipeline routes to one or the other depending on
// worker availability. Missing either silently degrades pre-filter benefit.
//
// CALL-SITE EDITS (mandatory wiring — verified r2):
//   • pipeline.ts:385  processImportsFromExtracted(graph, allPathObjects,
//       chunkWorkerData.imports, ctx, onProgress, repoPath, importCtx,
//       options?.crossRepoRegistry)  → append javaExternalFqnIndex as 9th arg.
//   • pipeline.ts:475  processImports(graph, chunkFiles, astCache, ctx, undefined,
//       repoPath, allPaths, options?.crossRepoRegistry)  → append the index as 9th arg.
//   The index is allocated ONCE in pipeline.ts (main thread) under the opts.lsp gate
//   and passed by reference to BOTH import functions (population) AND both call
//   functions via ProcessCallsOpts (consumption). All four run on the MAIN thread
//   (the worker pool only emits ExtractedImport[]/ExtractedCall[]); the live Map
//   instance is therefore shared — no structured-clone boundary copies it.

// ── call-processor.ts ─────────────────────────────────────────────────────

export interface RecallFeedItem {
  sourceId: string;
  calledName: string;
  file: string;           // CALLER's .java file — not the callee location
  line: number;
  character: number;
  calleeExternalFqn?: string;  // [N] raw FQN if callee is provably external Java library
                               // undefined = uncertain = probe (I-2c conservative)
}

export interface ProcessCallsOpts {
  // ... existing fields unchanged (lsp, recallFeed, correctionFeed, ...) ...
  /** Optional index from import-processor. When present, used at both recall-push
   *  sites to populate RecallFeedItem.calleeExternalFqn.
   *  Not present on default analyze path → calleeExternalFqn always undefined → probe. */
  javaExternalFqnIndex?: Map<string, Map<string, string>>;  // [N]
}

// Injection logic at recall-push sites (gated on opts.lsp) — TWO SEPARATE SITES:
//
// SLOW SITE (~processCalls, line 657–665): receiverTypeName is the bare local variable
//   computed at :542-628 and passed to resolveCallTarget :643; effectiveCall is NOT in
//   scope, and the in-scope path identifier is `file.path` (NOT `filePath`) — verified
//   r2 at call-processor.ts:661 `file: file.path`.
//   if (file.path.endsWith('.java') && receiverTypeName) {
//     const fqn = opts.javaExternalFqnIndex?.get(file.path)?.get(receiverTypeName);
//     if (fqn) item.calleeExternalFqn = fqn;
//   }
//
// FAST SITE (~processCallsFromExtracted, line 1574): effectiveCall IS in scope;
//   use effectiveCall.receiverTypeName.
//   if (effectiveCall.filePath.endsWith('.java') && effectiveCall.receiverTypeName) {
//     const fqn = opts.javaExternalFqnIndex
//       ?.get(effectiveCall.filePath)
//       ?.get(effectiveCall.receiverTypeName);
//     if (fqn) item.calleeExternalFqn = fqn;
//   }
//
// Both sites: non-.java files and absent receiverTypeName produce calleeExternalFqn: undefined.
// DO NOT reference effectiveCall at the slow site — it is not in scope there.

// ── pipeline.ts (canSkipCandidate recall branch) ──────────────────────────

// recallExternalFqnMap: Map<string, string>  (candidateLocationKey → rawFqn)
// Built INSIDE the `for (const r of recallFeed)` loop where `r` is in hand.
// VERIFIED r2: the recall loop at pipeline.ts:704-712 pushes an ANONYMOUS object
// literal into the shared candidates[] — there is NO named `candidate` binding to
// pass to candidateLocationKey. There is no recallCandidates[] array; recall items
// share candidates[] alongside correction (:693) and heritage (:731).
//
//   // Inside the existing for (const r of recallFeed) loop, build the key from `r`
//   // directly (recall items have no relType → 4-tuple key matches the formula):
//   if (r.calleeExternalFqn) {
//     recallExternalFqnMap.set(
//       candidateLocationKey({
//         sourceId: r.sourceId,
//         calledName: r.calledName,
//         line: r.line,
//         character: r.character,
//       } as Candidate),
//       r.calleeExternalFqn,
//     );
//   }
//   // (Equivalently: capture the pushed literal in a named const and reuse it.)
//
// candidateLocationKey formula: `${sourceId}|${calledName}|${line}|${character}`
// (+`|relType` only for heritage — recall has none; verified mode-a-reconciler.ts:2175)
// sourceId is file-scoped so cross-file key collisions cannot occur.
// The recall skip is gated behind `!candidate.oldTargetId` in canSkipCandidate,
// so a correction candidate with the same key is never falsely skipped.
//
// canSkipCandidate recall branch (replaces bare 'return false'):
//   if (!candidate.oldTargetId) {
//     const key = candidateLocationKey(candidate);
//     const fqn = recallExternalFqnMap.get(key);
//     if (fqn) {
//       preFilteredKeys.add(key);
//       return true;
//     }
//     return false;
//   }
//   // correction branch below — unchanged

// ── mode-a-reconciler.ts ─────────────────────────────────────────────────
// NO CHANGES. The canSkipCandidate seam, preFilteredKeys, and preFilteredExternal
// counter are already present (WS-C, shipped). The recall branch fires automatically
// through the existing seam when canSkipCandidate returns true.
```

## Invariants

- **I-2c (no false skips):** `calleeExternalFqn` absent → `recallExternalFqnMap` has no entry → `canSkipCandidate` returns `false` → probe. Only a positively-matched FQN (truthy string, starts with a known prefix, derived from a non-wildcard import where `resolveJavaImport` returned null) triggers a skip.
- **I-9 (golden byte-identity):** Index population is gated on `opts.lsp` — the default analyze path (non-lsp) never allocates `javaExternalFqnIndex` and never enters the population branch. `calleeExternalFqn` injection is inside the `opts.lsp && opts.recallFeed` gate. The `Candidate` interface and `sortCandidates` are untouched — sort output byte-identical.
- **I-8-replay:** `preFilteredKeys.add(key)` fires on every `return true` from `canSkipCandidate` (existing seam behavior), so `reconcileDecisions` excludes pre-filtered recall candidates from replay.
- **Wildcard exclusion is absolute:** `rawImportPath.endsWith('.*')` check at index-population time excludes wildcards unconditionally — this is not configurable. A simpleClassName derived from a wildcard could collide with a same-package class.
- **In-repo wins by construction (population side):** `javaExternalFqnIndex` is populated ONLY in the new sibling `if (!result …)` block where `result` is the resolver output. A non-null `result` (in-repo node) means the population block is never entered for that import. So an *imported* in-repo `Foo` produces no external entry. (EP-I verifies this — see EdgeCases.)
- **No false skip at LOOKUP time (the operative proof — corrected r2):** The skip fires on `receiverTypeName` matching an external index key, and `receiverTypeName` is resolved INDEPENDENTLY of imports (TypeEnv/constructor binding/static-receiver fallback `receiverTypeName = receiverName` at call-processor.ts:454/:592/:1520). The population-side argument above is therefore NOT sufficient — a same-package/no-import in-repo `Foo` can carry `receiverTypeName='Foo'` with no import entry of its own. Safety rests on the **Java single-name-import rule**: a file cannot hold an explicit `import org.springframework.Foo` (which writes the external `Foo` index key) AND resolve an unqualified same-package `Foo` in the same file — `javac` rejects the collision. Combined with per-file index keying (no cross-file collision), this guarantees: if `receiverTypeName='Foo'` matches an external key in that file, no in-repo `Foo` is reachable unqualified in that file. (EP-K verifies the same-package-no-import case — see EdgeCases.)
- **Both import paths must be patched:** `processImports` (slow/AST path) and `processImportsFromExtracted` (fast/worker path) are independent code paths. Missing either one silently degrades pre-filter coverage for the affected repo class.
- **Java-only:** Index population gated on `language === SupportedLanguages.Java` (slow path: loop-local variable; fast path: `imp.language` enum). `calleeExternalFqn` injection gated on `filePath.endsWith('.java')`. Kotlin is explicitly excluded.
- **Heritage feed excluded:** IMPLEMENTS/EXTENDS candidates always resolve to the repo's symbol table; `calleeExternalFqn` is never set on heritage `RecallFeedItem` entries. No heritage feed patching.
- **Correction branch unchanged:** `canSkipCandidate` correction path (`oldTargetId` present → `graph.getNode` lookup) is unmodified. The recall and correction branches are fully separate with no logic interleaving.
- **Path-key identity (r2):** The index key (import filePath) and the recall lookup key (caller `file.path` / `effectiveCall.filePath`) MUST be the identical worker-emitted `file.path` string under identical normalization. Holds today by construction — the worker emits both `result.imports` and `result.calls` with `filePath: file.path` from the same source (parse-worker.ts), and both passes key on `file.path`. Any future change to path normalization in one pass MUST be mirrored in the other, or every lookup silently misses (no-op, no error). Optional guard: a unit assertion that a known external import produces a hit for a same-file call, to fail loudly if the key forms drift.
- **Single live index instance (r2):** `javaExternalFqnIndex` is allocated ONCE in pipeline.ts (main thread, under the `opts.lsp` gate) and passed by reference to BOTH import producers (population) AND both call producers via `ProcessCallsOpts` (consumption) within the same pipeline run. All four functions (`processImports`, `processImportsFromExtracted`, `processCalls`, `processCallsFromExtracted`) execute on the main thread — verified: the worker pool only emits `ExtractedImport[]`/`ExtractedCall[]`; the resolution functions are `await`ed directly in pipeline.ts (no structured-clone boundary copies the Map). If any of these four were ever moved inside a worker that receives a serialized copy, population and consumption would no longer share one instance and the feature would silently no-op.
- **Two-overload same-key conservatism:** If two unresolved overloads share the same `candidateLocationKey` (same sourceId/calledName/line/character) and only one resolves external, the `recallExternalFqnMap` last-write is safe only when both share the same `receiverTypeName` (and thus the same lookup result). On any divergent-receiver collision at a shared key, the conservative behavior (probe) is preserved by the requirement that the map entry carries the FQN only when the lookup is unambiguous. (EP test EP-J verifies — see EdgeCases.)

## Flows

| UC | Sequence |
|----|----------|
| Index build (both import paths) | `#sd-index-build` |
| Recall pre-filter — happy (FQN matched, skip) | `#sd-recall-prefilter` (FQN present branch) |
| Recall pre-filter — uncertain (no FQN, probe) | `#sd-recall-prefilter` (FQN absent branch) |
| Recall pre-filter — wildcard import | `#sd-index-build` (wildcard skip step) → `#sd-recall-prefilter` (FQN absent branch) |
| Correction candidate | `#sd-recall-prefilter` (correction branch — unchanged) |

## EdgeCases

- **receiverTypeName absent at call-emission time:** `receiverTypeName` (slow site) or `effectiveCall.receiverTypeName` (fast site) is undefined for some call forms (unresolved chains, primitive types). Lookup is `?.get(receiverTypeName)` — produces `undefined`, no FQN set, falls through to probe. Correct per I-2c.
- **Same simpleClassName in two external packages (e.g. `java.util.Date` vs `java.sql.Date`):** Both entries write to the same `simpleClassName` key under the same `filePath`; the last import wins. The skip is still correct (both are external) — the only consumer (the skip decision) needs presence, not the exact FQN. **Caveat (r2):** the stored FQN is best-effort under same-simpleName multi-import and may carry the wrong package; the deferred verbose-funnel-logging follow-up (the stated rationale for choosing a string over a boolean) MUST treat the logged FQN as best-effort, not authoritative. A missed classification would at worst probe unnecessarily — no false skip.
- **Java file with no explicit imports (same-package class):** No import → no resolver call → no index entry → `calleeExternalFqn` undefined → probe. Correct: same-package classes are in-repo.
- **opts.lsp absent:** Both `javaExternalFqnIndex` allocation and `calleeExternalFqn` injection are inside the `opts.lsp` gate. On the default (non-LSP) path, neither map is allocated nor any branch entered. Zero behavioral or I-9 impact.
- **EP-I (in-repo/external simpleClassName collision — invariant test):** A file imports `org.springframework.Foo` (external, prefix-match) AND `com.example.repo.Foo` (in-repo, resolver returns a node). The in-repo import is processed first OR last; regardless, the in-repo result (`!result === false`) means the population branch is never entered for that simpleClassName. The index under `filePath` has no entry for `Foo` (or has only the external entry if the in-repo import is not present in the same file). Verify: `recallExternalFqnMap` produces `undefined` for `Foo` when the in-repo resolver returns non-null for that name → candidate probes. This is the "in-repo wins by construction" invariant.
- **EP-J (two unresolved overloads at the same site — conservative key test):** Two recall candidates share `sourceId|calledName|line|character` (same call site, different argCounts or overload forms). Only one has a `receiverTypeName` matching an external import. The other has `receiverTypeName` absent or non-matching. The `recallExternalFqnMap` entry for the key is set by the first (external) and the second candidate must still probe. Verify: `canSkipCandidate` is called for BOTH; the one without a positive FQN match returns `false` → probe. (If both share the same `receiverTypeName` → same lookup result → both skip, which is correct if both are genuinely external. The test exercises the divergent case.)
- **EP-K (same-package-no-import vs prefix-matched external import — R7 / lookup-side false-skip test):** A `.java` file has NO import for an in-repo same-package class `Bar`, AND a sibling external import for a DIFFERENT class (e.g. `import org.springframework.X`). A call site `bar.method()` resolves `receiverTypeName='Bar'` via the static-receiver fallback (no import). Assert: the index under that `filePath` has NO entry for `Bar` (no import → no population) → `recallExternalFqnMap.get(key)` is undefined → the in-repo call **probes** (returns `false`), not skips. This is the exact R7 case (absence-from-import must not classify a same-package class as external) and the lookup-side complement to EP-I. The Java single-name-import rule (no explicit external import can collide with an unqualified same-package simple name in one file) is what makes a positive external lookup safe; EP-K pins the negative case.

## CrossCutting

**Performance:** `javaExternalFqnIndex` population is O(imports) with no file I/O — bounded by the existing import-processing pass. The O(1) map lookup at each recall-push site replaces nothing (new code path, inside existing opts.lsp gate). Net: no measurable overhead on the default analyze path; recall-push sites add a single map lookup per Java call.

**Observability:** `preFilteredExternal` counter (already shipped) accumulates recall pre-filter hits alongside correction hits. The existing funnel line `(budget B of N candidates)` reports the aggregate. Verbose funnel logging using the raw `calleeExternalFqn` string is a future extension (deferred).

## BlastRadius

| Depth | Areas |
|-------|-------|
| d1 | `import-processor.ts` (both producer fns — new 9th optional param + sibling population block), `call-processor.ts` (both push sites — `calleeExternalFqn` field on `RecallFeedItem` + `javaExternalFqnIndex` on `ProcessCallsOpts`), `pipeline.ts` (canSkipCandidate recall branch + recallExternalFqnMap construction + the index allocation + **two import call-site edits at :385 and :475 to pass the 9th arg** + the existing call-site that already passes ProcessCallsOpts). The two import call-site edits are mandatory wiring (not "no update required") — WI-A1 Size must cover both producer fns + both call sites + the new constant. |
| d2 | `RecallFeedItem` consumers (pipeline.ts only — reconciler consumes via existing seam), `preFilteredExternal` counter consumers (funnel log line, test assertions in mode-a-external-prefilter.test.ts), `ProcessCallsOpts` callers. Two distinct `preFilteredExternal` increment sites: (a) `canSkipCandidate` recall branch [new, this PR — asserted by EP-G/EP-H]; (b) `isUnindexablePath` pre-filter inside `fetchDefinitionForCandidate` [WS-C, already shipped — asserted by C5-3/C5-4]. Tests MUST pin which site fired; the two counters must not be conflated. |
| d3 | Golden byte-identity tests (`C7-7`, `AC-2`) — untouched; existing EP-A through EP-F assertions — untouched; C5-3/C5-4 (`isUnindexablePath` path) — untouched (TS-path fixtures, `calleeExternalFqn` never set) |

## DownstreamDocs

| Type | Path | Action |
|------|------|--------|
| adr | `gitnexus/docs/adr/ADR-002-lsp-augmentation-at-scale.md` | **amend** — add a "Phase 1: Java recall external pre-filter" section (continues P0 / WS-B / WS-C lineage). ADR-003 was considered but folded into this amendment per Challenge Ledger r2-15. |

<div class="callout"><b>Autonomous Decisions</b><br>

<b>JAVA_EXTERNAL_PACKAGE_PREFIXES = ['java.', 'javax.', 'jakarta.', 'org.springframework.', 'com.fasterxml.', 'org.slf4j.', 'io.opentelemetry.']</b> — 7 prefixes covering JDK, Spring Core/Web/Boot, Jackson, SLF4J, and OpenTelemetry; defined as a named readonly constant in import-processor.ts for extension without interface changes; Maven pom.xml scanning deferred. (WI-A4 measurement outcome: the bond-exception-handler spike at 5-prefix set yielded skip floor = 46; 7-prefix re-measurement yielded **measured floor = 36** (two consecutive runs, committed as `PINNED_FLOOR = 36` in `java-recall-external-prefilter.test.ts:723`). The 36 result is lower than the naive ~92 raw-count upper bound because the realized floor is measured AFTER same-key dedup, the 2k cap, I-2c safety hardening, and RECV_ABSENT attrition (128 of 298 pushes carry no `receiverTypeName` and are structurally uncapturable). Still 2.4× the 15-skip kill-threshold; go/no-go cleared at 5-prefix floor 46.)

<b>javaExternalFqnIndex is a Map&lt;string, Map&lt;string, string&gt;&gt; (callerFilePath → simpleClassName → rawFqn)</b> passed as an optional out-parameter to processImports and processImportsFromExtracted — not a ResolutionContext field and not a return value (avoids return-type change to processImports which returns void).

<b>Wildcard imports (import java.util.*) are excluded from javaExternalFqnIndex by construction</b> (rawImportPath.endsWith('.*') check at population time) even when the package prefix is provably external.

<b>calleeExternalFqn on RecallFeedItem is a string (the raw FQN), not a boolean flag,</b> to enable future verbose funnel logging.

<b>The public Candidate interface is NOT extended;</b> a closure-local recallExternalFqnMap keyed on candidateLocationKey carries the FQN to canSkipCandidate.

<b>canSkipCandidate recall branch and correction branch are fully separate code paths</b> with no logic interleaving — correction path (oldTargetId present) is unchanged.

<b>Both call-processor recall push sites (processCallsFromExtracted ~line 1574 and processCalls ~line 658) are patched;</b> the heritage feed is not patched (IMPLEMENTS/EXTENDS always resolve to repo symbol table; no external heritage case exists).

<b>The javaExternalFqnIndex lookup at call-emission time is O(1) with no file I/O</b> — consistent with the reuse-first note; no new AST parsing is introduced.

<b>Index population IS gated on opts.lsp</b> (ruling #11): the sole consumer of javaExternalFqnIndex is the calleeExternalFqn-injection path which is also lsp-gated. Always-populating adds allocation and per-Java-import branch work to the byte-identity-critical default path for zero benefit. Gating on opts.lsp shrinks the I-9 blast radius to zero by construction. (Prior autonomous decision "not gated" was REVISED by adjudication.)

<b>CANDIDATE INTERFACE NOT EXTENDED:</b> The public Candidate interface (mode-a-reconciler.ts:81) gains no new field. calleeExternalFqn is carried in a closure-local Map&lt;candidateLocationKey, string&gt; (recallExternalFqnMap) inside pipeline.ts. This is a one-way door toward I-9 safety — if Candidate ever gained a calleeExternalFqn field, any downstream sort that serializes Candidate fields could produce a different byte sequence. The closure-local map is invisible to the sort.

<b>PROCESSCALLSOPTS INJECTION (NOT RESOLUTIONCONTEXT):</b> javaExternalFqnIndex is threaded via ProcessCallsOpts as a new optional field, NOT added to ResolutionContext. ResolutionContext is a stable interface with a documented factory and test mocks; touching it risks a mock-update cascade. ProcessCallsOpts already carries the lsp-gated feed sinks (correctionFeed, recallFeed) and is the natural co-lifecycle home.

<b>WILDCARD EXCLUSION IS ABSOLUTE:</b> import java.util.* produces NO entry in javaExternalFqnIndex even though the package prefix is provably external. A simpleName derived from a wildcard could collide with a same-package class, violating I-2c. This is not configurable; wildcards are always excluded.

<b>BOTH IMPORT PATHS MUST BE EXTENDED:</b> processImports (slow/AST path) and processImportsFromExtracted (fast/worker path) are independent code paths — pipeline routes to one or the other depending on worker availability. Missing either one silently degrades pre-filter benefit on the affected repo class. Both MUST be patched in the same PR.

<b>WI-A4 GATE-MEASURE RESULT — FULFILLED (5→7 prefix expansion approved & re-measured):</b> A pre-build count-only instrumentation spike ran `analyze --lsp` on bond-exception-handler using the original 5-prefix set. Result: **skip floor = 46 with the 5-prefix set = 3.1× the 15-skip kill-threshold → GATE PASSED** (no abort/pivot). Matched-FQN breakdown: org.springframework 24, java.* 12, javax 6, com.fasterxml 4. Funnel verbatim: `confirmed 54, corrected 2, recall +30, refused 175, skipped(cap) 0`. Honest caveat: **128 of 298 recall pushes had NO `receiverTypeName` (RECV_ABSENT)** — structurally uncapturable by an import-based pre-filter; the larger future lever (receiverTypeName enrichment for static/qualified calls) is explicitly a LATER phase, not this PR. The 7-prefix expansion to include `org.slf4j.` and `io.opentelemetry.` (top residual non-matches: Logger ×26, Span ×20) was re-measured on bond-exception-handler and yielded **measured floor = 36** (two consecutive runs, committed as `PINNED_FLOOR = 36` in `java-recall-external-prefilter.test.ts:723`). The 36 result is lower than the naive ~92 raw-count upper bound because the realized floor is measured AFTER same-key dedup, the 2k cap, I-2c safety hardening, and the 128 RECV_ABSENT pushes. Still **2.4× the 15-skip kill-threshold** → go/no-go already cleared. WI-A4 re-measurement action **DONE**; `PINNED_FLOOR = 36` committed and never recomputed at test time.

<b>WI-A4 GATE-MEASURE RE-MEASUREMENT — FULFILLED (rulings r1 #8/#9, r2 #13/#14/#15):</b> After the 7-prefix expansion is approved (GATE PASSED at 5-prefix floor 46), the re-measurement with the 7-prefix set on bond-exception-handler was executed and yielded **measured floor = 36** (committed as `PINNED_FLOOR = 36` in `java-recall-external-prefilter.test.ts:723`). This re-measurement is NOT a second go/no-go gate (the kill-decision was already made at 5-prefix with floor 46 >> 15); it is a final floor quantification for the concrete E2E test constant `PINNED_FLOOR`. The 36 result is lower than the naive ~92 raw-count projection due to same-key dedup, the 2k cap, I-2c conservative hardening, and the 128 of 298 RECV_ABSENT pushes that carry no `receiverTypeName` and are structurally uncapturable by an import-based pre-filter. Still **2.4× the 15-skip kill-threshold**. <b>TESTABLE AC (r2, updated for 7-prefix, FULFILLED):</b> (1) run <code>analyze --lsp</code> on bond-exception-handler with the 7-prefix set; measured preFilteredExternal = 36; committed as pinned numeric constant `PINNED_FLOOR = 36` (never recomputed at test time — circular pass would be untestable) ✓; (2) INTEGRATION test on a small committed Java fixture (one .java caller importing <code>java.util.List</code> + <code>org.springframework.X</code> + <code>org.slf4j.Logger</code>) asserting the recall candidate is skipped specifically via the <code>canSkipCandidate</code> path — EP-G/EP-H use injected maps and do NOT exercise the real import→call→skip chain ✓; (3) residual refused-FQN package histogram emitted (present + non-empty), so under-coverage from Lombok/Apache/Guava is visible, not silent ✓.

<b>EARS R1 "configurable allowlist" — SCOPE CORRECTION (r2 #11):</b> EARS R1 as written includes "or any Maven-dependency prefix declared in a configurable allowlist." Phase 1 ships a FIXED 5-prefix constant; editing a source constant and recompiling is NOT configuration. Resolution recorded on the record: the "configurable allowlist" clause of EARS R1 is <b>explicitly OUT OF SCOPE for Phase 1</b> — R1 is amended to require only the fixed provably-external prefix set, and allowlist/Maven configurability is deferred to Phase 2+ (consistent with the KeyDecisions "no file I/O on the hot ingestion path" constraint). This is a recorded requirement amendment, not a silent narrowing. (Rejected alternative: adding env-var config plumbing now — scope creep against the deferral, and no consumer needs it in Phase 1.)

<b>NON-JAVA FILES EXCLUDED AT BOTH SITES:</b> Index population is gated on imp.language === SupportedLanguages.Java (not on file extension, because ExtractedImport carries the language enum directly in the fast path). calleeExternalFqn injection is gated on effectiveCall.filePath.endsWith('.java'). Kotlin is explicitly excluded.

<b>AUTHORITATIVE (supersedes the prior <code>calleePackage</code> draft):</b> The public <code>Candidate</code> interface is <b>NOT</b> extended. The callee FQN is named <code>calleeExternalFqn</code> (a raw FQN string), carried only on <code>RecallFeedItem</code> and threaded to <code>canSkipCandidate</code> via the closure-local <code>recallExternalFqnMap</code> keyed on <code>candidateLocationKey</code>. <b>The earlier "<code>calleePackage</code> on Candidate" wording was a superseded drafting pass and is void — no implementer or test may re-introduce a <code>calleePackage</code> field or a Candidate-interface change.</b> No existing caller is broken (the new optional field lives only on <code>RecallFeedItem</code>; object-literal construction needs no update). The only behavioral change is that <code>canSkipCandidate</code> may now return <code>true</code> for recall candidates whose callee is positively classified as an external Java library. Tests C5-3/C5-4 in mode-a-session.test.ts assert <code>preFilteredExternal</code> counts via the <code>isUnindexablePath</code> gate inside <code>fetchDefinitionForCandidate</code> — a DISTINCT increment site from the new <code>canSkipCandidate</code> recall path — and use TS-path fixtures that never set <code>calleeExternalFqn</code>, so they stay byte-green. Absent <code>calleeExternalFqn</code> = probe (I-2c). I-9 holds because the default path never sets the field and the <code>Candidate</code> sort shape is untouched.

<h4>Challenge Ledger (adjudicated r1)</h4>

| # | Decision | Adversarial objection (lens) | Ruling | Rationale / revision |
|---|----------|------------------------------|--------|----------------------|
| 1 | Candidate interface NOT extended; field is `calleeExternalFqn` on RecallFeedItem | Doc self-contradicts: line-302 callout says Candidate gains `calleePackage?` — opposite of every other section, on the highest-scrutiny I-9 constraint (Decision Auditor / Arch Skeptic / Completeness Adversary, 4 challenges) | **accept** | Verified contradiction. Line-302 paragraph rewritten as AUTHORITATIVE: Candidate untouched, field `calleeExternalFqn` on RecallFeedItem only, `calleePackage` declared void. I-9 rationale preserved by construction. |
| 2 | `javaExternalFqnIndex` threaded into import processing | Contracts invent `processImports(ctx, opts, idx?)` + a nonexistent `ProcessImportsOpts`; real sig is `(graph, files, astCache, ctx, onProgress?, repoRoot?, allPaths?, crossRepoRegistry?)`; `processImportsFromExtracted` differs (extractedImports/prebuiltCtx) (Decision Auditor + Completeness Adversary) | **accept** | Verified at import-processor.ts:292 and :448. `ProcessImportsOpts` does not exist. WI-A1/Contracts must be re-anchored to the two REAL 8-arg signatures; thread the index as a new trailing optional param on BOTH (after crossRepoRegistry). |
| 3 | Reuse the not-in-repo signal at import time | Cited `resolveJavaImport null-return (jvm.ts:125)`; resolveJavaImport is never called in import-processor.ts (it's wired as `provider.importResolver`); the real seam is the existing `if (!result)` at :407 (slow) and :499 (fast). Index sequence diagram implies a SECOND resolver call → doubles hot-path I/O, contradicting the "zero additional I/O" tradeoff (Arch Skeptic + Completeness Adversary) | **accept** | Verified: importResolver at :402/:419/:496; `if (!result ...)` at :407/:499; resolveJavaImport only at languages/java.ts:26 + import-resolvers/jvm.ts:126. Hook population INTO the existing `if (!result)` branch reusing the in-scope `result`; never re-invoke importResolver. Fix path to import-resolvers/jvm.ts and correct the diagram. |
| 4 | Two-path patch of import processing | The `imp.language === Java` gate exists ONLY on the fast path (iterates ExtractedImport[]); the slow path has no `imp` — it derives `language = getLanguageFromFilename(file.path)` (:332) and `rawImportPath` (:398) (Arch Skeptic + Completeness Adversary) | **accept** | Verified. WI-A1 split into per-path recipes: fast path gates on `imp.language`/`imp.rawImportPath`; slow path gates on the loop-local `language`/`rawImportPath`. Both consume the existing `result`. |
| 5 | `calleeExternalFqn` injected at BOTH recall-push sites | "BLOCKER: processCalls site (~657) has no `effectiveCall` and no receiverTypeName in scope — the behavior step can't compile" (Arch Skeptic) | **partial** | Verified the asymmetry is REAL but the objection overstates: the slow site (657-665) has NO `effectiveCall`, yet a bare local `receiverTypeName` IS in scope (computed :542-628, passed to resolveCallTarget :643). Fast site (1573) uses `effectiveCall.receiverTypeName`. Fix: per-site bindings (`receiverTypeName` slow, `effectiveCall.receiverTypeName` fast) — do NOT drop the slow site, but split into two separately-verified behavior bullets. |
| 6 | FQN map carried via `candidateLocationKey` lookup | Design builds the map by index-zipping a phantom `recallCandidates[i]` — no such array; recall items push into the SHARED `candidates[]` (pipeline.ts:704-712) alongside correction (:693) + heritage (:731) (Decision Auditor + Arch Skeptic + Completeness Adversary) | **accept** | Verified: single `candidates: Candidate[]` at :692; no recallCandidates[]. Build `recallExternalFqnMap` INSIDE the `for (const r of recallFeed)` loop where `r` (and `r.calleeExternalFqn`) is in hand, keyed by `candidateLocationKey` of the candidate just constructed. Drop the index-misalignment EdgeCase. |
| 7 | `candidateLocationKey` keys the FQN map | Prose implies file-based keying; real key = `sourceId\|calledName\|line\|character` (+relType), no `file` (mode-a-reconciler.ts:2175). Recall↔correction at same site share the key (Arch Skeptic) | **partial** | Verified key formula. Round-trip is correct (set and get use the same fn) and the recall skip is gated behind `!oldTargetId`, plus the dedup at :757-764 makes correction beat recall (first-writer-wins, correction pushed first). Add an invariant note: `sourceId` is file-scoped so cross-file collisions can't occur; correct the file-keying prose. NO logic change. |
| 8 | receiverTypeName is the skip key on the RECALL path | recall = resolution FAILURE; for many Spring/JDK refusals receiverTypeName is unresolved/absent → lookup misses → no skip. The >95% prefix-coverage claim is about the import set, not about how many refusals carry a populated receiverTypeName matching simpleClassName (Decision Auditor + Arch Skeptic) | **partial** | Genuine coverage-honesty gap (and a missed-skip, never a false-skip — I-2c safe). Mechanism is sound; benefit is unquantified. Add an empirical pre-impl measurement on bond-exception-handler (of 175 refusals: how many have `.java` + non-empty receiverTypeName matching an external import) and a measured floor in WI-A4. Adjust expected-benefit honestly; do NOT inflate the 57k headline. |
| 9 | Coverage of the 5-prefix set | No measurable AC; Lombok/SLF4J/Apache/Guava refusals silently un-skipped with no signal (Completeness Adversary) | **accept** | Add a WI-A4 acceptance criterion: after `analyze --lsp` on bond-exception-handler, assert `preFilteredExternal` >= a JDK/Spring/Jackson floor AND log a residual refused-FQN package histogram so under-coverage is visible, not silent. Quantifies what deferring the Maven scan leaves on the table. |
| 10 | C5-3 stays green | The d2/blast-radius note references `calleePackage` and reasons against the rejected variant; C5-3 trips `isUnindexablePath` inside fetchDefinitionForCandidate — a different increment site than canSkipCandidate (Decision Auditor) | **accept** | Low impact (fixture genuinely unaffected) but the stale name propagates the BLOCKER's contradiction. Normalize all blast-radius refs to `calleeExternalFqn`; WI-A4 must assert the new EP-G test increments `preFilteredExternal` via the canSkipCandidate path specifically, keeping the two increment sources individually pinned. |
| 11 | Index POPULATION is not gated on opts.lsp | YAGNI/hot-path: the only consumer is the lsp-gated recall push; always-populating adds allocation + per-Java-import branch work to the byte-identity-critical default path for zero benefit, widening I-9 surface (Decision Auditor) | **partial** | Fair. Gating population on `opts.lsp` shrinks the I-9 blast radius to zero on the default path by construction and removes hot-path overhead — the sole consumer is lsp-gated. Revise: gate population on `opts.lsp` too; ungate only if a non-lsp consumer ever appears. (The original "don't silently degrade a future consumer" rationale defends a hypothetical absent from the call graph.) |
| 12 | Same simpleClassName resolves both in-repo and external | Population order could let an external entry shadow a real in-repo class of the same simple name in the same file → potential false skip (Completeness Adversary) | **partial** | In-repo imports are never added by construction (only `!result` + prefix-match writes), so an in-repo `Foo` produces no entry and cannot be shadowed — but the design must STATE this invariant and prove the population path can't write an external entry for a simple name that also has an in-repo resolution. Add the invariant + an EP test for the in-repo-wins collision. |
| 13 | Two unresolved overloads at the same site (recall↔recall key collision) | last-write-wins on `candidateLocationKey` could skip a candidate whose own callee was not classified external — a false skip, I-2c (Decision Auditor) | **partial** | Real edge but narrow: both overloads share `sourceId\|calledName\|line\|character` AND the same `receiverTypeName`→FQN lookup, so if one is external the lookup result is identical for both. A divergent-receiver same-key collision is the only false-skip risk. Add an EP test: two unresolved overloads at the same line/character where only one resolves external → the other MUST still probe. Conservative: on any ambiguity at a shared key, do not skip. |
| 14 | Wildcard imports excluded absolutely | (no challenge — autonomous decision) | **upheld** | A simpleName from `import java.util.*` could collide with a same-package class; excluding wildcards is the conservative I-2c choice. `rawImportPath.endsWith('.*')` guard at population time. |
| 15 | Heritage feed not patched | (no challenge — autonomous decision) | **upheld** | IMPLEMENTS/EXTENDS resolve to the repo's own symbol table; no external-heritage case for Java. Verified heritage push at pipeline.ts:731 carries oldTargetId (always a resolved repo edge). |
| 16 | calleeExternalFqn is a string FQN, not a boolean | (no challenge — autonomous decision) | **upheld** | Raw FQN enables verbose funnel logging at zero cost and is self-describing; a boolean is unrecoverable. No I-9 impact (RecallFeedItem is not the sort shape). |
| 17 | ProcessCallsOpts is the threading home (not ResolutionContext) | (no challenge — autonomous decision) | **upheld** | Verified ProcessCallsOpts (call-processor.ts:1398) already carries the lsp-gated `recallFeed`/`correctionFeed` sinks — the natural co-lifecycle home; avoids the ResolutionContext factory/mock cascade. (Index ALSO threaded through the import-processor signatures per ruling #2 — distinct lifecycle.) |
| 18 | DownstreamDocs mints ADR-003 | Work is ADR-002 Phase 1 (continues WS-B/WS-C); a new ADR-003 fragments the decision lineage (Completeness Adversary) | **partial** | Documentation-trail scope point, not a code risk. Prefer appending a Phase-1 section/amendment to ADR-002 so the recall-prefilter lineage stays with P0/WS-B/WS-C. If a split is still desired, ADR-002 MUST cross-link forward to ADR-003. |

<h4>Challenge Ledger (adjudicated r2 — re-verified against live source)</h4>

The r2 reviewers re-checked the r1 rulings against the actual source. The adjudicator independently re-verified every line-anchored claim below. Two BLOCKERs were ACCEPTED: the r1 fix to ruling #2 was applied to the design's *prose* but the Contracts *signature* for `processImportsFromExtracted` was never corrected to the real 8-arg shape, and the reuse seam is a compound `if (!result && crossRepoRegistry)`, not a bare `if (!result)`. Both are now fixed in the body.

| # | Decision / target | Adversarial objection (lens) | Ruling | Rationale / revision (source-verified) |
|---|-------------------|------------------------------|--------|----------------------------------------|
| r2-1 | Contracts: `processImportsFromExtracted` signature (lines 219-225) | BLOCKER ×2: r1 #2 claimed the sig was re-anchored, but the Contracts block STILL declared `(extractedImports, prebuiltCtx, opts, crossRepoRegistry?)` with a phantom `opts: ProcessCallsOpts`; real sig is 8 positional args (Decision Auditor + Arch Skeptic) | **accept** | VERIFIED at import-processor.ts:448-457: `(graph, files, extractedImports, ctx, onProgress?, repoRoot?, prebuiltCtx?, crossRepoRegistry?)`. No `opts` object exists → the opts.lsp gate CANNOT be read inside the fn; the caller gates allocation/passing. Contracts block rewritten to the real 8-arg shape + index as 9th trailing optional. `processImports` sig (8-arg) was already correct and is unchanged. |
| r2-2 | Reuse seam: "hook into existing `if (!result)` at :407/:499" (lines 35, 62, 313, diagram :79/:94) | BLOCKER/MAJOR: no bare `if (!result)` — both are `if (!result && crossRepoRegistry)`; `crossRepoRegistry` is undefined on single-repo analyze (incl. both validation targets), so nesting silently no-ops the feature (Decision Auditor + Arch Skeptic) | **accept** | VERIFIED at :407 and :499 — both `if (!result && crossRepoRegistry)`; a third bare `if (!result) return;` lives in `applyImportResult`:166 (wrong home — no index/prefix/lang params). Body corrected: population is a NEW SIBLING `if (!result && javaExternalFqnIndex && …)` block in the caller, adjacent to (not inside) the crossRepo branch, independent of crossRepoRegistry, after `applyImportResult()`. Reuse inventory, both sequence-diagram notes, the in-repo invariant, and the placement comment all updated. |
| r2-3 | Invariant "In-repo wins by construction" / EP-I (lines 313, 336) | MAJOR: invariant proves POPULATION safety, but the false-skip risk is at LOOKUP time keyed on `receiverTypeName`, which is resolved INDEPENDENTLY of imports (static-receiver fallback) — the stated proof is not the operative mechanism (Arch Skeptic) | **partial** | Objection is structurally correct: VERIFIED `receiverTypeName = receiverName/receiverText` at call-processor.ts:454/:592/:1520 (no import needed). Outcome is still SAFE via the Java single-name-import rule (an explicit external import cannot collide with an unqualified same-package simple name in one file), but the proof must argue from the lookup key + that rule. Added a "No false skip at LOOKUP time" invariant and EP-K (same-package-no-import vs prefix-matched external import) — the negative-case test. No logic change; the skip remains correct. |
| r2-4 | receiverTypeName as skip key; ">95% of refusals" benefit claim (KeyDecisions r3) | MAJOR: >95% measures the import SET, not the skip SET; many Spring/JDK refusals have receiverTypeName absent → lookup misses → no skip; headline inflated (Decision Auditor) | **partial** | Missed-skip (I-2c safe), not a false-skip; mechanism sound, benefit unquantified. Struck ">95% of refusals" in KeyDecisions (reframed as import-SET coverage). Made WI-A4's pre-impl measurement a BLOCKING go/no-go gate with a placeholder kill-threshold (&lt; 15 skips → pivot), not a documentation note. |
| r2-5 | WI-A4 AC testability + empty-state go/no-go | MAJOR ×2: "preFilteredExternal &gt;= measured floor" is circular/untestable (floor measured at test time → trivially passes, can't catch regression to 0); no committed numeric expectation; EP-G/H use injected maps, never the real chain; no go/no-go kill threshold for the dominant receiverTypeName-absent empty-state (Completeness Adversary) | **accept** | Rewrote WI-A4 AC: (1) commit the one-time floor as a CONCRETE pinned constant (not recomputed); (2) add an INTEGRATION test exercising the real import→call→pipeline chain on a committed Java fixture, asserting skip via the `canSkipCandidate` path specifically; (3) assert the residual-FQN histogram is emitted (present + non-empty). Added the explicit kill-gate. |
| r2-6 | WI-A3 recipe: `candidateLocationKey(candidate)` (lines 279-282) | MAJOR: no named `candidate` at the recall-push loop — pipeline.ts:704-712 pushes an ANONYMOUS literal into the shared candidates[]; recipe names a phantom var (Arch Skeptic) | **accept** | VERIFIED at :704-712 (anonymous push; single shared `candidates: Candidate[]` at :692; no recallCandidates[]). Recipe rewritten to build the key from `r` directly via a 4-tuple `{sourceId, calledName, line, character}` (recall has no relType — key formula confirmed at mode-a-reconciler.ts:2175). |
| r2-7 | EARS R1 "configurable allowlist" vs fixed 5-prefix constant | MAJOR: R1 asserts a configurable allowlist; ship is a hard-coded constant; editing+recompiling ≠ configuration — a silently-narrowed requirement (Completeness Adversary) | **partial** | Recorded a requirement amendment: the "configurable allowlist" clause of R1 is explicitly OUT OF SCOPE for Phase 1 (consistent with the no-file-I/O deferral); not a silent narrowing. REJECTED the alternative of adding config plumbing now (scope creep; no Phase-1 consumer). Recorded in Autonomous Decisions + KeyDecisions. |
| r2-8 | calleeExternalFqn string under same-simpleName collision (Date vs Date) | MINOR: stored FQN is wrong for half the call sites under same-simpleName multi-import; the string-over-boolean rationale rested on verbose logging the edge case breaks (Completeness Adversary) | **partial** | Skip decision is correct (presence, not FQN, is what the consumer needs) — keep the string (boolean migration is unwarranted churn). Added an explicit caveat: the deferred verbose-logging follow-up must treat the FQN as best-effort, not authoritative. Rationale for string-over-boolean re-scoped to "self-describing presence", not "always-correct FQN". |
| r2-9 | slow-site recall-push recipe: `filePath.endsWith('.java')` (lines 254-257) | MINOR: in-scope identifier at processCalls:657 is `file.path`, not `filePath`; recipe references an undefined identifier (Arch Skeptic) | **accept** | VERIFIED at call-processor.ts:661 `file: file.path`; `receiverTypeName` is the bare local in scope; no `effectiveCall`. Slow-site recipe corrected to `file.path` on both the gate and the lookup. Fast site (`effectiveCall.filePath`) was already correct. |
| r2-10 | blastRadius d1: "optional field addition — no caller update required" | MINOR: omits the two mandatory import-call-site edits (pipeline.ts:385, :475) that must pass the new 9th arg (Arch Skeptic) | **accept** | VERIFIED both call sites pass 8 args today. Added both to d1 + WI-A1's edit list; WI-A1 Size must cover both producer fns + both call sites + the new constant. |
| r2-11 | path-key join (index key vs recall lookup key) | MINOR: design never states the index key and lookup key must be the identical normalized `file.path`; silent no-op if they ever diverge (Decision Auditor) | **accept** | Holds today by construction (both passes emit/key on worker `file.path`). Added an explicit Path-key-identity invariant + an optional same-file-hit assertion to fail loudly on drift. |
| r2-12 | concurrency / worker-boundary single-instance | MINOR: design asserts "co-lifecycle" but never shows the SAME Map instance reaches both population and consumption within one run if either crosses a worker boundary (Completeness Adversary) | **accept** | VERIFIED all four functions are `await`ed on the main thread in pipeline.ts (the worker pool only emits ExtractedImport[]/ExtractedCall[]); a by-reference Map is shared. Added a Single-live-index invariant. No logic change — holds by construction today. |
| r2-13 | EP-I framing / R7 same-package case | MINOR: EP-I covers two-imports collision, not the import-vs-same-package-no-import case R7 actually calls out (Completeness Adversary) | **accept** | Added EP-K (the R7 negative case) and rewrote the lookup-side invariant to cite the Java single-name-import rule explicitly. (Same root as r2-3; folded.) |
| r2-14 | applyImportResult:166 placement trap | MINOR: the bare `if (!result) return;` lives in applyImportResult (:166); a naive reader could place population there (lacks params) instead of the caller (Completeness Adversary) | **accept** | VERIFIED at :155/:166. Added an explicit placement note in Contracts: population goes in the CALLER after `applyImportResult()` returns, NOT inside applyImportResult and NOT inside the crossRepo branch. |
| r2-15 | DownstreamDocs row vs ruling #18 | MINOR: table still says "create ADR-003" while ruling #18 said amend ADR-002 — artifact contradicts its own ledger (Decision Auditor) | **accept** | Reconciled: DownstreamDocs row changed to "amend ADR-002 with a Phase-1 section"; standalone ADR only with a forward cross-link. |

</div>
