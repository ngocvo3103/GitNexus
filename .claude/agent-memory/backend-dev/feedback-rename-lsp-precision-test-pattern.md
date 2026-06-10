---
name: rename-lsp-precision-test-pattern
description: Mock pattern for rename(precision:'lsp') unit tests — mirror rename-accuracy.test.ts + mock the LSP funnel via vi.mock
metadata:
  type: feedback
---

For the `rename(precision:'lsp')` test file
(`gitnexus/test/unit/rename-lsp-precision.test.ts`), the working
mock setup is:

1. vi.mock `fs/promises` AND `node:fs/promises` (see
   [[node-fs-promises-lazy-import-bypasses-vi-mock]]).
2. vi.mock `child_process` to return a hoisted `rgFiles` array.
3. vi.mock the lsp module
   `../../src/core/ingestion/lsp/reference-provider.js` with
   `await importOriginal()` so the real
   `workspaceEditToChanges` / `applyPreciseEdits` are still
   available, then overwrite `withReferenceProvider` with a
   `vi.fn()` the test body drives directly per case.
4. Hoist `fileContents` + `rgFiles` + `writeCalls` (for D6/D7
   dry-run gating) via `vi.hoisted`.

**Why:** the funnel's `vi.fn()` lets the test inject a
`ChangesFile[]` (D1 success) or `null` (D2-D5 each gate's
refuse) without spawning a real LSP. The real adapter/applier
remain in scope so D7's precise-writeFile assertion is
end-to-end (not a mock of a mock).

**How to apply:** use this for any future LSP-MCP wiring
test (WI-5 impact, Mode C verifier updates). The same mock
surface applies — only the controlled funnel result shape
changes.
