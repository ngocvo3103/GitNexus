---
title: "`context` incoming references are file-level IMPORTS, not method-level CALLS"
labels: [triage, low]
---

## Steps to reproduce
1. Call `context(name="UserService", repo="sample-angular")`
2. Check `incoming.imports` field

## Actual behavior
For Angular `UserService`: `incoming.imports` shows `app.module.ts` and `user-list.component.ts` (file-level), but not the specific `constructor` injection or `this.userService.getUsers()` method call.

Similar issue in Go: relations are at the struct/file level rather than method level.

## Expected behavior
`context` should show method-level call references (e.g., `constructor(private userService: UserService)`, `this.userService.getUsers()`) not just file-level imports.

## User impact
Impact analysis is shallow for non-Java repos — shows file depends on symbol via IMPORTS, but doesn't show which specific method calls it.

## Evidence
```json
context(name="UserService", repo="sample-angular") →
{ "incoming": { "imports": ["app.module.ts", "user-list.component.ts"] } }
// Missing: constructor injection, method call references
```