---
name: node-fs-promises-lazy-import-bypasses-vi-mock
description: When code uses `await import('node:fs/promises')`, vi.mock('fs/promises') does NOT intercept it; must mock BOTH or the real fs leaks
metadata:
  type: feedback
---

When a module lazy-imports `await import('node:fs/promises')` (e.g. in a default
helper to keep cold-start cheap — `defaultReadFile` /
`defaultWriteFile` in `gitnexus/src/core/ingestion/lsp/reference-provider.ts`),
the test's `vi.mock('fs/promises')` does NOT intercept it. vitest treats
`'fs/promises'` and `'node:fs/promises'` as distinct module specifiers.

**Why:** vitest's mock registry keys on the import specifier string. The
string `'node:fs/promises'` is not aliased to `'fs/promises'`, so a mock
on the bare specifier leaves the prefixed specifier's real module
importable. The real fs leaks through, `readFile` throws ENOENT, and
`workspaceEditToChanges` returns `null` (refuse path).

**How to apply:** in any test that exercises code that lazy-imports
`node:fs/promises`, add a SECOND `vi.mock('node:fs/promises', ...)` with
the same shape as the bare-specifier mock. Also include a `default`
export on the `node:` mock — some helpers reach for the namespace via
`fs.default.readFile` (esModuleInterop), and a missing `default` triggers
a `vitest` stderr notice (benign but noisy). See
[[rename-lsp-precision-test-pattern]] for the exact pattern.
