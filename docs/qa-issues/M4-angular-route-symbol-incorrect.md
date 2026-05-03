---
title: "Angular `Route:/app.module` symbol is incorrectly typed as Route instead of Class"
labels: [triage, medium]
---

## Steps to reproduce
1. Index an Angular project (e.g., `sample-angular`)
2. Call `query(query="Angular modules", repo="sample-angular")`
3. Observe `Route:/app.module` symbol in results

## Actual behavior
`query` returns a `Route:/app.module` definition for `AppModule` in `app.module.ts`. `AppModule` is an Angular NgModule, not an HTTP route.

## Expected behavior
Angular NgModule classes should be typed as `Class`, not `Route`.

## User impact
This pollutes the graph and confuses downstream tools that search for Route nodes, leading to incorrect endpoint detection results.

## Evidence
```json
query(query="Angular modules", repo="sample-angular") →
{ "definitions": [{ "name": "Route:/app.module", "filePath": "src/app/app.module.ts" }] }
```