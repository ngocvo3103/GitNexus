# document-endpoint — Complete Reference

> Last updated: 2026-04-13 | Branch: release/1.4.11

## Overview

`document-endpoint` is an MCP tool that generates API documentation for an HTTP endpoint by tracing its call chain through the GitNexus knowledge graph. It extracts request/response schemas, downstream API calls, messaging, persistence, validation, and produces either OpenAPI YAML or AI-enriched JSON.

## Tool Schema

**Name:** `document-endpoint`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `method` | string | yes | — | HTTP method: GET, POST, PUT, DELETE, PATCH |
| `path` | string | yes | — | Path or keyword to match (e.g. `"users"`, `"/api/users/{id}"`) |
| `depth` | number | no | 10 | Max call-chain depth to trace |
| `mode` | string | no | `openapi` | Output mode: `openapi` or `ai_context` |
| `repo` | string | no | — | Repository name/path (omitted if only one repo indexed) |

Deprecated: `include_context` boolean → use `mode: 'ai_context'` instead.

## Architecture & Data Flow

```
MCP Client (Cursor/Claude/Claude Code)
  │ JSON-RPC over stdio
  ▼
server.ts → CallToolRequestSchema handler
  │ backend.callTool('document-endpoint', args)
  ▼
local-backend.ts → documentEndpoint(repo, params)
  │ normalize params, build CrossRepoContext
  ▼
document-endpoint.ts → documentEndpoint(repo, options)
  │
  ├─ Step 1: queryEndpoints(repo, {method, path})
  │           → Route node lookup via Cypher on :Route
  │           → fallback: findHandlerByPathPattern() (scans Method @XxxMapping)
  │           → Result: EndpointInfo {method, path, handler, controller, filePath, line}
  │
  ├─ Step 2: executeTrace(executeQuery, repoId, {uid, maxDepth, include_content})
  │           (trace-executor.ts)
  │           ├─ BFS traversal via CALLS edges
  │           ├─ resolveInterfaceCall() → WI-7 interface impl resolution
  │           ├─ extractMetadata(content) per node
  │           └─ Returns: TraceResult { root, chain: ChainNode[], summary }
  │
  ├─ Step 3: buildDocumentation(params)
  │           ├─ Parallel: extractDownstreamApis + extractBodySchemas
  │           │           + extractMessaging + extractPersistence
  │           ├─ Sequential: extractExceptionCodes, extractAnnotations,
  │           │             extractRequestParams, extractValidationRules,
  │           │             generateCodeDiagram
  │           └─ Returns: DocumentEndpointResult
  │
  └─ Step 4: Route by effectiveMode
             ├─ 'ai_context' → applyAiContextPlaceholders(result)
             │   → fills empty fields with TODO_AI_ENRICH
             │   → ensures _context always defined
             │   → Returns: { result: DocumentEndpointResult }
             └─ 'openapi' → convertToOpenAPIYamlString([result])
                 → Returns: OpenApiModeResult { yaml, method, path, handlerClass, handlerMethod }
```

## Source Files

| File | Role |
|------|------|
| `src/mcp/tools.ts` | Tool definition (MCP JSON schema, parameter spec, description) |
| `src/mcp/local/document-endpoint.ts` | **Core implementation** — main function, all extractors, types |
| `src/mcp/local/local-backend.ts` | Orchestrator — dispatches tool calls, wires up CrossRepoContext |
| `src/mcp/local/endpoint-query.ts` | Route node lookup from knowledge graph |
| `src/mcp/local/trace-executor.ts` | BFS call-chain traversal; metadata regex extraction |
| `src/mcp/local/cross-repo-context.ts` | Interface for cross-repo type resolution |
| `src/mcp/core/lbug-adapter.ts` | LadybugDB connection pool; parameterized query executor |
| `src/core/openapi/converter.ts` | `DocumentEndpointResult[]` → OpenAPI YAML string |
| `src/core/openapi/schema-builder.ts` | `BodySchema` → OpenAPI `Schema` converter |
| `src/core/openapi/types.ts` | OpenAPI 3.1.0 TypeScript type system |
| `src/core/openapi/enricher.ts` | Post-processes existing OpenAPI YAML with x-extensions |

## Key Types

### DocumentEndpointOptions (input)

