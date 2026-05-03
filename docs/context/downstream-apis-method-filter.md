# Backend Spec: Downstream API Method Filtering

## Overview

Fix `document-endpoint` to only include HTTP calls made by the handler method in `downstreamApis`, not all HTTP calls from the entire class content.

## Current Behavior

1. `executeTrace` fetches chain nodes from the graph DB
2. Each node's `content` field contains source code (may span entire class)
3. `extractMetadata(content)` scans content for HTTP call patterns using `HTTP_CALL_PATTERN` and `FEIGN_HTTP_ANNOTATION_PATTERN`
4. All matches are added to `httpCallDetails` regardless of which method they belong to
5. `extractDownstreamApis` processes all `httpCallDetails` entries, producing one downstream API per entry

**Bug:** When content spans the entire class, HTTP calls from sibling methods (e.g., `deleteOrder()` in the same controller) are incorrectly included as downstream dependencies.

## Proposed Behavior

### Content Filtering (WI-1)

After `extractMetadata` processes the content, filter `httpCallDetails` to only include entries whose source location falls within the chain node's `startLine`–`endLine` range.

**Implementation approach:**

1. `extractMetadata` currently returns `{ httpCalls, httpCallDetails, ... }` — it takes only `content` as input.
2. Change `extractMetadata` signature to accept optional `startLine` and `endLine` parameters.
3. When line range is provided, filter `httpCallDetails` to exclude entries from outside the range.
4. When line range is not provided (or `startLine === undefined`), include all entries (backward compatible).

**Line matching strategy:**
- Each `HttpCallDetail` does not currently carry line number information.
- Need to track which line each match was found on during regex extraction.
- Modify `HTTP_CALL_PATTERN` and `FEIGN_HTTP_ANNOTATION_PATTERN` matching loops to record line numbers.
- Filter: keep entries where `matchLine >= startLine && matchLine <= endLine`.

### HttpCallDetail Interface Update

```typescript
export interface HttpCallDetail {
  httpMethod: string;
  urlExpression: string;
  resolvedUrl?: string;
  isFeignClient?: boolean;
  lineNumber?: number;  // NEW: line number where the call was found
}
```

### extractMetadata Signature Update

```typescript
// Before:
function extractMetadata(content: string): TraceMetadata

// After:
function extractMetadata(content: string, startLine?: number, endLine?: number): TraceMetadata
```

### Line Number Tracking

In the extraction loops, use `RegExp.lastIndex` or manual line counting to determine the line number of each match:

```typescript
// In the HTTP_CALL_PATTERN loop:
while ((httpMatch = HTTP_CALL_PATTERN.exec(content)) !== null) {
  const lineNumber = content.substring(0, httpMatch.index).split('\n').length;
  // ... existing dedup check ...
  metadata.httpCallDetails.push({ httpMethod, urlExpression, lineNumber });
}

// After extraction:
if (startLine !== undefined && endLine !== undefined) {
  metadata.httpCallDetails = metadata.httpCallDetails.filter(
    d => d.lineNumber === undefined || (d.lineNumber >= startLine && d.lineNumber <= endLine)
  );
}
```

### Call Site Updates

1. `executeTrace` line ~1244: Pass `nodeInfo.startLine` and `nodeInfo.endLine` to `extractMetadata`:
   ```typescript
   metadata: extractMetadata(content, nodeInfo.startLine, nodeInfo.endLine),
   ```

## Business Rules

1. **Line range filtering is additive** — it only removes entries, never adds new ones
2. **Backward compatible** — when `startLine`/`endLine` are undefined, all entries are included
3. **One-to-one correspondence** — each remaining `httpCallDetail` maps to exactly one actual HTTP call in the handler's source code
4. **Self-reference exclusion** (from #35) still applies on top of line-range filtering

## Response Shape

No change to `DownstreamApi` interface. The output shape is identical — just more accurate data (fewer false positives).