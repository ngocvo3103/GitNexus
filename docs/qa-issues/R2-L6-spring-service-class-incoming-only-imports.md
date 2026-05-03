---
title: "Spring service class `context` incoming shows only file-level IMPORTS, not method-level CALLS from controllers"
labels: [triage, low]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `context` on `OrderService`:
   ```
   context(name="OrderService", repo="sample-spring-minimal", include_content=true)
   ```

## Actual behavior

`OrderService` context shows only file-level imports in incoming:
```json
{
  "incoming": {
    "imports": [
      { "uid": "File:src/main/java/com/example/controller/OrderController.java", "name": "OrderController.java" }
    ]
  }
}
```

No `calls` relationship is listed, even though `OrderController.getOrder` and `OrderController.deleteOrder` both call methods on `OrderService`.

## Expected behavior

The `incoming` section should include method-level `calls` from:
- `OrderController.getOrder` → `OrderService.getOrder`
- `OrderController.deleteOrder` → `OrderService.deleteOrder`

These CALLS edges DO exist in the graph (verified via Cypher):
```
getOrder | OrderController.java | getOrder | OrderService.java
deleteOrder | OrderController.java | deleteOrder | OrderService.java
```

But they are not surfaced in the `context` tool's incoming section at the class level.

## User impact

**LOW** -- The data exists in the graph but is not presented at the class level in `context`. Users can find the information by querying at the method level (e.g., `context(name="getOrder", file_path="OrderService.java")`), but class-level inspection provides an incomplete picture. This is related to L1 from Round 1 but specifically for the class context view not showing method-level incoming calls.