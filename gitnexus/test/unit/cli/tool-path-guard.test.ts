/**
 * Security regression tests: validateOutputPath prefix-match bypass fix.
 *
 * Fix (gitnexus/src/cli/tool.ts): the original guard used
 *   resolved.startsWith(resolve(root))
 * which accepts "/tmp-evil/x" because it starts with "/tmp" (when tmpdir
 * is "/tmp"). The fix adds `+ path.sep` so only true children pass:
 *   resolved === rr || resolved.startsWith(rr + path.sep)
 *
 * Each test asserts the FIXED behaviour. Reverting the fix to the old
 * startsWith-without-sep form would make the sibling-dir test pass
 * (returning the resolved path instead of calling process.exit), causing
 * the "REJECTED" assertion to fail — the test would break on revert.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { validateOutputPath } from '../../../src/cli/tool.js';

// ─── Intercept process.exit so tests survive rejection ───────────────────
//
// validateOutputPath calls `process.exit(1)` on bad input. We replace it
// with a throw so the call stack unwinds normally inside the test.

function withExitAsThrow<T>(fn: () => T): T {
  const spy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    throw new Error(`process.exit(${code ?? ''})`);
  });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Prefix-bypass boundary (the fixed bug) ──────────────────────────────

describe('validateOutputPath — prefix-match bypass fix (security regression)', () => {
  it('REJECTS a sibling dir that shares a prefix with a safe root but is not under it', () => {
    // Build a sibling of /tmp (or the platform tmpdir) by appending "-evil".
    // e.g. safe root = /tmp  →  attack path = /tmp-evil/payload
    // The old guard: "/tmp-evil/payload".startsWith("/tmp") → true (bug).
    // The new guard: "/tmp-evil/payload".startsWith("/tmp" + sep) → false (fixed).
    const tmpDir = path.resolve(os.tmpdir());      // e.g. /tmp or /var/folders/…
    const siblingRoot = tmpDir + '-evil';
    const attackPath = path.join(siblingRoot, 'payload');

    expect(() =>
      withExitAsThrow(() => validateOutputPath(attackPath)),
    ).toThrow(/process\.exit/);
  });

  it('REJECTS path containing ".." sequences (path-traversal guard)', () => {
    expect(() =>
      withExitAsThrow(() => validateOutputPath('../../etc/passwd')),
    ).toThrow(/process\.exit/);
  });

  it('ACCEPTS a legitimate child of /tmp (positive case must not regress)', () => {
    // /tmp/gnx-sec-test is a real child of /tmp (a known safe root).
    // The fix must not over-reject: resolved === rr passes, and
    // resolved.startsWith(rr + sep) passes for any child.
    const safePath = path.join(os.tmpdir(), 'gnx-sec-test-output');

    // Should NOT throw — returns the resolved absolute path.
    let result: string | undefined;
    expect(() => {
      result = withExitAsThrow(() => validateOutputPath(safePath));
    }).not.toThrow();

    // The returned value is the resolved form of the input.
    expect(result).toBe(path.resolve(safePath));
  });

  it('ACCEPTS cwd-relative path (safe root = process.cwd())', () => {
    // A relative path that resolves under cwd must be accepted.
    const cwdRelative = 'some-output-file.json';
    let result: string | undefined;
    expect(() => {
      result = withExitAsThrow(() => validateOutputPath(cwdRelative));
    }).not.toThrow();
    expect(result).toBe(path.resolve(cwdRelative));
  });
});
