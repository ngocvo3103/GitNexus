---
name: project-lsp-consumer-funnel-contract-2026-06
description: The consumer of withReferenceProvider in local-backend.ts now expects the funnel to return {publicChanges, lspChanges} not just lspChanges. Test mock pattern.
metadata:
  type: project
---

The consumer in `gitnexus/src/mcp/local/local-backend.ts:3414` (WI-4 branch) was refactored (S-14 + S-30) to call BOTH `workspaceEditToChanges` (public) and `workspaceEditToApplierChanges` (applier) inside the `withReferenceProvider` callback, and the funnel now returns `{ publicChanges, lspChanges } | null` instead of `ApplierChangesFile[] | null`.

**Why:** Eliminate the hand-projection in the consumer (the old `lspChanges.map(...)` to strip `newText`/`range` for the wire output). The two adapters share refuse gates, so the cost is one extra `readFile` per file (page-cache hit, negligible).

**How to apply:** When mocking `withReferenceProvider` in tests, the success path must return `{publicChanges, lspChanges}`. See `gitnexus/test/unit/rename-lsp-precision.test.ts:359-391` for the `setFunnelResult({ mode: 'success', changes, publicChanges })` helper. The test pre-computes BOTH shapes via the real `workspaceEditToApplierChanges` and `workspaceEditToChanges` so the mock doesn't have to call the real adapter twice.
