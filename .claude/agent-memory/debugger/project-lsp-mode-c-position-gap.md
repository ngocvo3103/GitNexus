---
name: lsp-mode-c-position-gap
description: Mode C verify can't produce matches>0 — persisted CALLS edge lacks callee position; queries caller decl line at col 0
metadata:
  type: project
---

Mode C verify (`src/core/ingestion/lsp/mode-c-verifier.ts`, `gitnexus verify --lsp`) structurally CANNOT produce `matches > 0` against a real server, even after the F4-forward URI fix (June 2026).

**Root constraint:** the persisted CALLS edge has NO callee position. The Kùzu `CodeRelation` CSV schema is exactly `from,to,type,confidence,reason,step,source` (`src/core/lbug/csv-generator.ts:457`). `GraphRelationship.line` exists but is **in-memory only — NOT serialized** (see comment in `src/core/graph/types.ts`). There is no column/character field at all.

**Consequence:** `classifyEdge` builds the `textDocument/definition` position from `a.startLine` (the CALLER node's declaration line) at `character: 0` (`mode-c-verifier.ts` Cypher `RETURN a.startLine AS sourceLine` + `position: { line: edge.sourceLine, character: 0 }`). The LSP server resolves the symbol at the caller's own line → returns the enclosing function (defLine===srcLine empirically), never the callee → every resolved edge is `falseConfident`, never `matches`.

**Why it looked like "100% no_node" before:** the F4 URI bug (`file://${edge.sourceFile}` on a repo-relative path = malformed host) made every request return null → flat refusal. Fixing the URI exposed the deeper position defect (false-confident rose 0→8/45).

**Fix is a SEPARATE work item (HIGH blast radius):** persist call-site line+column on the CALLS edge — touches the CSV writer, the Kùzu `CodeRelation` table definition, all CALLS writers in `call-processor.ts`, and the Mode C reader projection. Do NOT bundle into a URI/bug fix.

**Mode A is NOT affected** — its candidates carry `character` (`nameNode.startPosition.column`) from the live AST, so Mode A resolves callee positions correctly and produces real confirm/correct/recall decisions. See [[lsp-uri-must-anchor-to-repo-root]].
</content>
</invoke>
