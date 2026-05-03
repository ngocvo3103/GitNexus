---
title: "`endpoints` tool returns empty array for FastAPI (Python) repos"
labels: [triage, high]
---

## Steps to reproduce
1. Index a FastAPI project with routers (e.g., `sample-fastapi` fixture)
2. Call `endpoints(repo="sample-fastapi")`
3. Observe result: `{"endpoints": []}`

## Actual behavior
The `endpoints` tool returns an empty array. The `query` tool correctly finds handler functions (`get_users`, `create_user`, `get_order`, `delete_order`, `health`), confirming code is indexed but route extraction is missing. Cypher `MATCH (r:Route) RETURN r.name` also returns `[]` — no Route nodes created during ingestion.

The fixture has clear `@router.get("/users")`, `@router.post("/users")`, `@router.delete("/orders/{order_id}")` decorators and `app.include_router(users.router, prefix="/api")` registration.

## Expected behavior
`endpoints` should return Route nodes for all FastAPI decorators, with correct method, path, handler, and controller fields.

## User impact
All endpoint-dependent tools (`endpoints`, `document-endpoint`, `impacted_endpoints`) are completely non-functional for FastAPI projects — a major Python framework.

## Evidence
```json
endpoints(repo="sample-fastapi") → {"endpoints": []}
query(query="FastAPI routes", repo="sample-fastapi") → finds get_users, create_user, etc.
MATCH (r:Route) RETURN r.name → []
```

Fixture: `gitnexus/test/fixtures/sample-fastapi/`