```typescript
interface DocumentEndpointOptions {
  method: string;
  path: string;
  depth?: number;                          // default 10
  mode?: 'openapi' | 'ai_context';        // default 'openapi'
  include_context?: boolean;              // deprecated, use mode
  compact?: boolean;
  repo?: string;
  executeQuery?: (repoId, query, params) => Promise<any[]>;  // inject for testing
  crossRepo?: CrossRepoContext;
}
```

### DocumentEndpointResult (ai_context output)

```typescript
interface DocumentEndpointResult {
  method: string;
  path: string;
  summary: string;                         // TODO_AI_ENRICH when unresolved
  handlerClass?: string;
  handlerMethod?: string;
  specs: {
    request: {
      params: ParamInfo[];
      body: BodySchema | JSON;
      validation: ValidationRule[];
    };
    response: {
      body: BodySchema | JSON;
      codes: ResponseCode[];
    };
  };
  externalDependencies: {
    downstreamApis: DownstreamApi[];
    messaging: {
      outbound: MessagingOutbound[];
      inbound: MessagingInbound[];
      nestedSchemas?: Map<string, BodySchema>;
    };
    persistence: PersistenceInfo[];
    validation: ValidationRule[];
  };
  logicFlow: string;                       // → separated chain names
  codeDiagram: string;                     // Mermaid graph TB
  cacheStrategy: CacheStrategy;
  retryLogic: RetryLogic[];
  keyDetails: KeyDetails;
  nestedSchemas?: Map<string, BodySchema>;
  _context?: { summaryContext, resolvedProperties };
}
```

### OpenApiModeResult (openapi output)

```typescript
interface OpenApiModeResult {
  yaml: string;          // OpenAPI 3.1.0 YAML
  method: string;
  path: string;
  handlerClass?: string;
  handlerMethod?: string;
}
```

### ChainNode (trace executor)

```typescript
interface ChainNode {
  uid: string;
  name: string;
  filePath: string;
  depth: number;
  kind: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  callees: string[];
  parameterCount?: number;
  returnType?: string;
  parameterAnnotations?: string;
  annotations?: string;
  fields?: string;
  resolvedFrom?: string;
  isInterface?: boolean;
  metadata: {
    httpCalls: string[];
    httpCallDetails: HttpCallDetail[];
    eventPublishing: string[];
    messagingDetails: MessagingDetail[];
    repositoryCalls: string[];
    repositoryCallDetail: RepositoryCallDetail[];
    valueProperties: string[];
    exceptions: ExceptionDetail[];
    builderDetails: BuilderDetail[];
    annotations: string;
  };
}
```

### BodySchema & BodySchemaField

```typescript
interface BodySchema {
  typeName: string;
  source: 'indexed' | 'external' | 'primitive';
  fields?: BodySchemaField[];
  repoId?: string;
  isContainer?: boolean;
}

interface BodySchemaField {
  name: string;
  type: string;
  annotations: string[];
  source?: 'indexed' | 'external' | 'primitive';
  fields?: BodySchemaField[];     // nested objects
  isContainer?: boolean;          // List<T>, Set<T>
}
```

### Domain Types

```typescript
interface ParamInfo {
  name: string; type: string; required: boolean;
  description: string; location?: 'path' | 'query' | 'header' | 'cookie';
  _context?: string;
}

interface DownstreamApi {
  serviceName: string; name: string; type: string; service: string;
  endpoint: string; condition: string; purpose: string;
  repoId?: string; resolvedUrl?: string; resolvedFrom?: string;
  resolutionDetails?: object;
  _context?: string;
}

interface MessagingOutbound {
  topic: string; pattern: string; type: string; direction: string;
  payload: string | BodySchema; trigger: string;
  service?: string; sourceRepo?: string; _context?: string;
}

interface MessagingInbound {
  topic: string; pattern: string; type: string; direction: string;
  payload: string; consumptionLogic: string;
  service?: string; sourceRepo?: string; _context?: string;
}

interface PersistenceInfo {
  database: string; tables: string; entity: string;
  operation: string; storedProcedures: string;
}

interface ValidationRule {
  field: string; type: string; required: boolean;
  rules: string; _context?: string;
}

interface ResponseCode {
  code: number;    // HTTP status code
  description: string;
}

interface EndpointInfo {
  method: string; path: string;
  controller?: string; handler?: string;
  filePath?: string; line?: number;
}
```

### CrossRepoContext

