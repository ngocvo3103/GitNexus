# Bug: document-endpoint Tool - Empty downstreamApis and Incomplete logicFlow

**Status:** Investigation Complete - Root Cause Identified
**Discovered:** 2026-04-03
**Impact:** High - `document-endpoint` output is incomplete for certain endpoints

## Summary

The `document-endpoint` tool produces incomplete output for some endpoints:
- `logicFlow` shows only the handler method name with no downstream calls
- `downstreamApis` is `null` instead of showing downstream API dependencies

## Evidence

### Working Endpoint (GET /e/v1/bookings/{bondProductCode}/suggest)

```json
{
  "method": "GET",
  "path": "/e/v1/bookings/{bondProductCode}/suggest",
  "logicFlow": "suggest → suggestOrder → suggestOrderIcnPro → ... (many downstream calls)",
  "downstreamApis": null,
  "codeDiagram": "graph TB\n  subgraph Controller\n    A[suggest]\n  end\n  subgraph Service\n    B[suggestOrder]\n    ...\n  end\n  A --> B\n  B --> C"
}
```

### Broken Endpoint (PUT /e/v1/bookings/{productCode}/suggest)

```json
{
  "method": "PUT",
  "path": "/e/v1/bookings/{productCode}/suggest",
  "logicFlow": "unhold",
  "downstreamApis": null,
  "codeDiagram": "graph TB\n  subgraph Controller\n    A[unhold]\n  end"
}
```

### Graph Database Evidence

```
MATCH (m:Method {name: 'suggest'})-[rel]->(target) WHERE m.filePath CONTAINS 'BookingIConnectExtControllerV2'
=> CALLS to: suggestOrder, suggestOrderIcnPro (MatchingService) ✓

MATCH (m:Method {name: 'unhold'})-[rel]->(target) WHERE m.filePath CONTAINS 'BookingIConnectExtControllerV2'
=> 0 results ✗
```

## Root Cause

### CALLS Relationships Not Created for Method Calls on Interface-Typed Receivers

The issue is that CALLS relationships are not created when:
1. The receiver type is an interface (e.g., `SuggestionService`)
2. The method name is common (e.g., `process`) with multiple implementations
3. The interface type is captured via FILE_SCOPE bindings

**Source Code Pattern:**
```java
@Controller
public class BookingIConnectExtControllerV2 {
    // Field with interface type
    private final SuggestionService<SuggestionOrderResultDto, Map<String, Object>> unHoldSuggestionServiceImpl;
    
    public SuggestionOrderResultDto unhold(...) {
        return unHoldSuggestionServiceImpl.process(req);  // CALLS NOT CREATED
    }
}
```

**What Works:**
- `matchingServiceV2.suggestOrder(prm)` → CALLS created ✓
- `bondBookingServiceV2.getBookingInformation(...)` → CALLS created ✓

**What Doesn't Work:**
- `holdSuggestionServiceImpl.process(req)` → NO CALLS ✗
- `unHoldSuggestionServiceImpl.process(req)` → NO CALLS ✗

### Resolution Path Analysis

The call resolution in `call-processor.ts` follows these steps:
1. **Step 0**: FILE_SCOPE bindings resolve `unHoldSuggestionServiceImpl` → `SuggestionService` ✓
2. **Step D1**: Resolve `SuggestionService` → finds the interface ✓
3. **Step D2**: Widen candidates to all `process` methods (14 candidates)
4. **Step D3**: Filter by file path - should narrow to `SuggestionService.java`
5. **Step D4**: Filter by ownerId

The issue is likely in Steps D3 or D4 where the filtering fails to uniquely identify the correct `process` method.

### Related Bugs

1. **Fixed**: `typeEnvBindings` merge issue in parse-worker.ts - FILE_SCOPE bindings now properly passed
2. **This Issue**: CALLS relationships not created for interface-typed receivers with common method names

## Test Results

### Test Output Files

| File | Path | Size |
|------|------|------|
| test1-with-context.json | docs/tmp/ | 53,702 bytes |
| test2-no-context.json | docs/tmp/ | 36,611 bytes |
| test3-json-schema-no-strict.json | docs/tmp/ | 53,702 bytes |
| test4-json-schema-strict.json | docs/tmp/ | 53,702 bytes |
| test5-no-json-schema.json | docs/tmp/ | 12,189 bytes |
| suggest-endpoint.json | docs/tmp/ | - |

### Indexed Nodes

| Category | Count |
|----------|-------|
| Total nodes | 7,884 |
| Route nodes | 341 |
| Method nodes | 4,074 |
| CALLS relationships | 5,476 |

### External Dependencies

| Repository | Nodes | Edges | Status |
|------------|-------|-------|--------|
| tcbs-bond-trading-core | 5,834 | 11,515 | ✓ Indexed |
| bond-exception-handler | 116 | 175 | ✓ Indexed |
| matching-engine-client | 182 | 211 | ✓ Indexed |
| tcbs-bond-amqp | 112 | 152 | ✓ Indexed |
| tcbs-bond-amqp-message | 30 | 40 | ✓ Indexed |
| tcbs-bond-trading | 7,884 | 23,412 | ✓ Indexed |

## Files Affected

| File | Purpose |
|------|---------|
| `gitnexus/src/core/ingestion/call-processor.ts` | Call resolution logic |
| `gitnexus/src/mcp/local/trace-executor.ts` | Trace execution |
| `gitnexus/src/mcp/local/document-endpoint.ts` | API documentation generation |

## Next Steps

1. Add debug logging to `resolveCallTarget()` to trace why `process` with `SuggestionService` receiver fails
2. Implement interface-to-implementation resolution for Spring DI pattern
3. Consider adding fallback resolution that finds implementations of an interface