# `gitnexus document-endpoint`

Generate comprehensive API documentation for an HTTP endpoint from the GitNexus knowledge graph.

## Synopsis

```bash
gitnexus document-endpoint --method <METHOD> --path <pattern> [options]
```

## Description

Analyzes the call chain from an HTTP endpoint handler through all service layers, extracting:

- **Request/Response schemas** - Parameters, body types, validation rules, nested field resolution
- **Call chain** - Complete method call graph from controller to deepest service
- **Downstream APIs** - External HTTP calls with resolved URLs (service URL resolution)
- **Messaging** - Inbound (event listeners) and outbound (event publishers) messaging with payload types
- **Persistence** - Database tables and stored procedures accessed
- **Exception handling** - Error codes mapped to HTTP responses
- **Annotations** - Spring annotations (`@Retryable`, `@Cacheable`, `@Transactional`)
- **Validation** - Method-level and field-level validation annotations

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--method <METHOD>` | Yes | - | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `--path <pattern>` | Yes | - | Path pattern (fuzzy match supported) |
| `--depth <n>` | No | 10 | Maximum call chain depth to trace |
| `--include-context` | No | false | Include source code snippets for AI enrichment |
| `--compact` | No | false | Omit source content and empty arrays (use with `--include-context`) |
| `--openapi` | No | false | Preserve raw BodySchema for OpenAPI generation (includes validation annotations) |
| `--schema-path <path>` | No | bundled | Path to custom JSON schema file for output validation |
| `--strict` | No | warn | Fail on schema validation errors (default: warn only) |
| `-r, --repo <name>` | No | - | Target repository (if multiple indexed) |

## Path Matching

The `--path` argument uses fuzzy matching:

| Pattern | Matches |
|---------|---------|
| `bonds` | `/e/v1/bonds`, `/b/v1/bonds`, `/api/bonds` |
| `customers/{id}` | `/customers/{tcbsId}`, `/v1/customers/{id}/assets` |
| `/t/v1/orders/cds/sell` | Exact or near-exact match |

When Route nodes exist in the graph, the tool uses them for precise matching. Otherwise, it falls back to searching for `@XxxMapping` annotations in controller classes.

## Output Modes

The tool supports multiple output modes depending on the flags used:

### Default Mode (No Context)

Converts request/response bodies to simplified JSON example format with top-level keys. Best for quick reference and human readability.

```json
{
  "specs": {
    "request": {
      "body": {
        "productCode": "String",
        "quantity": "Integer",
        "orderType": "String"
      }
    }
  }
}
```

### With Context (`--include-context`)

Preserves full `BodySchema` structure with:
- `typeName` - The DTO/POJO class name
- `fields` - Nested array with full schema resolution
- Validation annotations (`@NotEmpty`, `@NotNull`, `@JsonFormat`, etc.)
- `_context` - Source code snippets for each extracted element

```json
{
  "specs": {
    "request": {
      "body": {
        "typeName": "SuggestionOrderDto",
        "source": "external",
        "fields": [
          {
            "name": "productCode",
            "type": "String",
            "annotations": ["@NotEmpty"],
            "_context": "// SuggestionOrderDto.java:15\n@NotEmpty\nprivate String productCode;"
          }
        ]
      }
    }
  }
}
```

### OpenAPI Mode (`--openapi`)

Preserves raw `BodySchema` structure optimized for OpenAPI 3.0 schema generation:
- Includes all validation annotations in field metadata
- Preserves nested type structures for recursive schema generation
- Suitable for piping to OpenAPI bundler/converter

```json
{
  "specs": {
    "request": {
      "body": {
        "typeName": "SuggestionOrderDto",
        "fields": [
          {
            "name": "productCode",
            "type": "String",
            "annotations": ["@NotEmpty(message = \"Product code is required\")"],
            "nullable": false
          }
        ]
      }
    }
  }
}
```

### Strict Mode (`--strict`)

Validates output against JSON schema. By default, validation errors are logged as warnings. With `--strict`:
- Fails with non-zero exit code on schema violations
- Useful for CI/CD pipelines requiring valid output

### Compact Mode (`--compact`)

When combined with `--include-context`:
- Omits source code content from `_context` fields
- Removes empty arrays from output
- Reduces output size by ~50%

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
gitnexus document-endpoint --method GET --path "bonds" -r tcbs-bond-trading
```

### OpenAPI Schema Generation

```bash
# Generate output suitable for OpenAPI 3.0 schema generation
gitnexus document-endpoint --method PUT --path "bookings/suggest" --openapi > openapi-schema.json
```

### Strict Validation

