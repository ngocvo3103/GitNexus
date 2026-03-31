# Bug: Validation Field Empty in document-endpoint Output

**Date:** 2026-03-31
**Status:** RESOLVED
**Severity:** Medium
**Component:** document-endpoint tool
**Resolution Date:** 2026-03-31

## Resolution

The validation extraction now correctly recursively processes nested fields. The `extractValidationRules()` function iterates through all fields including nested type properties.

**Evidence:** `docs/tmp/put-suggest-with-context.json` shows 23 validation rules correctly extracted.

## Original Summary

The `validation` field in the `specs.request` object is always empty (`[]`), even though validation annotations (`@NotEmpty`, `@NotNull`, etc.) are correctly extracted and present in the `body.fields[].annotations` array.

## Expected Behavior

The `validation` field should contain extracted validation rules, e.g.:
```json
{
  "field": "quantity",
  "type": "Integer",
  "required": true,
  "rules": "@NotNull"
}
```

## Actual Behavior

```json
{
  "specs": {
    "request": {
      "params": [...],
      "body": {
        "typeName": "SuggestionOrderResultDto",
        "fields": [
          {
            "name": "quantity",
            "type": "Integer",
            "annotations": ["@NotNull"]  // <-- Present here
          }
        ]
      },
      "validation": []  // <-- But empty here
    }
  }
}
```

## Evidence

### Test Command
```bash
node dist/cli/index.js document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --include-context --depth 15
```

### Output Shows Annotations in Fields
```
action: ['NotEmpty']
customerTcbsId: ['NotEmpty']
quantity: ['NotNull']
productCode: ['NotEmpty']
```

### But Validation Array is Empty
```
validation: []
validation count: 0
```

## Root Cause Investigation

The validation extraction appears to happen in the document-endpoint pipeline, but the extracted rules are not being populated into the `validation` field.

### Files to Investigate
1. `src/mcp/local/local-backend.ts` - `document-endpoint` tool implementation
2. `src/core/document-endpoint.ts` - Main logic for endpoint documentation
3. Any validation extraction logic that should map `body.fields[].annotations` to `validation[]`

## Impact

1. **OpenAPI Output**: The OpenAPI schema correctly includes validation constraints (e.g., `required` fields) via `schema-builder.ts`, so this doesn't break OpenAPI generation.
2. **JSON Output**: Consumers of the JSON output cannot access structured validation rules.
3. **API Documentation**: Users cannot see which fields are required without inspecting the body schema.

## Workaround

Parse `body.fields[].annotations` directly to extract validation rules until this is fixed.

## Test Files
- `docs/tmp/put-suggest-with-context-v3.json` - Contains empty validation array but populated body.annotations

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/validation-field-empty.md` |
| Bug Report | `docs/bug/validation-field-empty.md` |

## Root Cause

`extractValidationRules` at `src/mcp/local/document-endpoint.ts:2179-2195` only iterates top-level fields and never recurses into nested type properties.

## Fix Approach

Add recursive helper `collectFieldValidations(field, path)` that processes nested fields with proper path prefixes.