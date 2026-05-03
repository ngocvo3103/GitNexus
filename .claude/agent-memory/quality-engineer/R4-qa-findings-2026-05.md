---
name: R4 QA Findings 2026-05
description: 5 new issues (1 HIGH, 3 MEDIUM, 1 LOW) from R4 QA round on cross-repo and document-endpoint
type: project
---

# R4 QA Findings (2026-05-01)

## New Issues Created

1. **#41 HIGH** - Cross-repo `context` drops all incoming/outgoing relationships. Using `repos` param with multiple repos returns only symbol metadata + `_repoId` but strips ALL relationship data (extends, imports, has_method, has_property, calls, implements). Single-repo context works correctly.

2. **#42 MEDIUM** - document-endpoint ignores HTTP method mismatch. Passing wrong method (GET for POST endpoint) returns documentation with the wrong method instead of rejecting/correcting. No error or warning.

3. **#43 MEDIUM** - Angular endpoints have line=-1 and missing critical fields (method, path, controller, handler). Only filePath is present. Route nodes are incomplete shells.

4. **#44 MEDIUM** - document-endpoint ai_context produces 157KB+ response for complex endpoints. Default depth=10 causes explosion: 85 validation rules, 15K char logic flow, 32 persistence tables. Depth parameter works but default is too high.

5. **#45 LOW** - document-endpoint ai_context resolves wrong downstream HTTP methods. Class-name-heuristic resolver includes unrelated HTTP methods (e.g., DELETE in GET endpoint documentation).

## Confirmed Known Issues (NOT re-reported)

- FastAPI/Gin endpoints empty
- document-endpoint result+error combo on non-existent paths
- impact upstream returns empty for many symbols
- unresolved downstream expressions (url.toString(), targetUrl, [internal])
- Angular Route wrong type
- No EXTENDS edges to TcbsBaseException in bond-exception-handler

## Cross-repo Status

- `query` with `repos`: Works correctly, returns `_repoId` attribution. Invalid repo names produce error in `errors` array.
- `context` with `repos`: Broken (issue #41)
- `impact` with `repos`: Returns empty results for all targets (known issue + cross-repo limitation)
- `impacted_endpoints` with `repos`: Works for single-repo diff detection. No cross-repo propagation of changes.
- `cypher` with `repos`: Works correctly, returns `_repoId` in results.

## Test Environment

- Branch: feature/impact_analysis_to_endpoint
- 10 repos indexed (6 production + 4 fixtures)
- tcbs-bond-trading: 11855 symbols, 31656 edges
- tcbs-bond-trading-core: 17185 symbols, 34799 edges