```typescript
interface CrossRepoContext {
  findDepRepo: (packagePrefix: string) => Promise<string | null>;
  queryMultipleRepos: (repoIds: string[], query: string, params: any) => Promise<Array<{repoId; results}>>;
  listDepRepos: () => Promise<string[]>;
}
```

## Endpoint Resolution

### Primary: Route Node Query

```
queryEndpoints(repo, {method, path})
  → MATCH (r:Route) WHERE r.httpMethod=$method AND r.routePath CONTAINS $path
  → ORDER BY LENGTH(r.routePath) DESC
  → Returns EndpointInfo
```

Route node schema: `id` (deterministic `{filePath}:{httpMethod}:{routePath}`), `httpMethod`, `routePath`, `controllerName`, `methodName`, `filePath`, `startLine`. Created from `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping` annotations. `@FeignClient` routes excluded.

### Fallback: Annotation Pattern Search

When no Route nodes match, `findHandlerByPathPattern()` scans Method nodes:

1. Find Method nodes whose `content` contains `@XxxMapping` annotations
2. Extract annotation path + class `@RequestMapping` prefix
3. Combine to `fullPath = classPrefix + methodPath`
4. Validate via `pathsMatchStructurally()` (suffix matching from path end)
5. Score candidates: annotation match (+150), exact path (+500)
6. Return top-scored EndpointInfo

`pathsMatchStructurally()` normalizes path variables `{id}` → `{}` and compares segments from the end, so `/e/v1/bonds/{id}` matches `/api/external/v1/bonds/{123}`.

## Extractors

All extractors run in `document-endpoint.ts`:

### extractDownstreamApis(chain, ...)

- Traces HTTP calls from `metadata.httpCallDetails` on each ChainNode
- Resolves URLs through multiple strategies:
  1. `resolvedValue` from `@Value` annotations (HTTP URL or path)
  2. `pathConstants` (static final fields in same class)
  3. `staticParts` (inline string literals)
  4. `resolveBuilderUrl()` for `UriComponentsBuilder` patterns
  5. `traceVariableAssignment()` for field references
- Cross-repo attribution via `crossRepo.findDepRepo(packagePrefix)`
- Normalizes endpoints: strips domain from full URLs, extracts service name from first path segment

### extractBodySchemas(chain, ...)

- Resolves request/response body types via `resolveTypeSchema()`
- Walks `@RequestBody` annotated parameters for request body
- Walks return type for response body
- `source: 'indexed'` when type found in graph, `'external'` when not, `'primitive'` for built-ins
- Cross-repo resolution: extracts package prefix, queries `crossRepo.queryMultipleRepos()`
- Recursive: resolves nested types (`nestedSchemas` Map) respecting max depth
- Circular references: tracked to prevent infinite loops
- `serialVersionUID` fields filtered out
- Container types (`List<X>`, `X[]`) → `isContainer: true` with array examples

### extractMessaging(chain, ...)

**Outbound** (methods that publish/send):
- `rabbitTemplate.convertAndSend()` / `rabbitTemplate.send()`
- `kafkaTemplate.send()`
- `streamBridge.send()`
- `applicationEventPublisher.publishEvent()`
- `trigger` = `node.name` (method name), falls back to `TODO_AI_ENRICH`

**Inbound** (methods that listen/consume):
- Chain-based: `@EventListener`, `@TransactionalEventListener` on methods in call chain
- Graph-query-based: Cypher for `@RabbitListener` (queues), `@KafkaListener` (topics), `@JmsListener`
- Array syntax parsing: `queues = {"queue1", "queue2"}`
- `topic` = `TODO_AI_ENRICH` for `@EventListener` (cannot be inferred)

### extractPersistence(chain, ...)

- Traces `repositoryCallDetails` from metadata
- Derives entity name: strips `Repository/Dao/Repo` suffix
- Database heuristics: `@Table(schema=...)` annotation → schema name; `@Entity` without `@Table` → `JPA`; no JPA annotations → `TODO_AI_ENRICH`
- CRUD operation derivation from repository method prefix (`save`/`insert` → CREATE, `find`/`get` → READ, `update` → UPDATE, `delete` → DELETE)

### extractRequestParams(handler)

- Extracts from `ChainNode.parameters` JSON
- `@PathVariable` → `required: true`, `location: 'path'`
- `@RequestParam` → `required: true` (default), `location: 'query'`; handles `required=false`, `name` attribute
- `@RequestHeader` → `location: 'header'`; handles `required` attribute
- `@CookieValue` → `location: 'cookie'`; handles `required` attribute
- Skips framework types: `HttpServletRequest`, `HttpServletResponse`, `Model`, `ModelMap`, `Principal`
- Skips `@RequestBody` params (handled by body schema)
- Unannotated DTO parameters not extractable

