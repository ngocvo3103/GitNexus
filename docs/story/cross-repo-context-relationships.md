# Fix: Cross-repo context drops all incoming/outgoing relationships

**Type:** Bug
**Created:** 2026-05-01
**Status:** in review

## Summary

The `context` MCP tool's multi-repo handler drops `incoming`, `outgoing`, and `processes` relationship data when called with the `repos` parameter. Single-repo mode works correctly.

## Context

The cross-repo handler calls `this.context()` which returns full relationship data, but the aggregation code only extracts `symbol` and discards the rest. Fix requires capturing and returning relationship fields with `_repoId` attribution. GitHub issue: #41.

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/cross-repo-context-relationships.md` |
| Backend spec | `docs/context/cross-repo-context-fix.md` |
| Solution design | `docs/designs/cross-repo-context-relationships-solution-design.md` |

## Implementation Summary

- **WI-1**: Fixed cross-repo context aggregation in `local-backend.ts:callToolMultiRepo` case 'context'. Added `incoming`, `outgoing`, `processes` fields to the response with `_repoId` on each entry. Added first-wins guard to prevent overwrite when symbol found in multiple repos. Added defensive defaults (`incoming: {}`, `outgoing: {}`, `processes: []`). Added `errors` field when repo errors exist.
- **WI-2**: Added 8 test cases (TC-1 through TC-8) using `vi.spyOn(backend, 'context')` for deterministic cross-repo mocking. Tests cover: incoming/outgoing/processes with _repoId, empty relationship shape, nested _repoId, error isolation, ambiguous candidates, and not-found status.
- **Test results**: 5419 passed, 49 skipped, 0 failed.