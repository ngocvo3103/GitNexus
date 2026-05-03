---
title: "`document-endpoint` downstream APIs show unresolved code expressions"
labels: [triage, low]
---

## Steps to reproduce
1. Call `document-endpoint(method="POST", path="/i/v2/orders/ibond", repo="tcbs-bond-trading")`

## Actual behavior
Downstream APIs show entries like `POST url.toString()`, `GET targetUrl`, `GET [internal]`, `GET targetUrl.toString()`. These are unresolved code expressions from `RestTemplate`/`WebClient` builder patterns, not actual endpoint URLs.

## Expected behavior
Unresolved expressions should either be filtered out or clearly marked as "unresolved" rather than appearing as valid downstream dependencies.

## User impact
Users see these as valid downstream dependencies and may try to trace them, not realizing they're unresolved expressions. Known ceiling (code-expr=190).

## Evidence
```json
document-endpoint(method="POST", path="/i/v2/orders/ibond", repo="tcbs-bond-trading") →
{ "externalDependencies": { "downstreamAPIs": ["POST url.toString()", "GET targetUrl"] } }
```