### extractValidationRules(handler, requestBody, chain)

Three extraction sources:

1. **Parameter-level**: `@NotNull`, `@NotBlank`, `@NotEmpty`, `@Size(min,max)`, `@Min`, `@Max`, `@Email`, `@Pattern(regexp=...)`, `@Positive`, `@PositiveOrZero`, `@Negative`, `@NegativeOrZero`, `@Past`, `@Future`, `@Valid`, `@Validated`
2. **Body field-level**: `BodySchema.fields[].annotations` → individual rules per field
3. **Imperative**: Regex detection of patterns like `TcbsValidator.doValidate()`, `ValidationUtils.validate()`, `Validator.check()`, `.validateJWT()`, `validationService.process()` — deduplicated when overlapping patterns match

Field name resolution: lowercase param name kept; capitalized Java type name falls back to `"body"`.

### extractExceptionCodes(chain)

- Extracts from `metadata.exceptions`: `throw new XxxException(...ErrorCode.xxx)`
- Maps to `ResponseCode[]` with HTTP status codes (e.g. `BusinessException` → 400)
- Success code (200) always included

### extractAnnotations(chain)

- `@Transactional`, `@Retryable`, `@Async` → `keyDetails`

### generateCodeDiagram(chain)

- Generates Mermaid `graph TB` diagram from call chain

## URL Resolution Strategies

Priority order for downstream API endpoint URLs:

| Priority | Strategy | Source |
|----------|----------|--------|
| 1 | `resolvedValue` (HTTP URL) | `@Value` annotation resolving to full URL |
| 2 | `resolvedValue` (path) | `@Value` annotation resolving to `/path` |
| 3 | `pathConstants` | Static final fields in same class |
| 4 | `staticParts` | Inline string literals |
| 5 | Builder pattern | `UriComponentsBuilder.fromHttpUrl()` |
| 6 | Variable tracing | `traceVariableAssignment()` for field references |

**Endpoint normalization rules:**
- Full HTTP URL: strip domain, keep path as `endpoint`, first path segment as `serviceName`
- Domain-only URL: strip domain, keep remaining path
- Relative path (`/v1/...`): first segment as `serviceName`
- Raw code expressions (unresolvable): no normalization

## Output Modes

### mode: openapi (default)

Returns `OpenApiModeResult`:
- `yaml`: OpenAPI 3.1.0 YAML string
- Contains `openapi`, `info`, `paths`, `components.schemas`
- Path variables normalized: `:param` → `{param}`
- `x-extension` fields for downstream dependencies
- CLI: `--outputPath` writes YAML file + JSON metadata

### mode: ai_context

Returns `{ result: DocumentEndpointResult }`:
- Full JSON with all extracted fields
- `TODO_AI_ENRICH` placeholder for unresolved fields
- `_context` field always present with source snippets
- `BodySchema` payloads preserved (not converted to examples)
- `resolvedProperties` in `_context` for resolved `@Value` properties

## MCP Registration Flow

```
tools.ts → GITNEXUS_TOOLS array (schema definitions)
server.ts → ListToolsRequestSchema handler (exposes all tools)
         → CallToolRequestSchema handler (dispatches to LocalBackend.callTool())
local-backend.ts → switch(method) → documentEndpoint()
```

Key points:
- All tool schemas centralized in `tools.ts`
- Single dispatch switch in `LocalBackend.callTool()`
- `mode` parameter normalizes deprecated `include_context` flag
- Result stringified via `JSON.stringify(result, null, 2)` + optional `hint`
- `stripUndefined()` applied before return for clean JSON

## Cross-Repo Resolution

When a type is not found in the local repo:

1. Extract package prefix from type name (e.g. `com.example.UserDTO` → `com.example`)
2. `crossRepo.findDepRepo(packagePrefix)` → find dependent repo ID
3. If found, `crossRepo.queryMultipleRepos([repoId], cypher, params)` → resolve type in remote repo
4. Same type for request/response resolved correctly
5. Recursive nested type resolution across repos
6. Partial failure: resolves from one repo when another fails
7. Falls back to `source: 'external'` BodySchema when not in any repo

## Test Coverage

5 test files with comprehensive coverage:

