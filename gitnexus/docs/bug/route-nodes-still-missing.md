# Bug Report: Route Nodes Still Missing After Fix

**Date:** 2026-04-02
**Status:** Investigating
**Severity:** High
**Related:** `docs/bug/route-and-endpoint-resolution-bugs.md`

---

## Summary

After implementing the debug logging fix for Bug 1, Route nodes are still not created despite:
- 102 Java controller files with `@Controller`/`@RestController` annotations
- 114 Class nodes in controller files
- 395 Method nodes in controller files
- 0 Route nodes in the graph

---

## Investigation

### What Works
- Class nodes ARE created for controllers (114 found)
- Method nodes ARE created for controller methods (395 found)
- Spring route extraction code exists and looks correct
- `extractSpringRoutes` is called during parsing (line 2349-2351)

### What Doesn't Work
- No `[route-resolution]` debug output during indexing
- 0 Route nodes in graph after indexing
- No DEFINES or CALLS edges from Route nodes

### Possible Causes

1. **Routes not extracted during parsing**
   - `extractSpringRoutes` might return empty array
   - Tree-sitter parsing might not find controller annotations
   
2. **Routes extracted but empty**
   - `result.routes` might be empty when passed to `processRoutesFromExtracted`
   - `isControllerClass` flag might not be set correctly

3. **Symbol resolution failing silently**
   - Debug logging only fires when `isVerboseIngestionEnabled()` is true
   - Need to check if routes are being extracted before checking resolution

---

## Next Steps

1. Add logging BEFORE `processRoutesFromExtracted` to see if routes array is empty
2. Add logging INSIDE `extractSpringRoutes` to see if routes are being extracted
3. Run with `GITNEXUS_VERBOSE=1` and capture full output
4. Check if the issue is in parsing (tree-sitter queries) or resolution (symbol table)

---

## Commands to Reproduce

```bash
# Clean and reindex
node dist/cli/index.js clean --all --force
node dist/cli/index.js analyze -v /path/to/tcbs-bond-trading

# Check Route nodes
node dist/cli/index.js cypher "MATCH (r:Route) RETURN COUNT(r)" -r tcbs-bond-trading
# Expected: > 0, Actual: 0

# Check Class nodes
node dist/cli/index.js cypher "MATCH (c:Class) WHERE c.filePath CONTAINS 'Controller' RETURN COUNT(c)" -r tcbs-bond-trading
# Result: 114 (works)

# Check Method nodes
node dist/cli/index.js cypher "MATCH (m:Method) WHERE m.filePath CONTAINS 'Controller' RETURN COUNT(m)" -r tcbs-bond-trading
# Result: 395 (works)
```

---

## Files to Investigate

- `src/core/ingestion/workers/parse-worker.ts:2349-2351` - route extraction call
- `src/core/ingestion/workers/spring-route-extractor.ts` - route extraction logic
- `src/core/ingestion/call-processor.ts:1378-1478` - route processing
- `src/core/ingestion/pipeline.ts:328-341` - route processing pipeline

---

## Additional Investigation (2026-04-02)

### Finding: Routes May Not Be Extracted

After checking:
- ✅ Class nodes exist (114 controller classes)
- ✅ Method nodes exist (395 controller methods)
- ✅ File nodes exist
- ❌ Route nodes = 0

### Possible Root Cause

The `processRoutesFromExtracted` function is called with `chunkWorkerData.routes ?? []`. If routes are not being extracted during parsing, this array will be empty.

**Two scenarios:**
1. Routes extracted but symbol resolution fails → Debug logging should fire
2. Routes NOT extracted → No debug output, empty routes array

Since **no debug output** appeared even with `GITNEXUS_VERBOSE=1`, scenario 2 is more likely.

### Next Steps

1. Add logging BEFORE `processRoutesFromExtracted` to check routes array length
2. Add logging INSIDE `extractSpringRoutes` to see if any routes are returned
3. Check if `SupportedLanguages.Java` detection is working correctly
4. Verify tree-sitter queries for `@Controller`/`@RestController` match Java annotations
