# Bug Analysis: OpenAPI Output Missing `required` Fields

**Date:** 2026-03-31  
**Status:** Root Cause Identified  
**Severity:** Medium  

---

## Summary

OpenAPI output does not include `required` array for request body properties, even though validation annotations (`@NotEmpty`, `@NotNull`) are correctly detected in the body schema.

---

## Root Cause

The bug is a **data transformation issue** where `BodySchema` is converted to a plain JSON example before OpenAPI generation, losing all annotation metadata needed to populate the `required` array.

### Data Flow Trace

```
1. documentEndpointCommand (src/cli/tool.ts:184-191)
   └─> backend.callTool('document-endpoint', { include_context: false })

2. documentEndpoint (src/mcp/local/document-endpoint.ts:637)
   └─> buildDocumentation({ includeContext: false })
   
3. buildDocumentation (src/mcp/local/document-endpoint.ts:767-773)
   └─> result.specs.request.body = bodySchemaToJsonExample(requestBody, nestedSchemas)
   ⚠️ CRITICAL: BodySchema → JSON example (annotations lost here!)

4. convertToOpenAPIDocument (src/core/openapi/converter.ts:304)
   └─> bodyToRequestBody(result.specs.request.body)
   
5. bodyToRequestBody (src/core/openapi/converter.ts:116-134)
   └─> isBodySchema(body) returns false (it's a JSON object)
   └─> Creates { type: 'object', example: body } schema
   └─> bodySchemaToOpenAPISchema() never called!
```

---

## Key Files

| File | Line | Issue |
|------|------|-------|
| `src/mcp/local/document-endpoint.ts` | 767-773 | Converts BodySchema to JSON example, losing annotations |
| `src/core/openapi/converter.ts` | 116-134 | `isBodySchema()` returns false, skips schema builder |
| `src/core/openapi/schema-builder.ts` | 108-121 | Has correct logic but never reached |

---

## Evidence: Correct Logic Exists but is Bypassed

### schema-builder.ts (lines 108-121) - CORRECT but UNREACHABLE
```typescript
const isRequired = field.annotations?.some(a =>
  a.includes('@NotNull') ||
  a.includes('@NotEmpty') ||
  a.includes('@NotBlank')
) ?? false;

if (isRequired) {
  required.push(field.name);  // This code path is never reached!
}
```

### converter.ts (lines 116-134) - The Problem
```typescript
function bodyToRequestBody(body, components, extractSchemas) {
  if (!body) return undefined;
  
  let schema: OpenAPISchema;
  
  if (isBodySchema(body)) {
    // THIS BRANCH NEVER TAKEN because body is already JSON example
    schema = bodySchemaToOpenAPISchema(body);  // <-- Correct logic here
  } else {
    // THIS BRANCH TAKEN - creates minimal schema without required
    schema = {
      type: Array.isArray(body) ? 'array' : 'object',
      example: body,
    };
  }
  ...
}
```

---

## Fix Options

### Option A: Keep BodySchema for OpenAPI generation (Recommended)

**Change:** When OpenAPI output is requested, pass `BodySchema` directly to converter instead of converting to JSON example.

**Implementation:**
1. Add `--openapi` flag to `documentEndpointCommand` (or detect from context)
2. When OpenAPI mode, skip `bodySchemaToJsonExample()` conversion
3. Pass raw `BodySchema` to `convertToOpenAPIDocument()`
4. Converter's `isBodySchema()` will return true
5. `bodySchemaToOpenAPISchema()` will be called, populating `required`

**Code change in document-endpoint.ts (line ~767):**
```typescript
// When OpenAPI output, keep BodySchema for proper schema generation
if (openApiMode) {
  result.specs.request.body = requestBody;  // Keep as BodySchema
  result.specs.response.body = responseBody;
} else if (includeContext) {
  result.specs.request.body = embedNestedSchemas(requestBody, nestedSchemas);
  result.specs.response.body = embedNestedSchemas(responseBody, nestedSchemas);
} else {
  result.specs.request.body = bodySchemaToJsonExample(requestBody, nestedSchemas);
  result.specs.response.body = bodySchemaToJsonExample(responseBody, nestedSchemas);
}
```

### Option B: Add required extraction before conversion

**Change:** Extract required fields before converting to JSON example, pass separately.

**Implementation:**
1. Add helper `extractRequiredFields(bodySchema: BodySchema): string[]`
2. Pass required array alongside JSON example
3. Modify converter to use separate required array

**More invasive, not recommended.**

---

## Test Command

```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi --format yaml | grep -A20 "requestBody"
```

---

## Impact Assessment

- **API consumers** cannot see which fields are required
- **Generated client code** won't have proper validation
- **API documentation** is incomplete

---

## Recommended Fix

**Implement Option A** - Pass `BodySchema` to OpenAPI converter when `--openapi` flag is present. This requires:

1. Add `openapi?: boolean` parameter to `documentEndpointCommand` options
2. Add `openApiMode` flag propagation through `documentEndpoint` 
3. Conditional body handling in `buildDocumentation`
4. No changes needed to schema-builder.ts (logic already correct)

---

## Files to Modify

1. `src/cli/tool.ts` - Add `--openapi` flag and parameter
2. `src/cli/index.ts` - Add CLI option parsing
3. `src/mcp/local/document-endpoint.ts` - Add `openApiMode` parameter, conditional body handling
4. Test: Add test case for OpenAPI with required fields