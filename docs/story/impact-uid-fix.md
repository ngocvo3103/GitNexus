# Work Item: impact uid parameter completely broken — all uid-format targets fail

**Issue:** #17
**Type:** Bug
**Priority:** High
**Labels:** bug, high, confirmed
**Status:** in review

## Problem Statement

The `impact` MCP tool rejects uid-format targets like `Class:UserController` with "Target not found", even though `context()` returns uids in this exact format. The disambiguation workflow (context → uid → impact) is completely broken.

## Root Cause

`_impactImpl` (local-backend.ts:3088-3122) only queries `n.name = $targetName`. When passed `Class:UserController`, it searches for `n.name = 'Class:UserController'` which fails because `n.name` is `UserController` while `n.id` is `Class:UserController`. The `context` tool already handles this correctly with `isQualified` detection and `WHERE n.id = $symName OR n.name = $symName`.

## Fix

Add `isQualified` detection to `_impactImpl`:
1. Detect if target contains `:` or `/`
2. If qualified, try `MATCH (n) WHERE n.id = $targetName` first (uid match)
3. If uid match fails, extract name part and fall back to existing priority-based name lookup
4. Plain name targets work identically to before

## Planning Artifacts

- **Solution design:** `docs/designs/impact-uid-fix-solution-design.md`
- **Backend spec:** `docs/context/impact-uid-resolution.md`
- **Plan:** `docs/plans/impact-uid-fix.md`
- **Test strategy:** See plan document § Test Strategy

## Acceptance Criteria

- [x] `impact(target="Class:UserController")` returns full result (not "Target not found")
- [x] `impact(target="UserController")` returns same result as before
- [x] All unit tests pass (19/19)
- [x] Existing integration tests pass (no regression — 3380 passed)

## Implementation Summary

### WIs Completed
- **WI-1**: Added `isQualified` detection and uid-match resolution to `_impactImpl` in `gitnexus/src/mcp/local/local-backend.ts`
- **WI-2**: Updated impact tool schema description in `gitnexus/src/mcp/tools.ts` to document uid format support
- **WI-3**: Created `gitnexus/test/unit/impact-uid-resolution.test.ts` with 19 unit tests

### Code Polish Fixes
- Replaced `pop()!` with `pop() ?? target` for defensive name extraction
- Added `logQueryError` for uid query `.catch()` block
- Added 3 missing tests: T1.5 (degenerate edge case `Class:`), T3.4 (unlabeled fallback), T4.3 (Interface seed expansion)
- Strengthened T5.2 error assertion

### Review Notes
- Pre-existing issues documented as follow-ups: direction enum in schema, minConfidence default mismatch, BFS string interpolation, shared resolveSymbol helper