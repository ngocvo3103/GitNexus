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
| `--mode <mode>` | No | `openapi` | Output mode: `openapi` or `ai_context` |
| `--input-yaml <path>` | No | - | Enrich an existing OpenAPI spec file |
| `--depth <n>` | No | 10 | Maximum call chain depth to trace |
| `--outputPath <path>` | No | - | Output directory; required when writing files |
| `--schema-path <path>` | No | bundled | Path to custom JSON schema file for output validation |
| `--strict` | No | warn | Fail on schema validation errors (default: warn only) |
| `-r, --repo <name>` | No | - | Target repository (if multiple indexed) |

### `--mode <openapi|ai_context>`

Controls the output format. Default is `openapi`.

#### Mode 1: `openapi` (default)

Returns OpenAPI 3.1.0 YAML with `x-` extension fields. Machine-readable, enhanced with dependency data.

**Output file:** `{METHOD}_{sanitized-path}.openapi.yaml`

```yaml
openapi: '3.1.0'
info:
  title: 'API - /e/v1/bookings/{productCode}/suggest'
  version: '1.0.0'
paths:
  /e/v1/bookings/{productCode}/suggest:
    put:
      summary: Suggest booking
      operationId: put_e_v1_bookings_productCode_suggest
      parameters:
        - name: productCode
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SuggestionOrderDto'
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SuggestionResultDto'
        '400':
          description: Bad Request
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    SuggestionOrderDto:
      type: object
      required:
        - productCode
        - quantity
      properties:
        productCode:
          type: string
          minLength: 1
        quantity:
          type: integer
```

**YAML Spec Features:**
- Full OpenAPI 3.1.0 compliance
- Parameter locations (`path`, `query`, `header`, `cookie`) from Spring annotations
- Request body schemas with required fields
- Response schemas differentiated by status code (2xx vs 4xx/5xx)
- Nested type resolution for complex DTOs
- Validation annotations mapped to OpenAPI constraints
- `x-extension` fields embedding dependency metadata (downstream APIs, messaging, persistence)

#### Mode 2: `ai_context`

Returns full JSON with `_context` fields, `BodySchema` payloads, and `TODO_AI_ENRICH` placeholders for AI agent enrichment.

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
        }
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
      }
    },
    "_context": {
      "summaryContext": "Handler: Controller.handler() → Chain: handler → process"
    }
  }
}
```

**`TODO_AI_ENRICH` placeholders** mark fields that require AI agent completion:
- `summary` — human-readable endpoint summary
- `condition` / `purpose` on downstream API entries — business context
- Any other descriptive fields left empty by the analyzer

> **Note:** `--include-context` is deprecated and maps to `--mode ai_context`. A deprecation warning is emitted when `--include-context` is used.

### `--input-yaml <path>`

Enrich an existing OpenAPI specification file with data extracted from the knowledge graph.

```bash
gitnexus document-endpoint --input-yaml ./openapi.yaml --method PUT --path "bookings/suggest"
```

**Behavior:**
- `--method` and `--path` select specific endpoints to enrich
- Without `--method` and `--path`, all endpoints are enriched
- Output written to `{baseName}.enriched.openapi.yaml`
- Original file is unchanged

**Enrichment adds:**
- Parameter types and required flags from source analysis
- Request/response body schemas (resolving nested DTOs)
- Validation constraints from field annotations
- `x-` extension blocks for downstream APIs, messaging, and persistence

### Deprecated: `--include-context`

`--include-context` is deprecated. Use `--mode ai_context` instead.

```bash
# Deprecated
gitnexus document-endpoint --method GET --path "bonds" --include-context

