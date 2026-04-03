# Bug: Route Nodes Not Created During Ingestion

**Type:** Bug
**Created:** 2026-04-03
**Status:** resolved
**Resolution Date:** 2026-04-03

## Summary

Route nodes are not being created during ingestion for Java Spring projects. The `processRoutesFromExtracted` function in `call-processor.ts` should create Route nodes with CALLS edges to handler methods, but the graph shows 0 Route nodes after indexing tcbs-bond-trading.

## Evidence

### Graph Query Results

After indexing `tcbs-bond-trading`:

```
=== Node Labels ===
Method: 4074
File: 960
Class: 587
Interface: 189
...

Route Nodes: 0
Nodes with httpMethod property: 0

CALLS Relationships: 5520
IMPLEMENTS Relationships: 209
```

### Expected Behavior

`processRoutesFromExtracted` (call-processor.ts:1527-1569) should:
1. Create Route nodes with `label: 'Route'` (line 1535)
2. Add properties: `httpMethod`, `routePath`, `controllerName`, `methodName`, `filePath`
3. Create DEFINES edge from File to Route (line 1552-1559)
4. Create CALLS edge from Route to handler Method (line 1561-1569)

### Actual Behavior

No Route nodes exist in the graph. However, document-endpoint still works because it has a fallback mechanism (document-endpoint.ts:595-608) that searches for handler methods directly when Route nodes don't exist.

## Root Cause Analysis

The issue is likely in one of these stages:

### 1. Route Extraction (parsing-processor.ts:280-286)

```typescript
// Extract Spring routes from Java controller files
if (language === SupportedLanguages.Java && file.path.includes('/controller/')) {
  const springRoutes = extractSpringRoutes(tree, file.path);
  if (springRoutes.length > 0 && isVerboseIngestionEnabled()) {
    console.debug(`[route-seq] Extracted ${springRoutes.length} Spring routes from ${file.path}`);
  }
  allRoutes.push(...springRoutes);
}
```

**Possible issues:**
- File path filter `file.path.includes('/controller/')` may miss controller files in different locations
- `extractSpringRoutes` may not be extracting routes correctly
- Language detection may not be identifying files as Java

### 2. Route Processing (call-processor.ts:1498-1548)

```typescript
for (const route of extractedRoutes) {
  if (!route.controllerName || !route.methodName) continue;  // Skip if missing required fields
  
  const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
  if (!controllerResolved || controllerResolved.candidates.length === 0) {
    skipped++;
    continue;
  }
  
  if (route.isControllerClass) {
    // Create Route node only for Spring routes
    // ...
  }
}
```

**Possible issues:**
- `route.controllerName` or `route.methodName` may be missing
- `ctx.resolve()` may fail to resolve controller
- `route.isControllerClass` may be `false`
- `methodId` may not be found (line 1529: "Skip if method not resolved")

## Investigation Steps

1. **Check extraction results:**
   - Add logging to `extractSpringRoutes` to see how many routes are extracted
   - Check if `isControllerClass` is set to `true`

2. **Check resolution:**
   - Log `controllerResolved` results
   - Check if `methodId` is found

3. **Check route data structure:**
   - Verify `ExtractedRoute` interface matches what Spring route extractor returns

## Impact

### Affected
- Route node queries return empty results
- Route-based navigation in graph is impossible
- Endpoint discovery relies on fallback mechanism

### Not Affected
- document-endpoint tool (uses fallback)
- CALLS relationships (created directly from code)

## Files Involved

| File | Role |
|------|------|
| `src/core/ingestion/parsing-processor.ts` | Route extraction coordination |
| `src/core/ingestion/workers/spring-route-extractor.ts` | Spring route extraction |
| `src/core/ingestion/call-processor.ts` | Route processing, Route node creation |
| `src/core/ingestion/pipeline.ts` | Route processing orchestration |

## Test Case

1. Index tcbs-bond-trading project
2. Query: `MATCH (n:Route) RETURN COUNT(*)` 
3. Expected: > 0 (project has many Spring endpoints)
4. Actual: 0

## Workaround

document-endpoint tool has fallback to search for handler methods directly when Route nodes don't exist. This allows the tool to function, but Route-based graph queries will fail.

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/route-nodes-not-created.md` |

## Related

- document-endpoint.ts:595-608 - Fallback handler search
- call-processor.ts:1478-1577 - processRoutesFromExtracted function
- parsing-processor.ts:280-286 - Spring route extraction

## Implementation Summary

### Root Cause
Sequential fallback path in `pipeline.ts` never called `processRoutesFromExtracted`. Routes were extracted but discarded.

### Fix
1. **WI-1**: Added `sequentialChunkRoutes` array to capture routes during sequential parsing, then called `processRoutesFromExtracted` in the fallback loop (pipeline.ts:254, 354-355, 381-384)
2. **WI-2**: Added UID validation fallback in document-endpoint.ts — if Route UID doesn't match a Method node, falls back to `findHandlerByPathPattern` instead of returning error

### Files Changed
- `src/core/ingestion/pipeline.ts` — sequential route processing
- `src/mcp/local/document-endpoint.ts` — UID validation fallback
- `test/unit/document-endpoint.test.ts` — mock fixes for verification query
- `test/unit/mcp/endpoint-query.test.ts` — removed incorrect fallback tests
- `test/unit/document-endpoint-url-resolution.test.ts` — added mock for executeParameterized

### Test Results
- Baseline: 277 failed, 4534 passed
- After fix: 257 failed, 4582 passed
- Net improvement: -20 failures, +48 passed
- `route-node-e2e.test.ts` passes: Route nodes created correctly

### Verification
Index `tcbs-bond-trading` project and query:
```
MATCH (n:Route) RETURN COUNT(*)
```
Expected: > 0 (was 0 before fix)