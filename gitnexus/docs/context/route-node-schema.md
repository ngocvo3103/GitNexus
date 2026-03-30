# Route Node Schema

**Service:** GitNexus Core (graph ingestion)
**Status:** Draft

## Summary

The `Route` node table stores HTTP route/endpoint metadata extracted from Spring Boot controller classes during code ingestion. Route nodes enable the `document-endpoint` and `endpoints` tools to query and trace API endpoints.

## Schema Definition

### Node Table: Route

| Column | Type | Description |
|--------|------|-------------|
| id | STRING | Primary key. Generated via `generateId('Route', '{filePath}:{httpMethod}:{routePath}')` |
| name | STRING | Display name: `"{httpMethod} {routePath}"` |
| httpMethod | STRING | HTTP method (GET, POST, PUT, DELETE, PATCH) |
| routePath | STRING | URL path pattern (e.g., `/api/v1/bonds/{id}`) |
| controllerName | STRING | Owning controller class name |
| methodName | STRING | Handler method name |
| filePath | STRING | Source file path |
| startLine | INT64 | Line number in source file |
| lineNumber | INT64 | Same as startLine (kept for compatibility) |
| isInherited | BOOLEAN | Whether route is inherited from parent class |

### Relationships

| Edge Type | Direction | Description |
|-----------|-----------|-------------|
| DEFINES | File → Route | Source file defines this route |
| CALLS | Route → Method | Route maps to handler method |

### Extraction Source

Routes are extracted from Java files containing Spring annotations:
- `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`
- `@RequestMapping` (with method attribute)
- Class-level `@RequestMapping` prefix is combined with method-level paths
- `@FeignClient` classes are excluded

## Data Flow

1. **parse-worker.ts** calls `extractSpringRoutes(tree, filePath)` for Java controller files
2. Extracted routes accumulate in `ParseWorkerResult.routes[]`
3. **pipeline.ts** passes `chunkWorkerData.routes` to `processRoutesFromExtracted()`
4. **call-processor.ts** creates Route nodes + DEFINES/CALLS edges in the knowledge graph
5. **csv-generator.ts** serializes Route nodes to CSV
6. **lbug-adapter.ts** bulk-loads Route CSV into LadybugDB via COPY

## Consumers

- `endpoint-query.ts` — `MATCH (r:Route)` queries for listing/filtering endpoints
- `document-endpoint.ts` — uses Route nodes as entry point for API documentation generation
- `trace-executor.ts` — follows CALLS edges from Route to trace execution chains

## Business Rules

- Route `id` must be deterministic: same file + method + path always produces the same id
- Routes from `@FeignClient` classes must be excluded (these are client stubs, not server endpoints)
- Class-level `@RequestMapping` prefix must be combined with method-level paths
- If `isInherited` is not determined, defaults to `false`
