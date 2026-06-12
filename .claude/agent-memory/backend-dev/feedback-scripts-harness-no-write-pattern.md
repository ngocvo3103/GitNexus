---
name: scripts-harness-no-write-pattern
description: WI-1b — scripts/measure-mode-c.ts dynamic-import pattern keeps assertNoGraphWriteImports sweep clean
metadata:
  type: feedback
---

For any new file under `gitnexus/scripts/`, the static no-write invariant
sweep (`assertNoGraphWriteImports` in `mode-c-verifier.ts:727-764` and the
broader `test/unit/lsp/no-write-invariant.test.ts`) is reused by
`test/unit/scripts/scripts-no-write-invariant.test.ts` (WI-V) to gate the
new harness.

**Why:** the plan's #159 measurement campaign (`docs/plans/159-mode-c-measurement.md`)
imposes KD-8: graph reads go through `executeParameterized` ONLY. The
sweep checks the SOURCE TEXT for forbidden tokens (`initLbug`,
`executeQuery`, `DROP … TABLE`, etc.) — so a static `import { runModeCVerify }`
from `dist/...` would trip the regex even though the import is read-only.

**How to apply:** in any new `scripts/*.ts` file, load production helpers
via `await import('../dist/<path>.js')` (dynamic, string-literal path) so
the source contains the URL string but not a static `import … from …`
declaration. The `import('...')` form is recognized by the sweep as
"dynamic, runtime-resolved" and is exempt. The `new URL(..., import.meta.url).href`
form also works but obscures the URL from a simple regex sweep.

The `exec` seam in the harness is implemented with `child_process.execFile`
(argument array) NOT `child_process.exec` (shell string) — see
PostToolUse security guidance. The seam NAME is `exec` (per the WI
contract) but the implementation must be shell-free.
