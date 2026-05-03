---
title: "`impact` tool silently picks wrong candidate for ambiguous symbol names"
labels: [triage, medium]
---

## Steps to reproduce
1. Call `impact(target="GetOrder", direction="upstream", repo="sample-gin")`
2. `GetOrder` exists in both `services/order_service.go` and `handlers/order_handler.go`

## Actual behavior
`impact` silently picks the service method (first candidate) which has 0 upstream callers, rather than the handler method which would have the route as a caller.

Meanwhile, `context(name="GetOrder")` properly returns `status: "ambiguous"` with both candidates.

## Expected behavior
`impact` should either (a) require disambiguation like `context` does, or (b) analyze all candidates and show which one has meaningful impact data.

## User impact
User gets a misleading "LOW risk, 0 impacted" result when the handler version would show a route dependency. This could cause a user to underestimate the blast radius of a change.

## Evidence
```json
impact(target="GetOrder", direction="upstream", repo="sample-gin") →
{ "risk": "LOW", "byDepth": { "d=1": [] } }

context(name="GetOrder", repo="sample-gin") →
{ "status": "ambiguous", "candidates": ["handlers/order_handler.go", "services/order_service.go"] }
```