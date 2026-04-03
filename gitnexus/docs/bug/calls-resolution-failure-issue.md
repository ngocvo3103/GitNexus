# Bug: CALLS Relationships Not Being Created for Controller Method Invocations

**Status:** In Progress
**Discovered:** 2026-04-02
**Impact:** High - `downstreamApis` is empty for endpoints because call chains are not being traced

## Summary

After fixing the Java call extraction bug (`result.typeEnvBindings` not initialized), Java calls ARE being extracted (43,510 calls). However, CALLS relationships are NOT being created from controller methods to their service calls when the receiver type is an interface.

## Root Cause Analysis

### What Works

- `matchingServiceV2.suggestOrder()` in `suggest` method → CALLS edge created ✓
- `bondBookingServiceV2.getBookingInformation()` → CALLS edge created ✓

### What Doesn't Work

- `holdSuggestionServiceImpl.process()` in `hold` method → NO CALLS edge ✗
- `unHoldSuggestionServiceImpl.process()` in `unhold` method → NO CALLS edge ✗

### Key Differences

| Aspect | MatchingService | SuggestionService |
|--------|-----------------|-------------------|
| Type | Interface | Interface |
| Method | `suggestOrder` (unique name) | `process` (common name) |
| Implementations | 1 implementation | Multiple implementations |

The `process` method exists in 14 different files, including:
- `SuggestionService.java` (interface)
- `UnHoldSuggestionServiceImpl.java`
- `HoldSuggestionServiceImpl.java`
- `JobUnHoldSuggestionServiceImpl.java`
- And more...

### Hypothesis

The issue appears to be that when resolving `process` with receiver type `SuggestionService`:
1. FILE_SCOPE correctly resolves `unHoldSuggestionServiceImpl` → `SuggestionService`
2. `resolveCallTarget` finds 14 `process` method candidates
3. D3 (file-based filtering) should narrow to `SuggestionService.java`
4. But there are still multiple candidates after filtering (potentially because the interface and implementations all match)

### Evidence

From verbose logging:
```
[call-resolution] typeEnvBindings for .../BookingIConnectExtControllerV2.java: 4 bindings
  - matchingServiceV2 : MatchingService
  - bondBookingServiceV2 : BondBookingService
  - holdSuggestionServiceImpl : SuggestionService
  - unHoldSuggestionServiceImpl : SuggestionService
```

FILE_SCOPE bindings are correctly populated. However, no RESOLVED or FAILED messages appear for `process` calls with `SuggestionService` receiver.

## Resolution Path Analysis

Looking at `resolveCallTarget()` in `call-processor.ts`:

1. **Step 0 (FILE_SCOPE)**: Resolves `unHoldSuggestionServiceImpl` → `SuggestionService` ✓
2. **Step D1**: `ctx.resolve('SuggestionService', filePath)` - should find the interface ✓
3. **Step D2**: Widens candidates to all `process` methods (14 candidates)
4. **Step D3**: Filters by file path - should narrow to `SuggestionService.java`
5. **Step D4**: Filters by ownerId - should match `SuggestionService` node

The issue is likely in Step D3 or D4 when dealing with interface types.

## Files Affected

| File | Purpose |
|------|---------|
| `gitnexus/src/core/ingestion/call-processor.ts` | Call resolution logic |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | FILE_SCOPE binding extraction |
| `gitnexus/src/core/ingestion/type-env.ts` | Type environment lookup |

## Related Issues

- #1: Java call extraction issue (fixed)
- #2: FILE_SCOPE bindings merge issue (fixed)

## Next Steps

1. Add debug logging to `resolveCallTarget()` for interface-typed receivers
2. Check if Step D3 file-based filtering is working correctly for interfaces
3. Verify that ownerId filtering in Step D4 correctly matches interface nodes
4. Consider implementing interface-to-implementation resolution for Spring DI pattern