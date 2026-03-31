# Bug: Nested Field Validation Not in Output `validation` Array

**Date:** 2026-03-31
**Severity:** Medium
**Component:** document-endpoint tool - validation extraction

## Summary

Validation annotations (`@NotEmpty`, `@NotNull`) on nested fields are correctly extracted into `body.fields[].annotations` but NOT added to the `validation` array in the output.

## Evidence

### body.fields has annotations
```json
{
  "name": "order",
  "type": "SavingMarketDto",
  "fields": [
    {
      "name": "action",
      "type": "String",
      "annotations": ["NotEmpty"]  // <-- Present here
    },
    {
      "name": "quantity",
      "type": "Integer",
      "annotations": ["NotNull"]   // <-- Present here
    }
  ]
}
```

### validation array missing nested entries
```json
{
  "validation": [
    // Only imperative validation entries (validateJWT, validateRequest, etc.)
    // MISSING: { "field": "order.action", "rules": "NotEmpty" }
    // MISSING: { "field": "order.quantity", "rules": "NotNull" }
  ]
}
```

## Expected Behavior

The `validation` array should include:
```json
[
  { "field": "order.action", "type": "String", "required": true, "rules": "NotEmpty" },
  { "field": "order.customerTcbsId", "type": "String", "required": true, "rules": "NotEmpty" },
  { "field": "order.quantity", "type": "Integer", "required": true, "rules": "NotNull" },
  { "field": "order.productCode", "type": "String", "required": true, "rules": "NotEmpty" },
  { "field": "order.marketType", "type": "String", "required": true, "rules": "NotEmpty" }
]
```

## Root Cause Analysis

The `processFieldsRecursive` function was added to recursively process nested fields, but it appears to only add field-level validation to the body schema's annotations, not to the top-level `validation` array.

The `extractValidationRules` function should:
1. Process top-level body fields with annotations
2. Recurse into nested fields (using `processFieldsRecursive`)
3. Add validation entries for each field with annotations, using dot-notation paths

## Files to Investigate

1. `src/mcp/local/document-endpoint.ts` - `extractValidationRules` function
2. `src/mcp/local/document-endpoint.ts` - `processFieldsRecursive` helper

## Test Command

```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --include-context --depth 15 | jq '.specs.request.validation'
```

## Output Files

- `docs/tmp/put-suggest-with-context.json` - Contains body.annotations but missing validation entries