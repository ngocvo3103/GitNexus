---
name: R5 QA Findings 2026-05
description: 6 new issues (2 HIGH, 2 MEDIUM, 2 LOW) from cross-repo tracing and CLI testing of GitNexus
type: project
---

# Round 5 QA Findings — 2026-05-01

## Summary
6 NEW issues found (2 HIGH, 2 MEDIUM, 2 LOW). GitHub issues #46-#51.

Focus areas tested:
1. Cross-repo dependency tracing (THE KEY FEATURE of this branch)
2. Integration test suite
3. CLI commands
4. Data consistency between tools
5. Special Spring code patterns
6. Concurrent/stress testing

## Key Findings

### HIGH: Cross-repo registry artifactId-to-repoName mismatch (#46)
The `CrossRepoRegistry` reverse dependency map is broken because Maven artifactIds don't match GitNexus repo names. Manifest says `com.tcbs.bond.trading:exception-handler` but repo is named `bond-exception-handler`. The WI-1 code checks `this.entries.has('exception-handler')` which fails. Result: `findConsumers('bond-exception-handler')` returns `[]`, and `findDepRepo('com.tcbs.bond.trading:exception-handler')` wrongly returns `tcbs-bond-amqp` instead of `bond-exception-handler`. Self-referencing also occurs.

### HIGH: Cross-repo resolver all 3 stages fail for real Maven deps (#50)
The CrossRepoResolver's 3-stage resolution completely fails because:
- Stage 1: IMPORTS edges never cross repo boundaries (import processor only creates edges for locally resolvable files)
- Stage 2: Consumer repo has no Class nodes for external dependency classes
- Stage 3: Package-path matching would match wrong local files in the same package directory

Evidence: BondExtController imports TcbsErrorCode and TcbsException from bond-exception-handler, but graph shows only 3 IMPORTS edges (all local). Zero cross-repo IMPORTS edges exist.

### MEDIUM: impacted_endpoints summary format differs between single-repo and multi-repo (#49)
Single-repo returns `{ changed_files: number, changed_symbols: number, impacted_endpoints: number }`.
Cross-repo returns `{ changed_files: {repoId: count}, impacted_endpoints: {repoId: count} }` (changed_symbols missing from summary).
Current code always uses cross-repo format even for single-repo calls.

### MEDIUM: CLI query/context crash with raw stack trace when multiple repos indexed (#47)
`gitnexus query` and `gitnexus context` throw unhandled Node.js exceptions with full stack trace when multiple repos are indexed. The `impact` command handles this gracefully with a JSON error.

### LOW: analyze --skip-git on empty dir creates 0-node index and pollutes registry (#48)
Running `gitnexus analyze --skip-git /tmp/nonexistent-path` succeeds with 0 nodes, adds it to the global registry, and creates AGENTS.md/CLAUDE.md in the target directory.

### LOW: detect_changes includes non-code files (CLAUDE.md) as changed symbols (#51)
CLAUDE.md and other non-code files appear in changed_symbols, inflating change counts.

## Test Results

### Integration Tests
- All 5392 unit/integration tests PASS (165 test files, 0 failures)
- `impacted-endpoints-e2e.test.ts`: 28/28 pass
- `impacted-endpoints-cross-repo.test.ts`: 5/5 pass (seeded fixture tests only)

### CLI
- `analyze`: Works, but --skip-git allows empty dirs
- `status`: Works correctly
- `list`: Works correctly
- `clean --all -f`: Works
- `query/context/impact/cypher`: Crash when multiple repos without --repo

### Data Consistency
- BondServiceImpl: startLine 47, endLine 519 — consistent across query, context, impact, cypher
- BondExtController: startLine 29, endLine 103 — consistent

### Spring Patterns
- @EventListener: BondEventHandler tracked with 30 methods (Interface + Impl)
- @Async: processTradingWhenHaveProductForSale appears in processes
- @Transactional: No special tracking (correct — it's AOP, not structural)
- No @ControllerAdvice in tcbs-bond-trading graph (it's in bond-exception-handler)

### Concurrent Testing
- 5 simultaneous tool calls: all completed successfully with consistent results
- No race conditions observed

### Cross-Repo (the KEY finding)
- The entire cross-repo feature is non-functional for real Maven dependencies
- Root cause: import processor drops external imports + registry artifactId mismatch
- The seeded integration tests pass because they use synthetic combined-seed data that has IMPORTS edges within a single graph — this doesn't represent real cross-repo scenarios where each repo has its own separate graph