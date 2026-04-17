# document-endpoint --all — Batch Documentation Mode

> Last updated: 2026-04-14 | Branch: release/1.4.11

## Overview

The `--all` flag extends `document-endpoint` to batch-document ALL endpoints in an indexed repository in a single invocation. Unlike the default single-endpoint mode (which requires `--method` and `--path`), `--all` discovers all Route nodes, iterates through each, and writes individual OpenAPI YAML files to the specified output directory.

**Key characteristics:**
- **CLI-only** (not available via MCP `document-endpoint` tool)
- **Batch mode** — discovers endpoints via `queryAllEndpoints()`, loops through each
- **YAML-only output** — forces `mode = 'openapi'` regardless of `--mode` flag value
- **Requires `--outputPath`** — error if missing; directory created if it doesn't exist
- **Mutually exclusive** with `--method` and `--path`
- **Per-endpoint error tolerance** — failures on individual endpoints logged to stderr, batch continues
- **Progress reporting** — stderr logs "Documented N/total: METHOD /path" for each endpoint

## CLI Interface

### Command Syntax

```bash
gitnexus document-endpoint --all --outputPath <dir> [--repo <name>]
```

### Flag Definition

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--all` | boolean | yes (mutually exclusive with `--method`/`--path`) | — | Enable batch mode; document all endpoints |
| `--outputPath` | string | yes (required when `--all` is set) | — | Output directory for YAML files |
| `--repo` | string | no | first indexed repo | Target repository name/path |

### Constraints

1. **Mutual exclusivity**: If `--all` is set, `--method` and `--path` MUST NOT be present. Error if both are provided.
2. **Output directory required**: If `--all` is set, `--outputPath` MUST be provided. Error if missing.
3. **Mode override**: The `--mode` parameter (if provided) is **ignored**. `--all` always uses `mode = 'openapi'`.
4. **Depth parameter**: Optional `--depth <n>` applies to all endpoints (default: 10).
5. **Schema validation**: Optional `--schema-path` and `--strict` flags ignored (apply only to single-endpoint mode).
6. **YAML enrichment**: The `--input-yaml` path (YAML enrichment mode) is incompatible with `--all`. Error if both are provided.

### Usage Examples

**Basic batch documentation:**
```bash
gitnexus document-endpoint --all --outputPath ./api-docs
```

**With custom depth:**
```bash
gitnexus document-endpoint --all --outputPath ./api-docs --depth 15
```

**For a specific repository:**
```bash
gitnexus document-endpoint --all --outputPath ./api-docs --repo my-service
```

### Error Messages

```
Error: --all requires --outputPath
Error: --all cannot be used with --method
Error: --all cannot be used with --path
Error: --all is incompatible with --input-yaml (use single-endpoint mode for YAML enrichment)
Error: Repository "repo-name" not found. Run 'gitnexus index' first.
```

## Architecture & Data Flow

```
CLI Entry (documentEndpointCommand)
  │
  ├─ Step 1: Validate flags
  │           ├─ Check: --all + (--method OR --path) → error
  │           ├─ Check: --all + --outputPath → error if missing
  │           ├─ Check: --all + --input-yaml → error
  │           └─ Resolve repo
  │
  ├─ Step 2: Parse options & setup
  │           ├─ outputPath (create directory)
  │           ├─ depth (default: 10)
  │           └─ repo handle
  │
  ├─ Step 3: queryAllEndpoints(repo, {depth})
  │           → Route node lookup (no method/path filters)
  │           → Cypher: MATCH (r:Route) RETURN r.httpMethod, r.routePath, ...
  │           → Result: EndpointInfo[] (sorted by path length DESC, method ASC)
  │
  ├─ Step 4: Batch loop (with error tolerance)
  │           │
  │           ├─ FOR each EndpointInfo:
  │           │   ├─ documentEndpoint(repo, {method, path, depth, mode: 'openapi'})
  │           │   ├─ Log progress: "Documented N/total: METHOD /path" → stderr
  │           │   ├─ ON SUCCESS: write YAML file
  │           │   │              ({METHOD}_{sanitized_path}.openapi.yaml)
  │           │   └─ ON FAILURE: log error → stderr, continue to next endpoint
  │           │
  │           └─ Final summary: "Documented M/N endpoints successfully"
  │
  └─ Step 5: Exit
              ├─ Exit code 0 if all succeeded
              └─ Exit code 1 if any endpoint failed (warn user)
```

## New Function: queryAllEndpoints

### Signature

```typescript
export async function queryAllEndpoints(
  repo: RepoHandle
): Promise<{ endpoints: EndpointInfo[] }>;
```

### Purpose

Discovers all Route nodes in the knowledge graph for batch processing. No method/path filters applied.

### Cypher Query

```cypher
MATCH (r:Route)
RETURN r.httpMethod AS method, r.routePath AS path,
       r.controllerName AS controller, r.methodName AS handler,
       r.filePath AS filePath, r.lineNumber AS line
