---
title: "`impact` tool uid parameter always fails with 'Target not found'"
labels: [triage, high]
---

## Steps to reproduce

1. Use `context` to find a symbol and get its uid, e.g., `Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl`
2. Pass that uid as the `target` parameter to `impact`:
   ```
   impact(target="Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl", direction="upstream", repo="sample-spring-minimal")
   ```
3. Repeat with method uids, function uids, and struct uids across all repos

## Actual behavior

ALL uid-based `impact` lookups fail with:
```
Target 'Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl' not found
```

Tested with:
- `Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl` (Spring)
- `Method:src/main/java/com/example/service/OrderService.java:getOrder` (Spring)
- `Function:app/routes/users.py:get_users` (FastAPI)
- `Struct:services/user_service.go:UserService` (Go/Gin)

All return "Target 'undefined' not found" or "Target '...uid...' not found".

## Expected behavior

The `impact` tool should accept uid values returned by `context` and `query` to disambiguate symbols. The uid format `Kind:filePath:name` is the canonical identifier used throughout the system.

## User impact

**CRITICAL** -- This makes `impact` useless for disambiguation. When a symbol name is ambiguous (e.g., `getUsers` exists in UserController, UserService interface, and UserServiceImpl), the user has NO way to specify which one they mean. The `context` tool correctly handles ambiguity by returning candidates, but `impact` simply fails instead of either resolving the uid or returning the ambiguous candidates.

Without uid-based lookup, users cannot perform accurate impact analysis on any symbol that shares a name with another symbol in the codebase.

## Evidence

```
impact(target="Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl", direction="upstream", repo="sample-spring-minimal")
→ { "error": "Target 'Class:src/main/java/com/example/service/UserServiceImpl.java:UserServiceImpl' not found" }

impact(target="Method:src/main/java/com/example/service/OrderService.java:getOrder", direction="upstream", repo="sample-spring-minimal")
→ { "error": "Target 'Method:src/main/java/com/example/service/OrderService.java:getOrder' not found" }

impact(target="Function:app/routes/users.py:get_users", direction="upstream", repo="sample-fastapi")
→ { "error": "Target 'Function:app/routes/users.py:get_users' not found" }

impact(target="Struct:services/user_service.go:UserService", direction="downstream", repo="sample-gin")
→ { "error": "Target 'Struct:services/user_service.go:UserService' not found" }
```

For comparison, the same uids work perfectly with `context`:
```
context(uid="Method:src/main/java/com/example/controller/UserController.java:getUsers", repo="sample-spring-minimal")
→ { "status": "found", "symbol": { ... } }
```