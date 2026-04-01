# E2E Verification Report: @Value Inheritance Fix

**Date:** 2026-04-01
**Test Endpoint:** `PUT /e/v1/bookings/{productCode}/suggest`
**Repository:** tcbs-bond-trading (with dependencies: bond-exception-handler, matching-engine-client, tcbs-bond-amqp, tcbs-bond-amqp-message, tcbs-bond-trading-core)

---

## Test Results

### All Modes Passed ✓

| Mode | Status | Output File |
|------|--------|-------------|
| `--include-context` | ✓ PASS | e2e-with-context.json (195KB) |
| No context | ✓ PASS | e2e-no-context.json (39KB) |
| `--schema-path` (no strict) | ✓ PASS | e2e-schema-no-strict.json |
| `--strict` | ✓ PASS | e2e-strict.json |
| `--openapi` (bundled schema) | ✓ PASS | e2e-openapi.json (64KB) |

---

## Fix Verification: @Value Inheritance Resolution

### Before Fix

```json
{
  "serviceName": "unknown-service",
  "endpoint": "EXCHANGE url"
}
```

### After Fix

```json
{
  "serviceName": "tcbs.profile.service",
  "endpoint": "EXCHANGE url",
  "resolutionDetails": {
    "serviceField": "PROFILE_URL",
    "serviceValue": "${tcbs.profile.service}",
    "resolvedValue": "http://10.7.2.85:8092/"
  }
}
```

**Root Cause Resolution:** The `@Value("${tcbs.profile.service}")` annotation was in the parent class `BaseServiceImpl`. The fix added inheritance traversal to `resolveValueAnnotation` so it now checks parent classes when a field is not found in the immediate class.

---

## All Downstream APIs Resolved ✓

| Service Name | Resolved URL |
|--------------|--------------|
| tcbs.bond.settlement.service.url | http://apiintsit.tcbs.com.vn/bond-settlement |
| tcbs.matching.service.url | http://apiintsit.tcbs.com.vn/matching-engine/ |
| tcbs.bond.product.url | http://apiintsit.tcbs.com.vn/bond-product |
| tcbs.pricing.service.url | http://apiintsit.tcbs.com.vn/fund-pricing |
| hft-krema.service.url | http://apiintsit.tcbs.com.vn/hft-krema/v1/ |
| services.hft-krema.cashInvestments.url | http://apiintsit.tcbs.com.vn/hft-krema/v1/accounts/{customerTcbsId}/cashInvestments |
| hold.suggestion.captcha.google.url | https://www.google.com/recaptcha/api/siteverify... |
| **tcbs.profile.service** | **http://10.7.2.85:8092/** ← FIXED |

**No `unknown-service` entries remain.**

---

## Cross-Repo Type Resolution ✓

Types resolved from external dependencies:

| Type | Source Repository |
|------|-------------------|
| SavingMarketDto | tcbs-bond-trading-core |
| OrderAttrDto | matching-engine-client |
| SuggestionOrderDto | tcbs-bond-trading-core |
| CaptchaReqDto | tcbs-bond-trading-core |

---

## Validation ✓

24 custom validation rules populated:
- validateJWT
- validateRequest
- validateOrderSuggestion
- validateCaptcha
- suggestionValidationServiceImpl.process
- And more...

---

## Messaging ✓

2 outbound topics with payload types:
- hold-suggestion-order-market → HoldSuggestionOrderMarketEvent
- rm-served-sell-i-bond → RmServedSellIBondEvent

---

## Controller Name ✓

`Handler: BookingIConnectExtControllerV2.unhold()` correctly resolved.

---

## Output Files

All files saved to: `/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/tmp/`

| File | Size | Mode |
|------|------|------|
| e2e-with-context.json | 195KB | `--include-context` |
| e2e-no-context.json | 39KB | default |
| e2e-openapi.json | 64KB | `--openapi` |
| e2e-schema-no-strict.json | 39KB | `--schema-path` |
| e2e-strict.json | 39KB | `--strict` |

---

## Summary

✅ **All issues from previous verification resolved:**
1. Controller name: **FIXED** ✓
2. URL resolution: **FIXED** - all services now resolve, including inherited `@Value` fields
3. Cross-repo type resolution: **WORKING** ✓
4. Validation: **POPULATED** ✓
5. Messaging: **WORKING** ✓

The inheritance traversal fix enables resolution of `@Value` annotations from parent classes, eliminating the last `unknown-service` case.
