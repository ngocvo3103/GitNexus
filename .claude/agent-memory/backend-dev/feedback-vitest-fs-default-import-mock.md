---
name: vitest-fs-default-import-mock
description: When mocking Node's `fs` for a vitest test, mock BOTH the namespace AND `default` export; under esModuleInterop, `import fs from 'fs'` resolves to the namespace, but a default-only mock breaks the named-import path.
metadata:
  type: feedback
---

When mocking `fs` (or any CJS Node module) in vitest, the `vi.mock` factory must return BOTH the namespace members (`statSync`, `existsSync`, etc.) AND a `default` object containing the same mocks. Under `esModuleInterop: true`, `import fs from 'fs'` in the SUT resolves to the namespace, but TypeScript's resolution can produce different shapes depending on how the SUT imports it.

**Why:** The `core/ingestion/lsp/server-discovery.ts` WI-2 implementation imports as `import fs from 'fs'`. A mock that only returns `{ statSync, existsSync }` (namespace form) leaves `fs.statSync` undefined → all `existsFile` calls fail. Adding `default: { ...actual, statSync, existsSync }` fixes both call-sites. A bare-mock-error or "statSync is not a function" in a fresh mock is the tell.

**How to apply:** For any new vi.mock of `fs`, `path`, `os`, or other Node built-ins, mirror the same mock function under both the named key and `default`. Pattern:

```ts
const statSyncMock = vi.fn(...);
return {
  ...actual,
  statSync: statSyncMock,
  default: { ...actual, statSync: statSyncMock },
};
```

Same for any custom module that mixes `import x from 'mod'` and `import { y } from 'mod'` call-sites.
