# Feature Gap: document-endpoint --all Option

**Date:** 2026-03-31
**Status:** MISSING
**Severity:** High
**Component:** CLI - document-endpoint command

## Problem

The `document-endpoint` CLI command requires both `--method` and `--path` as required options. There is no way to generate documentation for **all endpoints** in a repository.

```bash
# Current usage (single endpoint):
gitnexus document-endpoint --method PUT --path "/e/v1/bookings/{productCode}/suggest" --repo tcbs-bond-trading --openapi

# Missing capability:
gitnexus document-endpoint --all --repo tcbs-bond-trading --openapi
gitnexus document-endpoint --all --format yaml --repo tcbs-bond-trading
```

## Current CLI Options

```
--method <method>     HTTP method (GET, POST, PUT, DELETE, PATCH) [REQUIRED]
--path <pattern>      Path pattern to match [REQUIRED]
--depth <n>           Max trace depth (default: 10)
--include-context     Include source context for AI enrichment
--compact             Omit source content and empty arrays
--openapi             Preserve raw BodySchema for OpenAPI generation
--schema-path <path>  Path to custom JSON schema file
--strict              Fail on schema validation errors
-r, --repo <name>     Target repository
```

## Expected Behavior

### Option 1: `--all` Flag

```bash
gitnexus document-endpoint --all --repo tcbs-bond-trading --openapi --output openapi.yaml
```

Should:
1. Discover all endpoints in the repository (Route nodes or fallback to handler search)
2. Generate documentation for each endpoint
3. Combine into a single OpenAPI 3.0 specification
4. Output to stdout or specified file

### Option 2: Separate `document-api` Command

```bash
gitnexus document-api --repo tcbs-bond-trading --format openapi-yaml
```

## Implementation Notes

### Endpoint Discovery

The `queryEndpoints` function in `src/mcp/local/endpoint-query.ts` can list endpoints:

```typescript
// Current implementation requires Route nodes (which may not exist)
MATCH (r:Route)
RETURN r.httpMethod AS method, r.routePath AS path, ...
```

### Fallback Handler Search

When Route nodes don't exist, `findHandlerByPathPattern` is used. A similar function could discover all handlers by scanning for `@RequestMapping` patterns.

### Files to Modify

1. `src/cli/index.ts` - Add `--all` option or new command
2. `src/cli/tool.ts` - Add `documentAllEndpointsCommand()` function
3. `src/mcp/local/endpoint-query.ts` - Add `discoverAllEndpoints()` function
4. `src/mcp/local/local-backend.ts` - Add `documentAllEndpoints` tool

### OpenAPI Generation

Create a combined OpenAPI spec structure:

```typescript
interface OpenAPISpec {
  openapi: '3.0.3';
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, PathItem>;
  components?: { schemas: Record<string, Schema> };
}
```

## Workaround (Manual Script)

Currently requires manual extraction:

```bash
# Extract endpoints from source
grep -rh "@\(Get\|Post\|Put\|Delete\|Patch\|Request\)Mapping" src/main/java --include="*.java" \
  | parse-and-combine-with-base-path \
  | for-each-endpoint: gitnexus document-endpoint --method X --path Y --openapi
```

## Related

- `docs/context/cli-document-endpoint.md` - CLI documentation
- `src/mcp/local/endpoint-query.ts` - Endpoint discovery logic
- `src/mcp/local/document-endpoint.ts` - Documentation generation

## Acceptance Criteria

- [ ] `--all` flag discovers all endpoints in repository
- [ ] Combined OpenAPI 3.0 YAML/JSON output
- [ ] Progress indicator for long-running operations
- [ ] Error handling for failed endpoints (continue vs fail)
- [ ] Configurable output path (`--output <file>`)
- [ ] Format options: `json`, `yaml`, `openapi-json`, `openapi-yaml`