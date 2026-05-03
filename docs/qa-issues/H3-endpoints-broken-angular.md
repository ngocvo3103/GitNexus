---
title: "`endpoints` tool returns broken data for Angular repos"
labels: [triage, high]
---

## Steps to reproduce
1. Index an Angular project (e.g., `sample-angular` fixture)
2. Call `endpoints(repo="sample-angular")`
3. Observe result: 7 entries all missing `method`, `path`, `controller`, `handler` fields, all with `line: -1`

## Actual behavior
Returns entries like `{"filePath": "src/app/services/user.service.ts", "line": -1}` with no method, path, controller, or handler fields. Additionally, `query` creates an incorrect `Route:/app.module` symbol from `AppModule` (an NgModule, not an HTTP route).

## Expected behavior
Angular is a client-side framework that consumes APIs, not defines HTTP endpoints. The tool should either:
- Clearly mark these as client-side HTTP calls with method/path info, or
- Not return them as endpoints at all

## User impact
Users get completely unusable endpoint data — entries cannot be navigated, have no method/path info, and the data is structurally broken.

## Evidence
```json
endpoints(repo="sample-angular") → [
  {"filePath": "src/app/services/user.service.ts", "line": -1},
  ... (6 more entries, all missing method/path/controller/handler)
]
```

Fixture: `gitnexus/test/fixtures/sample-angular/`