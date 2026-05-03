# Fix: document-endpoint wrong downstream APIs - lists all class methods instead of called ones

**Type:** Bug
**Created:** 2026-05-02
**Status:** in review

## Implementation Summary

- **WI-1**: Added `lineNumber?: number` to `HttpCallDetail` interface. Modified `extractMetadata` to accept optional `startLine`/`endLine` parameters. All three extraction loops (HTTP_CALL_PATTERN, EXEC_CALL_PATTERN, FEIGN_HTTP_ANNOTATION_PATTERN) now track line numbers. Added post-extraction filtering that removes `httpCallDetails` entries outside the handler's line range. Updated call site in `executeTrace` to pass `nodeInfo.startLine` and `nodeInfo.endLine`. Backward compatible: when line range is not provided, all entries are included.
- **WI-2**: Added 11 unit tests in `test/unit/metadata-filtering.test.ts` covering: handler line range filtering, sibling method exclusion, backward compatibility (no line range), boundary lines, FeignClient annotation filtering, exec-style call filtering, lineNumber field population, empty content, and partial line range scenarios.
- **Test results**: 3403 passed, 4 skipped, 0 regressions. 15 pre-existing failures in unrelated test files (ast-cache, repo-manager, settings-service).

## Summary

The `document-endpoint` tool lists all HTTP methods for a service path as downstream APIs instead of only the methods actually called by the handler. For example, `GET /api/orders/{id}` which only calls `orderService.getOrder()` incorrectly includes `DELETE /api/orders/{id}` in `downstreamApis`.

## Context

Root cause: `extractMetadata` in `trace-executor.ts` scans the entire content field of a chain node for HTTP call patterns. When the graph stores content at the class level, all methods' HTTP calls are extracted, not just the handler's. Fix requires filtering `httpCallDetails` to only include calls within the handler's line range (`startLine`–`endLine`). GitHub issue: #27.

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/downstream-apis-method-filter.md` |
| Backend spec | `docs/context/downstream-apis-method-filter.md` |
| Solution design | `docs/designs/downstream-apis-method-filter-solution-design.md` |
| Test strategy | `docs/qa-issues/downstream-apis-method-filter-test-strategy.md` |