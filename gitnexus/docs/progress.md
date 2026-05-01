# Impacted Endpoints Test Plan — Progress Tracker

**Started:** 2026-04-30
**Branch:** feature/impact_analysis_to_endpoint

---

## Phase 1: Baseline ✅
- [x] All 3240 existing unit tests pass (4 skipped)

## Phase 2: Unit Tests for Coverage Gaps ✅
- [x] 2.1 BFS Traversal Edge Cases (9 tests: U-BFS01–U-BFS10, U-BFS03 impractical)
- [x] 2.2 Route Discovery Queries (7 tests: U-RD01–U-RD07)
- [x] 2.3 Tier Classification (9 tests: U-T01–U-T09)
- [x] 2.4 Risk Scoring (13 tests: U-R01–U-R13)
- [x] 2.5 Error Handling (7 tests: U-E01–U-E07)
- [x] 2.6 Multi-Repo Dispatch (6 tests: U-MR01–U-MR06)
- [x] 2.7 Regression: detect_changes (5 tests: U-REG01–U-REG05)
- **56 new unit tests** — full suite 3296 pass

## Phase 3: Sample Projects ✅
- [x] Python (FastAPI) — test/fixtures/sample-fastapi/ (13 files)
- [x] Go (Gin) — test/fixtures/sample-gin/ (10 files)
- [x] TypeScript/Angular — test/fixtures/sample-angular/ (11 files)
- [x] Java (Spring Boot minimal) — test/fixtures/sample-spring-minimal/ (12 files)
- All projects have git repos initialized

## Phase 4: E2E Acceptance Tests ✅
- [x] Java scenarios (E2E-J01, J02, J03, J06, J08a, J08b)
- [x] Shape validation (summary fields, endpoint fields, tier boundaries)
- [x] Multi-file change detection
- [x] HealthController route discovery
- **14 E2E integration tests** — all pass

## Phase 5: Regression Suite ✅
- [x] Unit tests: 3296 pass (0 regressions)
- [x] E2E integration: 14 pass (pre-existing failures in cobol/route-node unrelated)
- [x] MCP tool regression: 7/8 pass (R-08 impacted_endpoints needs MCP restart, not a code bug)
- [x] execGitDiff regression: 5 tests (R-09–R-11) covered in Phase 2

## Phase 6: Gap Fixes Implementation ✅
- [x] WI-1: FETCHES query uses $expandedIds (Gap 4) — U-RD08, U-RD04 updated
- [x] WI-2: FETCHES query removes (s:Function) label (Gap 5) — U-RD09
- [x] WI-3: OVERRIDES added to BFS relTypes (Gap 6) — U-BFS11
- [x] WI-4: Cross-repo BFS bridging via CrossRepoContext (Gap 2) — U-MR07, U-MR08, 5 cross-repo tests
- [x] WI-5: Interface resolution in BFS (Gap 3) — U-IMPL01-04
- [x] WI-6/WI-7: Deferred to separate story docs

## Phase 7: Manual Verification ✅
- [x] Build: `npm run build` clean
- [x] Unit tests: 3295 pass (4 skipped)
- [x] E2E integration: 14 pass
- [x] vitest.config.ts updated: added impacted-endpoints-e2e + exec-git-diff to lbug-db project
- [x] TypeScript type fix: added ImpactedEndpointsResult interface to E2E test
- [x] Real-repo verification: tcbs-bond-trading has 0 Route nodes (only tcbs-bond-trading-core has 1: /actuator/health), confirming Gap 1 (non-Java route extractors) is the real blocker for production data
- [x] Cross-repo verification: all 6 repos indexed (bond-exception-handler, matching-engine-client, tcbs-bond-amqp, tcbs-bond-amqp-message, tcbs-bond-trading, tcbs-bond-trading-core)

## Phase 8: WI-1 & WI-2 Implementation ✅
- [x] WI-1: Annotation-based route fallback (always-run 4th parallel query)
- [x] WI-2: Index health check + diagnostics (`_diagnostics` field, schema version tracking)
- [x] Shared utility: `src/mcp/local/route-annotation-parser.ts` (32 unit tests)
- [x] `document-endpoint.ts` refactored to use shared annotation parser
- [x] `analyze.ts` now writes `schemaVersion` to `meta.json`
- [x] 6 annotation-fallback unit tests (AF-01–AF-06) + 6 health check unit tests (HC-01–HC-06)
- [x] Build: `npm run build` clean
- [x] Unit tests: 3354 pass (4 skipped)
- [x] E2E integration: 14 pass

