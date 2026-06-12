---
name: lsp-uri-must-anchor-to-repo-root
description: LSP definition-request URIs must be built from repoPath-anchored absolute paths, never from repo-relative paths directly
metadata:
  type: feedback
---

When building a `file://` URI to send to the LSP server for `textDocument/definition`, the input file path is the graph's **repo-relative POSIX path** (e.g. `src/db.ts`) — the same form nodes store as `filePath`. NEVER convert it to a URI directly.

**Why:** `pathToFileURL('src/db.ts')` resolves a relative path against `process.cwd()`, and `` `file://${relPath}` `` is malformed (first segment becomes the URI host). The LSP server is rooted at the repo (`workspaceRoot = repo.repoPath`), so a cwd-rooted or malformed URI points at a non-existent / out-of-workspace file → the server's didOpen containment check bails → every request returns null → every candidate becomes NO_NODE. This was the F4-forward bug (June 2026) that made 100% of Mode A + Mode C resolutions refuse.

**How to apply:** anchor the relative path to the repo root before the URI: `pathIsAbsolute(file) ? file : pathResolve(repoPath, file)`, then `pathToFileURL(absFile)`. Pass `repo.repoPath` through to the request site (Mode A: `fetchDefinitionForCandidate` gets `repoRoot`; Mode C: `RunModeCVerifyOpts.repoPath` → `classifyEdge`). Absolute inputs pass through untouched (no double-join).

**Gotcha — diagnosis traps that wasted time:** the `location-mapper.ts` `repoPath` rebase (URI→repo-relative for the DB lookup) is the INVERSE direction and is correct, but it is unreachable when requests return null — the mapper is never called because the engine short-circuits at `locs.length === 0`. Don't debug the mapper rebase when the symptom is 100% no_node; instrument the actual `client.request` raw response FIRST.

**Fixture caveat:** the `test/fixtures/mini-repo` candidate feed is all stdlib calls (`.now`, `.trim`, etc.) whose definitions are in `lib.es5.d.ts` (`.d.ts` → unindexable → correctly NO_NODE). It CANNOT show positive decisions. To prove `(confirm+correct+recall) > 0`, run Mode A dry-run on the real GitNexus repo (`analyze . --lsp-dry-run --skip-git`) — it yields dozens of confirm/correct/add. See [[lsp-mode-c-position-gap]].
</content>
