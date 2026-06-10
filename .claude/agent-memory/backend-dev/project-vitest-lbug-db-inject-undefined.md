---
name: vitest-lbug-db-project-inject-undefined
description: lbug-db project tests fail with `inject('lbugDbPath')` returning undefined in full test runs on vitest 4.x
metadata:
  type: project
---

When running `npx vitest run` (full suite) on vitest 4.x, the `lbug-db` project's `withTestLbugDB()` helper gets `undefined` from `inject<'lbugDbPath'>('lbugDbPath')`. The same code paths work fine for tests in the `default` project. The `location-mapper-db.test.ts`, `search-core.test.ts`, and `mode-c-verifier-db.test.ts` all hit this. Tests are skipped, with the suite-level `beforeAll` failing on `path.dirname(undefined)`.

**Why:** Likely a vitest 4.x `projects` + `globalSetup` + `inject` interaction bug — the `provide('lbugDbPath', dbPath)` from `test/global-setup.ts` doesn't propagate to the `lbug-db` sub-project's `inject()` context.

**How to apply:** When writing tests that use `withTestLbugDB()` and live in the `lbug-db` project include list, don't rely on `npx vitest run test/integration/lsp/<file>.test.ts` to actually execute them. Use unit tests for the same coverage where possible. Confirmed pre-existing on `main-afk @ 13b646a` before any of my changes.
