# Bug Report: Document-Endpoint Incomplete Output

**Date:** 2026-04-02
**Status:** Investigated
**Severity:** Medium
**Endpoint Tested:** `PUT /e/v1/bookings/{productCode}/suggest`

---

## Symptom Inventory

When calling `document-endpoint` for `PUT /e/v1/bookings/{productCode}/suggest`, the output is missing:

1. **`handlerClass` / `handlerMethod` fields** - Not present in output
2. **`logicFlow`** - Contains only `"TODO_AI_ENRICH"` placeholder
3. **`externalDependencies.downstreamApis`** - Empty array
4. **`validation` field** - Not populated with extracted validation rules

The Route node exists with correct handler info:
- Route: `PUT /e/v1/bookings/{productCode}/suggest`
- controllerName: `BookingIConnectExtControllerV2`
- methodName: `unhold`
- filePath: `src/main/java/com/tcbs/bond/trading/controller/external/v2/BookingIConnectExtControllerV2.java`

---

## Root Cause Analysis

### Issue 1: Missing `handlerClass` / `handlerMethod` Fields

**Proximate Cause:** `DocumentEndpointResult` interface does not define `handlerClass` or `handlerMethod` fields.

**Root Cause:** Schema design oversight. The handler information is available from `route.controller` and `route.handler` (line 802) but is only included in `_context.summaryContext` when `includeContext` is true.

**Evidence:**
- `src/mcp/local/document-endpoint.ts:234-266` - `DocumentEndpointResult` interface has no `handlerClass` or `handlerMethod` fields
- `src/mcp/local/document-endpoint.ts:800-805` - Handler info is only added to `_context.summaryContext`:
  ```typescript
  if (includeContext) {
    result._context = {
      summaryContext: `Handler: ${route.controller ?? 'Unknown'}.${route.handler}() ...`,
    };
  }
  ```

**Fix Location:** `src/mcp/local/document-endpoint.ts`
- Add `handlerClass` and `handlerMethod` to `DocumentEndpointResult` interface (line 234-266)
- Populate these fields in `buildDocumentation` using `route.controller` and `route.handler`

---

### Issue 2: `logicFlow` is TODO_AI_ENRICH Placeholder

**Proximate Cause:** Line 797 explicitly sets `logicFlow` to `TODO_AI_ENRICH`:
```typescript
// Generate logic flow placeholder
result.logicFlow = TODO_AI_ENRICH;
```

**Root Cause:** No implementation exists to generate actual logic flow. The `logicFlow` field is intended for AI enrichment but has no fallback or basic implementation.

**Evidence:**
- `src/mcp/local/document-endpoint.ts:797` - Hardcoded assignment
- No other code references `logicFlow` generation

**Fix Location:** `src/mcp/local/document-endpoint.ts:797`
- Option A: Generate basic logic flow from chain node names (e.g., `handler → callee1 → callee2`)
- Option B: Keep as-is and document that this field requires AI enrichment

---

### Issue 3: Empty `downstreamApis`

**Proximate Cause:** `extractDownstreamApis` returns empty array when chain nodes have no `httpCallDetails`.

**Root Cause:** Multiple potential causes:

1. **No CALLS edges from handler:** If the handler method doesn't call other methods that make HTTP calls, the chain will be short and have no HTTP call details.

2. **HTTP call patterns not detected:** The `extractMetadata` function in trace-executor uses regex patterns to detect HTTP calls. If the code uses patterns not matched, calls won't be extracted.

3. **Chain depth too shallow:** Default `depth` is 10, but if the chain is short, there may not be enough nodes.

**Evidence:**
- `src/mcp/local/document-endpoint.ts:817-827` - Iterates `chain[].metadata.httpCallDetails`
- `src/mcp/local/trace-executor.ts:266-350` - `extractMetadata` extracts HTTP call patterns
- `src/mcp/local/trace-executor.ts:166-197` - HTTP_PATTERNS and HTTP_CALL_PATTERN regex

