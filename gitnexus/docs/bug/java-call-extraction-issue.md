# Bug: Java Method Calls Not Being Extracted in Worker Path

**Status:** Fixed
**Discovered:** 2026-04-02
**Resolved:** 2026-04-02
**Impact:** High - CALLS relationships for Java repositories are missing

## Summary

Java method calls were not being extracted by the tree-sitter queries in the worker path due to a missing initialization in the `processBatch` function.

## Root Cause

The `result` object in `processBatch` (parse-worker.ts) was missing `typeEnvBindings: []` initialization. When implementation files (files with method bodies) tried to push their FILE_SCOPE bindings:

```typescript
result.typeEnvBindings.push({ filePath: file.path, bindings: new Map(fileScopeBindings) });
```

This threw an error: `Cannot read properties of undefined (reading 'push')`, causing the worker to crash and skip the query execution for those files.

Files affected were those with:
- Field declarations (e.g., `private CashService cashService;`)
- Local variable declarations in method bodies
- Any FILE_SCOPE bindings from `typeEnv.fileScope()`

Interface files (no method bodies, 0 FILE_SCOPE bindings) were not affected because they skipped the push.

## Fix

Added `typeEnvBindings: []` to the result object initialization in `processBatch`:

```typescript
const result: ParseWorkerResult = {
  nodes: [],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  heritage: [],
  routes: [],
  constructorBindings: [],
  typeEnvBindings: [],  // <-- Added this line
  skippedLanguages: {},
  fileCount: 0,
};
```

## Verification

Before fix:
- `Extracted 37 calls (0 Java)` - 0 Java calls

After fix:
- `Extracted 43510 calls (43510 Java)` - 43,510 Java calls extracted

Implementation files now show correct call extraction:
- `ExperienceTradeServiceImpl.java: 3038 calls`
- `HoldSuggestionServiceImpl.java: 159 calls`
- `ChecksumRequestValidationServiceImpl.java: 62 calls`

## Files Changed

| File | Change |
|------|--------|
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | Added `typeEnvBindings: []` to result initialization |

## Related Issues

- This was blocking the `document-endpoint` downstream APIs fix, as CALLS relationships are needed to trace method invocations