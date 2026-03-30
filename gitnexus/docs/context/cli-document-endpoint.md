# `gitnexus document-endpoint`

Generate comprehensive API documentation for an HTTP endpoint from the GitNexus knowledge graph.

## Synopsis

```bash
gitnexus document-endpoint --method <METHOD> --path <pattern> [options]
```

## Description

Analyzes the call chain from an HTTP endpoint handler through all service layers, extracting:

- **Request/Response schemas** - Parameters, body types, validation rules
- **Call chain** - Complete method call graph from controller to deepest service
- **Downstream APIs** - External HTTP calls with resolved URLs
- **Messaging** - Inbound (event listeners) and outbound (event publishers) messaging
- **Persistence** - Database tables and stored procedures accessed
- **Exception handling** - Error codes mapped to HTTP responses
- **Annotations** - Spring annotations (`@Retryable`, `@Cacheable`, `@Transactional`)

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--method <METHOD>` | Yes | - | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `--path <pattern>` | Yes | - | Path pattern (fuzzy match supported) |
| `--depth <n>` | No | 10 | Maximum call chain depth to trace |
| `--include-context` | No | false | Include source code snippets for AI enrichment |
| `--compact` | No | false | Omit source content and empty arrays (reduces output size) |
| `--repo <name>` | No | - | Target repository (if multiple indexed) |

## Path Matching

The `--path` argument uses fuzzy matching:

| Pattern | Matches |
|---------|---------|
| `bonds` | `/e/v1/bonds`, `/b/v1/bonds`, `/api/bonds` |
| `customers/{id}` | `/customers/{tcbsId}`, `/v1/customers/{id}/assets` |
| `/t/v1/orders/cds/sell` | Exact or near-exact match |

When Route nodes exist in the graph, the tool uses them for precise matching. Otherwise, it falls back to searching for `@XxxMapping` annotations in controller classes.

## Examples

### Basic Usage

```bash
# From inside an indexed repository
cd /path/to/your-repo
gitnexus document-endpoint --method GET --path "bonds"
gitnexus document-endpoint --method POST --path "/t/v1/orders/cds/sell"
gitnexus document-endpoint --method PUT --path "bookings/{productCode}/suggest"
```

### With Context for AI Enrichment

```bash
# Include source code snippets (larger output)
gitnexus document-endpoint --method GET --path "pricings" --include-context
```

### Compact Mode for Large Outputs

```bash
# Reduce output size (~50% smaller) - useful when hitting pipe buffer limits
gitnexus document-endpoint --method PUT --path "bookings" --include-context --compact
```

### Control Trace Depth

```bash
# Limit depth for complex endpoints (default is 10)
gitnexus document-endpoint --method POST --path "orders" --depth 5
```

### Multi-Repository

```bash
# Target a specific indexed repository
gitnexus document-endpoint --method GET --path "bonds" --repo tcbs-bond-trading
```

### Redirect to File

```bash
# For large outputs, redirect to file to avoid pipe buffer truncation
gitnexus document-endpoint --method PUT --path "bookings" --include-context > endpoint-doc.json
```

## Output Structure

```json
{
  "result": {
    "method": "PUT",
    "path": "/e/v1/bookings/{productCode}/suggest",
    "summary": "TODO_AI_ENRICH",
    "specs": {
      "request": {
        "params": [
          {
            "name": "productCode",
            "type": "String",
            "required": true,
            "description": ""
          }
        ],
        "body": {
          "typeName": "SuggestionOrderResultDto",
          "source": "external"
        },
        "validation": [
          {
            "field": "order",
            "type": "Custom",
            "required": true,
            "rules": "@Valid order validation"
          }
        ]
      },
      "response": {
        "body": { "typeName": "SuggestionOrderResultDto", "source": "external" },
        "codes": [
          { "code": 200, "description": "Success" },
          { "code": 400, "description": "TcbsException: ErrorCode.UNKNOWN_ERROR" }
        ]
      }
    },
    "externalDependencies": {
      "downstreamApis": [
        {
          "serviceName": "tcbs.bond.settlement.service.url",
          "endpoint": "POST /v1/bond-limit/hold-unhold",
          "condition": "TODO_AI_ENRICH",
          "purpose": "TODO_AI_ENRICH",
          "resolvedUrl": "bondSettlementService.concat(/v1/bond-limit/hold-unhold)"
        }
      ],
      "messaging": {
        "inbound": [
          {
            "topic": "TODO_AI_ENRICH",
            "payload": "StartUnholdSuggestionOrderEvent",
            "consumptionLogic": "EventHandlerImpl.startUnholdSuggestionOrder()"
          }
        ],
        "outbound": []
      },
      "persistence": [
        {
          "database": "TODO_AI_ENRICH",
          "tables": "trading, tradingAttr, bondProduct",
          "storedProcedures": "None detected"
        }
      ]
    },
    "logicFlow": "TODO_AI_ENRICH",
    "codeDiagram": "graph TB\n  subgraph Controller\n    A[unhold]\n  end\n  subgraph Service\n    B[process]\n  end\n  A --> B",
    "cacheStrategy": { "flow": "" },
    "retryLogic": [
      {
        "operation": "execPost",
        "maxAttempts": "3",
        "backoff": "TODO_AI_ENRICH",
        "recovery": "TODO_AI_ENRICH"
      }
    ],
    "keyDetails": {
      "transactionManagement": [],
      "businessRules": [],
      "security": []
    }
  }
}
```

### With `--include-context`

When `--include-context` is used, additional `_context` fields are added:

```json
{
  "result": {
    "specs": {
      "request": {
        "params": [
          {
            "name": "productCode",
            "_context": "// src/main/java/.../Controller.java:107\n@PathVariable"
          }
        ]
      }
    },
    "_context": {
      "callChain": [
        {
          "uid": "Method:src/main/java/.../Controller.java:handler",
          "name": "handler",
          "filePath": "src/main/java/.../Controller.java",
          "depth": 0,
          "callees": ["Method:.../Service.java:process"],
          "metadata": { "httpCalls": [], "annotations": [], ... }
        }
      ]
    }
  }
}
```

### With `--compact`

When `--compact` is used with `--include-context`:

1. Source code content is omitted from `_context` fields
2. Empty arrays (`[]`) are removed from the output
3. Output size is reduced by ~50%

This is useful when:
- Output needs to fit within terminal pipe buffers (64KB limit on macOS)
- Processing by AI with token limits
- Only structural metadata is needed

## Output Size Guidelines

| Mode | Approximate Size | Use Case |
|------|------------------|----------|
| Default | 2-5 KB | Quick reference |
| `--include-context` | 50-200 KB | Full AI enrichment |
| `--include-context --compact` | 25-100 KB | AI enrichment with size constraints |

**Note**: Terminal pipe buffers on macOS limit output to ~64KB. If output exceeds this:
- Use `--compact` to reduce size
- Redirect to file: `> output.json`

## Fields

### Request Params

Extracted from Spring annotations:
- `@PathVariable` - Path parameters
- `@RequestParam` - Query parameters
- `@RequestHeader` - Header parameters
- `@CookieValue` - Cookie values

### Validation Rules

Extracted from:
- JSR-303 annotations (`@Valid`, `@NotNull`, `@Size`, `@Pattern`)
- Custom validation methods (detected via patterns like `.validate*()`, `*ValidationServiceImpl.process()`)
- Imperative validation calls (`TcbsValidator.validate()`, `ValidationUtils.check()`)

### Downstream APIs

HTTP calls extracted from:
- `RestTemplate`, `WebClient`, `HttpClient` calls
- `@Value` expressions resolved to application properties
- Spring constants for URL paths

### Messaging

- **Inbound**: Methods with `@RabbitListener`, `@KafkaListener`, `@EventListener`
- **Outbound**: Calls to `publishEvent()`, `rabbitTemplate.send()`, etc.

### Persistence

Database access detected from:
- Repository method calls (`userRepository.findById()`)
- Entity table names extracted from `@Table` annotations
- Named queries

### Code Diagram

Mermaid `graph TB` format showing the call chain from controller to deepest service.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (no matching endpoint, invalid arguments, etc.) |

## See Also

- `gitnexus endpoints` - List all discovered endpoints
- `gitnexus context` - Get 360-degree view of a symbol
- `gitnexus impact` - Analyze blast radius of changes