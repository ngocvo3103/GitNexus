---
title: "Cypher `type()` function not supported -- standard Cypher function unavailable"
labels: [triage, low]
---

## Steps to reproduce

1. Run a Cypher query using the `type()` function on relationships:
   ```
   cypher(query="MATCH (n)-[r:CodeRelation]->(m) WHERE r.type = 'CALLS' RETURN n.name, n.filePath, type(r) as relType LIMIT 10", repo="sample-spring-minimal")
   ```
   or:
   ```
   cypher(query="MATCH (n)-[r]->(m) RETURN n.name, type(r) LIMIT 10", repo="sample-spring-minimal")
   ```

## Actual behavior

Both queries fail with:
```
Catalog exception: function TYPE does not exist.
```

## Expected behavior

`type()` is a standard Cypher function that returns the type/label of a relationship. The GitNexus graph uses a single `CodeRelation` edge table with a `type` property instead of distinct edge types. However, users writing Cypher queries naturally expect `type()` to work since the relationship type is a fundamental Cypher concept.

The workaround is to use `r.type` (accessing the property) instead of `type(r)` (the function), but this is non-obvious and diverges from standard Cypher practice.

## User impact

**LOW** -- Users familiar with standard Cypher will hit this error when trying to query relationship types. The workaround (`r.type` property access) works, but the error message "function TYPE does not exist" is confusing and doesn't guide users toward the correct syntax.