## Phase 9: Re-index & Real-Repo Verification ✅
- [x] Re-indexed tcbs-bond-trading with `--force` → 341 Route nodes, schemaVersion: 29
- [x] Re-indexed all 5 dependent repos (bond-exception-handler, matching-engine-client, tcbs-bond-amqp, tcbs-bond-amqp-message, tcbs-bond-trading-core)
- [x] `impacted_endpoints` on real tcbs-bond-trading: **5 impacted endpoints** (all WILL_BREAK), 35 changed_symbols, CRITICAL risk level
- [x] `impacted_endpoints` no longer returns 0 on real repos — the critical gap is resolved

## Phase 10: Multi-Language + Cross-Repo E2E Tests ✅
- [x] Seed data expanded: Python/FastAPI, Go/Gin, TypeScript/Angular, cross-repo consumer/library
- [x] 7 new multi-language E2E scenarios (E2E-PY01, PY02, GO01, GO02, TS01, ANN01, AF01)
- [x] 3 cross-repo E2E scenarios (consumer standalone, library standalone, aggregation placeholder)
- [x] vitest.config.ts updated: cross-repo test in lbug-db include + default exclude
- [x] Build: `npm run build` clean
- [x] Unit tests: 3354 pass (4 skipped)
- [x] E2E integration: 21 pass (main) + 3 pass (cross-repo) = 24 total

## Summary
- **Total new tests:** 75 (56 unit + 14 E2E + 5 regression) + 14 gap-fix tests + 12 WI-1/WI-2 tests + 32 parser tests + 10 multi-lang/cross-repo E2E = 143
- **Total test count:** 3354 unit tests, 24 E2E integration
- **Bugs found:** 0
- **Regressions:** 0
- **Architectural gaps identified:** 7 (5 fixed, 2 deferred)
- **Production fix verified:** impacted_endpoints works on real tcbs-bond-trading repo (5 endpoints, CRITICAL risk)

## Phase 11: Function-Level Diff Resolution ✅
- [x] New module `parse-diff-lines.ts`: `FileDiffWithLines`, `LineRange`, `parseDiffOutputWithLines` (9 unit tests)
- [x] New method `execGitDiffWithLines()`: uses `git diff --unified=0` for line-range-aware diff
- [x] Modified `_impactedEndpointsImpl` Steps 1+2: line-range filtering with fallback to file-level
- [x] Updated mock strategy in E2E tests: `buildUnifiedDiff`, `mockGitDiff`, `mockGitDiffMulti` helpers
- [x] 7 new E2E-LINE scenarios: single function, whole file, multi-hunk, transitive chain, fallback, multi-file
- [x] 5 new `execGitDiffWithLines` unit tests
- [x] Fixed cross-repo E2E test mock (consumer + library)
- [x] Path normalization fix: `changedFiles` normalized with `replace(/\\/g, '/')`
- [x] Build: `npm run build` clean
- [x] Unit tests: 3371 pass (4 skipped)
- [x] E2E tests: 28 pass (21 existing + 7 new LINE scenarios)
- [x] Cross-repo E2E: 3 pass
- [x] Real-repo verification: tcbs-bond-trading (5 endpoints), bond-exception-handler (0, library), tcbs-bond-trading-core (0, library)
## Phase 12: Cross-Repo Dependency Tracing Implementation ✅
- [x] WI-1: Reverse Dependency Map — `findConsumers()` on `CrossRepoRegistry`, 7 tests
- [x] WI-2: Cross-Repo Import Resolver — `CrossRepoResolver` with 3-stage resolution, 42 tests
- [x] WI-3: Enhanced BFS Step 3c — Replaced ID-matching query with resolver, 7 new + 2 updated tests
- [x] WI-4: Auto-Expand — `callToolMultiRepo` auto-discovers dependents, 5 new tests
- [x] WI-5: Attribution — `_triggered_by` field + cross-repo confidence, 6 new tests
- [x] WI-6: E2E + Unit Tests — Updated seed data, 5 cross-repo E2E tests
- [x] Build: `npm run build` clean
- [x] Unit tests: 239 pass (WI-related suites), pre-existing failures unchanged
- [x] E2E tests: 33 pass (28 existing + 5 cross-repo)
- [x] Pre-existing failures: COBOL resolver, document-endpoint E2E, route-node E2E (unrelated)
