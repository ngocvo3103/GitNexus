# Document-Endpoint Test Results

**Date:** 2026-04-02
**Endpoint:** `PUT /e/v1/bookings/{productCode}/suggest`
**Repository:** tcbs-bond-trading + 5 dependencies

---

## Test Output Files

| File | Size | Description |
|------|------|-------------|
| `endpoint-with-context.json` | 31,884 bytes | With source context for AI enrichment |
| `endpoint-no-context.json` | 8,078 bytes | Without source context |
| `endpoint-openapi-no-strict.json` | 8,143 bytes | OpenAPI mode, no strict validation |
| `endpoint-openapi-strict.json` | 8,143 bytes | OpenAPI mode, strict validation |
| `endpoint-bundled-schema.json` | 2,557 bytes | Bundled schema (truncated) |

---

## Test Results Summary

### ✅ Passing

1. **Endpoint Resolution**: Correctly identifies `PUT /suggest` endpoint
2. **Request Parameters**: All 4 params extracted (`filter`, `order`, `level`, `isShowZeroBalance`)
3. **Response Codes**: 10 error codes detected (200 success + 9 error codes)
4. **Messaging Integration**: Inbound topic `b.e.q.trading.005032` correctly identified with full payload schema
5. **Persistence**: Tables detected (`productBondOnlineView, trading, customer, issuer, bond, experienceOrder`)

### ⚠️ Issues Found

#### Issue 1: `builder.toUriString()` Not Resolved

**Severity:** Medium
**Location:** `externalDependencies.downstreamApis[1]` and `[2]`

```json
{
  "serviceName": "unknown-service",
  "endpoint": "GET builder.toUriString()",
  "condition": "TODO_AI_ENRICH",
  "purpose": "TODO_AI_ENRICH"
},
{
  "serviceName": "unknown-service",
  "endpoint": "POST builder.toUriString()",
  "condition": "TODO_AI_ENRICH",
  "purpose": "TODO_AI_ENRICH"
}
```

**Analysis:** The `builder.toUriString()` pattern is not being resolved. This is a Java `UriComponentsBuilder` pattern where the URL is constructed dynamically:
```java
UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(baseUrl);
// ... add query params
return builder.toUriString();
```

**Root Cause:** Bug 2 fix only handles `resolvedValue.startsWith('http') || resolvedValue.startsWith('/')`. The `builder.toUriString()` returns a method call, not a literal, so it falls through to the fallback.

**Recommendation:** Add pattern recognition for `builder.toUriString()` and similar builder patterns.

---

#### Issue 2: `serviceName: "unknown-service"` for Multiple APIs

**Severity:** Low
**Location:** `externalDependencies.downstreamApis`

Two downstream APIs show `serviceName: "unknown-service"`:
- The `builder.toUriString()` calls
- The `tcbs.profile.service` call shows correct URL but no service name context

**Analysis:** Service names are not being extracted from the code context. The `tcbs.profile.service` correctly resolves to `http://10.7.2.85:8092/` but the service name should be captured.

---

#### Issue 3: No Route Nodes Created

**Severity:** High
**Related:** `docs/bug/route-nodes-still-missing.md`

**Finding:** 0 Route nodes created despite 102 Java controller files. This is Bug 1 from the original bug report and is **NOT YET FIXED**.

The debug logging was added but the root cause (symbol resolution failure) was not addressed. Routes are being extracted during parsing but not processed into Route nodes due to `ctx.resolve()` failures.

---

### ✅ Working Correctly

1. **`tcbs.bond.product.url`** correctly resolved:
   ```json
   {
     "serviceName": "tcbs.bond.product.url",
     "endpoint": "GET /v1/products/attributes?marketType={marketType}&channel={channel}&lstAttribute={lstAttribute}",
     ...
   }
   ```

2. **`tcbs.profile.service`** correctly resolved:
   ```json
   {
     "serviceName": "tcbs.profile.service",
     "endpoint": "GET http://10.7.2.85:8092/",
     ...
   }
   ```

3. **Bug 3 Fix Working:** Cross-class constant resolution correctly finds static final field values

---

## External Dependencies Resolution

### Cross-Repo Dependencies

| Service | URL/Path | Resolution Status |
|---------|----------|-------------------|
| `tcbs.bond.product.url` | `/v1/products/attributes?...` | ✅ Resolved |
| `tcbs.profile.service` | `http://10.7.2.85:8092/` | ✅ Resolved |
| `unknown-service` | `builder.toUriString()` | ❌ Not resolved |
| Inbound MQ | `b.e.q.trading.005032` | ✅ Full payload schema |

---

## Recommendations

1. **High Priority:** Investigate why Route nodes are not being created (Bug 1)
   - Add logging before `processRoutesFromExtracted` to check if routes array is empty
   - Check if tree-sitter is correctly parsing Spring annotations
   - Verify symbol table is being populated correctly

2. **Medium Priority:** Add pattern recognition for `UriComponentsBuilder.toUriString()`
   - This is a common pattern in Spring RestTemplate calls
   - Should resolve to the constructed URL

3. **Low Priority:** Improve service name extraction
   - Extract service names from `@Value` annotations or configuration properties
