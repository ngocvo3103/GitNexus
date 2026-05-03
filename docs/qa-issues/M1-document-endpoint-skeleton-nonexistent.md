---
title: "`document-endpoint` returns skeleton response for non-existent paths"
labels: [triage, medium]
---

## Steps to reproduce
1. Call `document-endpoint(method="GET", path="/nonexistent/path", repo="tcbs-bond-trading")`

## Actual behavior
Returns BOTH a full skeleton response (with `specs`, `externalDependencies`, `logicFlow: "TODO_AI_ENRICH"`, etc.) AND an `error: "No endpoint found for GET /nonexistent/path"` field. The skeleton looks like valid endpoint documentation at a glance — a user scanning the response could miss the error field and think they found a real endpoint.

## Expected behavior
When no endpoint matches, return ONLY the error. Do not return a fabricated skeleton.

## User impact
Users could mistakenly treat fabricated skeletons as real documentation, leading to incorrect understanding of API structure.

## Evidence
```json
document-endpoint(method="GET", path="/nonexistent/path", repo="tcbs-bond-trading") →
{
  "error": "No endpoint found for GET /nonexistent/path",
  "specs": { ... full skeleton ... },
  "logicFlow": "TODO_AI_ENRICH",
  ...
}
```