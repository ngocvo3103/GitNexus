# Route Fix Verification - Findings

## Test Run: 2026-04-03

### Indexed Node Counts (tcbs-bond-trading)

| Node Type | Count |
|-----------|-------|
| Route     | 341   |
| Method    | 4,074 |
| Class     | 587   |
| File      | 960   |

### Document-Endpoint Results: PUT /e/v1/bookings/{productCode}/suggest

All fresh test outputs (run at 18:12 on Apr 3) for `/e/v1/bookings/{productCode}/suggest`:

| Mode | File | Size | downstreamApis | outbound | inbound | validation | params | hasContext |
|------|------|------|----------------|----------|---------|------------|--------|------------|
| no-context | 1-no-context.json | 43,123 | 11 | 2 | 1 | 24 | 1 | no |
| with-context | 2-with-context.json | 198,858 | 11 | 2 | 1 | 24 | 1 | yes |
| schema-no-strict | 3-schema-no-strict.json | 67,545 | 11 | 2 | 1 | 24 | 1 | no |
| schema-strict | 4-schema-strict.json | 67,545 | 11 | 2 | 1 | 24 | 1 | no |
| bundled | 5-bundled.json | 43,123 | 11 | 2 | 1 | 24 | 1 | no |

### Issues Found

#### 1. Outbound Message Fields Missing (queue, routingKey, payload)
The 2 outbound messages have `serviceName` and `endpoint` populated, but `queue` and `routingKey` are `undefined` and `payload` type is absent.

Example:
```json
{
  "serviceName": "tcbs.bond.amqp.otp.topic.exchange",
  "endpoint": "POST /v1/otp/send",
  "condition": "TODO_AI_ENRICH",
  "purpose": "TODO_AI_ENRICH"
}
```

Expected fields `queue`, `routingKey`, `payload` are not populated.

#### 2. Bundled vs No-Context Are Identical
Files `5-bundled.json` and `1-no-context.json` have the same byte size (43,123) and identical keys. The `--compact` flag without `--include-context` produces no visible difference from the base mode.

#### 3. Path Matching is Exact - Shorter Paths Return Empty Results
Using path `bookings/{productCode}/suggest` (without `/e/v1/` prefix) returns `downstreamApis=0`. The endpoint only resolves with the full prefix `/e/v1/bookings/{productCode}/suggest`. This may be expected behavior but was not clearly documented.

#### 4. Schema-No-Strict vs Schema-Strict Are Identical
Files `3-schema-no-strict.json` and `4-schema-strict.json` are exactly the same size (67,545 bytes). The `--strict` flag does not produce different output for this endpoint (no schema validation errors occurred, so both modes behave the same).

### What Works Correctly
- External API dependencies (downstreamApis=11) are correctly looked up and resolved
- Validation rules are populated (24 items)
- Request params are extracted (1 path param: productCode)
- Inbound messaging is detected (1 listener)
- Context enrichment (`--include-context`) produces valid large JSON with `_context` fields
- Node counts show 341 Route nodes were created (regression from previous bug where Route nodes were missing)

## Implementation Summary

**Date**: 2026-04-03

### WI-1: Payload Extraction ✓

- Enhanced regex patterns in `trace-executor.ts` for:
  - `convertAndSend` (3-arg, 2-arg, single-quoted variants)
  - `kafkaTemplate.send`
  - `streamBridge.send`
- Captured payload argument from messaging calls
- Changed trigger from hardcoded `TODO_AI_ENRICH` to `node.name || 'TODO_AI_ENRICH'`
- Refactored ~200 lines into `extractMessagingPattern` helper function
- Moved 10 regex patterns to module level for performance

### WI-2: Path Suffix Matching ✓

- Modified `pathsMatchStructurally` in `document-endpoint.ts` to support suffix matching
- When segment counts differ, compares from END of both paths
- Preserves equal-length exact matching behavior
- Exported `pathsMatchStructurally` and `extractMessaging` for testing

### Test Results

- 30 new tests passing
- All trace-executor tests pass (82 tests)
- Pre-existing failures in document-endpoint.test.ts (resolveBuilderUrl) unrelated to this work

### Code Quality

- 1 BLOCKER fixed (code duplication → helper function)
- 1 MAJOR fixed (regex compilation → module-level patterns)

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/route-fix-verification-issues.md` |
