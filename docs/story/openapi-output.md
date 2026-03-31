# OpenAPI Output for document-endpoint CLI

**Type:** Feature
**Created:** 2026-03-31
**Status:** in review

## Summary

Extend the `document-endpoint` CLI command to output OpenAPI 3.1.0 specification format (YAML/JSON). Users can generate OpenAPI specs directly from code analysis for API documentation, client generation, and contract testing.

## Context

GitNexus users wanted to generate OpenAPI specs from their codebase analysis. The existing `document-endpoint` command outputs a custom JSON format. This feature adds `--openapi` and related flags to output standard OpenAPI 3.1.0 YAML/JSON.

## Work Items Completed

- **WI-1**: OpenAPI TypeScript interfaces (`types.ts`) ✅
- **WI-2**: bodySchemaToOpenAPISchema function (`schema-builder.ts`) ✅
- **WI-3**: convertToOpenAPIPathItem function (`converter.ts`) ✅
- **WI-4**: convertToOpenAPIDocument function (`converter.ts`) ✅
- **WI-5**: OpenAPI CLI options (`index.ts`) ✅
- **WI-6**: documentEndpointCommand extension (`tool.ts`) ✅
- **WI-7**: js-yaml dependency (`package.json`) ✅

## New Files Created

| File | Purpose |
|------|---------|
| `gitnexus/src/core/openapi/types.ts` | OpenAPI 3.1.0 TypeScript interfaces |
| `gitnexus/src/core/openapi/schema-builder.ts` | BodySchema → OpenAPI Schema converter |
| `gitnexus/src/core/openapi/converter.ts` | DocumentEndpointResult → OpenAPI converter |
| `gitnexus/src/core/openapi/index.ts` | Public exports |
| `gitnexus/test/unit/openapi/converter.test.ts` | Unit tests (13 passing) |

## Modified Files

| File | Changes |
|------|---------|
| `gitnexus/package.json` | Added js-yaml and @types/js-yaml dependencies |
| `gitnexus/src/cli/index.ts` | Added new CLI options (--openapi, --format, --all-endpoints, --output, --title, --api-version) |
| `gitnexus/src/cli/tool.ts` | Extended command handler with OpenAPI conversion logic |

## Test Results

- **Backend**: 13 unit tests passed
- **Integration**: Tests not created for CLI handler (test strategy blocker)
- **Acceptance**: Not applicable (no UI work items)

## Code Review Summary

### Overall Verdict: ⚠️ APPROVED WITH NOTES

| Aspect | Verdict | Blockers | Majors |
|--------|---------|----------|--------|
| Completeness | ⚠️ NOTES | 0 | 0 |
| Design Quality | ⚠️ NOTES | 0 | 4 |
| Test Strategy | ⚠️ NOTES | 0 | 2 |
| Security | ✅ APPROVED | 0 | 0 |
| Performance | ⚠️ NOTES | 0 | 1 |
| Type Safety | ⚠️ NOTES | 0 | 4 |

### Fixed Blockers:
- `--all-endpoints` used non-existent tool 'endpoint-query' → Fixed to use 'endpoints'
- Dead code removed (unused variables, redundant branches)

### Known Issues (non-blocking):
- Missing test files for `types.ts` and `schema-builder.ts`
- Duplicate TYPE_MAP patterns could be consolidated
- N+1 pattern in all-endpoints loop (acceptable for CLI batch use)

## Deployment

- **Strategy**: N/A (CLI tool, no Docker deployment needed)
- **Status**: Build passes, tests pass

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/ancient-imagining-sunrise.md` |
| Research | `docs/research/openapi-libraries.md` |