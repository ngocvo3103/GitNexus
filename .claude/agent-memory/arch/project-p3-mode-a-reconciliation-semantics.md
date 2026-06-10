---
name: project-p3-mode-a-reconciliation-semantics
description: Issue #159 P3 Mode A — LSP-augmented CALLS reconciliation semantics (decision table; confidence 0.70 IMPLEMENTED, gated by callee-label precondition CALLABLE_SYMBOL_TYPES)
metadata:
  type: project
---

Issue #159 P3 "Mode A" = index-time LSP-augmented CALLS resolution in GitNexus (TS-only, CALLS-only, gated behind `analyze --lsp`; default analyze stays byte-identical). The arch-team CONVERGED consensus on RECONCILIATION SEMANTICS (the aspect I owned):

**Decision table** — heuristic state × LSP `mapLocationToNodeId` verdict → action/(target,confidence,source). TWO preconditions on every add/correct/confirm-restamp: P1 = mapper returns kind:'node' (not NO_NODE/AMBIGUOUS/null); P2 = that node's label ∈ `CALLABLE_SYMBOL_TYPES` {Function, Method, Constructor, Macro, Delegate} — IMPORTED from call-processor.ts:686, never hand-copied. Fail either → REFUSE.
- global-0.50-edge + LSP callable B==A → re-stamp (A, 0.70, `lsp-confirmed`) — target unchanged, confidence promoted
- global-0.50-edge + LSP callable B≠A → CORRECT (B, 0.70, `lsp-corrected`); remove old id + insert new (id embeds targetId)
- no-edge/ambiguous + LSP callable B → ADD (B, 0.70, `lsp-recall`)
- LSP NO_NODE / AMBIGUOUS / null / non-callable → REFUSE/KEEP heuristic unchanged (refuse-over-guess, inherited P0-P2)
- Enum (4): {`heuristic`, `lsp-confirmed`, `lsp-corrected`, `lsp-recall`}.

**Why:**
- The CALLEE-LABEL PRECONDITION (P2) is the non-obvious load-bearing constraint (surfaced by redteam): `mapLocationToNodeId`'s `LEAF_LABELS` (location-mapper.ts:93) is a generic "is this a real node" filter admitting all 17 labels incl Class/Interface/Enum/Struct/TypeAlias with NO callee-kind filter. A CALLS callee must be CALLABLE — accept ONLY {Function, Method, Constructor}; reject the other 14. Without this, `new Foo()`/type-position definition hits emit bogus CALLS→Class edges. The heuristic itself already distinguishes this (verifyConstructorBindings filters `def.type==='Class'` away). This is a strict correctness win.
- **Confidence 0.70** (the BINDING value in the implemented WIs, not 0.90). Implemented as `LSP_CONFIDENCE = 0.7` in `mode-a-reconciler.ts:570`. Reasoning: at 0.70 a depth-1 lsp edge lands in `LIKELY_AFFECTED` tier (route-tier gate is WILL_BREAK at conf>=0.85, LIKELY at conf>=0.7 in local-backend.ts ~:2814-2816) — conservative for the first LSP-augmented cycle, surfaces a NEW LIKELY_AFFECTED entry under --lsp (per WI-V golden test) without risking phantom WILL_BREAK entries. An earlier 0.90 hypothesis was rejected on blast-radius grounds: even with the callee-label gate, a higher confidence in a v1 LSP feature was judged too aggressive. **The 0.90 claim in earlier versions of this memory is aspirational, not implemented.** A future cycle may promote 0.70→0.90 once the callee-label gate has production track record.
- Dedup-collapse to one edge per (from,to,type) before CSV (engine owns): order confidence-DESC → source-precedence (lsp* > heuristic, only on EQUAL confidence) → id-ASC keep-first. Keeps same-file heuristic 0.95 over a 0.70 lsp row at a colliding key; deterministic.
- Behavior contract: default analyze byte-identical; under --lsp impacted_endpoints + impact gain entries. detect_changes/context/rename unaffected. source is audit-only, never a consumer branch. Staleness = accepted-residual (concurrent-edit-during-analyze only, self-healing), no cleanliness gate.

**How to apply:** Any future graph-WRITING LSP feature in GitNexus must (1) apply a node-KIND precondition appropriate to the edge type — never trust `mapLocationToNodeId`'s node verdict as semantically sufficient for a specific edge's target (it's a generic real-node filter); (2) preserve refuse-over-guess; (3) anchor new confidence values on the system's existing principled bands (e.g. `IMPACT_RELATION_CONFIDENCE`) rather than inventing magic numbers, and be conservative (LIKELY tier) for new LSP consumers in v1 — a future cycle may promote after production track record; (4) one edge per (from,to,type) before serialization is the downstream-BFS determinism invariant, ordered confidence-DESC. Links [[feedback-verify-pre-existing-claims]].
