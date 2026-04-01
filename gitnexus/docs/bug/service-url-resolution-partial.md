# Bug: Service URL Resolution Still Showing "unknown-service"

**Date:** 2026-03-31
**Status:** RESOLVED
**Severity:** Medium
**Component:** document-endpoint tool - service name resolution
**Resolution Date:** 2026-03-31

## Resolution

The `extractLocalVariableAssignments()` implementation now correctly resolves:
- `String url = matchingUrl + pathSuggestion;` → resolves `matchingUrl` field
- Direct field references like `bondproductService`

**Success rate:** 9/11 services resolved (82%)

## Remaining Issues

Two patterns still unresolved (see `docs/bug/unresolved-service-patterns.md`):
1. Static constant field references (`PROFILE_URL`)
2. URI builder patterns (`builder.toUriString()`)

## Original Summary

Some external API calls still show `serviceName: "unknown-service"` even after the variable assignment tracing fix. This indicates the fix is not complete or doesn't handle all patterns.

## Evidence

From `put-suggest-with-context.json`:
```json
{
  "serviceName": "unknown-service",
  "endpoint": "POST url",
  "_context": "// MatchingServiceV2Impl.java:398-402\nString url = matchingUrl + pathSuggestion;\nrestTemplate.postForObject(url, booking, ..."
}
```

```json
{
  "serviceName": "unknown-service",
  "endpoint": "GET captchaGoogleUrl",
  "_context": "// GoogleCaptchaServiceImpl.java:28-39\n..."
}
```

```json
{
  "serviceName": "unknown-service",
  "endpoint": "PUT url",
  "_context": "// MatchingServiceV2Impl.java:899-911\n..."
}
```

## Patterns Not Resolved

### Pattern 1: String concatenation (still failing)
```java
String url = matchingUrl + pathSuggestion;
restTemplate.postForObject(url, booking, ...);
```
Variable `matchingUrl` should resolve to `matchingUrl` field, then to `@Value` annotation.

### Pattern 2: Direct field reference
```java
restTemplateInternal.execGet(bondproductService, ...)
```
Should resolve `bondproductService` to `${tcbs.bond.product.url}`.

### Pattern 3: Captcha URL
```java
String secret = configurationProperties.getRecaptchaSecret();
restTemplate.getForObject(captchaGoogleUrl + ...)
```
`captchaGoogleUrl` is a field reference not resolved.

## Root Cause Analysis

The `extractLocalVariableAssignments` function extracts local variable assignments like `url = matchingUrl + pathSuggestion`, but:
1. The variable resolution may not be propagating to all call patterns
2. Field references in certain positions aren't being traced
3. The `matchingUrl` field resolution requires tracing through multiple levels

## Files to Investigate

1. `src/mcp/local/document-endpoint.ts` - `extractDownstreamApis` function
2. `src/mcp/local/document-endpoint.ts` - `extractLocalVariableAssignments` function
3. `src/mcp/local/document-endpoint.ts` - `traceVariableAssignment` function

## Test Command

```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --include-context | jq '.externalDependencies.downstreamApis[] | select(.serviceName == "unknown-service")'
```

## Partial Success

Some services ARE resolved correctly:
```json
{
  "serviceName": "tcbs.bond.settlement.service.url",
  "resolutionDetails": {
    "serviceField": "bondSettlementService",
    "serviceValue": "${tcbs.bond.settlement.service.url}"
  }
}
```

This shows the fix works for some patterns but not others.