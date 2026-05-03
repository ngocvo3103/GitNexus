---
title: "`document-endpoint` returns wrong HTTP status codes -- 201 and 204 reported as 200"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `document-endpoint` for POST /api/users:
   ```
   document-endpoint(method="POST", path="/api/users", repo="sample-spring-minimal")
   ```
3. Call `document-endpoint` for DELETE /api/orders/{id}:
   ```
   document-endpoint(method="DELETE", path="/api/orders/{id}", repo="sample-spring-minimal")
   ```

## Actual behavior

Both endpoints return only a `200` response code:

POST /api/users:
```yaml
responses:
  '200':
    description: Success
```

DELETE /api/orders/{id}:
```yaml
responses:
  '200':
    description: Success
```

## Expected behavior

The actual source code explicitly specifies different status codes:

UserController.createUser:
```java
@PostMapping
public ResponseEntity<User> createUser(@RequestBody CreateUserRequest request) {
    User user = userService.createUser(request.name(), request.email());
    return ResponseEntity.status(HttpStatus.CREATED).body(user);  // 201
}
```
Expected: `'201': description: Created`

OrderController.deleteOrder:
```java
@DeleteMapping("/{id}")
public ResponseEntity<Void> deleteOrder(@PathVariable Long id) {
    orderService.deleteOrder(id);
    return ResponseEntity.noContent().build();  // 204
}
```
Expected: `'204': description: No Content`

## User impact

**MEDIUM** -- Incorrect HTTP status codes in API documentation mislead API consumers and integrators. A client expecting 201 Created to indicate a new resource was created, or 204 No Content to confirm deletion, will receive incorrect contract information. This undermines the value of `document-endpoint` as a reliable API documentation source.