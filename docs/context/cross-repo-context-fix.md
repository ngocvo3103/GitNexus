# context (MCP Tool) — Cross-repo Fix

**Service:** GitNexus MCP Server
**Status:** Draft

## Summary
Fix the `context` MCP tool to include `incoming`, `outgoing`, and `processes` relationship data when called with the `repos` (multi-repo) parameter, matching the single-repo response shape with `_repoId` attribution.

## Request

### Parameters
| Param | Type | Required | Description | Default |
|---|---|---|---|---|
| name | string | Yes | Symbol name to look up | — |
| repo | string | No* | Single repository name | — |
| repos | string[] | No* | Multiple repository names | — |
| uid | string | No | Direct symbol UID for zero-ambiguity lookup | — |
| file_path | string | No | File path to disambiguate common names | — |
| include_content | boolean | No | Include full symbol source code | false |

*One of `repo` or `repos` must be provided.

## Response

### Success — single match (FIXED)
```json
{
  "status": "found",
  "symbol": {
    "uid": "string",
    "name": "string",
    "kind": "string",
    "filePath": "string",
    "startLine": "number",
    "endLine": "number",
    "_repoId": "string"
  },
  "incoming": {
    "CALLS": [{ "uid": "string", "name": "string", "kind": "string", "filePath": "string", "_repoId": "string" }],
    "IMPORTS": [...],
    "EXTENDS": [...],
    "IMPLEMENTS": [...]
  },
  "outgoing": {
    "CALLS": [...],
    "IMPORTS": [...],
    "EXTENDS": [...],
    "IMPLEMENTS": [...],
    "HAS_METHOD": [...],
    "HAS_PROPERTY": [...],
    "OVERRIDES": [...],
    "ACCESSES": [...]
  },
  "processes": [{ "name": "string", "label": "string", "step": "number", "_repoId": "string" }],
  "_repoId": "string"
}
```

### Success — ambiguous match (unchanged)
```json
{
  "status": "ambiguous",
  "candidates": [
    { "uid": "string", "name": "string", "kind": "string", "filePath": "string", "_repoId": "string" }
  ]
}
```

### Not found (unchanged)
```json
{
  "status": "not_found",
  "message": "string"
}
```

## Business rules
- When `repos` is provided, query `context` for each repo in parallel
- If exactly one repo returns `status: 'found'`, return that result with `_repoId` on symbol and each relationship entry
- If multiple repos return `status: 'found'`, use the first match (current behavior)
- If all repos return `status: 'ambiguous'`, aggregate candidates with `_repoId`
- If no repo finds the symbol, return `status: 'not_found'`
- `incoming`, `outgoing`, `processes` must match the shape returned by single-repo `context()`

## Notes
- This is a bug fix — the cross-repo handler was dropping these fields entirely
- `_repoId` is added to each relationship entry (not just the top-level symbol) for cross-repo traceability
- The single-repo path is unchanged — this fix only affects the cross-repo aggregation logic