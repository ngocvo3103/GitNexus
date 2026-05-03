---
title: "Go/Gin handler method CALLS edges are self-referencing instead of calling service methods"
labels: [triage, high]
---

## Steps to reproduce

1. Index the `sample-gin` repo
2. Query the CALLS relationships via Cypher:
   ```
   MATCH (n)-[r:CodeRelation]->(m) WHERE r.type = 'CALLS' RETURN n.name, n.filePath, m.name, m.filePath LIMIT 30
   ```
3. Look at handler method outgoing CALLS

## Actual behavior

Handler methods that call service methods have CALLS edges pointing back to themselves:

| Source | Source File | Target | Target File |
|--------|------------|--------|-------------|
| GetOrder | handlers/order_handler.go | GetOrder | handlers/order_handler.go |
| DeleteOrder | handlers/order_handler.go | DeleteOrder | handlers/order_handler.go |

The same bug as FastAPI: `h.service.GetOrder(id)` in the handler calls `services.OrderService.GetOrder`, but the CALLS edge points back to `handlers.OrderHandler.GetOrder` itself.

## Expected behavior

The CALLS edge should resolve to the actual service method being called:
- `OrderHandler.GetOrder` → `OrderService.GetOrder` (in `services/order_service.go`)
- `OrderHandler.DeleteOrder` → `OrderService.DeleteOrder` (in `services/order_service.go`)

## User impact

**HIGH** -- Same as the FastAPI self-referencing bug. This breaks all handler-to-service call chain tracing for Go/Gin repos, making impact analysis useless for tracing request flows from HTTP handlers through service layers.

## Evidence

Cypher query result showing self-referencing handler methods:
```
GetOrder  | handlers/order_handler.go | GetOrder  | handlers/order_handler.go
DeleteOrder | handlers/order_handler.go | DeleteOrder | handlers/order_handler.go
```

For comparison, constructor calls ARE correct:
```
NewUserHandler | handlers/user_handler.go | UserHandler | handlers/user_handler.go
main | main.go | NewUserHandler | handlers/user_handler.go
```

Source code of the handler:
```go
func (h *OrderHandler) GetOrder(c *gin.Context) {
    // ...
    result := h.service.GetOrder(id)  // Should call services.OrderService.GetOrder
    // ...
}
```