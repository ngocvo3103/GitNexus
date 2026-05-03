---
title: "FastAPI route handler CALLS edges are self-referencing instead of calling service methods"
labels: [triage, high]
---

## Steps to reproduce

1. Index the `sample-fastapi` repo
2. Query the CALLS relationships via Cypher:
   ```
   MATCH (n)-[r:CodeRelation {type: 'CALLS'}]->(m) WHERE m.name = 'get_users' AND m.filePath CONTAINS 'users.py' RETURN n.name, n.filePath, m.name, m.filePath
   ```
3. Check context for `get_users` in `app/routes/users.py`:
   ```
   context(name="get_users", file_path="app/routes/users.py", repo="sample-fastapi")
   ```

## Actual behavior

The route handler `get_users` in `app/routes/users.py` has a CALLS edge pointing to itself:

| Source | Source File | Target | Target File |
|--------|------------|--------|-------------|
| get_users | app/routes/users.py | get_users | app/routes/users.py |

This is confirmed by both Cypher and `context`. The outgoing CALLS of the route handler points back to itself, and the incoming CALLS also points from itself.

The same bug exists for ALL route handlers:
- `get_users` → `get_users` (self)
- `create_user` → `create_user` (self)
- `get_order` → `get_order` (self)
- `delete_order` → `delete_order` (self)

## Expected behavior

The route handler `get_users` in `app/routes/users.py` calls `service.get_users()` where `service` is a `UserService` instance. The CALLS edge should point to `UserService.get_users` in `app/services/user_service.py`, not back to itself.

Similarly:
- `create_user` (route) → `UserService.create_user` (service)
- `get_order` (route) → `OrderService.get_order` (service)
- `delete_order` (route) → `OrderService.delete_order` (service)

## User impact

**HIGH** -- This breaks all downstream impact analysis for Python/FastAPI repos. Any query to find "what does this route handler call?" will return itself instead of the actual service methods. This makes it impossible to trace request handling flows from routes through services.

## Evidence

Cypher query result:
```
get_users | app/routes/users.py | get_users | app/routes/users.py
create_user | app/routes/users.py | create_user | app/routes/users.py
get_order | app/routes/orders.py | get_order | app/routes/orders.py
delete_order | app/routes/orders.py | delete_order | app/routes/orders.py
```

Context output for `get_users` in `app/routes/users.py`:
```json
{
  "incoming": {
    "calls": [
      { "uid": "Function:app/routes/users.py:get_users", "name": "get_users", "filePath": "app/routes/users.py" }
    ]
  },
  "outgoing": {
    "calls": [
      { "uid": "Function:app/routes/users.py:get_users", "name": "get_users", "filePath": "app/routes/users.py" }
    ]
  }
}
```

The self-reference is clear: the function calls itself in both directions.

Source code of the route handler:
```python
@router.get("/users", response_model=List[dict])
def get_users(service: UserService = Depends(get_user_service)):
    return service.get_users()  # This should call UserService.get_users, not itself
```