# Equivalent
gitnexus document-endpoint --method GET --path "bonds" --mode ai_context
```

A deprecation warning is emitted when `--include-context` is used.

## Path Matching

The `--path` argument uses fuzzy matching:

| Pattern | Matches |
|---------|---------|
| `bonds` | `/e/v1/bonds`, `/b/v1/bonds`, `/api/bonds` |
| `customers/{id}` | `/customers/{tcbsId}`, `/v1/customers/{id}/assets` |
| `/t/v1/orders/cds/sell` | Exact or near-exact match |

When Route nodes exist in the graph, the tool uses them for precise matching. Otherwise, it falls back to searching for `@XxxMapping` annotations in controller classes.

## Enum Resolution

When a Java field is typed as an enum class (e.g., `private OrderAction action`), the OpenAPI output resolves the enum constants and emits an `enum:` array.

### How it works

1. `resolveTypeSchema()` first queries `:Class` nodes for the type name.
2. If no `:Class` found, it falls back to `MATCH (e:Enum) WHERE e.name = $typeName`.
3. The raw `content` of the `:Enum` node is parsed by `parseEnumConstants()` to extract uppercase constant names (e.g., `BUY`, `SELL`, `HOLD`).
4. The enum schema `{ source: 'indexed', enumValues: ['BUY','SELL','HOLD'] }` propagates through `resolveAllNestedTypes()` → `embedNestedSchemas()` → `bodySchemaToOpenAPISchema()`.
5. The OpenAPI schema emits `{ type: string, enum: ['BUY','SELL','HOLD'] }`.

### Output example

```yaml
properties:
  action:
    type: string
    enum:
      - BUY
      - SELL
      - HOLD
  status:
    type: string
    enum:
      - PENDING
      - COMPLETED
      - CANCELLED
```

### Limitations

- Only works when the Java field type IS the enum class (e.g., `OrderAction action`). Fields declared as `String` that semantically hold enum values are not auto-detected.
- Enum constants are parsed from raw source `content` via regex. Constants with non-standard casing or complex initializers may not be captured.
- Cross-repo enums (defined in dependency repos) are resolved via the same cross-repo fallback path.

## Output Size Guidelines

| Mode | Approximate Size | Use Case |
|------|------------------|----------|
| `openapi` (default) | 2-10 KB | Machine consumption, API registries |
| `ai_context` | 50-200 KB | AI agent enrichment |

**Note**: Terminal pipe buffers on macOS limit output to ~64KB. For `ai_context` output that may exceed this, redirect to a file.

## Examples

### Basic Usage

```bash
# From inside an indexed repository
cd /path/to/your-repo
gitnexus document-endpoint --method GET --path "bonds"
gitnexus document-endpoint --method POST --path "/t/v1/orders/cds/sell"
gitnexus document-endpoint --method PUT --path "bookings/{productCode}/suggest"
```

### OpenAPI Mode (default)

```bash
# Generate OpenAPI 3.1.0 YAML
gitnexus document-endpoint --method PUT --path "bookings/suggest"

# With explicit output directory
gitnexus document-endpoint --method PUT --path "bookings/suggest" --outputPath ./docs/api

# Validate generated YAML with Redocly CLI
npx @redocly/cli lint ./docs/api/PUT_e_v1_bookings_productCode_suggest.openapi.yaml
```

### AI Context Mode

```bash
# Full JSON with _context fields and TODO_AI_ENRICH placeholders
gitnexus document-endpoint --method GET --path "bonds" --mode ai_context

# Redirect to file for large output
gitnexus document-endpoint --method PUT --path "bookings" --mode ai_context > endpoint-doc.json
```

### Deprecation Warning

```bash
# --include-context still works but emits a warning
gitnexus document-endpoint --method GET --path "pricings" --include-context
# → Warning: --include-context is deprecated. Use --mode ai_context instead.
```

### Enrich an Existing OpenAPI File

```bash
# Enrich specific endpoint in existing spec
gitnexus document-endpoint --input-yaml ./openapi.yaml --method PUT --path "bookings/suggest"

# Output: openapi.enriched.openapi.yaml
```

```bash
# Enrich all endpoints in spec (no method/path filter)
gitnexus document-endpoint --input-yaml ./openapi.yaml

# Output: openapi.enriched.openapi.yaml
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

### Strict Validation

```bash
# Fail on schema validation errors (useful for CI/CD)
gitnexus document-endpoint --method GET --path "bonds" --strict

# Validate against custom schema
gitnexus document-endpoint --method POST --path "orders" \
  --schema-path ./schemas/endpoint-output.schema.json \
  --strict
```

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
| `--format <format>` | Output format: `json` (default) or `yaml` | Use `--mode openapi --outputPath` for YAML |

Workarounds:
- **Document multiple endpoints**: Use a shell script to iterate over endpoints
- **YAML output**: Use `--mode openapi --outputPath` to generate OpenAPI YAML

## See Also

- `gitnexus endpoints` - List all discovered endpoints
- `gitnexus context` - Get 360-degree view of a symbol
- `gitnexus impact` - Analyze blast radius of changes