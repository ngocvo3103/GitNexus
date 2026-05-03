---
name: R6 QA Findings 2026-05
description: 7 new issues (0 HIGH, 4 MEDIUM, 3 LOW) from deep codebase inspection and query/impact tool testing
type: project
---

# Round 6 QA Findings (2026-05-01)

7 new issues (#52-#58). Focus areas: deep codebase inspection, query quality, impact tool disambiguation, dead code, skipped tests.

## Issues Created

### #52 MEDIUM: query tool task_context and goal parameters are dead code
- `task_context` and `goal` accepted in method signature but never used in implementation
- Tools.ts documents them as "Helps ranking" but they have zero effect
- Verified: identical queries with different task_context/goal produce identical results

### #53 MEDIUM: impact tool ignores file_path parameter — resolves to wrong symbol
- `context` tool supports `file_path` disambiguation, `impact` tool does not
- `impact(target="unholdMoney", file_path=".../CashServiceV2Impl.java")` resolves to interface `CashService.java:unholdMoney`
- Cypher confirms 8 callers of `unholdMoney` exist, but impact returns 0
- Distinct from #10 (wrong candidate) — this is missing parameter support

### #54 LOW: ImportEntry.isExternal and externalRepo are dead code
- Fields defined in import-processor.ts but never populated or consumed
- Cross-repo tracking handled entirely by CrossRepoRegistry/CrossRepoResolver at query time
- No functional impact, but misleading for developers

### #55 LOW: Kotlin annotation extraction test suite entirely skipped
- `describe.skip('Kotlin', ...)` in annotation-extraction.test.ts
- Security annotations (@PreAuthorize, @Secured, @RolesAllowed) untested for all languages
- Test fixture ProjectsController.java has @PreAuthorize but no test validates extraction

### #56 MEDIUM: context tool returns no incoming callers for service implementation classes
- `context(name="CashServiceV2Impl")` returns `incoming: {}` despite 8 methods calling unholdMoney
- CALLS edges exist in graph (verified by cypher) but only at method level, not class level
- Class-level context should aggregate method-level CALLS via HAS_METHOD traversal

### #57 LOW: query tool ranks test files above production code
- `query("BondService")` returns BondTests.java, findOne (test method), BondTests (test class) before the actual BondService interface
- `isTestFilePath()` exists in local-backend.ts but is not used by query ranking
- Should demote test-file results by a factor (e.g., 0.5) in RRF scoring

### #58 MEDIUM: query max_symbols parameter reduces search quality
- Line 725: `searchLimit = processLimit * maxSymbolsPerProcess` couples search quality to output formatting
- `max_symbols=1, limit=2` → searchLimit=2 (4 total results) — processes completely missed
- `max_symbols=10, limit=2` → searchLimit=20 (40 total results) — processes found
- Same query returns fundamentally different results based on max_symbols
- Fix: decouple search limit from max_symbols

## Key Findings Not Reported (Already Known)

- #36: impact returns empty for implementation classes (confirmed CashServiceV2Impl returns 0 upstream)
- #10: impact picks wrong candidate for ambiguous names (confirmed: resolves interface over implementation)
- #41: cross-repo context drops relationships (confirmed: incoming is empty for cross-repo symbols)

## Codebase Insights

- CrossRepoRegistry.initialize() maps deps to consumer repo first (lines 94-96), then tries reverse lookup via artifactId match (lines 118-136)
- ImportEntry.isExternal/externalRepo never populated — cross-repo tracking is entirely query-time, not ingestion-time
- The query implementation (local-backend.ts lines 700-840) ignores task_context and goal
- Impact tool (_impactImpl, lines 3055-3150) has no file_path parameter and resolves names via UNION ALL priority (Class > Interface > Function > Method)
- describe.skip('Kotlin') in annotation-extraction.test.ts line 211