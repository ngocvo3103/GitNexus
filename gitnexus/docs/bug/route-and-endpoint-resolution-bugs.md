# Bug Report: Route Node Creation and Endpoint URL Resolution

**Date:** 2026-04-01
**Status:** Open
**Severity:** High (data loss + incorrect output)
**Repo:** tcbs-bond-trading + 5 dependencies

---

## Summary

Two critical bugs affecting GitNexus indexing and document-endpoint tool:

1. **Route nodes not created during indexing** — Despite 102 controller files with Spring annotations, **0 Route nodes** exist in the graph
2. **Endpoint URL resolution fails to use resolved values** — `resolvedValue` correctly resolves property placeholders but `endpoint` field shows raw variable names

---

## Bug 1: Route Nodes Not Created

### Observation

| Metric | Value |
|--------|-------|
| Route nodes in graph | **0** |
| Controller files with Spring annotations | 102 |
| Files with `@GetMapping/@PostMapping/@PutMapping/@DeleteMapping/@RequestMapping` | 105 |
| Class nodes | 587 |
| Method nodes | 4,074 |

### Root Cause

**File:** `src/core/ingestion/call-processor.ts:1378-1474`

Route node creation depends on successful symbol resolution:

```typescript
// Line 1393-1395
const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
if (!controllerResolved || controllerResolved.candidates.length === 0) continue;  // ❌ SKIPS HERE

// Line 1400-1402
const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
const methodId = methodResolved?.candidates[0]?.nodeId;

// Line 1407
if (!methodId) continue;  // ❌ SKIPS if method not resolved
```

**Why `ctx.resolve()` fails for Java classes:**
1. Java symbols are not indexed with proper `Class` nodes searchable by controller name
2. Resolution tier falls back to 'global' with ambiguous matches → skipped due to `controllerResolved.candidates.length > 1`

### Impact

- Route nodes not created for any Java Spring controllers
- `HANDLES_ROUTE` edges cannot be created (depends on Route nodes)
- Document-endpoint tool cannot match endpoint to Route nodes
- Cross-repo route resolution is impossible

### Fix Required

Investigate why `ctx.resolve()` fails for Java classes and methods. Possible causes:
1. `Symbol` nodes not created for Java classes/methods during parsing
2. `nodeId` on Symbol nodes not pointing to valid Class/Method nodes
3. Resolution context not including Java files properly

---

## Bug 2: Endpoint URL Resolution Not Using Resolved Values

### Observation

In `endpoint-with-context.json`, the `resolvedValue` is correctly computed but `endpoint` shows raw variable name:

```json
{
  "serviceName": "hold.suggestion.captcha.google.url",
  "endpoint": "GET captchaGoogleUrl",
  "resolutionDetails": {
    "serviceField": "captchaGoogleUrl",
    "serviceValue": "${hold.suggestion.captcha.google.url}",
    "resolvedValue": "https://www.google.com/recaptcha/api/siteverify?secret={secret}&response={response}"
  }
}
```

### Additional Examples

| serviceName | endpoint (current) | resolvedValue (correct) |
|-------------|-------------------|------------------------|
| `hold.suggestion.captcha.google.url` | `GET captchaGoogleUrl` | `https://www.google.com/recaptcha/api/siteverify...` |
| `tcbs.matching.service.url` | `POST url` | `http://apiintsit.tcbs.com.vn/matching-engine/` |
| `tcbs.bond.product.url` | `GET bondproductService` | `http://apiintsit.tcbs.com.vn/bond-product` |
| `services.hft-krema.cashInvestments.url` | `GET getCashInvestmentsUrl` | `http://apiintsit.tcbs.com.vn/hft-krema/v1/accounts/{customerTcbsId}/cashInvestments` |
| `tcbs.pricing.service.url` | `GET builder.toUriString()` | `http://apiintsit.tcbs.com.vn/fund-pricing` |
| `tcbs.profile.service` | `EXCHANGE url` | `http://10.7.2.85:8092/` |

### Root Cause

**File:** `src/mcp/local/document-endpoint.ts:969-980`

```typescript
let endpoint: string;
if (pathConstants.length > 0) {
  endpoint = `${detail.httpMethod} ${pathConstants[0].value}`;       // ✅ Works for static constants
} else if (parsed.staticParts.length > 0) {
  endpoint = `${detail.httpMethod} ${parsed.staticParts.join('')}`;  // ✅ Works for string literals
} else {
  endpoint = `${detail.httpMethod} ${detail.urlExpression}`;          // ❌ Falls back to raw name
}
```

**Problem:** The code never uses `resolvedValue` for the `endpoint` string. When URL resolution succeeds via `serviceValue`/`propertyKey`/`resolvedValue`, the result is stored in `resolutionDetails` but not used to build `endpoint`.

### Fix

Add condition to use `resolvedValue` when it's a complete URL:

```typescript
let endpoint: string;
if (pathConstants.length > 0) {
  endpoint = `${detail.httpMethod} ${pathConstants[0].value}`;
} else if (resolvedValue && resolvedValue.startsWith('http')) {
  endpoint = `${detail.httpMethod} ${resolvedValue}`;  // ADD THIS BRANCH
} else if (parsed.staticParts.length > 0) {
  endpoint = `${detail.httpMethod} ${parsed.staticParts.join('')}`;
} else {
  endpoint = `${detail.httpMethod} ${detail.urlExpression}`;
}
```

### Impact

- Document-endpoint output shows unresolved variable names instead of actual URLs
- OpenAPI generation shows incorrect URLs
- API documentation is misleading

