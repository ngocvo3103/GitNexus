---
name: R2 QA Findings 2026-05
description: Round 2 QA testing findings for GitNexus knowledge graph tools
type: project
---

## Round 2 QA Testing - May 2026

### Scope
Deep testing of GitNexus MCP tools across 5 indexed repos: sample-spring-minimal, sample-fastapi, sample-gin, sample-angular, tcbs-bond-trading

### Key Findings Summary (18 new issues, 0 duplicates with Round 1)

**HIGH (3):**
- R2-H1: `impact` uid parameter completely broken -- all uid lookups fail
- R2-H2: FastAPI CALLS edges self-reference route handlers instead of service methods
- R2-H3: Go/Gin handler CALLS edges self-reference instead of pointing to service methods

**MEDIUM (9):**
- R2-M1: Go IMPLEMENTS relationships not tracked (interface implementation detection missing)
- R2-M2: `impacted_endpoints` leaks changes across repos
- R2-M3: `document-endpoint` returns wrong HTTP status codes (201→200, 204→200)
- R2-M4: Spring CALLS resolves to interface method, not implementation -- breaks impact analysis
- R2-M5: Non-code files (CLAUDE.md, AGENTS.md, pom.xml, etc.) pollute graph
- R2-M6: `document-endpoint` returns both result object and error for non-existent paths
- R2-M7: Go struct anonymous fields indexed as own properties
- R2-M8: `document-endpoint` wrong downstream APIs (all class methods instead of called ones)
- R2-M9: `impacted_endpoints` inconsistent response format across repos

**LOW (6):**
- R2-L1: Cypher `type()` function not supported
- R2-L2: UserRepository typed as Class instead of Interface
- R2-L3: Angular CALLS edges exist in Cypher but invisible in `context` incoming
- R2-L4: Angular AppModule has empty outgoing (no imports/providers tracked)
- R2-L5: Go service methods have no incoming CALLS
- R2-L6: Spring service class context shows only IMPORTS, not CALLS

### Why: Systematic deep testing across all languages and tools
### How to apply: When debugging GitNexus issues, check these known patterns first