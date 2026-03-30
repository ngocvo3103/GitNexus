# Bug: Document-Endpoint Body Schema Resolution Returns Null

**Status:** FIXED
**Priority:** P2 - High
**Created:** 2026-03-30
**Updated:** 2026-03-30
**Related:** worker-pool-file-processing.md

## Summary

The `document-endpoint` tool was returning `null` for `request.body` and `response.body` even when handler methods had `@RequestBody` parameters and return types.

## Root Cause Analysis

### Cause 1: `labels()` Function Not Reliable in LadybugDB (FIXED)

**Problem:** The `findSymbolByUid` function used `labels(n)[0]` to get the node type, but LadybugDB's `labels()` function returns empty string instead of the actual label.

**Fix:** Derive `nodeType` from the UID prefix instead of relying on `labels()`:
```typescript
// Before: const nodeType = row.type || row[2];  // returns "" or undefined
// After:
const nodeType = uid.split(':')[0];  // "Method:..." → "Method"
```

**File:** `gitnexus/src/mcp/local/trace-executor.ts:591-593`

**Verification:**
```
[DEBUG] findSymbolByUid: row keys=id,name,type,filePath,startLine,endLine,content
[DEBUG] findSymbolByUid: row values={"id":"Method:...","name":"unhold","type":"","filePath":"..."}
[DEBUG] findSymbolByUid: nodeType="undefined"  // Before fix
[DEBUG] findSymbolByUid: nodeType="Method"     // After fix
```

### Cause 2: Worker Pool Variable Shadowing (FIXED)

**Problem:** Worker pool only processed 1-2 files per chunk due to variable shadowing bug.

**Fix:** See `worker-pool-file-processing.md` for details.

## Resolution Status

| Issue | Status | Notes |
|-------|--------|-------|
| `labels()` not returning node type | ✅ FIXED | Derive type from UID prefix |
| Controller classes not indexed | ✅ FIXED | Worker pool fix ensures all files processed |
| Method annotations missing | ✅ FIXED | Worker pool fix ensures all annotations captured |
| Cross-repo type resolution | ✅ WORKING | DTOs in indexed repos resolve correctly |

## Current Behavior

Body schemas now resolve correctly for endpoints with indexed DTO types:

```json
{
  "method": "PUT",
  "path": "/{productCode}/suggest",
  "specs": {
    "request": {
      "params": [{"name": "productCode", "type": "String", "required": true}],
      "body": {
        "serialVersionUID": 0,
        "order": { "orderId": 0, "action": "string", ... },
        "rate": 0,
        "productCode": "string",
        ...
      }
    },
    "response": {
      "body": {
        "serialVersionUID": 0,
        "order": { ... },
        "suggestions": [{ "orderId": 0, ... }],
        ...
      }
    }
  }
}
```

## Files Modified

| File | Change |
|------|--------|
| `gitnexus/src/mcp/local/trace-executor.ts` | Derive `nodeType` from UID prefix instead of `labels()` |
| `gitnexus/schemas/api-context-schema.json` | Allow `payload` to be object or string for resolved types |

## E2E Test Results

All test modes pass:
- ✅ No context mode: Body schemas resolved correctly
- ✅ With context mode: Body schemas with `_context` references
- ✅ Strict schema mode: Validates against JSON schema

## Lessons Learned

1. **Database functions vary**: `labels()` works differently in Neo4j vs LadybugDB
2. **UID format is reliable**: Node IDs contain type prefix (e.g., "Method:...")
3. **Existing patterns work**: The codebase already used UID prefix derivation in other places (see line 678 comment)