**Key Pattern Detection:**
```typescript
// Line 196-197: Detects restTemplate/webClient calls
const HTTP_CALL_PATTERN = /(?:restTemplate|webClient)\.(\w+)\s*\(\s*((?:[^,\n()]|\([^)]*\))+)/g;
const EXEC_CALL_PATTERN = /\bexec(Get|Post|Put|Delete)\s*\(\s*((?:[^,\n()]|\([^)]*\))+)/g;
```

**Investigation Needed:**
1. Check if `chain.length > 1` (handler calls other methods)
2. Check if handler content contains HTTP call patterns
3. Check if CALLS edges exist from handler method

**Fix Location:** 
- If no CALLS edges: Fix call-processor to create edges (see route-nodes-still-missing.md)
- If patterns not detected: Add more HTTP call patterns to `extractMetadata`

---

### Issue 4: Missing `validation` Field

**Proximate Cause:** `extractValidationRules` may not be extracting validation rules correctly.

**Root Cause:** Needs investigation. The function exists and is called at line 790.

**Evidence:**
- `src/mcp/local/document-endpoint.ts:790` - `extractValidationRules(handler, requestBody, chain, includeContext)` called
- `src/mcp/local/document-endpoint.ts:2504-2680` - `extractValidationRules` implementation

**Key Code Path:**
```typescript
// Line 786-791
const handler = chain.find(n => n.depth === 0);
if (handler) {
  result.specs.request.params = extractRequestParams(handler, includeContext);
  result.specs.request.validation = extractValidationRules(handler, requestBody, chain, includeContext);
}
```

**Investigation Needed:**
1. Check if `handler` is found (chain should have at least 1 node)
2. Check if `handler.parameterAnnotations` contains validation annotations
3. Check if `extractValidationRules` returns non-empty array

**Potential Issues:**
- `extractValidationRules` searches for imperative validation patterns (lines 2534-2617)
- Pattern matching may not detect all validation methods
- Validation annotations on parameters may not be extracted

**Fix Location:** `src/mcp/local/document-endpoint.ts:2504-2680`

---

## Competing Hypotheses

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| H1: Chain has only Route node (no Method) | ELIMINATED | User confirms Route has correct handler info; `documentEndpoint` constructs `handlerUid` from route and calls `executeTrace` |
| H2: Method node not found by UID | POSSIBLE | Need to verify Method node exists in graph |
| H3: No CALLS edges from Method | LIKELY | If no downstream calls, chain = [handler only] |
| H4: HTTP patterns not matched | POSSIBLE | Code may use patterns not in HTTP_PATTERNS |
| H5: Validation extraction failing | NEEDS CHECK | Function exists, need to verify extraction |

---

## Blast Radius

**Files to Modify:**
1. `src/mcp/local/document-endpoint.ts` - Add handler fields, improve logicFlow, fix validation extraction
2. `src/mcp/local/trace-executor.ts` - Add more HTTP call patterns if needed
3. `src/core/ingestion/call-processor.ts` - Ensure CALLS edges are created

**Tests to Update:**
- `test/unit/document-endpoint.test.ts` - Add tests for new fields
- `test/unit/trace-executor.test.ts` - Add HTTP call pattern tests

---

## Work Items

### WI-1: Add handlerClass/handlerMethod to Output [P1]
**What:** Add `handlerClass` and `handlerMethod` fields to `DocumentEndpointResult`
**Why:** User expects to see which controller/method handles the endpoint
**Files:** `src/mcp/local/document-endpoint.ts:234-266` (interface), `689-806` (buildDocumentation)
**Test:** Verify output contains `handlerClass: "BookingIConnectExtControllerV2"` and `handlerMethod: "unhold"`

