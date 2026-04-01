# Bug: Two Service URL Patterns Still Unresolved

**Date:** 2026-03-31
**Status:** RESOLVED (Pattern 2)
**Severity:** Medium
**Component:** document-endpoint tool - Service URL resolution
**Updated:** 2026-03-31

## Resolution Progress

### WI-2: Uppercase constant detection ✅ COMPLETE
`extractBaseField()` now accepts uppercase constants (`PROFILE_URL`, `BASE_URL`, etc.)

### WI-4: URI Builder patterns ✅ COMPLETE
Implemented full support for `UriComponentsBuilder.fromHttpUrl/fromUriString` patterns:
1. **Pattern detection** (`trace-executor.ts`): Captures builder variable and base URL expression from `UriComponentsBuilder` constructor
2. **StringBuilder tracing** (`document-endpoint.ts`): `traceStringBuilderConstruction()` traces `StringBuilder` back to its base field
3. **Resolution chain**: `fromUriString(url.toString())` → `StringBuilder` → `pricingServiceBaseUrl` → `@Value` → service name

**Verification:**
```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --include-context | jq '.externalDependencies.downstreamApis[] | select(.endpoint | contains("builder"))'
# Returns: serviceName: "tcbs.pricing.service.url" (resolved!)
```

### WI-3: External library constants ⏸️ KNOWN LIMITATION
`PROFILE_URL` is imported from an unindexed dependency. Cannot resolve constants from external libraries.

## Current Success Rate

- **Resolved:** 10/11 services (91%)
- **Unresolved:** 1/11 services (9%) - external library constant

## Implementation Details

### Pattern 2 Resolution (URI Builder)

```java
// Code pattern:
StringBuilder url = new StringBuilder(pricingServiceBaseUrl + PRICING_CONDITION_PATH);
UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(url.toString());
restTemplate.getForObject(builder.toUriString(), ...);
```

**Resolution chain:**
1. `URI_BUILDER_PATTERN` regex detects: `builder = UriComponentsBuilder.fromUriString(url.toString())`
2. `traceStringBuilderConstruction()` finds: `StringBuilder url = new StringBuilder(pricingServiceBaseUrl + ...)`
3. `extractBaseField()` extracts: `pricingServiceBaseUrl`
4. `resolveValueAnnotation()` resolves: `@Value("${tcbs.pricing.service.url}")` → `tcbs.pricing.service.url`

## Files Modified

1. `src/mcp/local/trace-executor.ts` - Added `BuilderDetail` interface and `URI_BUILDER_PATTERN` extraction
2. `src/mcp/local/document-endpoint.ts` - Added `resolveBuilderUrl()` and `traceStringBuilderConstruction()` functions

## Related

- `docs/bug/unresolved-service-urls.md` - Original bug report (resolved by `extractLocalVariableAssignments()`)
- `docs/bug/service-url-resolution-partial.md` - Follow-up bug report (partially resolved)