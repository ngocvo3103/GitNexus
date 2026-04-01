# document-endpoint

Generate API documentation for an endpoint.

## Usage

```bash
gitnexus document-endpoint --method <METHOD> --path <path-pattern> [options]
gitnexus document-endpoint --all-endpoints --openapi --repo <name> [options]
```

## Options

| Option | Description |
|--------|-------------|
| `--method <METHOD>` | HTTP method (GET, POST, PUT, DELETE, PATCH) |
| `--path <pattern>` | Path pattern to match |
| `--repo <name>` | Target repository |
| `--openapi` | Output in OpenAPI 3.1.0 format |
| `--format <yaml\|json>` | Output format (default: yaml when --openapi) |
| `--all-endpoints` | Generate OpenAPI for all endpoints in repo |
| `--output <path>` | Write to file instead of stdout |
| `--title <title>` | API title for OpenAPI info |
| `--api-version <ver>` | API version (default: 1.0.0) |

## --all-endpoints

The `--all-endpoints` flag generates OpenAPI documentation for all endpoints in a repository. It queries Route nodes from the knowledge graph.

### Prerequisites

Route nodes are created during repository indexing when Spring `@Controller` or `@RestController` annotations are detected. Ensure your repository was indexed with GitNexus >= v1.4.10.

### Re-indexing

If you get "No endpoints found" but expect endpoints to exist:

```bash
# Force re-index to populate Route nodes
gitnexus analyze --force /path/to/repo --repo my-service

# Then generate OpenAPI
gitnexus document-endpoint --all-endpoints --openapi --repo my-service
```

## Examples

```bash
# Single endpoint documentation
gitnexus document-endpoint --method GET --path "/users" --repo my-service

# Single endpoint as OpenAPI
gitnexus document-endpoint --method GET --path "/users/{id}" --openapi --repo my-service

# All endpoints as OpenAPI
gitnexus document-endpoint --all-endpoints --openapi --repo my-service --title "My API"
```

## Troubleshooting

### No endpoints found

If `--all-endpoints` returns no results:
1. Verify the repository was indexed: `gitnexus list`
2. Force re-index to populate Route nodes: `gitnexus analyze --force <path>`
3. Check for Spring annotations in your code: `@RestController`, `@GetMapping`, etc.

### Output format issues

For JSON output, use `--format json`. Default is YAML when `--openapi` is specified.