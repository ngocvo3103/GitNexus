# Bug: OpenAPI Output Missing `required` Fields

**Date:** 2026-03-31
**Status:** RESOLVED (root cause identified)
**Severity:** Medium
**Component:** document-endpoint tool - OpenAPI generation
**Root Cause:** `docs/bug/openapi-flag-not-forwarded.md`

## Root Cause

The `--openapi` CLI flag is NOT forwarded from `LocalBackend.documentEndpoint()` to `documentEndpoint()`. The flag is parsed correctly in CLI and passed to `callTool()`, but `local-backend.ts:1920-1927` omits the `openapi` parameter from `DocumentEndpointOptions`.

**Fix:** Add `openapi: params.openapi ?? false` to `DocumentEndpointOptions` in `LocalBackend.documentEndpoint()`.

## Original Summary

OpenAPI output does not include `required` array for request body properties, even though validation annotations (`@NotEmpty`, `@NotNull`) are correctly detected in the body schema.

## Evidence

### OpenAPI requestBody (actual)
```yaml
requestBody:
  description: Request body
  content:
    application/json:
      schema:
        type: object
        example:
          order:
            action: string
            quantity: 0
            # ... no required array
```

### Expected OpenAPI requestBody
```yaml
requestBody:
  description: Request body
  content:
    application/json:
      schema:
        type: object
        required:
          - order
        properties:
          order:
            type: object
            required:
              - action
              - customerTcbsId
              - quantity
              - productCode
              - marketType
            properties:
              action:
                type: string
                minLength: 1  # from @NotEmpty
              quantity:
                type: integer
                minimum: 1    # from @NotNull
```

## Root Cause Analysis

The OpenAPI schema builder (`src/core/openapi/schema-builder.ts`) may not be:
1. Reading validation annotations from the body schema
2. Converting `@NotEmpty`/`@NotNull` to `required` array
3. Adding constraints like `minLength: 1` for `@NotEmpty`

## Files to Investigate

1. `src/core/openapi/schema-builder.ts` - Schema generation logic
2. `src/mcp/local/document-endpoint.ts` - OpenAPI output generation

## Test Command

```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi --format yaml | grep -A20 "requestBody"
```

## Impact

- API consumers cannot see which fields are required
- Generated client code won't have proper validation
- API documentation is incomplete