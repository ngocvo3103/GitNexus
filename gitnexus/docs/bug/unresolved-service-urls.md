# Unresolved Service URLs in document-endpoint

**Date:** 2026-03-30
**Status:** PARTIALLY RESOLVED
**Priority:** P3 (Low)
**Updated:** 2026-03-31

## Current Status

**Resolved:** 9/11 services (82%)
**Unresolved:** 2/11 services (18%)

The `extractLocalVariableAssignments()` fix resolved most patterns. Remaining issues documented in `docs/bug/unresolved-service-patterns.md`.

## Summary

Originally 7 external API services showed as "unknown-service" in `document-endpoint` output. After fix, only 2 remain unresolved.

## Affected Endpoint

PUT /e/v1/bookings/{productCode}/suggest

## Evidence

```json
{
  "serviceName": "unknown-service",
  "endpoint": "POST url",
  "condition": "TODO_AI_ENRICH",
  "purpose": "TODO_AI_ENRICH",
  "_context": "// src/main/java/com/tcbs/bond/trading/service/impl/v2/MatchingServiceV2Impl.java:398-402\n\tprivate SuggestMatchingResponseDto getSuggestionMatching(SavingMarketDto prm, OrderDto booking) {\n\t\tString url = matchingUrl + pathSuggestion;\n\t\treturn restTemplate.postForObject(url, booking, Su..."
}
```

## Root Cause Analysis

### Pattern 1: Inline concatenation

```java
String url = matchingUrl + pathSuggestion;
restTemplate.postForObject(url, booking, SuggestMatchingResponseDto.class);
```

The tool extracts `url` as the endpoint but doesn't trace back to resolve `matchingUrl` + `pathSuggestion`.

### Pattern 2: URI builder

```java
String urlAccount = hftKremaServiceUrl + "/customers/{custodyCode}/accounts?accountType=normal";
```

Similar issue - the base URL variable is not resolved.

### Pattern 3: Exchange/External service

```java
String url = PROFILE_URL + "profiles/inside/policies/customer?tcbsUserId=" + tcbsId;
```

`PROFILE_URL` constant not resolved to actual service name.

## Expected Behavior

The tool should resolve:
- `matchingUrl` → `matching-engine-client` or `${matching.url}` property
- `hftKremaServiceUrl` → `${hft.krema.service.url}` property
- `PROFILE_URL` → actual service name

## Current Workaround

The `_context` field provides source location for manual investigation.

## Resolution Approach

1. Enhance `extractServiceName()` to trace variable assignments
2. Look for `@Value` annotations on class fields
3. Cross-reference with application.properties/Constants.java
4. Follow variable assignments back to field declarations

## Files to Investigate

- `src/core/ingestion/call-processor.ts` - Call extraction logic
- `src/mcp/local/document-endpoint.ts` - Endpoint document generation

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/unresolved-service-urls.md` |
| Bug Report | `docs/bug/unresolved-service-urls.md` |

## Root Cause

`HTTP_CALL_PATTERN` captures raw variable name but no logic traces back to assignment. `extractServiceName` at `document-endpoint.ts:965-979` is dead code.

## Fix Approach

Add pre-pass that builds map of local variable assignments, then lookup when processing HTTP calls.