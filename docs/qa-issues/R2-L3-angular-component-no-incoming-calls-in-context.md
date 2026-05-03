---
title: "Angular component→service CALLS edges tracked in Cypher but invisible in `context` incoming"
labels: [triage, low]
---

## Steps to reproduce

1. Index `sample-angular`
2. Call `context` on `UserService`:
   ```
   context(name="UserService", repo="sample-angular")
   ```
3. Call `context` on `UserListComponent`:
   ```
   context(name="UserListComponent", repo="sample-angular")
   ```
4. Run Cypher to verify CALLS edges exist:
   ```
   MATCH (n)-[r:CodeRelation]->(m) WHERE r.type = 'CALLS' AND m.filePath CONTAINS 'user.service' RETURN n.name, n.filePath, m.name
   ```

## Actual behavior

`UserService` context shows only `imports` in incoming, no `calls`:
```json
{
  "incoming": {
    "imports": [
      { "name": "app.module.ts" },
      { "name": "user-list.component.ts" }
    ]
  }
}
```

`UserListComponent` context shows empty `incoming: {}`.

But Cypher reveals these CALLS edges DO exist:
```
ngOnInit | src/app/components/user-list.component.ts | getUsers
addUser | src/app/components/user-list.component.ts | createUser
```

## Expected behavior

`UserService` context should show `calls` in incoming from `UserListComponent.ngOnInit` and `UserListComponent.addUser`. Similarly, `UserListComponent` should show itself as having incoming dependencies from the component template or routing.

## User impact

**LOW** -- The CALLS data exists in the graph (visible via Cypher) but is not surfaced through the `context` tool's incoming/outgoing categorization. This means users relying on `context` for impact analysis will miss these call dependencies, though they can still find them via direct Cypher queries.