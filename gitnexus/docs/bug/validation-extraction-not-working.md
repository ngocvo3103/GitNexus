# Bug Report: Validation Extraction Not Working

**Date:** 2026-04-02
**Status:** Confirmed
**Severity:** Medium
**Endpoint Tested:** `PUT /e/v1/bookings/{productCode}/suggest`

---

## Symptom

The `validation` field in `document-endpoint` output is empty (`[]`) despite the request body fields having validation annotations like `@NotEmpty`, `@NotNull`.

## Evidence

### Body fields with validation annotations (from --openapi output):
```json
{
  "name": "action",
  "type": "String",
  "annotations": ["NotEmpty"]
},
{
  "name": "customerTcbsId",
  "type": "String",
  "annotations": ["NotEmpty"]
},
{
  "name": "quantity",
  "type": "Integer",
  "annotations": ["NotNull"]
}
```

### But validation field is empty:
```json
"validation": []
```

## Root Cause Analysis

The `extractValidationRules` function (`document-endpoint.ts:2444-2647`) has three parts:
1. **Part 1 (lines 2452-2483):** Extracts from `handler.parameterAnnotations` - The handler has no validation annotations on parameters (only `@PathVariable`, `@RequestBody`)
2. **Part 2 (lines 2486-2519):** Extracts from body field annotations - Should be finding these but isn't
3. **Part 3 (lines 2521-2627):** Imperative validation patterns - Not present in this code

### Investigation Needed

1. Check if Part 2 is receiving the `requestBody` with resolved fields
2. Check if `findFieldsInChain` is finding the Class nodes
3. Check if field annotations are in the correct format

## Fix Location
- `gitnexus/src/mcp/local/document-endpoint.ts:2486-2519` - Body field validation extraction

---

## Test Output Files

| File | Size | Description |
|------|------|-------------|
| `test-1-with-context.json` | 52KB | Full output with context |
| `test-2-no-context.json` | 12KB | Compact output |
| `test-3-schema-strict.json` | 12KB | Strict schema validation |
| `test-4-schema-no-strict.json` | 12KB | Default schema validation |
| `test-5-openapi.json` | 36KB | OpenAPI mode with annotations |

---

## Index Summary

| Repository | Nodes | Route Nodes |
|------------|-------|-------------|
| tcbs-bond-trading | 6,922 | 341 |
| tcbs-bond-trading-core | 5,609 | 0 |
| matching-engine-client | 182 | 0 |
| bond-exception-handler | 116 | 0 |
| tcbs-bond-amqp | 112 | 0 |
| tcbs-bond-amqp-message | 30 | 0 |

**Total Nodes:** 12,971

---

## What IS Working

- ✅ `handlerClass` and `handlerMethod` fields populated correctly
- ✅ `logicFlow` shows chain (not TODO_AI_ENRICH)
- ✅ Cross-repo dependency resolution (OrderAttrDto from matching-engine-client)
- ✅ Inbound messaging detection and payload resolution
- ✅ Request body schema extraction with nested types
- ✅ Body field annotations extracted correctly in `--openapi` mode

## What Needs Fixing

- ❌ `validation` field not populated from body field annotations