```bash
# Fail on schema validation errors (useful for CI/CD)
gitnexus document-endpoint --method GET --path "bonds" --strict
```

### Custom Schema Validation

```bash
# Validate against custom schema
gitnexus document-endpoint --method POST --path "orders" \
  --schema-path ./schemas/endpoint-output.schema.json \
  --strict
```

### Redirect to File

```bash
# For large outputs, redirect to file to avoid pipe buffer truncation
gitnexus document-endpoint --method PUT --path "bookings" --include-context > endpoint-doc.json
```

## Output Structure

### Complete Output Schema

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
            "description": "",
            "_context": "// Controller.java:107\n@PathVariable String productCode"
          }
        ],
        "body": {
          "typeName": "SuggestionOrderDto",
          "source": "external",
          "sourceRepo": "tcbs-order-service",
          "fields": [
            {
              "name": "orderType",
              "type": "String",
              "annotations": ["@NotEmpty"],
              "_context": "// SuggestionOrderDto.java:25\n@NotEmpty\nprivate String orderType;"
            }
          ]
        },
        "validation": [
          {
            "field": "order",
            "type": "Custom",
            "required": true,
            "rules": "@Valid order validation",
            "method": "validateOrder"
          }
        ]
      },
      "response": {
        "body": {
          "typeName": "SuggestionOrderResultDto",
          "source": "external",
          "fields": []
        },
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
          "resolvedUrl": "http://bond-settlement.internal.tcbs.vn/v1/bond-limit/hold-unhold",
          "resolvedFrom": "@Value annotation"
        }
      ],
      "messaging": {
        "inbound": [
          {
            "topic": "bond.orders.unhold",
            "payload": {
              "typeName": "StartUnholdSuggestionOrderEvent",
              "fields": []
            },
            "consumptionLogic": "EventHandlerImpl.startUnholdSuggestionOrder()"
          }
        ],
        "outbound": [
          {
            "topic": "bond.orders.created",
            "payload": {
              "typeName": "BondOrderCreatedEvent",
              "fields": []
            },
            "publishMethod": "rabbitTemplate.convertAndSend()"
          }
        ]
      },
      "persistence": [
        {
          "database": "PostgreSQL",
          "tables": "trading, trading_attr, bond_product",
          "storedProcedures": "None detected"
        }
      ]
    },
    "logicFlow": "1. Validate request\n2. Check product exists\n3. Create order\n4. Publish event",
    "codeDiagram": "graph TB\n  subgraph Controller\n    A[unhold]\n  end\n  subgraph Service\n    B[process]\n    C[validate]\n    D[publishEvent]\n  end\n  A --> B\n  B --> C\n  B --> D",
    "cacheStrategy": {
      "flow": "Cache aside pattern with Redis",
      "annotations": ["@Cacheable(value = \"suggestions\", key = \"#productCode\")"]
    },
    "retryLogic": [
      {
        "operation": "execPost",
        "maxAttempts": "3",
        "backoff": "1000ms exponential",
        "recovery": "fallbackToCachedData"
      }
    ],
    "keyDetails": {
      "transactionManagement": ["@Transactional(readOnly = true)"],
      "businessRules": ["Order quantity must be positive"],
      "security": ["JWT validation required"]
    },
    "_context": {
      "callChain": [
        {
          "uid": "Method:src/main/java/.../Controller.java:handler",
          "name": "handler",
          "filePath": "src/main/java/.../Controller.java",
          "depth": 0,
          "callees": ["Method:.../Service.java:process"]
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

## Service Resolution Features

The tool performs advanced resolution to determine actual service URLs from Spring patterns:

### @Value Annotation Resolution

Resolves Spring `@Value("${property.key}")` annotations to actual service URLs from application properties:

```java
@Value("${tcbs.bond.settlement.service.url}")
private String bondSettlementService;
```

Resolves to: `http://bond-settlement.internal.tcbs.vn`

### Variable Assignment Tracing

Traces local variable assignments to find base URLs:

```java
public void processOrder() {
    String baseUrl = configService.getServiceUrl();
    String endpoint = baseUrl + "/v1/orders";
    restTemplate.postForEntity(endpoint, request, Response.class);
}
```

### Static Constant Resolution

Resolves static final constants and `@Value`-annotated constants:

```java
@Component
public class ApiEndpoints {
    public static final String ORDERS_PATH = "/v1/orders";
    
    @Value("${orders.service.url}")
    public static String ORDERS_SERVICE_URL;
}
```

### URI Builder Pattern Resolution

Resolves `UriComponentsBuilder` patterns:

```java
URI uri = UriComponentsBuilder
    .fromHttpUrl(bondServiceUrl)
    .path("/v1/bonds/{id}")
    .build(id)
    .toUri();
```

### StringBuilder Tracing

Traces `StringBuilder` construction for URL assembly:

```java
StringBuilder urlBuilder = new StringBuilder(config.getBaseUrl());
urlBuilder.append("/v1/products/");
urlBuilder.append(productId);
String finalUrl = urlBuilder.toString();
```

## Cross-Repository Resolution

When endpoints reference types from other indexed repositories:

- Automatically resolves types from indexed dependencies
- Uses Maven dependency coordinates from `repo_manifest.json`
- Resolves nested DTOs from dependency repositories
- Traces types across repository boundaries

Example: An endpoint in `tcbs-trading` uses `BondProductDto` from `tcbs-bond-product`:

```json
{
  "specs": {
    "response": {
      "body": {
        "typeName": "BondProductDto",
        "source": "external",
        "sourceRepo": "tcbs-bond-product"
      }
    }
  }
}
```

## Messaging Resolution

Detects and resolves messaging patterns for both inbound and outbound events:

### Inbound Messaging (Event Consumers)

- `@RabbitListener` - RabbitMQ message listeners
- `@KafkaListener` - Kafka message listeners
- `@EventListener` - Spring application events

### Outbound Messaging (Event Publishers)

Detects publishing patterns:

| Pattern | Framework |
|---------|-----------|
| `rabbitTemplate.convertAndSend()` | RabbitMQ |
| `kafkaTemplate.send()` | Kafka |
| `applicationEventPublisher.publishEvent()` | Spring Events |
| `eventBus.publish()` | Custom event bus |

### Payload Type Resolution

Resolves payload types with nested field schemas:

```json
{
  "messaging": {
    "outbound": [
      {
        "topic": "bond.orders.created",
        "payload": {
          "typeName": "BondOrderCreatedEvent",
          "fields": [
            { "name": "orderId", "type": "String" },
            { "name": "productCode", "type": "String" },
            { "name": "timestamp", "type": "LocalDateTime" }
          ]
        }
      }
    ]
  }
}
```

## Validation Extraction

### Method-Level Validation

Extracts validation method calls:

```java
validateJWT(token);
validateRequest(orderDto);
validateProductExists(productCode);
```

Result:

```json
{
  "validation": [
    {
      "field": "jwt",
      "type": "Custom",
      "method": "validateJWT",
      "required": true
    }
  ]
}
```

### Field-Level Validation Annotations

Extracts JSR-303/380 annotations:

| Annotation | Extracted Info |
|------------|----------------|
| `@NotNull` | Field required |
| `@NotEmpty` | Non-empty required |
| `@NotBlank` | Non-blank string required |
| `@Size(min, max)` | Size constraints |
| `@Pattern(regexp)` | Pattern constraint |
| `@Min`, `@Max` | Numeric bounds |
| `@JsonFormat(pattern)` | Date format |
| `@Email` | Email validation |

Example:

```json
{
  "fields": [
    {
      "name": "orderDate",
      "type": "LocalDateTime",
      "annotations": [
        "@JsonFormat(pattern = \"yyyy-MM-dd HH:mm:ss\")",
        "@NotNull"
      ]
    }
  ]
}
```

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
- `RestTemplate`, `WebClient`, `HttpClient`, `OkHttpClient` calls
- `@Value` expressions resolved to application properties
- Spring constants for URL paths
- URI builder patterns (`UriComponentsBuilder`)
- StringBuilder URL construction

Resolution chain:
1. Extract HTTP call from method body
2. Resolve base URL from field/variable assignments
3. Resolve `@Value` annotations to application properties
4. Trace static constants and service config fields
5. Include resolved URL in output with resolution source

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

## Missing Features

The following options are NOT currently implemented but may be useful:

| Option | Description | Status |
|--------|-------------|--------|
| `--all` | Document all endpoints in the repository | Not implemented |
| `--format <format>` | Output format: `json` (default) or `yaml` | Not implemented |
| `--output <file>` | Write output to file instead of stdout | Not implemented |

Workarounds:
- **Document multiple endpoints**: Use a shell script to iterate over endpoints
- **YAML output**: Pipe JSON through `yq` or `jq` for conversion
- **Write to file**: Redirect stdout: `gitnexus document-endpoint ... > output.json`

## See Also

- `gitnexus endpoints` - List all discovered endpoints
- `gitnexus context` - Get 360-degree view of a symbol
- `gitnexus impact` - Analyze blast radius of changes