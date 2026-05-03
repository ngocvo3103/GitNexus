---
title: "`endpoints` tool returns empty array for Go/Gin repos"
labels: [triage, high]
---

## Steps to reproduce
1. Index a Go/Gin project with route registrations (e.g., `sample-gin` fixture)
2. Call `endpoints(repo="sample-gin")`
3. Observe result: `{"endpoints": []}`

## Actual behavior
The `endpoints` tool returns an empty array. `main.go` contains explicit `router.GET("/users", userHandler.GetUsers)`, `router.POST("/users", userHandler.CreateUser)`, etc. Cypher `MATCH (r:Route) RETURN r.name` also returns `[]` — no Route nodes created during ingestion.

`query` correctly finds handler methods, confirming code is indexed but route extraction is missing.

## Expected behavior
`endpoints` should return Route nodes for all Gin route registrations, with correct method, path, handler, and controller fields.

## User impact
All endpoint-dependent tools are completely non-functional for Gin projects — a major Go framework.

## Evidence
```json
endpoints(repo="sample-gin") → {"endpoints": []}
query(query="Gin routes", repo="sample-gin") → finds GetUsers, CreateUser, etc.
MATCH (r:Route) RETURN r.name → []
```

Fixture: `gitnexus/test/fixtures/sample-gin/`