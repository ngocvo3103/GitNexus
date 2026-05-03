---
title: "Go/Gin handler struct indexes anonymous input struct fields as own properties"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-gin`
2. Call `context` on `UserHandler`:
   ```
   context(name="UserHandler", repo="sample-gin", include_content=true)
   ```

## Actual behavior

`UserHandler` context shows these outgoing `has_property` edges:
```json
{
  "has_property": [
    { "uid": "Property:handlers/user_handler.go:service", "name": "service", "filePath": "handlers/user_handler.go" },
    { "uid": "Property:handlers/user_handler.go:Name", "name": "Name", "filePath": "handlers/user_handler.go" },
    { "uid": "Property:handlers/user_handler.go:Email", "name": "Email", "filePath": "handlers/user_handler.go" }
  ]
}
```

The `Name` and `Email` properties are from the anonymous struct inside `CreateUser`:
```go
func (h *UserHandler) CreateUser(c *gin.Context) {
    var input struct {
        Name  string `json:"name" binding:"required"`
        Email string `json:"email" binding:"required"`
    }
```

## Expected behavior

Fields of a local anonymous struct variable inside a method should NOT be treated as properties of the enclosing struct type `UserHandler`. `UserHandler` only has one actual property: `service *services.UserService`.

## User impact

**MEDIUM** -- This confuses the code structure understanding. Users inspecting `UserHandler` would incorrectly believe it has `Name` and `Email` fields, leading to wrong assumptions about the data model and incorrect impact analysis.