---
title: "Go/Gin service methods have no incoming CALLS despite handler→service call chain"
labels: [triage, low]
---

## Steps to reproduce

1. Index `sample-gin`
2. Call `context` on `OrderService.GetOrder`:
   ```
   context(name="GetOrder", file_path="services/order_service.go", repo="sample-gin", include_content=true)
   ```
3. Call `context` on `UserService.GetUsers`:
   ```
   context(name="GetUsers", file_path="services/user_service.go", repo="sample-gin", include_content=true)
   ```

## Actual behavior

Both service methods show `incoming: {}` -- no callers tracked:

`OrderService.GetOrder`:
```json
{
  "incoming": {},
  "outgoing": {
    "calls": [{ "name": "FormatOrder", "filePath": "utils/format.go" }]
  }
}
```

`UserService.GetUsers`:
```json
{
  "incoming": {},
  "outgoing": {
    "calls": [{ "name": "FormatUser", "filePath": "utils/format.go" }]
  }
}
```

The handler methods that call these services (`OrderHandler.GetOrder` and `UserHandler.GetUsers`) have CALLS pointing to themselves instead (see H3).

## Expected behavior

`OrderService.GetOrder` should have `incoming.calls` including `OrderHandler.GetOrder`.
`UserService.GetUsers` should have `incoming.calls` including `UserHandler.GetUsers`.

Source code clearly shows:
```go
func (h *OrderHandler) GetOrder(c *gin.Context) {
    // ...
    result := h.service.GetOrder(id)  // Calls OrderService.GetOrder
```

## User impact

**LOW** -- This is the other side of the H3 self-referencing bug. The handler methods call themselves (H3), and the service methods have no incoming callers. Together these make the handler→service call chain completely invisible in both directions. Impact analysis on service methods will show zero callers.