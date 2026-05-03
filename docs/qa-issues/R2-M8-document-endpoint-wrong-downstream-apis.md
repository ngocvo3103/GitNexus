---
title: "`document-endpoint` lists wrong downstream API calls -- includes unrelated methods from same service"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `document-endpoint` for GET /api/orders/{id}:
   ```
   document-endpoint(method="GET", path="/api/orders/{id}", repo="sample-spring-minimal")
   ```

## Actual behavior

The downstream APIs section lists TWO calls:
```yaml
## External Dependencies

**Downstream APIs:** 2 calls to 1 services

| Service | Method | Endpoint |
|---------|--------|----------|
| order | GET | /{id} |
| order | DELETE | /{id} |
```

## Expected behavior

The source code for `OrderController.getOrder` only calls `orderService.getOrder(id)`:
```java
@GetMapping("/{id}")
public ResponseEntity<String> getOrder(@PathVariable Long id) {
    String order = orderService.getOrder(id);  // Only this call
    return ResponseEntity.ok(order);
}
```

The DELETE method is called by the `deleteOrder` handler, not by `getOrder`. The downstream APIs section should only list:
```
| Service | Method | Endpoint |
|---------|--------|----------|
| order | GET | /{id} |
```

## User impact

**MEDIUM** -- Downstream API documentation is inaccurate. A user analyzing the impact of changing the order GET endpoint would be told that DELETE is also a downstream call, creating false alarm. This "guilt by association" pattern -- listing all methods of a service class instead of just the ones actually called -- undermines the specificity that makes `document-endpoint` valuable.