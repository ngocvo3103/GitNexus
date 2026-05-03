---
title: "`document-endpoint` request body schema is `type: object` without field definitions"
labels: [triage, low]
---

## Steps to reproduce
1. Call `document-endpoint(method="POST", path="/api/orders", repo="sample-spring-minimal")`

## Actual behavior
Request body schema is always `type: object` with `example: { _type: OrderDto }` instead of actual DTO field definitions.

Contrast: POST /api/users in the same repo correctly resolves the response schema to `User` with fields, proving the ingestion can resolve DTOs.

## Expected behavior
Request body should resolve to actual DTO fields like the response schema does for User.

## User impact
Request body documentation is less useful than it could be — users see a generic object instead of the actual required fields.

## Evidence
```json
document-endpoint(method="POST", path="/api/orders", repo="sample-spring-minimal") →
{ "requestBody": { "schema": { "type": "object" }, "example": { "_type": "OrderDto" } } }
// Expected: { "requestBody": { "schema": { "$ref": "#/components/schemas/OrderDto" } } }
```