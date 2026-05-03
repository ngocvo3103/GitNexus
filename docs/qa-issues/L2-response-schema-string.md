---
title: "Spring `document-endpoint` response schema is `type: string` for entity endpoints"
labels: [triage, low]
---

## Steps to reproduce
1. Call `document-endpoint(method="GET", path="/api/orders/{id}", repo="sample-spring-minimal")`

## Actual behavior
Response schema: `type: string` — should be an object (the method returns an order entity).

Contrast: POST /api/users correctly returns `$ref: '#/components/schemas/User'` with full field definitions.

## Expected behavior
Response schema should resolve to the actual return type entity (e.g., Order with fields), not `type: string`.

## User impact
Minor — the response schema is technically wrong but doesn't break anything functionally.

## Evidence
```json
document-endpoint(method="GET", path="/api/orders/{id}", repo="sample-spring-minimal") →
{ "response": { "schema": { "type": "string" } } }
// Expected: { "response": { "schema": { "$ref": "#/components/schemas/Order" } } }
```