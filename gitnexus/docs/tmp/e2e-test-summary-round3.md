# E2E Test Summary - Round 3

**Date:** 2026-03-30
**Status:** All tests passing - validation extraction fixed

## Test Results

### GET Endpoints ✅

| Path | Params | Response | Status |
|------|--------|----------|--------|
| `/e/v1/bonds/{id}` | 1 | ✅ | ✅ PASS |
| `/e/v1/bonds/{id}/coupons` | 1 | ✅ | ✅ PASS |
| `/i/v1/customers/{id}` | 1 | ✅ | ✅ PASS |
| `/e/v1/rms/{tcbsId}/transactions` | 1 | ✅ | ✅ PASS |
| `/b/v1/customers/{tcbsId}/assets/ibond` | 3 | ✅ | ✅ PASS |

### POST Endpoints ✅

| Path | Rules | TODO | Primitives | Methods | Status |
|------|-------|------|------------|---------|--------|
| `/e/v1/experience/orders/rms` | 39 | 7 | 0 | 0 | ✅ PASS |
| `/e/v1/validation/signContract` | 51 | 27 | 0 | 0 | ✅ PASS |

### PUT Endpoints ✅

| Path | Rules | Inbound | Status |
|------|-------|---------|--------|
| `/b/v1/market/cds/cancel-order` | 2 | 1 | ✅ PASS |

## Fixes Applied

### WI-3: Validation Field Name Extraction

**Problem:** Validation field names included:
- Method calls: `bondProduct.getId()`, `dto.getTradingDate()`
- Primitive types: `String`, `Integer`, `Date`
- Null literals: `null`

**Solution:** Added helper functions in `extractFieldName()`:

```typescript
// Split arguments respecting nested parentheses
function splitArguments(argsStr: string): string[]

// Detect complex expressions (method calls, operators, lambdas, ternary)
function isComplexExpression(arg: string): boolean

// Extract field name from getter calls like dto.getTradingDate()
function extractFieldName(arg: string, params, requestBody): string
```

**Results:**
- Validation count: 68 → 51 (17 rules filtered)
- No primitive types as field names
- No method calls as field names
- Complex expressions marked as `TODO_AI_ENRICH` for AI enrichment

## Coverage Summary

| Category | Tested | Passed | Issues |
|----------|--------|--------|--------|
| GET with path params | 5 | 5 | None |
| POST with body | 2 | 2 | None |
| PUT with body | 1 | 1 | None |
| Path matching | 8 | 8 | None |
| Validation extraction | 2 | 2 | None |
| Messaging topics | 1 | 1 | None |

## Key Findings

1. **Path matching works correctly** across all controller types
2. **Validation extraction** now properly handles:
   - Simple field names: `dto.action`, `dto.customerTcbsId`
   - Getter calls: `dto.getTradingDate()` → `dto.tradingDate`
   - Type+name patterns: `SavingTradingDto dto` → `body`
   - Complex expressions: marked as `TODO_AI_ENRICH`
3. **No false positives** - primitive types and null are filtered
4. **Messaging topics** correctly detected (inbound/outbound)

## Recommendations

1. **P2**: Consider AI enrichment for `TODO_AI_ENRICH` fields
2. **P2**: Add support for DELETE and PATCH methods
3. **P3**: Add error message when no matching endpoint is found