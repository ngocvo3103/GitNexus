---
name: R7 QA Findings 2026-05
description: 11 new issues (3 HIGH, 4 MEDIUM, 4 LOW) from rename, impacted_endpoints, document-endpoint, Cypher, and Express testing
type: project
---

## R7 QA Findings (2026-05-01)

11 new issues filed as #60-#72. Total across all rounds: 65 issues.

### HIGH (3)

- **#60** rename: substring false-positive — renaming `getAllBond` matches `getAllBondCategory` (old_text==new_text no-op edit)
- **#61** rename: misses definition line and implementation when renaming interface method — `getBondById` on BondService finds 11 call sites but not the interface declaration or the impl method
- **#72** rename: class rename misses the definition file and most references — `BondServiceImpl` rename only finds 1 file (BondServiceV2Impl import), missing the class declaration itself

### MEDIUM (4)

- **#62** rename: misses actual call sites while finding false positives — `getAllBond` rename misses `bondService.getAllBond()` at AssetDetailServiceImpl:607,613 but finds false positive on `getAllBondCategory` at line 129
- **#63** rename: reports wrong line numbers for duplicate occurrences — AssetServiceTest has `getAllBond()` on lines 83, 165, 240 but rename reports all 3 on line 83
- **#64** impacted_endpoints: max_depth parameter is ignored — max_depth=0,1,5,10 all return identical results; LIKELY_AFFECTED and MAY_NEED_TESTING tiers never populated
- **#65** document-endpoint: returns both error and result for invalid HTTP method — `method="INVALID"` returns error field AND result object
- **#66** impact: minConfidence accepts out-of-range values (1.5) without error
- **#71** document-endpoint: returns both error and result for nonexistent endpoint path — same dual-response pattern as #65

### LOW (4)

- **#67** Cypher: Route node properties inaccessible — only `name` works; `method`, `path`, `controllerClass` cause binder exceptions
- **#68** Cypher: labels() function returns empty strings — MATCH with :Label works but labels(n)[0] returns ""
- **#69** OVERRIDES relationship type returns zero results despite being in schema
- **#70** No Express/Node.js route extractor — framework-detection.ts has Express heuristics but no route-extractors/ entry

### Additional observations (not filed as issues, related to known issues)

- impact tool on BondService (interface) returns 0 upstream callers — known #30 (resolves to interface)
- impacted_endpoints cannot traverse from CashServiceV2Impl to endpoints — same #30 root cause
- rename text_search_edits always 0 — text search mechanism appears non-functional
- document-endpoint ai_context output for POST /i/v1/orders was 127KB — very large for a single endpoint
- Community labels: most are "Impl" (231), "Service" (265), "V2" (49) — functional area heuristics but not very descriptive for Java naming convention patterns