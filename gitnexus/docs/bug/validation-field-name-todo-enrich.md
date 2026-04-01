# Validation Field Names: TODO_AI_ENRICH

**Date:** 2026-03-30
**Status:** Open
**Priority:** P2 (Medium)

## Summary

Some validation field names appear as `TODO_AI_ENRICH` instead of the actual parameter/field being validated.

## Affected Endpoint

PUT /e/v1/bookings/{productCode}/suggest

## Evidence

```json
{
  "field": "TODO_AI_ENRICH",
  "type": "Custom",
  "required": false,
  "rules": "validateApiKey"
}
{
  "field": "TODO_AI_ENRICH",
  "type": "Custom",
  "required": false,
  "rules": "validateSuggestion"
}
```

## Root Cause Analysis

### Case 1: validateApiKey

```java
private void validateJWT(TcbsJWT jwt) {
    // validate X-Api-Key
    jwt.validateApiKey();
}
```

The field name extraction can't determine the implicit parameter context. The validation is on `jwt` object but the method call `jwt.validateApiKey()` doesn't explicitly reference a field.

### Case 2: validateSuggestion

Similar pattern - complex validation logic that doesn't map directly to a specific request field.

## Expected Behavior

Field names should be:
- `jwt` or `apiKey` for `validateApiKey`
- `suggestion` or `body` for `validateSuggestion`

## Current Workaround

The `_context` field (in `--include-context` mode) provides the source code for manual analysis.

## Resolution Approach

1. Track implicit `this` parameter in method calls
2. Analyze method signatures to infer validated parameter
3. Use heuristics from method names (e.g., `validateApiKey` → `apiKey`)
4. Cross-reference with other validations in same method

## Code Locations

- `src/core/ingestion/type-extractors/shared.ts` - Field name extraction
- `HoldSuggestionServiceImpl.java:128-136` - validateJWT method
- `InternalHoldSuggestionServiceImpl.java:58-60` - validateJWT method

## Test Case

```java
private void validateJWT(TcbsJWT jwt) {
    // validate X-Api-Key
    jwt.validateApiKey();  // Expected: field = "jwt" or "apiKey"
}
```