ORDER BY LENGTH(r.routePath) DESC, r.httpMethod
```

### Return Type

```typescript
{
  endpoints: EndpointInfo[]  // sorted by path length (longest first), then HTTP method
}
```

### EndpointInfo Schema (same as queryEndpoints)

```typescript
interface EndpointInfo {
  method: string;        // e.g. "GET", "POST"
  path: string;          // e.g. "/api/v1/users/{id}"
  controller?: string;   // e.g. "UserController"
  handler?: string;      // e.g. "getUserById"
  filePath?: string;     // e.g. "src/controllers/UserController.java"
  line?: number;         // line number where @XxxMapping is defined
}
```

### Implementation Location

File: `gitnexus/src/mcp/local/endpoint-query.ts`

Add after existing `queryEndpoints()` function:

```typescript
export async function queryAllEndpoints(
  repo: RepoHandle
): Promise<{ endpoints: EndpointInfo[] }> {
  const cypher = `
    MATCH (r:Route)
    RETURN r.httpMethod AS method, r.routePath AS path,
           r.controllerName AS controller, r.methodName AS handler,
           r.filePath AS filePath, r.lineNumber AS line
    ORDER BY LENGTH(r.routePath) DESC, r.httpMethod
  `;

  const rows = await executeParameterized(repo.id, cypher, {});

  const endpoints: EndpointInfo[] = rows.map((row: any) => ({
    method: row.method ?? row[0],
    path: row.path ?? row[1],
    controller: row.controller ?? row[2] ?? undefined,
    handler: row.handler ?? row[3] ?? undefined,
    filePath: row.filePath ?? row[4] ?? undefined,
    line: row.line ?? row[5] ?? undefined,
  }));

  return { endpoints };
}
```

## Batch Handler Logic

### Location

File: `gitnexus/src/cli/tool.ts` in `documentEndpointCommand()`

### Implementation (Pseudocode)

```typescript
// ── Batch mode (--all) ─────────────────────────────────────────────────────
if (options?.all) {
  // Validate flags
  if (options.method || options.path) {
    console.error('Error: --all cannot be used with --method or --path');
    process.exit(1);
  }

  if (!options.outputPath) {
    console.error('Error: --all requires --outputPath');
    process.exit(1);
  }

  if (options.inputYaml) {
    console.error('Error: --all is incompatible with --input-yaml');
    process.exit(1);
  }

  // Setup
  const backend = await getBackend();
  const repoHandle = await backend.resolveRepo(options.repo);
  
  if (!repoHandle) {
    console.error(`Error: Repository "${options.repo ?? 'default'}" not found.`);
    process.exit(1);
  }

  const safeOutputPath = validateOutputPath(options.outputPath);
  fs.mkdirSync(safeOutputPath, { recursive: true });

  const { queryAllEndpoints } = await import('../mcp/local/endpoint-query.js');
  const { endpoints } = await queryAllEndpoints(repoHandle);

  if (endpoints.length === 0) {
    console.error('Warning: No endpoints found in repository');
    process.exit(0);
  }

  // Batch loop
  let successCount = 0;
  const errors: Array<{endpoint: EndpointInfo, error: Error}> = [];

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const progress = `${i + 1}/${endpoints.length}`;

    try {
      // Call documentEndpoint for single endpoint
      const response = await backend.callTool('document-endpoint', {
        method: endpoint.method,
        path: endpoint.path,
        depth: options.depth ? parseInt(options.depth, 10) : 10,
        mode: 'openapi',  // FORCE openapi mode
        repo: options.repo,
      });

      const result = response?.result ?? response;

      // Validate it's OpenAPI mode result (has yaml field)
      if (!('yaml' in result) || typeof result.yaml !== 'string') {
        throw new Error('Expected OpenAPI YAML output from documentEndpoint');
      }

      // Write YAML file
      const sanitizedPath = endpoint.path
        .replace(/^\//, '')
        .replace(/[{}]/g, '')
        .replace(/[\/:.-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/_$/, '');
      
      const baseName = `${endpoint.method.toUpperCase()}_${sanitizedPath}`;
      const yamlPath = path.join(safeOutputPath, `${baseName}.openapi.yaml`);
      
      fs.writeFileSync(yamlPath, result.yaml, 'utf-8');
      
      console.error(`Documented ${progress}: ${endpoint.method.toUpperCase()} ${endpoint.path}`);
      successCount++;

    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`ERROR (${progress}): ${endpoint.method.toUpperCase()} ${endpoint.path}: ${errMsg}`);
      errors.push({ endpoint, error: err });
    }
  }

  // Summary
  console.error(`\nDocumented ${successCount}/${endpoints.length} endpoints successfully`);

  if (errors.length > 0) {
    console.error(`\nFailed endpoints:`);
    errors.forEach(({ endpoint, error }) => {
      console.error(`  ${endpoint.method.toUpperCase()} ${endpoint.path}: ${error.message}`);
    });
    process.exit(1);
  }

  process.exit(0);
}
```

## Output File Naming

### Format

```
{METHOD}_{sanitized_path}.openapi.yaml
```

### Sanitization Rules

Same as existing single-endpoint mode in `documentEndpointCommand()`:

1. **Remove leading slash**: `/api/users` → `api/users`
2. **Remove path variables**: `{id}` → removed (characters `{}` stripped)
3. **Replace special characters**: `/`, `:`, `.`, `-` → `_`
4. **Collapse consecutive underscores**: `api__users` → `api_users`
5. **Remove trailing underscores**: `api_users_` → `api_users`

### Examples

| Endpoint | Output Filename |
|----------|-----------------|
| `GET /api/v1/users` | `GET_api_v1_users.openapi.yaml` |
| `POST /api/v1/users/{id}` | `POST_api_v1_users.openapi.yaml` |
| `DELETE /internal.v1:bond/delete` | `DELETE_internal_v1_bond_delete.openapi.yaml` |
| `PATCH /api/v2/orders/{orderId}/items/{itemId}` | `PATCH_api_v2_orders_items.openapi.yaml` |

## Error Handling

### Per-Endpoint Failures

When `documentEndpoint()` fails for a single route (e.g., handler not found, trace failed):

1. Log error to **stderr**: `ERROR (N/total): METHOD /path: error message`
2. Record endpoint in error list
3. **Continue** to next endpoint (do not abort batch)

### Common Failure Scenarios

| Scenario | Behavior | Log Level |
|----------|----------|-----------|
| Handler method not found | Skip endpoint, log error, continue | ERROR |
| Trace execution timeout | Skip endpoint, log error, continue | ERROR |
| Invalid HTTP method in Route node | Skip endpoint, log error, continue | ERROR |
| Output directory creation fails | Abort batch, exit code 1 | ERROR |
| No routes found in repo | Warn and exit cleanly (exit code 0) | WARNING |
| Partial batch failure (some routes succeed) | Exit code 1 after summary | ERROR |

### Exit Codes

| Exit Code | Condition |
|-----------|-----------|
| 0 | All endpoints documented successfully OR no endpoints found |
| 1 | Any endpoint failed OR validation error (missing --outputPath, etc.) |

### Summary Output

After batch completes, print to **stderr**:

```
Documented {successCount}/{total} endpoints successfully

