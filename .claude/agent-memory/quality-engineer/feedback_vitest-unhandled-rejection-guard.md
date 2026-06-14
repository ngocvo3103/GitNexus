---
name: vitest-unhandled-rejection-guard
description: LspClient fake-subprocess tests need a dual unhandledRejection guard — ERR_STREAM_DESTROYED AND vscode-jsonrpc "Connection is disposed." (code 2)
metadata:
  type: feedback
---

When fake-subprocess tests exercise awaitReady=false or awaitReady=throws paths, `cleanupAfterFailure()` kills the fake proc, which emits 'exit', which triggers the lifecycle listener's `restart()` → `spawnAndInitialize()` → `connection.listen()` on an already-disposed connection.

This produces two classes of unhandled rejections that must both be filtered:
1. `ERR_STREAM_DESTROYED` — pipe written after cleanup destroys it.
2. vscode-jsonrpc serialized error code `2`, message contains "disposed" — "Connection is disposed."

**Why:** Both are pure cleanup noise; no test assertion depends on them. Without the dual filter, vitest reports "4 unhandled errors" even though all tests pass and exit code is 0.

**How to apply:** In any `describe` block that exercises awaitReady failure paths, install this guard in the `describe` body (not `beforeAll`):

```ts
const _orig = process.listeners('unhandledRejection');
process.removeAllListeners('unhandledRejection');
process.on('unhandledRejection', (reason: any) => {
  const code = reason?.code ?? '';
  if (reason && typeof reason === 'object' && (
    String(code) === 'ERR_STREAM_DESTROYED' ||
    (typeof code === 'number' && code === 2 &&
      typeof reason?.message === 'string' &&
      (reason.message as string).includes('disposed'))
  )) return;
  for (const l of _orig) {
    try { (l as any).call(process, reason); } catch { /* noop */ }
  }
});
```

See: `gitnexus/test/unit/lsp/lsp-client-adapter.test.ts` (WI-4a and WI-4b suites).
