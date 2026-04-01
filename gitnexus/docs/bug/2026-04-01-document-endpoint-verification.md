# Bug Investigation Report: Document Endpoint Verification

**Date:** 2026-04-01
**Test Endpoint:** `PUT /e/v1/bookings/{productCode}/suggest`
**Repository:** tcbs-bond-trading (with dependencies: bond-exception-handler, matching-engine-client, tcbs-bond-amqp, tcbs-bond-amqp-message, tcbs-bond-trading-core)

---

## Test Results

### All Modes Passed

| Mode | Status | Output File |
|------|--------|-------------|
| `--include-context` | PASS | put-bookings-suggest-with-context.json (195KB) |
| No context | PASS | put-bookings-suggest-no-context.json (39KB) |
| `--schema-path` (no strict) | PASS | put-bookings-suggest-schema-no-strict.json |
| `--strict` | PASS | put-bookings-suggest-strict.json |
| `--openapi` (bundled schema) | PASS | put-bookings-suggest-openapi.json (64KB) |

---

## Previous Issues Status

### Issue 1: Controller Name in summaryContext — FIXED

**Previous:** `Handler: undefined.unhold()`
**Current:** `Handler: BookingIConnectExtControllerV2.unhold()`

The controller name is now correctly resolved and displayed.

---

### Issue 2: URL Resolution for Some Services — PARTIAL

Most URLs are correctly resolved:

| Service Name | Resolved URL |
|--------------|--------------|
| `tcbs.bond.settlement.service.url` | `http://apiintsit.tcbs.com.vn/bond-settlement` |
| `tcbs.matching.service.url` | `http://apiintsit.tcbs.com.vn/matching-engine/` |
| `tcbs.bond.product.url` | `http://apiintsit.tcbs.com.vn/bond-product` |
| `tcbs.pricing.service.url` | `http://apiintsit.tcbs.com.vn/fund-pricing` |
| `hft-krema.service.url` | `http://apiintsit.tcbs.com.vn/hft-krema/v1/` |
| `hold.suggestion.captcha.google.url` | `https://www.google.com/recaptcha/api/siteverify...` |

One unresolved case remains:

```json
{
  "serviceName": "unknown-service",
  "endpoint": "EXCHANGE url",
  "resolutionDetails": {
    "attemptedPatterns": ["url"],
    "enclosingClass": "ProfileServiceImpl",
    "filePath": "src/main/java/com/tcbs/bond/trading/service/impl/ProfileServiceImpl.java"
  }
}
```

**Root Cause:** Dynamic URL construction pattern `PROFILE_URL + "profiles/inside/policies/customer?tcbsUserId=" + tcbsId` where `PROFILE_URL` is a constant not resolvable at index time.

---

### Issue 3: Cross-Repo Type Resolution — WORKING

Cross-repo type resolution is working correctly:

| Type | Source Repository |
|------|-------------------|
| `SavingMarketDto` | tcbs-bond-trading-core |
| `OrderAttrDto` | matching-engine-client |
| `SuggestionOrderDto` | tcbs-bond-trading-core |
| `CaptchaReqDto` | tcbs-bond-trading-core |

Types from external repos are correctly attributed:

| Source Value | Meaning |
|--------------|---------|
| `source: "indexed"` | Found in an indexed repo (correct) |
| `source: "external"` | NOT found in any indexed repo (truly external) |
| `source: "primitive"` | Primitive type |

When a type is found in an external indexed repo, it shows as `indexed` with `repoId` attribution. This is by design.

---

### Issue 4: Fuzzy Path Matching — WORKING

Using full path `--path "/e/v1/bookings/{productCode}/suggest"` correctly matches the intended endpoint.

---

## New Findings

### Validation Field — POPULATED

The `validation` field is properly populated with 24 custom validation rules:

- `validateJWT`
- `validateRequest`
- `validateOrderSuggestion`
- `validateCaptcha`
- `validateFakeRequest`
- `suggestionValidationServiceImpl.process`
- `checkCaptchaValidationServiceImpl.process`
- `validateSuggestion`
- `validateHoldMoney`
- `validateAsset`
- `validatePolicyCode`
- And more...

---

### Downstream APIs — WORKING

11 downstream APIs detected with resolved URLs and path constants.

---

### Messaging — WORKING

Outbound messaging topics resolved with payload types:

- `hold-suggestion-order-market`
- `hold-suggestion-order-iconnect`
- `cancel-suggestion-order-market`
- And more...

---

## Output Files Location

All output files saved to:
`/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/tmp/`

---

## Recommendations

| # | Action | Issue |
|---|--------|-------|
| 1 | **CLOSE** | Controller name is fixed |
| 2 | **CLOSE** | Cross-repo resolution working as designed |
| 3 | **KEEP** | One unresolved URL pattern remains (minor, acceptable) |
| 4 | **CLOSE** | Path matching works with full path |

---

## Summary

All 5 document-endpoint modes passed verification. Cross-repo type resolution is working correctly with proper `repoId` attribution. The only remaining minor issue is one unresolved dynamic URL pattern in `ProfileServiceImpl`.
