# E2E Test Summary

**Date:** 2026-03-30
**Fix Applied:** Class-level path prefix resolution before structural validation

## Test Results

| Endpoint | Path Returned | Params | Body | Response | Messaging | Status |
|----------|--------------|--------|------|----------|-----------|--------|
| GET /e/v1/bonds/{id} | /e/v1/bonds/{id} | ✅ 1 | - | ✅ | - | ✅ PASS |
| GET /e/v1/bonds/{id}/coupons | /e/v1/bonds/{id}/coupons | ✅ 1 | - | ✅ | - | ✅ PASS |
| GET /e/v1/bonds | /e/v1/bonds | 0 | - | - | - | ⚠️ No data |
| GET /i/v1/customers/{id} | /i/v1/customers/{id} | ✅ 1 | - | ✅ | - | ✅ PASS |
| POST /e/v1/experience/orders/rms | /e/v1/experience/orders/rms | - | ✅ | - | - | ✅ PASS |
| POST /e/v1/experience/orders | /e/v1/experience/orders | - | - | - | - | ⚠️ No data |
| POST /b/v3/rms/cds/create | /b/v3/rms/cds/create | - | ✅ | - | - | ✅ PASS |
| PUT /b/v1/market/cds/cancel-order | /b/v1/market/cds/cancel-order | - | validation | ✅ codes | ✅ inbound | ✅ PASS |
| PUT /e/v1/experience/orders/{id}/sign | /e/v1/experience/orders/{id}/sign | - | ✅ | - | - | ✅ PASS |
| DELETE /e/v1/orders/{id} | /e/v1/orders/{id} | - | - | - | - | ⚠️ Verify if exists |
| GET /nonexistent/path | /nonexistent/path | - | - | - | - | ⚠️ Should return error |

## Key Findings

### Fixed Issues ✅
1. **Path matching now works correctly** - Class-level `@RequestMapping` prefix is resolved before structural validation
2. **GET endpoints with path params** - Correctly resolved with params and response
3. **POST endpoints** - Correctly resolved with body schema
4. **PUT endpoints** - Correctly resolved with validation, messaging, and downstream APIs
5. **Internal endpoints (/i/v1/...)** - Now correctly matched

### Potential Issues ⚠️

1. **Non-existent path handling** - `/nonexistent/path` returns empty result instead of error
   - Current behavior: Returns empty result with `error: null`
   - Expected: Should return error indicating endpoint not found

2. **Some endpoints return no data** - `/e/v1/bonds` and `/e/v1/experience/orders`
   - May need verification if these endpoints exist in the codebase
   - May need Route nodes instead of fallback search

3. **Path variable naming** - `/i/v1/customers/{tcbsId}` doesn't match, but `/i/v1/customers/{id}` does
   - Path variable names must match the annotation exactly
   - This is expected behavior

## Code Changes

**File:** `src/mcp/local/document-endpoint.ts`

**Changes:**
1. Query class-level `@RequestMapping` prefix for each candidate
2. Combine class prefix with method annotation path before validation
3. Validate structural match against the full path, not just method path
4. Increase query LIMIT from 20 to 100 to find more candidates
5. Cache class-level paths to avoid repeated database queries

## Recommendations

1. **P1:** Add error handling for non-existent paths - return meaningful error instead of empty result
2. **P2:** Consider normalizing path variable names (e.g., `{id}` matches `{tcbsId}`)
3. **P3:** Add Route nodes for better endpoint discovery (fallback is slower)