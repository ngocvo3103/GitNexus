---
title: "`endpoints` tool does not support `repos` parameter for cross-repo queries"
labels: [triage, medium]
---

## Steps to reproduce
1. Call `endpoints(repos=["sample-spring-minimal", "sample-gin"])`

## Actual behavior
Returns error: "Multiple repositories indexed. Specify which one with the 'repo' parameter."

## Expected behavior
`endpoints` should support cross-repo queries consistent with other tools (`query`, `impacted_endpoints`) which properly support the `repos` parameter with `_repoId` attribution.

## User impact
Users with multiple indexed repos cannot query endpoints across repos in a single call, unlike other GitNexus tools.

## Evidence
```json
endpoints(repos=["sample-spring-minimal", "sample-gin"]) →
{ "error": "Multiple repositories indexed. Specify which one with the 'repo' parameter." }
```