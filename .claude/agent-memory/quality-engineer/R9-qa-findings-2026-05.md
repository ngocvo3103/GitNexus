---
name: R9 QA Findings 2026-05
description: 14 new issues (3 HIGH, 7 MEDIUM, 4 LOW) from Python/Go/TS ingestion, document-endpoint DELETE, missing route extractors, interface duplication testing
type: project
---

# Round 9 QA Findings — 2026-05-02

Focus areas: Python ingestion, Go ingestion, TypeScript/Angular ingestion, tool interaction combinations, Cypher advanced queries, document-endpoint with real endpoints, version/index health.

## New Issues Created (#76-#89)

| # | Severity | Title | Category |
|---|----------|-------|----------|
| 76 | MEDIUM | Python class methods indexed as Function instead of Method nodes | Python ingestion |
| 77 | MEDIUM | Go anonymous struct fields leak as Properties of parent struct | Go ingestion |
| 78 | HIGH | FastAPI repos have 0 execution flows — CALLS edges self-reference | Python ingestion |
| 79 | HIGH | No Python route extractor — FastAPI and Flask endpoints never discovered | Missing feature |
| 80 | HIGH | Go/Gin endpoints tool returns empty array — no Go route extractor | Missing feature |
| 81 | HIGH | document-endpoint returns wrong handler for DELETE requests | document-endpoint |
| 82 | LOW | Cypher count{} pattern comprehension syntax not supported | Cypher |
| 83 | MEDIUM | Python/TS Interface types duplicated at import locations | Ingestion |
| 84 | HIGH | FastAPI DI calls resolve to same-name local function (Python self-referencing CALLS) | Python ingestion |
| 85 | MEDIUM | Go IMPLEMENTS relationships not created between structs and interfaces | Go ingestion |
| 86 | MEDIUM | Function/Method parameterCount and returnType not populated for any language | Schema |
| 87 | MEDIUM | Angular duplicate Interface nodes at import sites | TS ingestion |
| 88 | MEDIUM | Go interface methods not indexed — IUserService.GetUsers missing | Go ingestion |
| 89 | LOW | TypeScript Interface node startLine=0 for non-zero-line definitions | TS ingestion |

## Key Discoveries

### Python Ingestion (Critical Gaps)
- Python class methods (including __init__) are typed as `Function`, not `Method` — inconsistent with Go/TS/Java
- FastAPI repos produce 0 execution flows because CALLS edges self-reference route handlers
- No Python route extractor exists — FastAPI/Flask/Django endpoints never discovered
- Python decorators (@router.get) not captured as graph nodes at all

### Go Ingestion (Interface Gaps)
- IMPLEMENTS relationships return empty even with correct Interface and Struct nodes
- Go interface methods not indexed (IUserService.GetUsers missing)
- Anonymous struct fields inside function bodies leak as parent struct Properties

### TypeScript/Angular Ingestion
- Interface nodes duplicated at import locations (User in format.util.ts AND user.service.ts)
- First Interface in a file often has startLine=0

### document-endpoint
- DELETE method endpoints return wrong handler (ProductController instead of OrderExtController)
- HTTP method constraint ignored in fallback matching
- DELETE method endpoints not extracted at all (endpoints tool returns empty for DELETE)

### Schema Accuracy
- parameterCount and returnType documented in schema but never populated for any language
- Cypher count{} pattern comprehension syntax not supported

### Index Health
- Schema version 29, all repos indexed successfully
- list_repos correctly shows all 4 indexed repos
- FastAPI: 40 nodes / 0 processes; Gin: 61 nodes / 4 processes; Angular: 74 nodes / 1 process