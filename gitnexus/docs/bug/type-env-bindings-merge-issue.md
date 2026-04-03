# Bug: FILE_SCOPE Bindings Not Being Merged in Worker Results

**Status:** Fixed
**Discovered:** 2026-04-02
**Impact:** High - CALLS relationships for method calls with field-typed receivers were not being created

## Summary

The `mergeResult` function in `parse-worker.ts` was not merging `typeEnvBindings` from sub-batch results, causing FILE_SCOPE type bindings to be lost when using worker-based parallel parsing.

## Root Cause

Two issues in `parse-worker.ts`:

1. **Missing merge line in `mergeResult` function:**
```typescript
// BEFORE: typeEnvBindings was not being merged
const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
  target.nodes.push(...src.nodes);
  // ... other fields ...
  target.constructorBindings.push(...src.constructorBindings);
  // typeEnvBindings was MISSING!
};
```

2. **Missing `typeEnvBindings` in `accumulated` object:**
```typescript
// BEFORE: accumulated object didn't include typeEnvBindings
let accumulated: ParseWorkerResult = {
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], heritage: [], routes: [], 
  constructorBindings: [], skippedLanguages: {}, fileCount: 0,
  // typeEnvBindings: [] was MISSING!
};
```

## Fix

Added `typeEnvBindings` to both locations:

```typescript
// In mergeResult function:
if (src.typeEnvBindings) {
  if (!target.typeEnvBindings) target.typeEnvBindings = [];
  target.typeEnvBindings.push(...src.typeEnvBindings);
}

// In accumulated object:
let accumulated: ParseWorkerResult = {
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], heritage: [], routes: [], 
  constructorBindings: [], typeEnvBindings: [], 
  skippedLanguages: {}, fileCount: 0,
};

// In reset (flush) block:
accumulated = { 
  nodes: [], relationships: [], symbols: [], 
  imports: [], calls: [], heritage: [], routes: [], 
  constructorBindings: [], typeEnvBindings: [], 
  skippedLanguages: {}, fileCount: 0 
};
```

## Verification

Before fix:
- `[call-resolution] Processing 0 typeEnvBindings files`

After fix:
- `[call-resolution] Processing 524 typeEnvBindings files`
- `[call-resolution] typeEnvBindings for src/main/java/com/tcbs/bond/trading/controller/external/v2/BookingIConnectExtControllerV2.java: 4 bindings`
- FILE_SCOPE bindings for `matchingServiceV2`, `bondBookingServiceV2`, `holdSuggestionServiceImpl`, `unHoldSuggestionServiceImpl` now properly extracted

## Files Changed

| File | Change |
|------|--------|
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | Added `typeEnvBindings` merge and initialization |

## Related Issues

- #1: Java call extraction issue (`result.typeEnvBindings` not initialized in `processBatch`)
- #2: CALLS relationships not being created for controller method invocations