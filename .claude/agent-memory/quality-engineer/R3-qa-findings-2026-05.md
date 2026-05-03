---
name: R3 QA Findings 2026-05
description: Round 3 QA testing findings for GitNexus knowledge graph tools
type: project
---

## Round 3 QA Testing - May 2026

### Scope
Thorough user-perspective testing of GitNexus MCP tools: detect_changes, impacted_endpoints, cypher, query, document-endpoint, rename, impact, context. Focus on edge cases, error handling, data integrity, performance. Tested primarily on tcbs-bond-trading repo (912 files, 11857 nodes, 31656 edges).

### Key Findings Summary (6 new issues, 0 duplicates with Rounds 1-2)

**HIGH (1):**
- R3-H1: `document-endpoint` includes its own endpoint as downstream API dependency via class-name-heuristic

**MEDIUM (3):**
- R3-M1: `impact` returns 0 upstream callers for implementation classes (doesn't follow IMPLEMENTS to interface)
- R3-M2: `rename` produces duplicate edits on same line when EXTENDS+IMPORTS edges resolve to same code location
- R3-M3: `document-endpoint` logicFlow contains duplicate method names (e.g., "getBondById → getBondById")

**LOW (2):**
- R3-L1: `document-endpoint` classifies Map<String,Object> response body as source "primitive"
- R3-L2: `document-endpoint` returns excessively large results (56KB+) for deep endpoints

### Confirmed Still Present from Rounds 1-2
- R2-M4/M2: Spring CALLS resolves to interface not impl; impact returns 0 for impl classes
- R2-M5: Non-code files (CLAUDE.md etc.) still in graph and detect_changes results
- R2-L2: Interface kind reported as "Class" in context tool (systemic, affects all interfaces)

### Not Issues (verified working correctly)
- detect_changes: all 4 scopes (unstaged, staged, all, compare) work correctly
- detect_changes: compare scope properly handles branch references
- impacted_endpoints: tier classification works as designed (empty deeper tiers due to no CALLS edges)
- query: handles empty strings (error), typos (fuzzy results), non-English text (empty results) correctly
- context: properly disambiguates ambiguous symbols, returns candidates
- impact/rename: properly handle non-existent symbols with clear errors
- cypher: handles invalid queries with clear parser error messages
- endpoints: correctly returns empty for DELETE/PATCH (none exist in tcbs-bond-trading)
- line numbers in context tool match actual file content
- rename: correctly scopes to specified repo, doesn't leak across repos

### Why: Third round of systematic QA testing
### How to apply: Check these findings before reporting new issues