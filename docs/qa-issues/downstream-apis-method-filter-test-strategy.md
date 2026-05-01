# Test Strategy: Downstream API Method Filtering

## Risk Calibration

This is a data accuracy bug fix in the trace extraction pipeline. The fix adds line-range filtering to `extractMetadata`. The key risk is over-filtering (removing legitimate calls) rather than under-filtering (leaving false positives). Testing should focus on:
- **Deep**: Line-range filtering correctness (boundary conditions, missing data)
- **Light**: Integration/E2E (the fix is deterministic, no external dependencies)

## Coverage Map

| Test Level | WIs | Key Invariants |
|---|---|---|
| Unit | WI-1, WI-2 | httpCallDetails only includes calls within handler line range; methods outside range are excluded; empty line range falls back to current behavior |

## Per-WI Test Assignments

### WI-1: Filter httpCallDetails to handler line range

**Level:** Unit  
**Technique:** Equivalence partitioning + boundary value analysis  
**File:** `gitnexus/test/unit/trace-executor.test.ts` (or new `test/unit/metadata-filtering.test.ts`)  

**Test Cases:**

| TC# | Description | Input | Expected |
|---|---|---|---|
| TC-1 | Handler with single call in range | content with 2 methods, startLine=5, endLine=10, call at line 7 | Only the call at line 7 is in httpCallDetails |
| TC-2 | Handler with multiple calls in range | content with 3 calls, all within startLine/endLine | All 3 calls included |
| TC-3 | Sibling method call outside range | content with call at line 35, handler lines 5-10 | Call at line 35 is excluded |
| TC-4 | No line range provided | startLine=undefined, endLine=undefined | All calls included (backward compat) |
| TC-5 | Call at boundary line | call exactly at startLine | Included (inclusive) |
| TC-6 | Call at endLine | call exactly at endLine | Included (inclusive) |
| TC-7 | Call one line before startLine | call at startLine-1 | Excluded |
| TC-8 | FeignClient annotations filtered | @GetMapping at line 8 (within range 5-10) and @DeleteMapping at line 35 (outside range) | GET mapping included, DELETE mapping excluded |

### WI-2: Add test coverage for line-range filtering

(Tests are defined as TC-1 through TC-8 above, covering the same WI-1 fix.)

## Anti-patterns to Avoid

1. Testing with mock chains that don't include line numbers — must use realistic chain nodes with startLine/endLine
2. Only testing happy path — must verify boundary conditions and missing data
3. Testing the entire document-endpoint pipeline — focus on the extractMetadata filtering unit