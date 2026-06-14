/**
 * Security regression: uriToRepoRelative realpathSync-before-containment fix.
 *
 * Fix (gitnexus/src/core/ingestion/lsp/reference-provider.ts,
 *      function uriToRepoRelative):
 *
 * The original code converted a URI to an abs path and then checked
 * containment using the LEXICAL path:
 *
 *   abs = fileURLToPath(uri)         // lexical path, may be a symlink
 *   if (!isWithinRepo(abs, repoPath)) return null   // lexical check
 *   content = readFile(abs)          // reads through the symlink!
 *
 * A malicious LSP server can return a URI like
 *   file:///repo/escape.ts
 * where `/repo/escape.ts` is a symlink → `/etc/passwd`. The lexical
 * path `/repo/escape.ts` passes isWithinRepo, so the old code read
 * the out-of-repo target.
 *
 * The fix inserts `realpathSync` BEFORE the containment check:
 *
 *   abs = fileURLToPath(uri)
 *   abs = realpathSync(abs)          // resolve symlinks FIRST
 *   if (!isWithinRepo(abs, repoPath)) return null   // now checks real path
 *
 * If realpathSync throws (dangling symlink, non-existent path) the function
 * also returns null — refuse rather than read from an unknown location.
 *
 * This file does NOT mock node:fs so the real realpathSync runs on real
 * filesystem objects. apply-precise-edits.test.ts mocks node:fs to keep
 * its synthetic /repo paths working; keeping the files separate avoids
 * the mock collision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  workspaceEditToChanges,
  type WorkspaceEdit,
} from '../../../src/core/ingestion/lsp/reference-provider.js';

// ─── Real-filesystem symlink containment tests ───────────────────────────

describe('uriToRepoRelative — realpathSync symlink fix (security regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Resolve the real path of tmpDir so it matches what realpathSync returns
    // for files created inside it (on macOS /var → /private/var symlink).
    tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gnx-sec-symlink-')));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses a URI whose realpathSync resolves OUTSIDE the repo (symlink escape)', async () => {
    // Layout:
    //   tmpDir/repo/           ← fake repo root (repoDir)
    //   tmpDir/outside.ts      ← file outside the repo
    //   tmpDir/repo/escape.ts  ← symlink → ../outside.ts  (escapes repo)
    //
    // A malicious LSP server returns file://<repoDir>/escape.ts.
    // Lexical path is inside the repo → old code accepted it and read the
    // symlink target. Fixed code runs realpathSync first → outside → refuse.
    const repoDir = path.join(tmpDir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    const outsideFile = path.join(tmpDir, 'outside.ts');
    writeFileSync(outsideFile, 'secret outside content\n');

    const symlinkInRepo = path.join(repoDir, 'escape.ts');
    try {
      symlinkSync(outsideFile, symlinkInRepo);
    } catch {
      // Symlink creation unavailable (rare restricted CI env) — skip.
      return;
    }

    const symlinkUri = `file://${symlinkInRepo}`;
    const edit: WorkspaceEdit = {
      changes: {
        [symlinkUri]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' },
        ],
      },
    };

    // readFile stub: must NOT be called — realpathSync containment fires first.
    const readFile = vi.fn(async () => 'secret outside content\n');

    const result = await workspaceEditToChanges(edit, repoDir, { readFile });

    // The fix: realpathSync resolves escape.ts → outside.ts → outside repoDir → null.
    // Without the fix: lexical check passes → readFile called → null not returned.
    expect(result).toBeNull();

    // Confirm containment check short-circuited before any read.
    // If this fails, the fix has been reverted and lexical-path check is back.
    expect(readFile).not.toHaveBeenCalled();
  });

  it('accepts a URI to a real in-repo file (positive case)', async () => {
    // Sanity guard: a legitimate file that actually exists inside the repo
    // must still be accepted after the fix. The fix must not over-reject.
    const repoDir = path.join(tmpDir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    const realFile = path.join(repoDir, 'legit.ts');
    writeFileSync(realFile, 'export const x = 1;\n');

    const fileUri = `file://${realFile}`;
    const edit: WorkspaceEdit = {
      changes: {
        [fileUri]: [
          { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: '2' },
        ],
      },
    };

    const readFile = vi.fn(async () => 'export const x = 1;\n');
    const result = await workspaceEditToChanges(edit, repoDir, { readFile });

    // The real file exists → realpathSync succeeds → containment check passes.
    expect(result).not.toBeNull();
    expect(result![0].file_path).toBe('legit.ts');
  });
});
