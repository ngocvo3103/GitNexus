---
name: mode-a-session-test-pattern
description: Test mock pattern for withReconciliationSession (WI-4a) — the funnel contract mirrors withReferenceProvider; uses positional 4-arg `withReconciliationSession(repo, candidates, fn, deps)` with overrides spread into deps.
metadata:
  type: feedback
---

For the `withReconciliationSession` unit test file
(`gitnexus/test/unit/lsp/mode-a-session.test.ts`), the working
mock setup mirrors the `withReferenceProvider` test pattern
(see [[rename-lsp-precision-test-pattern]]):

1. The funnel signature is `(repo, candidates, fn, deps)` —
   **4 positional args, no 5th `options` slot**. Override
   per-test values by spreading the deps bag: `{ ...deps, handToEngine }`,
   `{ ...deps, cap }`, `{ ...deps, requestTimeoutMs: 1234 }`.
2. Hand `request` impl as `requestImpl: async () => bareLocation`
   on `makeMockClient()` to drive the per-candidate LSP response
   shape.
3. The work fn signature is `fn(selected, meta, skipped)` —
   three positional args, in that order. `skipped = max(0, sorted.length - selected.length)` is the deterministic count of candidates that did NOT make the cap.
4. The engine dispatch is the `handToEngine(candidate, locations[])`
   dep — a no-op default; tests pass a `vi.fn()` to capture
   the (already-normalized) `Location[]` payload per candidate.
5. Default probe is the real `probeWorkspaceReadiness` with
   empty samples (refuses); production callers MUST override.

**Why:** the funnel's `vi.fn()` lets the test inject
per-candidate LSP responses and per-test gate failures without
spawning a real LSP. The 4-arg signature is load-bearing for
the override-via-spread pattern.

**How to apply:** use this for any future funnel-style
lifecycle helper that follows the same shape. The 4-arg
positional signature is the canonical funnel form for the
#159 cycle; deviating from it will break the test pattern.
