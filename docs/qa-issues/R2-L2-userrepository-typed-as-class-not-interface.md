---
title: "Spring `UserRepository` typed as Class instead of Interface"
labels: [triage, low]
---

## Steps to reproduce

1. Index `sample-spring-minimal`
2. Call `context` on `UserRepository`:
   ```
   context(name="UserRepository", repo="sample-spring-minimal")
   ```

## Actual behavior

The context shows:
```json
{
  "uid": "Interface:src/main/java/com/example/repository/UserRepository.java:UserRepository",
  "name": "UserRepository",
  "kind": "Class"
}
```

The uid correctly says `Interface:` but the `kind` field says `"Class"`.

## Expected behavior

Since `UserRepository` is declared as:
```java
@Repository
public interface UserRepository extends JpaRepository<User, Long> {}
```

The `kind` field should be `"Interface"`, consistent with the uid prefix.

## User impact

**LOW** -- Inconsistent metadata between uid and kind field. Consumers relying on `kind` for type-based logic will misidentify this as a class. However, the uid prefix correctly identifies it as an interface, so the information is available to users who check both fields.