| Test File | Scope |
|-----------|-------|
| `test/unit/document-endpoint.test.ts` | Core function, all extractors, mode routing, cross-repo, JSON example generation |
| `test/unit/document-endpoint-url-resolution.test.ts` | URL resolution strategies, `deriveDisplayName` |
| `test/unit/document-endpoint-path-matching.test.ts` | `pathsMatchStructurally()` suffix matching |
| `test/unit/document-endpoint-messaging-trigger.test.ts` | Outbound messaging trigger extraction |
| `test/unit/mcp/endpoint-query.test.ts` | `queryEndpoints` Route node queries |

### Key Test Scenarios

**Core function:**
- Minimal mode: endpoint not found, valid JSON structure, response codes from exceptions
- ai_context mode: `_context` fields included, `TODO_AI_ENRICH` placeholders
- OpenAPI mode: YAML string output, valid YAML, `openapi: 3.1.0`
- Mode precedence: `mode` takes precedence over deprecated `include_context`
- Deprecation warning for `include_context` flag

**Extractors:**
- Downstream APIs: variable URL expressions, static URLs, complex references, service name extraction
- Body schemas: no parameters, `@RequestBody` params, unresolved types, nested types, circular refs, generic containers, array syntax
- Messaging: chain-based + graph-based inbound detection, array syntax parsing, `@RabbitListener`/`@KafkaListener`, multiple outbound from same node
- Persistence: `@Table` schema, `@Entity` fallback, CRUD operation derivation
- Request params: all annotation types, framework type filtering, edge cases (null/invalid JSON)
- Validation: 20+ JSR-303 annotations, imperative validation, deduplication, field-level from BodySchema
- Exception codes: `BusinessException` → 400, success code always included

**URL resolution:**
- `resolvedValue` HTTP URL, path, null fallback
- `pathConstants` priority
- `staticParts` fallback
- Invalid resolved value (non-HTTP, non-path) falls back
- `deriveDisplayName`: path segment extraction, trailing slash, IP addresses, fallback chain

**Path matching:**
- Equal segment count, suffix matching (both directions)
- Single segments, empty strings, case insensitivity
- Placeholder normalization

**Cross-repo:**
- Package prefix extraction, local-only fallback, partial failure
- Recursive type resolution, circular reference handling
- `executeQuery` undefined handling

## Known Issues

| Issue | Severity | Description |
|-------|----------|-------------|
| `--outputPath` crash in openapi mode | P0 | `convertToOpenAPIDocument` receives `OpenApiModeResult` (has `yaml`) instead of `DocumentEndpointResult` (has `specs`); crashes on `result.specs.response` |
| BodySchema → JSON example loses `required` | P1 | `buildDocumentation()` converts `BodySchema` to JSON example before OpenAPI generation; `isBodySchema()` returns false, bypassing `bodySchemaToOpenAPISchema()` which populates `required` array |
| `externalDependencies.validation` undefined in ai_context | P1 | Field not populated despite `specs.request.validation` having rules |
| Messaging fields incomplete | P2 | `pattern`, `type`, `direction`, `service` often `undefined` in messaging output |
| Persistence fields incomplete | P2 | `entity`, `operation` often `undefined` |
| DownstreamApi fields incomplete | P2 | `name`, `type`, `service` often `undefined` |
| Cross-repo `repoId` missing | P2 | Downstream APIs have `repoId: undefined` even when external repos are indexed |

## Related Context Docs

- [cli-document-endpoint.md](cli-document-endpoint.md) — CLI surface area, options, examples
- [document-endpoint-params-validation-messaging.md](document-endpoint-params-validation-messaging.md) — Design spec for params, validation, messaging extraction
- [document-endpoint-outputpath-openapi-fix.md](document-endpoint-outputpath-openapi-fix.md) — Bug fix spec for `--outputPath` crash
- [document-endpoint-metadata.md](document-endpoint-metadata.md) — Bug fix for metadata empty when `include_context=false`
- [document-endpoint-ai-context-quality.md](document-endpoint-ai-context-quality.md) — Data quality fixes for ai_context mode
- [call-resolution-interface-types.md](call-resolution-interface-types.md) — D5 tier for interface-typed call resolution
- [downstream-api-endpoint-normalization.md](downstream-api-endpoint-normalization.md) — Endpoint normalization rules
- [route-node-schema.md](route-node-schema.md) — Route node table schema and extraction pipeline