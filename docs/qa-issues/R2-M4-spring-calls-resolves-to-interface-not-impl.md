---
title: "Spring CALLS edges resolve to interface methods instead of implementations -- breaks impact analysis"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `context` on `UserController.getUsers`:
   ```
   context(uid="Method:src/main/java/com/example/controller/UserController.java:getUsers", repo="sample-spring-minimal")
   ```
3. Call `impact` on `UserServiceImpl`:
   ```
   impact(target="UserServiceImpl", direction="upstream", repo="sample-spring-minimal")
   ```

## Actual behavior

`UserController.getUsers` outgoing CALLS point to the interface method:
```json
{
  "outgoing": {
    "calls": [
      { "uid": "Method:src/main/java/com/example/service/UserService.java:getUsers", "filePath": "src/main/java/com/example/service/UserService.java" }
    ]
  }
}
```

This means `impact` on `UserServiceImpl` returns **0 upstream dependents** because no CALLS edge directly points to `UserServiceImpl`. The call chain is:
```
UserController.getUsers → UserService.getUsers (interface)
UserServiceImpl IMPLEMENTS UserService (tracked)
```

But the CALLS from UserController stops at the interface. The implementation resolution is not followed.

## Expected behavior

One of two approaches should work:
1. **CALLS should resolve to the implementation** -- `UserController.getUsers` calls `userService.getUsers()` where `userService` is injected. At the CALLS level, it should point to `UserServiceImpl.getUsers` (the runtime implementation), OR
2. **Impact should follow IMPLEMENTS edges transitively** -- When searching upstream from `UserServiceImpl`, it should find `UserController` by following: `UserController.getUsers` CALLS→ `UserService.getUsers` ← IMPLEMENTS `UserServiceImpl`

## User impact

**MEDIUM** -- Impact analysis on any Spring class that implements an interface will miss callers who depend on the interface. Since interface-based DI is the standard Spring pattern (UserService interface injected into UserController), this means impact analysis is fundamentally broken for the majority of Spring service classes. Users asking "what breaks if I change UserServiceImpl?" will get 0 results even though UserController directly calls it.