Failed endpoints:
  GET /api/v1/users: Handler method not found
  POST /api/v2/orders: Trace execution timeout
```

## Files Affected

| File | Change | Role |
|------|--------|------|
| `gitnexus/src/cli/index.ts` | Add `--all` flag to `document-endpoint` command definition | CLI flag registration (Commander.js) |
| `gitnexus/src/cli/tool.ts` | Add batch handler block in `documentEndpointCommand()` before single-endpoint logic | Batch mode entry point; orchestrates loop, error handling, file output |
| `gitnexus/src/mcp/local/endpoint-query.ts` | Add `queryAllEndpoints(repo)` function | Route discovery (no method/path filters) |

## E2E Validation

### Manual Test Command

```bash
# Index a test repo
cd ~/my-service
gitnexus analyze

# Document all endpoints
gitnexus document-endpoint --all --outputPath ./api-docs --depth 10

# Verify output
ls -la ./api-docs/
cat ./api-docs/GET_api_v1_users.openapi.yaml
```

### Expected Output

```bash
Documented 1/3: GET /api/v1/users
Documented 2/3: POST /api/v1/users
Documented 3/3: GET /api/v1/users/{id}

Documented 3/3 endpoints successfully
```

### Verification Checklist

1. **File creation**: YAML files created in `--outputPath` directory
2. **File naming**: `{METHOD}_{sanitized_path}.openapi.yaml` pattern matches
3. **YAML validity**: Each file is valid OpenAPI 3.1.0 YAML (parseable by `js-yaml`)
4. **Content**: Each YAML contains:
   - `openapi: '3.1.0'`
   - `info.title` and `info.version`
   - `paths` object with documented endpoint
   - `components.schemas` with request/response models
5. **Progress logging**: Each endpoint logged to stderr with progress counter
6. **Error tolerance**: If one endpoint fails, batch continues; summary shows counts
7. **Exit code**: 0 if all succeeded, 1 if any failed

## Known Limitations

| Limitation | Reason | Workaround |
|-----------|--------|-----------|
| No filtering (method/path) in batch mode | `--all` documents every route; filtering done via `--method`/`--path` in single-endpoint mode | Use single-endpoint mode for selective documentation |
| Cannot enrich existing YAML with `--all` | Enrichment (`--input-yaml`) is single-endpoint only | Use single-endpoint mode with `--input-yaml` |
| No parallel execution | Endpoints processed sequentially to avoid resource contention | Batch is I/O-bound (file writes), sequential is adequate |
| No filtering by controller/handler | Route nodes don't support faceted filtering | Post-process output if subset needed |

## Related Context Docs

- [document-endpoint.md](document-endpoint.md) — Core single-endpoint tool, MCP registration, extractors
- [cli-document-endpoint.md](cli-document-endpoint.md) — Legacy single-endpoint CLI reference (for comparison)
- [document-endpoint-outputpath-openapi-fix.md](document-endpoint-outputpath-openapi-fix.md) — Bug fix for `--outputPath` crash (applies to batch mode as well)
