# Document-Endpoint Empty Results Investigation

**Date**: 2026-04-03
**Status**: Investigation Complete
**Endpoint**: PUT /e/v1/bookings/{productCode}/suggest

## Problem Summary

After reindexing tcbs-bond-trading and all dependencies, `document-endpoint` returns empty arrays for:
- `downstreamApis` (expected: 11)
- `outbound` (expected: 2)
- `inbound` (expected: 1)
- `validation` (expected: 24)

Only `params` and `body` are correctly populated.

## Test Output Files

| File | Size | Description |
|------|------|-------------|
| `docs/tmp/1-with-context.json` | 198,856 bytes | `--include-context` mode |
| `docs/tmp/2-no-context.json` | 43,121 bytes | Default mode |
| `docs/tmp/3-schema-no-strict.json` | 43,121 bytes | Schema validation (no strict) |
| `docs/tmp/4-schema-strict.json` | 43,121 bytes | Schema validation (strict) |
| `docs/tmp/5-bundled.json` | 43,121 bytes | Compact mode |

## Indexed Repositories

| Repository | Nodes | Edges | Clusters | Processes |
|------------|-------|-------|-----------|-----------|
| tcbs-bond-trading | 7,899 | 23,463 | 783 | 300 |
| bond-exception-handler | 126 | 279 | 13 | 4 |
| matching-engine-client | 187 | 313 | 34 | 0 |
| tcbs-bond-amqp | 126 | 241 | 14 | 6 |
| tcbs-bond-amqp-message | 30 | 40 | 1 | 0 |
| tcbs-bond-trading-core | 5,837 | 11,546 | 1,116 | 144 |

**Total Route nodes in tcbs-bond-trading**: 341

## Root Cause Analysis

### 1. Route Node Exists ✅

```cypher
MATCH (r:Route)
WHERE r.routePath = '/e/v1/bookings/{productCode}/suggest'
  AND r.httpMethod = 'PUT'
RETURN r
```
**Result**: Found - `BookingIConnectExtControllerV2.unhold` at line 107

### 2. Method Node Exists ✅

The handler method exists with annotations and parameter info.

### 3. CALLS Relationships Missing ❌

```cypher
MATCH (n:Method)-[r:CALLS]->(c)
```
**Error**: "Table CALLS does not exist"

### 4. Document-Endpoint Output

```json
{
  "method": "PUT",
  "path": "/e/v1/bookings/{productCode}/suggest",
  "params": 1,           // ✅ Correct
  "validation": 0,       // ❌ Expected: 24
  "downstreamApis": 0,   // ❌ Expected: 11
  "outbound": 0,         // ❌ Expected: 2
  "inbound": 0           // ❌ Expected: 1
}
```

## Root Cause

The ingestion pipeline is **not creating relationship edges** (CALLS, HANDLES_ROUTE, etc.) during indexing. LadybugDB returns "Table does not exist" errors for all relationship queries.

### Pre-existing Code Modifications

Git status shows modifications to core ingestion files:
- `src/core/ingestion/call-processor.ts`
- `src/core/ingestion/parsing-processor.ts`
- `src/core/ingestion/resolution-context.ts`
- `src/core/ingestion/workers/parse-worker.ts`

These modifications may have broken the edge creation logic.

## Test Artifacts

All test outputs saved in:
```
/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/tmp/
```

## Recommendation

**DO NOT FIX** - Requires deeper investigation of the ingestion pipeline. The pre-existing modifications to ingestion files need to be reviewed and potentially reverted.
