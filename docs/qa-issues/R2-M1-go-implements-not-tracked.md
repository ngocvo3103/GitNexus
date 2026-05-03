---
title: "Go/Gin IMPLEMENTS relationships not tracked -- interface implementation detection missing"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-gin` repo
2. Check `context` for `IUserService`:
   ```
   context(name="IUserService", repo="sample-gin")
   ```
3. Check Cypher for IMPLEMENTS edges:
   ```
   MATCH (n)-[r:CodeRelation {type: 'IMPLEMENTS'}]->(m) RETURN n.name, n.filePath, m.name, m.filePath
   ```

## Actual behavior

- `IUserService` context shows `incoming: {}` and `outgoing: {}` -- completely empty
- `IOrderService` context shows same empty incoming/outgoing
- Cypher query for IMPLEMENTS edges returns empty array for `sample-gin`
- `IUserService` methods `GetUsers()` and `CreateUser()` are not listed as outgoing `has_method` edges

## Expected behavior

- `UserService` struct should have an IMPLEMENTS edge to `IUserService` interface
- `IUserService` should list `GetUsers()` and `CreateUser()` as outgoing `has_method` edges
- Impact analysis on `IUserService` should find `UserService` as an implementor

Source code clearly shows the interface and implementation:
```go
// interfaces/service_interface.go
type IUserService interface {
    GetUsers() []models.User
    CreateUser(name string, email string) models.User
}

// services/user_service.go
type UserService struct {
    users []models.User
}
// UserService implicitly implements IUserService by having the same method signatures
```

## User impact

**MEDIUM** -- Go interface implementation detection is completely absent. This is a core feature for understanding Go codebases, where interface-based design is pervasive. Users cannot trace from interface to concrete implementation or from implementation to interface contract. Impact analysis on interfaces will miss all concrete implementations.