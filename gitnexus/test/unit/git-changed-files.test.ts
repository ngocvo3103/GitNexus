import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getChangedFilesSince } from '../../src/lib/git-changed-files.js';

/**
 * Lever 15: `getChangedFilesSince` drives `--lsp-changed-since`. The contract:
 * modified + staged + untracked-new files since a ref (repo-relative POSIX),
 * a real empty set when nothing changed, and a THROW on a bad ref so the CLI
 * can warn + fall back rather than silently scoping to nothing.
 */
describe('getChangedFilesSince (lever 15)', () => {
  let repo: string;
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'gnx-changed-'));
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
  });

  afterAll(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('returns an empty set when nothing changed since HEAD', () => {
    expect(getChangedFilesSince(repo, 'HEAD')).toEqual(new Set());
  });

  it('captures a modified tracked file (repo-relative POSIX path)', () => {
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 99;\n');
    const changed = getChangedFilesSince(repo, 'HEAD');
    expect(changed.has('src/a.ts')).toBe(true);
    expect(changed.has('src/b.ts')).toBe(false);
  });

  it('captures an untracked NEW file', () => {
    writeFileSync(path.join(repo, 'src', 'c.ts'), 'export const c = 3;\n');
    const changed = getChangedFilesSince(repo, 'HEAD');
    expect(changed.has('src/c.ts')).toBe(true);
  });

  it('throws on a bad ref (so the CLI can warn + fall back to a full run)', () => {
    expect(() => getChangedFilesSince(repo, 'no-such-ref-xyz')).toThrow();
  });
});
