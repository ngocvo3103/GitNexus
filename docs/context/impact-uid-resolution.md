# Impact Tool — UID Target Resolution

**Service:** GitNexus MCP Server
**Status:** Draft

## Summary
Fix the `impact` tool to accept uid-format targets (e.g., `Class:UserController`) in addition to plain names.

## Current Behavior

### Request
```json
{
  "target": "Class:UserController",
  "direction": "upstream",
  "repo": "sample-spring-minimal"
}
```

### Response (broken)
```json
{
  "error": "Target 'Class:UserController' not found"
}
```

## Expected Behavior

### Request — uid-format target
```json
{
  "target": "Class:UserController",
  "direction": "upstream",
  "repo": "sample-spring-minimal"
}
```

### Response (success)
```json
{
  "target": { "id": "Class:UserController", "name": "UserController", "type": "Class", "filePath": "..." },
  "direction": "upstream",
  "impactedCount": 5,
  "risk": "MEDIUM",
  "summary": { "direct": 3, "processes_affected": 1, "modules_affected": 2 },
  "affected_processes": [...],
  "affected_modules": [...],
  "byDepth": { ... }
}
```

### Request — plain name (backward compatible)
```json
{
  "target": "UserController",
  "direction": "upstream",
  "repo": "sample-spring-minimal"
}
```

### Response — same as before, no change

## Business Rules
- If `target` contains `:` or `/`, treat it as a uid-format target
- Uid-format targets are resolved first via `MATCH (n) WHERE n.id = $targetName`
- If uid match fails, extract the name part (after the last `:` or `/`) and fall back to priority-based name lookup
- Plain name targets (no `:` or `/`) use existing priority-based lookup unchanged
- Response shape is identical regardless of whether uid or plain name is used

### Name Extraction Edge Cases
| Input | isQualified | Extracted Name | Behavior |
|---|---|---|---|
| `Class:UserController` | true | `UserController` | uid match first, then name fallback |
| `Method:getUsers` | true | `getUsers` | uid match first |
| `pkg/mod:Func` | true | `Func` | uid match first (slash detection) |
| `Module::Submodule::Class` | true | `Class` | Last segment after `:` is the name |
| `UserController` | false | `UserController` | Plain name, existing priority query |
| `Class:` | true | `` (empty) | uid query returns [], name query for "" returns [], final: "Target 'Class:' not found" |
| `:` | true | `` (empty) | Same as above — no match, error |
| `//` | true | `` (empty) | Same as above |

### Database Failure Handling
| Condition | Behavior |
|---|---|
| uid query throws error | Catch error, fall through to name-based lookup (existing `.catch(() => [])` pattern) |
| name-based UNION query throws error | Catch error, fall through to unlabeled match (existing `.catch(() => [])` pattern) |
| All queries fail/empty | Return `{ error: "Target '{target}' not found" }` |

## Error Responses
| Condition | Error Message |
|---|---|
| Target not found by uid or name | `Target '{target}' not found` |
| Database query failure during uid lookup | Gracefully falls back to name-based lookup |

## Notes
- This matches the pattern used by the `context` tool and `findSymbolByName` utility
- No new parameters added — `target` accepts both formats