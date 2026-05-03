---
title: "`impacted_endpoints` response format inconsistent across repos and parameter combinations"
labels: [triage, medium]
---

## Steps to reproduce

1. Call `impacted_endpoints` with `repo="sample-spring-minimal"` -- observe `changed_files` is an object with multiple repos
2. Call `impacted_endpoints` with `repo="sample-fastapi"` -- observe `changed_files` is a number (not an object)
3. Call `impacted_endpoints` with `repo="sample-angular"` -- observe `changed_files` is an object with single repo
4. Call `impacted_endpoints` with `repos=["sample-spring-minimal"]` -- observe `changed_files` is an object with single repo

## Actual behavior

The `changed_files` field type varies across calls:

**Call 1** (repo="sample-spring-minimal"):
```json
"changed_files": { "sample-spring-minimal": 2, "tcbs-bond-trading": 8 }
```
Type: object with multiple keys (also leaks cross-repo data, see M2)

**Call 2** (repo="sample-fastapi"):
```json
"changed_files": 2
```
Type: number

**Call 3** (repo="sample-angular"):
```json
"changed_files": { "sample-angular": 2 }
```
Type: object with single key

**Call 4** (repos=["sample-spring-minimal"]):
```json
"changed_files": { "sample-spring-minimal": 2 }
```
Type: object with single key

## Expected behavior

The response format should be consistent regardless of which repo or parameter combination is used. Either always return an object keyed by repo ID, or always return a number when a single repo is specified.

## User impact

**MEDIUM** -- Inconsistent response format breaks client-side parsing. A consumer that handles `changed_files` as an object will fail when it receives a number, and vice versa. This makes it harder to build reliable integrations on top of the API.