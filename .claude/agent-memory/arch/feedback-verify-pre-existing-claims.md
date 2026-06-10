---
name: verify-pre-existing-claims
description: When verifying a "these test failures are pre-existing" claim on GitNexus, independently run the CLI E2E suites — tsc-clean + scoped-unit-green hides runtime-only regressions
metadata:
  type: feedback
---

A "these failures are pre-existing" claim from an implementer must be **independently verified**, and on GitNexus the decisive evidence is the **CLI E2E suites** — `test/integration/cli-e2e.test.ts`, `cli-verify-lsp.test.ts`, `route-node-e2e.test.ts` — NOT just `tsc --noEmit` + the scoped unit suites.

**Why:** #159 P2 shipped with a circular import — `core/ingestion/lsp/location-mapper.ts` imported `VALID_NODE_LABELS` from `mcp/local/local-backend.ts` (a layering inversion), and a module-top `export const ALL_VALID_NODE_LABELS = VALID_NODE_LABELS` ran while the const was in the Temporal Dead Zone → `ReferenceError: Cannot access 'VALID_NODE_LABELS' before initialization`, crashing **every CLI subprocess**. `tsc` was clean (TypeScript does no initialization-order analysis) and all in-process unit suites passed (they never spawn the CLI), so it was mislabeled "pre-existing." Only the CLI E2E suites — which `spawn` a fresh Node process — exposed it. 20 of 22 failures were this single P2 regression; only 2 (LadybugDB file-lock `IO exception` in `batch-k-impl-calls`/`java-class-impl-calls`) were genuinely pre-existing.

**How to apply:** A "pre-existing" verdict only holds when BOTH (a) the failing test's touched files are provably disjoint from the change set, AND (b) the error type matches a documented quirk — LadybugDB file-lock `IO exception` on parallel forks, or `inject('lbugDbPath')` undefined on isolated runs. A `ReferenceError`/module-load crash in a CLI subprocess is never a harness quirk — it's a real regression. Burden of proof is on "pre-existing"; default to "regression" on uncertainty. Run the full suite (or at least the 3 CLI E2E files) before accepting the claim. Pairs with the verification workflow shape (one test-runner owns ground truth to avoid lbug-db lock contention, then QE lenses + an adversarial classifier fan out).