### WI-2: Implement Basic logicFlow [P2]
**What:** Generate basic logic flow from chain node names instead of TODO_AI_ENRICH
**Why:** Users need to see call chain even without AI enrichment
**Files:** `src/mcp/local/document-endpoint.ts:797`
**Test:** Verify `logicFlow` contains "unhold → methodName → ..." for endpoints with calls

### WI-3: Debug Empty downstreamApis [P1]
**What:** Investigate why downstream APIs are not extracted
**Why:** Critical for understanding external dependencies
**Files:** `src/mcp/local/trace-executor.ts:266-350` (metadata extraction), `document-endpoint.ts:817-1010`
**Test:** Add test case with RestTemplate/webClient calls

### WI-4: Fix Validation Extraction [P2]
**What:** Ensure `extractValidationRules` correctly extracts validation from handler parameters
**Why:** Users need to know request validation rules
**Files:** `src/mcp/local/document-endpoint.ts:2504-2680`
**Test:** Verify validation rules appear in output

---

## Verification Commands

```bash
# Check if Route node exists
node dist/cli/index.js cypher "MATCH (r:Route) WHERE r.routePath CONTAINS '/suggest' RETURN r" -r tcbs-bond-trading

# Check if Method node exists
node dist/cli/index.js cypher "MATCH (m:Method) WHERE m.filePath CONTAINS 'BookingIConnectExtControllerV2' AND m.name = 'unhold' RETURN m" -r tcbs-bond-trading

# Check CALLS edges from handler
node dist/cli/index.js cypher "MATCH (m:Method {name: 'unhold'})-[r:CALLS]->(c) RETURN c.name" -r tcbs-bond-trading

# Check handler parameter annotations
node dist/cli/index.js cypher "MATCH (m:Method) WHERE m.filePath CONTAINS 'BookingIConnectExtControllerV2' AND m.name = 'unhold' RETURN m.parameterAnnotations" -r tcbs-bond-trading
```

---

## Related Bugs

- `docs/bug/route-nodes-still-missing.md` - Route nodes not being created
- `docs/bug/document-endpoint-test-results.md` - Previous test results
- `docs/bug/route-and-endpoint-resolution-bugs.md` - Original bug report
---

## Investigation Results (2026-04-02)

### Verification Findings

**Method Node Exists:**
```
m.name: unhold
m.filePath: src/main/java/com/tcbs/bond/trading/controller/external/v2/BookingIConnectExtControllerV2.java
m.parameterAnnotations: [
  {"name":"jwt","type":"TcbsJWT","annotations":[]},
  {"name":"request","type":"HttpServletRequest","annotations":[]},
  {"name":"productCode","type":"String","annotations":["PathVariable"]},
  {"name":"prm","type":"SuggestionOrderResultDto","annotations":["RequestBody"]}
]
```

**CALLS Edges:**
- Total CALLS relationships: 341
- All 341 are from Route → Method (not Method → Method)
- Handler method `unhold` has **NO outgoing CALLS edges**

**Root Cause for Empty downstreamApis:**
The handler method `unhold` doesn't have any CALLS edges to other methods. This means:
1. The trace chain contains only the handler method
2. `extractDownstreamApis` iterates over `chain[].metadata.httpCallDetails`
3. Since chain has only 1 node (the handler), there are no downstream calls to extract

**This is expected behavior if the method doesn't call other methods with HTTP calls.**

### What IS Working
- ✅ Route nodes created (341 total)
- ✅ Route → Method CALLS edges exist
- ✅ Method node has correct parameter annotations
- ✅ Inbound messaging detected from code patterns
- ✅ Request body schema extracted from parameter types

### What Needs Fixing
1. **handlerClass/handlerMethod in output** - Schema missing these fields
2. **logicFlow** - Only TODO_AI_ENRICH placeholder
3. **Validation** - Need to verify extraction logic

### Recommendations

1. **Add handler fields to output** (P1) - Simple schema change
2. **Implement basic logicFlow** (P2) - Generate from chain node names
3. **Investigate Method → Method CALLS** (P2) - If method calls should be traced, check call-processor

