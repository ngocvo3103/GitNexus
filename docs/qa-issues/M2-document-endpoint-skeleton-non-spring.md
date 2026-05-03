---
title: "`document-endpoint` returns misleading skeleton for FastAPI/Gin repos"
labels: [triage, medium]
---

## Steps to reproduce
1. Call `document-endpoint(method="GET", path="/api/users", repo="sample-fastapi")`
2. Since FastAPI endpoints are never indexed (see H1), every call returns the same skeleton + error pattern.

## Actual behavior
Returns full skeleton with all `TODO_AI_ENRICH` fields plus `error: "No endpoint found for GET /api/users"`.

## Expected behavior
Return only the error, not a fake skeleton. Same root cause as the non-existent path issue but exacerbated because ALL paths will fail for non-Spring repos.

## User impact
Every `document-endpoint` call against FastAPI/Gin repos produces misleading output.

## Evidence
```json
document-endpoint(method="GET", path="/api/users", repo="sample-fastapi") →
{
  "error": "No endpoint found for GET /api/users",
  "specs": { ... skeleton ... }
}
```