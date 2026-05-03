---
title: "`document-endpoint` returns both a populated result object AND an error message for non-existent endpoints"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `document-endpoint` for a path that does not exist:
   ```
   document-endpoint(method="GET", path="/nonexistent/path", repo="sample-spring-minimal")
   ```
3. Also call for a valid path in a non-Spring repo:
   ```
   document-endpoint(method="POST", path="/api/users", repo="sample-fastapi")
   ```

## Actual behavior

Both responses contain:
1. A fully populated `result` object with placeholder data (response codes, validation, persistence, etc.)
2. An `error` field saying "No endpoint found for GET /nonexistent/path"

```json
{
  "result": {
    "method": "GET",
    "path": "/nonexistent/path",
    "summary": "TODO_AI_ENRICH",
    "specs": {
      "request": { "params": [], "body": null, "validation": [] },
      "response": { "body": null, "codes": [{ "code": 200, "description": "Success" }] }
    },
    "externalDependencies": { ... },
    "logicFlow": "TODO_AI_ENRICH",
    ...
  },
  "error": "No endpoint found for GET /nonexistent/path"
}
```

## Expected behavior

When an endpoint is not found, the tool should either:
- Return only the error with NO result object (preferred), OR
- Return a clear 404-style response without fabricated data

Returning BOTH a detailed result object AND an error message is contradictory. A consumer parsing the response must handle this ambiguity, and a naive consumer might use the fabricated data thinking it's real.

## User impact

**MEDIUM** -- API documentation tools or integrations that parse the response may inadvertently use the fabricated skeleton data for non-existent endpoints, generating incorrect API documentation. The dual result/error format creates an ambiguous contract that consumers must special-case.