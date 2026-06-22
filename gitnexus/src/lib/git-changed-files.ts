import { execFileSync } from 'node:child_process';

/**
 * Repo-relative POSIX paths of files changed since `baseRef` — modified/staged
 * (via `git diff <ref>`) plus untracked-new (via `git ls-files --others`).
 *
 * Used by `--lsp-changed-since` (lever 15) to scope the LSP candidate feed to
 * changed files. Throws if `git diff <ref>` fails (e.g. bad ref or not a git
 * repo) so the caller can warn and fall back to a full run rather than silently
 * scoping to nothing. A valid ref with no changes returns an EMPTY set — that
 * is a real result (reconcile nothing), distinct from the throw.
 *
 * git emits forward-slash paths even on Windows; we normalise defensively so
 * the set compares directly against the indexer's repo-relative POSIX
 * `candidate.file` values.
 */
export function getChangedFilesSince(repoPath: string, baseRef: string): Set<string> {
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  // `diff` throws on a bad ref — let it propagate (caller decides).
  const changed = run(['diff', '--name-only', baseRef]);
  // Untracked files are best-effort; never let them fail the whole call.
  let untracked: string[] = [];
  try {
    untracked = run(['ls-files', '--others', '--exclude-standard']);
  } catch {
    untracked = [];
  }

  const set = new Set<string>();
  for (const f of [...changed, ...untracked]) set.add(f.replace(/\\/g, '/'));
  return set;
}
