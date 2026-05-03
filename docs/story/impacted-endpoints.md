# Impacted Endpoints — Enhanced Impact Analysis

**Type:** Feature
**Created:** 2026-04-29
**Status:** in review

## Summary
Add `impacted_endpoints` MCP tool to GitNexus. Given a git base_ref, discovers all API endpoints impacted by code changes via two-phase graph traversal (upstream BFS + Route node discovery). Enables targeted integration test re-runs, documentation-update enforcement, and cross-service impact analysis.

## Context
GitNexus currently has `detect_changes` (git diff → changed symbols → affected processes) and `impact` (BFS from target symbol) but neither discovers impacted API endpoints. PR reviewers need to know which HTTP endpoints are affected by a code diff.

**Key constraints:**
- Keep existing tools completely intact (impact, detect_changes, api_impact, route_map, shape_check, endpoints, document-endpoint)
- Zero schema changes (Route nodes already exist with full properties)
- Transitive traversal (full BFS through CALLS/IMPORTS chains, not just direct handlers)
- Multi-repo support via existing CrossRepoContext
- New standalone MCP tool (not enhancement to existing)

## Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/impacted-endpoints.md` |
| Backend spec | `docs/context/impacted-endpoints.md` |
| Contract | `docs/service-context/impacted-endpoints-contract.md` |
| Test strategy | `docs/context/impacted-endpoints-test-strategy.md` |
| Design diagrams | `docs/designs/impacted-endpoints-diagrams.md` |

## Implementation Summary

**Work items completed:** 7/7 (WI-1 through WI-7)

- WI-1: Extracted `execGitDiff` helper — pure refactor, `detectChanges` unchanged
- WI-2: Implemented `_impactedEndpointsImpl` — two-phase traversal (BFS upstream + 3 parallel Route discovery queries) with tier classification
- WI-3: Registered `impacted_endpoints` tool in `GITNEXUS_TOOLS`
- WI-4: Added `callTool` dispatch case
- WI-5: Added `callToolMultiRepo` dispatch case with `_repoId` attribution
- WI-6: Created seed fixture for E2E tests
- WI-7: Wrote 45 tests (10 exec-git-diff + 14 impl + 6 tools + 12 dispatch + 3 E2E)

**Test results:** 3240 unit tests pass (0 regressions). Integration/E2E tests need running LadybugDB (pre-existing).

**Code polish:** 1 iteration. Fixed 1 BLOCKER (Cypher safety filter in BFS frontier), 4 MAJORs (module enrichment chunking, route dedup affected_by merge, multi-repo _meta aggregation, minConfidence default), 2 MINORs (env var leak in tests, minConfidence default consistency).

**Spec deltas:** None — all implementations match contract.

---

## Bug Fix: Response Format Consistency (Issue #28)

**Type:** Bug
**Created:** 2026-05-03
**Status:** in review

### Summary

The `impacted_endpoints` tool returns inconsistent `summary.changed_files` and `summary.impacted_endpoints` types: `number` for single-repo, `Record<string, number>` for multi-repo. Fix normalizes both fields to always return `Record<string, number>`.

### Planning Artifacts

| Artifact | Path |
|---|---|
| Plan | `docs/plans/impacted-endpoints-response-format.md` |
| Design diagrams | `docs/designs/impacted-endpoints-response-format-solution-design.md` |
| Contract | `docs/service-context/impacted-endpoints-contract.md` *(updated)* |

### Implementation Summary

**Work items completed:** 4/4 (WI-1 through WI-4)

- WI-1: Normalized `_impactedEndpointsImpl` return shape — `changed_files` and `impacted_endpoints` in summary are now `{ [repo.id]: count }` instead of scalar numbers. Fixed all 5 return paths (3 early returns + 2 main returns).
- WI-2: Updated `callToolMultiRepo` aggregation to merge per-repo objects via `Object.assign()` instead of building from scalars. Added backward-compat handling for number type.
- WI-3: Updated contract documentation to `Record<string, number>` with behavioral guarantee.
- WI-4: Updated `ImpactedEndpointsResult` interface, added `totalFromRecord` helper, updated all assertions, added 4 new test cases for issue #28 (object format, zero changes, repo ID keys, type checks).

**Code polish:** 1 iteration. Fixed 1 BLOCKER (3 early-return paths still emitting scalar numbers), 1 MAJOR (no multi-repo test coverage — noted but requires LadybugDB for E2E), 2 MINORs (defensive guard in `totalFromRecord`, misleading test comment).

**Spec deltas:** None — all implementations match updated contract.
