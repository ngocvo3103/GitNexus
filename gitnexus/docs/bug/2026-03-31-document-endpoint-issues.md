# Document-Endpoint Tool Issues

**Date:** 2026-03-31
**Test Endpoint:** `PUT /e/v1/bookings/{productCode}/suggest`
**Repository:** tcbs-bond-trading

## Issue 1: Controller Name Undefined in summaryContext

**Severity:** MINOR
**Status:** OPEN

### Description
The `_context.summaryContext` shows `Handler: undefined.unhold()` instead of the actual controller name.

### Evidence
```json
{
  "_context": {
    "summaryContext": "Handler: undefined.unhold() → Chain: ..."
  }
}
```

### Expected
Should show actual controller name like `Handler: BookingIConnectExtControllerV2.unhold()`

### Root Cause (Suspected)
The `route.controller` property is undefined when building the summary. The route lookup may not be returning the controller name correctly.

### Files to Investigate
- `gitnexus/src/mcp/local/document-endpoint.ts` - where `summaryContext` is built
- `gitnexus/src/mcp/local/endpoint-query.ts` - where routes are queried

---

## Issue 2: URL Resolution Fails for Some Services

**Severity:** MINOR
**Status:** OPEN

### Description
Some downstream APIs show `serviceName: "unknown-service"` when URL resolution fails.

### Evidence
```json
{
  "serviceName": "unknown-service",
  "endpoint": "EXCHANGE url",
  "resolutionDetails": {
    "attemptedPatterns": ["url"],
    "enclosingClass": "ProfileServiceImpl",
    "filePath": "src/main/java/com/tcbs/bond/trading/service/impl/ProfileServiceImpl.java"
  }
}
```

### Root Cause (Suspected)
The URL resolution logic cannot trace dynamic URL construction patterns like:
```java
String url = PROFILE_URL + "profiles/inside/policies/customer?tcbsUserId=" + tcbsId;
```

Where `PROFILE_URL` is a constant or field that needs to be resolved separately.

### Impact
AI enrichment will have incomplete service URL information.

---

## Issue 3: No Cross-Repo Type Resolution

**Severity:** MAJOR
**Status:** OPEN

### Description
External dependencies (api, message types from other repos) are not resolved cross-repo. All types show `source: "indexed"` instead of `source: "external"` with `sourceRepo`.

### Evidence
```bash
$ cat put-bookings-suggest-with-context.json | jq '.. | objects | select(.source == "external")'
# (no output)
```

All 30 type sources show `"indexed"`:
```bash
$ cat put-bookings-suggest-with-context.json | jq '.. | objects | select(has("source")) | .source' | sort | uniq -c
30 "indexed"
```

### Expected
Types from external repos should show:
```json
{
  "typeName": "SomeExternalDto",
  "source": "external",
  "sourceRepo": "tcbs-bond-trading-core"
}
```

### Repositories Indexed
- tcbs-bond-trading (main)
- tcbs-bond-trading-core (external dependency)
- bond-exception-handler (external dependency)
- matching-engine-client (external dependency)
- tcbs-bond-amqp (external dependency)
- tcbs-bond-amqp-message (external dependency)

### Root Cause (Suspected)
1. Cross-repo type resolution may not be enabled or configured
2. `repo_manifest.json` may be missing or incomplete in tcbs-bond-trading
3. The `crossRepo` parameter may not be passed correctly to `documentEndpoint()`

### Files to Investigate
- `gitnexus/src/mcp/local/document-endpoint.ts` - crossRepo handling
- `tcbs-bond-trading/.gitnexus/repo_manifest.json` - dependency declarations
- `gitnexus/src/mcp/local/trace-executor.ts` - cross-repo type resolution

---

## Issue 4: Fuzzy Path Matching Too Loose

**Severity:** MINOR
**Status:** OPEN

### Description
When user specifies `--path "suggest"`, it matches a different endpoint (`/suggest`) instead of the expected `/e/v1/bookings/{productCode}/suggest`.

### Evidence
```bash
$ gitnexus document-endpoint --method PUT --path "suggest"
# Returns /suggest endpoint, not /e/v1/bookings/{productCode}/suggest
```

### Workaround
Use full path: `--path "/e/v1/bookings/{productCode}/suggest"`

### Suggestion
Improve path matching to:
1. Prefer longer/more specific matches
2. Score matches by path segment count
3. Show multiple candidates when ambiguous

---

## Test Results Summary

### All Modes Passed ✓
| Mode | Status | Output File |
|------|--------|-------------|
| `--include-context` | ✓ PASS | put-bookings-suggest-with-context.json |
| No context | ✓ PASS | put-suggest-no-context.json |
| `--schema-path` (no strict) | ✓ PASS | put-suggest-schema-no-strict.json |
| `--strict` | ✓ PASS | put-suggest-strict.json |
| `--openapi` (bundled schema) | ✓ PASS | put-suggest-openapi.json |

### callChain Removal Verified ✓
The `_context` field no longer contains `callChain`. Only `summaryContext` and `resolvedProperties` are present.

---

## Recommendations

1. **Priority 1:** Fix cross-repo type resolution (Issue 3)
2. **Priority 2:** Fix controller name in summaryContext (Issue 1)
3. **Priority 3:** Improve path matching (Issue 4)
4. **Priority 4:** Better URL resolution for dynamic patterns (Issue 2)
