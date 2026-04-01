# Bug: OpenAPI Flag Not Forwarded to documentEndpoint

**Date:** 2026-03-31
**Status:** RESOLVED
**Severity:** High
**Component:** LocalBackend - documentEndpoint tool
**Resolution Date:** 2026-03-31

## Resolution

Fixed by adding `openapi: params.openapi ?? false` to `DocumentEndpointOptions` in `LocalBackend.documentEndpoint()`.

**Verification:**
```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi | jq '.specs.request.body.typeName'
# "SuggestionOrderResultDto" ✓
```

## Original Summary

The `--openapi` CLI flag is correctly parsed and passed to `LocalBackend.callTool()`, but `LocalBackend.documentEndpoint()` does NOT forward it to the `documentEndpoint()` function.

## Evidence

### CLI passes flag correctly
`src/cli/tool.ts:201-206`:
```typescript
const response = await backend.callTool('document-endpoint', {
  method: options.method,
  path: options.path,
  depth: options.depth ? parseInt(options.depth, 10) : undefined,
  include_context: options.includeContext ?? false,
  compact: options.compact ?? false,
  openapi: options.openapi ?? false,  // ✓ Correctly passed
  repo: options.repo,
});
```

### LocalBackend does NOT forward openapi
`src/mcp/local/local-backend.ts:1920-1927`:
```typescript
const options: DocumentEndpointOptions = {
  method: params.method,
  path: params.path,
  depth: params.depth ?? 10,
  include_context: params.include_context ?? false,
  compact: params.compact ?? false,
  repo: params.repo,
  crossRepo,
  // ❌ MISSING: openapi: params.openapi ?? false
};
return documentEndpoint(repo, options);
```

### Result
Even when `--openapi` is specified, `DocumentEndpointOptions.openapi` is always `undefined`, defaulting to `false` in `documentEndpoint()`:
```typescript
const { ..., openapi = false, ... } = options;
```

This causes `buildDocumentation()` to receive `openapi: false`, which triggers the wrong branch:
```typescript
// Line 776-780
if (openapi || includeContext) {
  result.specs.request.body = embedNestedSchemas(requestBody, nestedSchemas);
  result.specs.response.body = embedNestedSchemas(responseBody, nestedSchemas);
} else {
  // ← Always hits this branch because openapi is false
  result.specs.request.body = bodySchemaToJsonExample(requestBody, nestedSchemas);
  result.specs.response.body = bodySchemaToJsonExample(responseBody, nestedSchemas);
}
```

## Impact

- OpenAPI output does NOT preserve BodySchema (includes validation annotations)
- OpenAPI output shows JSON example format instead of schema format
- No `required` array can be generated from validation annotations
- Users relying on `--openapi` for OpenAPI generation get incorrect output

## Test Case

```bash
# Expected: body should have "typeName" property (BodySchema format)
# Actual: body is JSON example format (no typeName)
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi | jq '.specs.request.body | has("typeName")'
# false (should be true)
```

## Root Cause

Missing property forwarding in `src/mcp/local/local-backend.ts:LocalBackend/documentEndpoint`.

## Fix

Add the missing line in `local-backend.ts`:

```typescript
const options: DocumentEndpointOptions = {
  method: params.method,
  path: params.path,
  depth: params.depth ?? 10,
  include_context: params.include_context ?? false,
  compact: params.compact ?? false,
  openapi: params.openapi ?? false,  // ← Add this line
  repo: params.repo,
  crossRepo,
};
```

## Files to Modify

1. `src/mcp/local/local-backend.ts` - Add `openapi: params.openapi ?? false` to `DocumentEndpointOptions`

## Verification

After fix:
```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi | jq '.specs.request.body | has("typeName")'
# true
```