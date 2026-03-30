# E2E Test Summary - Round 2

**Date:** 2026-03-30
**Status:** Path matching working correctly across all tested endpoints

## Test Results

### GET Endpoints ✅

| Path | Params | Response | Status |
|------|--------|----------|--------|
| `/e/v1/bonds/{id}` | 1 | ✅ | ✅ PASS |
| `/e/v1/bonds/{id}/coupons` | 1 | ✅ | ✅ PASS |
| `/e/v1/bonds/{tcbsId}/get` | 5 | - | ✅ PASS |
| `/i/v1/customers/{id}` | 1 | ✅ | ✅ PASS |
| `/e/v1/rms/{tcbsId}/transactions` | 1 | ✅ | ✅ PASS |
| `/b/v1/customers/{tcbsId}/assets/ibond` | 3 | ✅ | ✅ PASS |
| `/e/v1/bookings/{productCode}/suggest` | 1 | ✅ | ✅ PASS |
| `/e/v1/rms/{tcbsId}/transactions/couterparty/{orderId}` | 2 | - | ✅ PASS |
| `/b/v1/pricings/iconnect` | 0 | ✅ | ✅ PASS |

### POST Endpoints ✅

| Path | Body | Validation | Status |
|------|------|------------|--------|
| `/e/v1/experience/orders/rms` | ✅ | 40 rules | ✅ PASS |
| `/e/v1/validation/signContract` | ✅ | 68 rules | ✅ PASS |
| `/t/v1/orders/cds/sell` | ✅ | - | ✅ PASS |
| `/e/v2/bookings/normalized/{productCode}/suggest` | ✅ | - | ✅ PASS |

### PUT Endpoints ✅

| Path | Body | Validation | Messaging | Status |
|------|------|------------|-----------|--------|
| `/b/v1/market/cds/cancel-order` | - | 2 rules | ✅ inbound | ✅ PASS |
| `/e/v1/bookings/{productCode}/suggest` | ✅ | - | - | ✅ PASS |

### Edge Cases ⚠️

| Path | Expected | Actual | Notes |
|------|----------|--------|-------|
| `/nonexistent/path` | Error | Empty result + null error | Should return meaningful error |

## Coverage Summary

| Category | Tested | Passed | Issues |
|----------|--------|--------|--------|
| GET with path params | 9 | 9 | None |
| POST with body | 4 | 4 | None |
| PUT with body | 2 | 2 | None |
| Multi-segment paths | 3 | 3 | None |
| Internal endpoints (/i/...) | 1 | 1 | None |
| Backend endpoints (/b/...) | 2 | 2 | None |
| Thirdparty endpoints (/t/...) | 1 | 1 | None |
| Non-existent path | 1 | 0 | Should return error |

## Key Findings

1. **Path matching is working correctly** across all controller types:
   - External (`/e/v1/...`)
   - Internal (`/i/v1/...`)
   - Backend (`/b/v1/...`)
   - Thirdparty (`/t/v1/...`)

2. **Multiple path parameters** are correctly extracted (e.g., `/e/v1/rms/{tcbsId}/transactions/couterparty/{orderId}` returns 2 params)

3. **Request body extraction** works for POST/PUT endpoints

4. **Validation rules** are correctly extracted (up to 68 rules for complex endpoints)

5. **Messaging topics** are correctly detected (inbound/outbound)

## Remaining Issues

1. **P2 - Non-existent path handling**: Should return a meaningful error instead of empty result with null error

## Recommendations

1. Consider adding error message when no matching endpoint is found
2. Add support for DELETE and PATCH methods (no endpoints found in this codebase)
3. Consider caching class-level path prefixes for performance