---

## Bug 3: Cross-Class Constant Resolution Query Broken

### Observation

Constants like `captchaGoogleUrl`, `bondproductService`, `getCashInvestmentsUrl` are not resolved via cross-class query.

### Root Cause

**File:** `src/mcp/local/document-endpoint.ts:1136-1157`

```typescript
const crossClassQuery = `
  MATCH (c:Class)-[:HAS_FIELD]->(f:Field)
  WHERE f.name = $fieldName
    AND 'static' IN f.modifiers
    AND 'final' IN f.modifiers
    AND f.value IS NOT NULL
  RETURN c.name AS className, f.value AS value
  LIMIT 5
`;
```

**This query looks for `Field` nodes connected by `HAS_FIELD` relationships, but Field nodes do not exist in the graph.**

### Evidence

From `parse-worker.ts:2270-2277`:

```typescript
// Field extraction for DTO/Entity classes
let fields: string | undefined;
if (nodeLabel === 'Class' && definitionNode) {
  const classFields = extractClassFields(definitionNode, language);
  if (classFields.length > 0) {
    fields = JSON.stringify(classFields);  // Stored as JSON on Class node
  }
}
```

Fields are stored as a JSON string property on the Class node (`fields`), NOT as separate Field nodes with HAS_FIELD edges.

### Fix Required

Rewrite query to search within Class node's `fields` JSON property:

**Option A: Query Class nodes and parse JSON**
```typescript
const crossClassQuery = `
  MATCH (c:Class)
  WHERE c.fields CONTAINS $fieldName
  RETURN c.name AS className, c.fields AS fields
`;
// Then parse JSON and extract field value in TypeScript
```

**Option B: Pre-index constants during ingestion**
- Create separate Constant nodes during parsing
- Or add a searchable constants index

---

## Affected Files

| File | Bug | Role |
|------|-----|------|
| `src/core/ingestion/call-processor.ts` | Bug 1 | Route node creation |
| `src/mcp/local/document-endpoint.ts` | Bug 2, Bug 3 | URL resolution, constant query |
| `src/core/ingestion/workers/parse-worker.ts` | Bug 3 | Field storage format |

---

## Verification

### Bug 1: Route Nodes
```bash
# Query LadybugDB directly
sqlite3 .gitnexus/lbug/lbug.db "SELECT COUNT(*) FROM nodes WHERE label = 'Route'"
# Expected: > 0, Actual: 0
```

### Bug 2: Endpoint Resolution
```bash
# Check document-endpoint output
cat docs/tmp/endpoint-with-context.json | jq '.externalApis[] | select(.endpoint | test("captchaGoogleUrl|url|bondproductService"))'
# Shows resolvedValue correct but endpoint wrong
```

### Bug 3: Field Nodes
```bash
# Query for HAS_FIELD relationships
sqlite3 .gitnexus/lbug/lbug.db "SELECT COUNT(*) FROM relationships WHERE type = 'HAS_FIELD'"
# Expected: > 0, Actual: 0 (fields stored as JSON property, not nodes)
```

---

## Priority

1. **Bug 2** — Simple fix, high impact, affects all document-endpoint output
2. **Bug 1** — Blocks Route node creation, requires symbol resolution investigation
3. **Bug 3** — Optimization, can be worked around with Option A query rewrite

---

## Implementation Summary

**Date:** 2026-04-01
**Status:** Fixed

### Changes Made

#### Bug 1: Route Node Creation (Debug Logging Added)
**File:** `src/core/ingestion/call-processor.ts`

Added debug logging to identify symbol resolution failures:
- Logs `FAILED` when controller resolution returns no candidates
- Logs `AMBIGUOUS` when global tier returns multiple candidates with file paths
- Wrapped logging in `isVerboseIngestionEnabled()` check for performance

**Root Cause Investigation:** Tier 1 same-file lookup fails, falls back to Tier 3 (global) which returns multiple ambiguous candidates.

#### Bug 2: Endpoint URL Resolution
**File:** `src/mcp/local/document-endpoint.ts`

Added new branch in endpoint construction:
```typescript
} else if (resolvedValue && (resolvedValue.startsWith('http') || resolvedValue.startsWith('/'))) {
  endpoint = `${detail.httpMethod} ${resolvedValue}`;
}
```

Priority order: `pathConstants > resolvedValue (if URL/path) > staticParts > urlExpression`

#### Bug 3: Cross-Class Constant Query
**File:** `src/mcp/local/document-endpoint.ts`

Rewrote query to use `Class.fields` JSON property:
- Changed from `MATCH (c:Class)-[:HAS_FIELD]->(f:Field)` to `MATCH (c:Class) WHERE c.fields CONTAINS $fieldName`
- Added JSON parsing with `FieldInfo` type annotation
- Filters for `static` + `final` + `value !== undefined`
- Prefers URL-like values over plain strings

### Tests Added

| File | Tests | Purpose |
|------|-------|---------|
| `test/integration/java-route-creation.test.ts` | 7 | Bug 1 integration tests |
| `test/unit/document-endpoint-url-resolution.test.ts` | 7 | Bug 2 unit tests |
| `test/integration/cross-class-constant-resolution.test.ts` | 7 | Bug 3 integration tests |

**Total:** 21 tests passing

### Code Review Notes

- **Type Safety:** Added `FieldInfo` type import and cast for JSON.parse result
- **Debug Logging:** Wrapped in `isVerboseIngestionEnabled()` for performance
- **Performance:** Pre-existing N+1 patterns noted for future optimization
