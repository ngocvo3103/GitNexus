# Feature: document-endpoint — Request Params, Validation, Messaging Inbound

**Service:** GitNexus / document-endpoint MCP tool  
**Status:** Design Phase  
**Date:** 2026-03-23  
**Feature Branch:** feature/document-endpoint  
**Task Key:** WI-6 (params + validation) + WI-9 (messaging)

## Summary

The `document-endpoint` tool generates API documentation JSON from Spring Boot HTTP endpoints indexed in the GitNexus knowledge graph. Three major output sections are currently empty and need implementation:

1. **`specs.request.params`** — Array of detected request parameters from path, query, header, and cookie annotations
2. **`specs.request.validation`** — Array of validation rules extracted from `@NotNull`, `@Size`, `@Email` etc. on parameters and DTOs
3. **`externalDependencies.messaging.inbound`** — Array of event listeners and message consumers the endpoint depends on
4. **`externalDependencies.messaging.outbound` (gaps)** — New patterns for Kafka, event publishing, stream bridges

These three sections, combined with existing HTTP downstream APIs and persistence metadata, form the complete external dependency contract for an endpoint.

---

## New Output Fields

### 1. specs.request.params

**Purpose:** Document all input parameters the endpoint accepts (path, query, header, cookie).

**Schema:**
```typescript
type ParamInfo = {
  name: string;           // Parameter name (e.g., "id", "limit", "Authorization")
  type: string;           // Java type (String, Integer, UUID, etc.)
  required: boolean;      // true if @PathVariable or @RequestParam(required=true)
  description: string;    // Human-readable description
  _context?: string;      // (When include_context=true) annotation text + location
};
```

**Example Output (include_context=false):**
```json
{
  "params": [
    {
      "name": "bondId",
      "type": "Long",
      "required": true,
      "description": ""
    },
    {
      "name": "limit",
      "type": "Integer",
      "required": false,
      "description": ""
    },
    {
      "name": "Authorization",
      "type": "String",
      "required": true,
      "description": ""
    }
  ]
}
```

**Data Source:** `ChainNode.parameters` JSON (populated during ingestion by `extractMethodSignature()` in `utils.ts`)

**Handler Node Structure (from trace):**
```json
{
  "uid": "Method:src/BondHoldController.java:holdBond",
  "parameters": [
    {
      "name": "bondId",
      "type": "Long",
      "annotations": ["@PathVariable"]
    },
    {
      "name": "limit",
      "type": "Integer",
      "annotations": ["@RequestParam"]
    },
    {
      "name": "auth",
      "type": "String",
      "annotations": ["@RequestHeader(\"Authorization\")"]
    }
  ]
}
```

### 1a. Algorithm: Extract Request Parameters

**Input:** Handler node from `chain[0]` (depth=0)  
**Output:** `specs.request.params` array

**Steps:**

1. **Parse handler.parameters JSON** (skip if null or parse fails)
   ```
   For each parameter in handler.parameters:
     - name = parameter.name
     - type = parameter.type
     - annotations = parameter.annotations (array of strings like "@PathVariable", "@RequestParam")
   ```

2. **Determine if required:**
   - If annotation contains `@PathVariable` → required = true (always)
   - If annotation contains `@RequestParam` → check `required` attribute:
     - `@RequestParam(required=true)` or no attribute → required = true
     - `@RequestParam(required=false)` → required = false
   - If annotation contains `@RequestHeader` or `@CookieValue` → check `required` attribute (default true)
   - Unannotated parameters → skip (bean-style DTO params cannot be statically extracted)

3. **Skip framework-injected parameters:**
   Skip entirely (don't include in array):
   - `HttpServletRequest`, `HttpServletResponse`
   - `Model`, `ModelMap` (Spring MVC model binding)
   - Custom resolvers like `TcbsJWT`, `TcbsUserDetails`
   - `java.security.Principal`
   - Any type not resolvable to a concrete class

4. **Skip @RequestBody parameters:**
   Don't include request body parameters here — they're handled by `specs.request.body` and `specs.request.validation`

5. **Default description to empty string:**
   `description = ""`  
   When `include_context=true`, populate `_context` field (see section 1c)

**Example Pseudocode:**
```
extractRequestParams(handler) {
  if (!handler.parameters) return [];
  
  const params = [];
  for (const param of JSON.parse(handler.parameters)) {
    // Skip framework types
    if (FRAMEWORK_TYPES.has(param.type)) continue;
    
    // Skip @RequestBody (goes to body schema)
    if (param.annotations?.includes('@RequestBody')) continue;
    
    // Determine requirement
    let required = false;
    const annotations = param.annotations || [];
    
    if (annotations.some(a => a.includes('@PathVariable'))) {
      required = true;
    } else if (annotations.some(a => a.includes('@RequestParam'))) {
      const attr = extractAttributeFromAnnotation(annotation, 'required');
      required = attr !== 'false';  // Default: true
    } else if (annotations.some(a => a.includes('@RequestHeader') || a.includes('@CookieValue'))) {
      const attr = extractAttributeFromAnnotation(annotation, 'required');
      required = attr !== 'false';  // Default: true
    }
    
    params.push({
      name: param.name,
      type: param.type,
      required,
      description: ''
    });
  }
  
  return params;
}
```

### 1b. Supported Annotations

| Annotation | Behavior | Example |
|-----------|----------|---------|
| `@PathVariable` | Required path segment; extract from URI template | `@PathVariable Long bondId` |
| `@PathVariable(required=false)` | Optional path variable (rare) | `@PathVariable(required=false) Long id` |
| `@RequestParam` | Query parameter; required by default | `@RequestParam String filter` |
| `@RequestParam(required=false)` | Optional query parameter | `@RequestParam(required=false) Integer limit` |
| `@RequestHeader` | HTTP header; required by default | `@RequestHeader String Authorization` |
| `@RequestHeader(required=false)` | Optional header | `@RequestHeader(required=false) String X-Custom` |
| `@CookieValue` | Cookie parameter; required by default | `@CookieValue String sessionId` |
| `@CookieValue(required=false)` | Optional cookie | `@CookieValue(required=false) String lang` |

### 1c. _context Behavior (include_context=true)

When `include_context=true`, include `_context` field in each parameter:

```json
{
  "name": "bondId",
  "type": "Long",
  "required": true,
  "description": "",
  "_context": "// src/BondHoldController.java:42-50\n@PathVariable(\"bondId\") Long bondId"
}
```

Format: `// filePath:startLine\n{annotation text from source}`

**Purpose:** AI enrichment pass can use this raw annotation text + source location to populate `description` fields with human-friendly text derived from variable names or nearby comments.

### 1d. Limitations

- **Unannotated DTO parameters:** Cannot extract. Bean-style params like `public void save(SavingMarketDto prm)` without `@ModelAttribute` are not statically determinable without analyzing all Spring resolvers.
- **Complex annotation attributes:** Only simple string/boolean attributes are extracted. Complex attributes like `@RequestParam(defaultValue = someConstant)` → skip enrichment.
- **External type parameters:** If `type` is not resolvable in the graph, still include but note it may need AI enrichment.

---

### 2. specs.request.validation

**Purpose:** Document all validation rules on request parameters and request body fields.

**Schema:**
```typescript
type ValidationRule = {
  field: string;           // Parameter/field name (e.g., "bondId", "amount", "user.email")
  type: string;            // Java type of the field
  required: boolean;       // true if @NotNull, @NotBlank, or @NotEmpty present
  rules: string;           // Human-readable rule (e.g., "Size: min=1, max=100")
  _context?: string;       // (When include_context=true) annotation + source location
};
```

**Example Output (include_context=false):**
```json
{
  "validation": [
    {
      "field": "bondId",
      "type": "Long",
      "required": true,
      "rules": "NotNull"
    },
    {
      "field": "amount",
      "type": "BigDecimal",
      "required": true,
      "rules": "NotNull, Positive"
    },
    {
      "field": "user.name",
      "type": "String",
      "required": true,
      "rules": "NotBlank, Size: min=1, max=100"
    },
    {
      "field": "user.email",
      "type": "String",
      "required": true,
      "rules": "NotNull, Email"
    },
    {
      "field": "TODO_AI_ENRICH",
      "type": "TODO_AI_ENRICH",
      "required": false,
      "rules": "TODO_AI_ENRICH",
      "_context": "// src/BondHoldService.java:85-95\nTcbsValidator.doValidate(holdRequest, context);"
    }
  ]
}
```

**Data Sources:**

1. **Parameter-level validation:** `ChainNode.parameters[].annotations` on handler (from trace)
2. **Field-level validation:** `BodySchema.fields[].annotations` (resolved during trace)
3. **Imperative validation:** Call chains containing validation framework calls (e.g., `TcbsValidator.doValidate()`)

### 2a. Algorithm: Extract Validation Rules

**Input:**
- Handler node from chain[0]
- Request body schema (if available)
- Full call chain (for imperative validation detection)

**Output:** `specs.request.validation` array

**Steps:**

**Part 1: Parameter-level validation**
```
For each parameter in handler.parameters:
  annotations = parameter.annotations || []
  
  For each annotation in annotations:
    field = parameter.name
    type = parameter.type
    
    If annotation is @NotNull, @NotBlank, or @NotEmpty:
      required = true
    
    Parse annotation attributes:
      @NotNull                    → rules = "NotNull"
      @NotBlank                   → rules = "NotBlank"
      @NotEmpty                   → rules = "NotEmpty"
      @Size(min=1, max=100)       → rules = "Size: min=1, max=100"
      @Min(5)                     → rules = "Min: 5"
      @Max(100)                   → rules = "Max: 100"
      @Positive                   → rules = "Positive"
      @PositiveOrZero             → rules = "PositiveOrZero"
      @Negative                   → rules = "Negative"
      @NegativeOrZero             → rules = "NegativeOrZero"
      @Pattern(regexp="[A-Z]+")   → rules = "Pattern: [A-Z]+"
      @Email                      → rules = "Email"
      @Temporal(TIMESTAMP)        → rules = "Temporal: TIMESTAMP"
      @Future                     → rules = "Future"
      @FutureOrPresent            → rules = "FutureOrPresent"
      @Past                       → rules = "Past"
      @PastOrPresent              → rules = "PastOrPresent"
    
    Add rule to rules array or combine with commas
```

**Part 2: Request body field validation**
```
If handler has @RequestBody parameter:
  bodySchema = resolveBodySchema(requestBodyType)
  
  For each field in bodySchema.fields:
    fieldPath = "field.name" (e.g., "user.email")
    type = field.type
    annotations = field.annotations || []
    
    Apply same parsing logic as Part 1
    required = true if any annotation is @NotNull/@NotBlank/@NotEmpty
```

**Part 3: Imperative validation detection** (when include_context=true)
```
For each node in chain:
  For each method call in node.metadata.repositoryCalls + direct calls:
    If call matches validation pattern:
      - /TcbsValidator\.(validate|doValidate)\(/
      - /ValidationUtils\.(validate|check)\(/
      - /\.validate\(/
      - /Validator\.(validate|check)\(/
    
    Emit validation rule with:
      field = "TODO_AI_ENRICH"
      type = "TODO_AI_ENRICH"
      required = false
      rules = "TODO_AI_ENRICH"
      _context = "// filePath:line\n{code snippet of validation call}"
```

**Example Pseudocode:**
```typescript
function extractValidationRules(
  handler: ChainNode,
  requestBodySchema: BodySchema | null,
  chain: ChainNode[],
  includeContext: boolean
): ValidationRule[] {
  const rules: ValidationRule[] = [];
  
  // Part 1: Parameter-level validation
  if (handler.parameters) {
    const params = JSON.parse(handler.parameters);
    for (const param of params) {
      const paramRules = extractAnnotationRules(
        param.annotations || [],
        param.name,
        param.type
      );
      rules.push(...paramRules);
    }
  }
  
  // Part 2: Request body field validation
  if (requestBodySchema?.fields) {
    for (const field of requestBodySchema.fields) {
      const fieldRules = extractAnnotationRules(
        field.annotations || [],
        field.name,
        field.type
      );
      rules.push(...fieldRules);
    }
  }
  
  // Part 3: Imperative validation
  if (includeContext) {
    for (const node of chain) {
      const imperativeRules = detectImperativeValidation(node);
      rules.push(...imperativeRules);
    }
  }
  
  return rules;
}

function extractAnnotationRules(
  annotations: string[],
  fieldName: string,
  fieldType: string
): ValidationRule[] {
  const rules: ValidationRule[] = [];
  const ruleTexts: string[] = [];
  let required = false;
  
  for (const ann of annotations) {
    if (ann.includes('@NotNull') || ann.includes('@NotBlank') || ann.includes('@NotEmpty')) {
      required = true;
    }
    
    // Extract rule text from annotation
    const ruleText = parseAnnotationToRule(ann);
    if (ruleText) {
      ruleTexts.push(ruleText);
    }
  }
  
  if (ruleTexts.length > 0 || required) {
    rules.push({
      field: fieldName,
      type: fieldType,
      required,
      rules: ruleTexts.join(', ')
    });
  }
  
  return rules;
}

function parseAnnotationToRule(annotation: string): string | null {
  // @NotNull → "NotNull"
  if (annotation.includes('@NotNull')) return 'NotNull';
  if (annotation.includes('@NotBlank')) return 'NotBlank';
  if (annotation.includes('@NotEmpty')) return 'NotEmpty';
  
  // @Size(min=1, max=100) → "Size: min=1, max=100"
  const sizeMatch = annotation.match(/@Size\(([^)]+)\)/);
  if (sizeMatch) return `Size: ${sizeMatch[1]}`;
  
  // ... other annotations
  
  return null;
}
```

### 2b. Supported Validation Annotations

| Annotation | Purpose | Rule Output |
|-----------|---------|-------------|
| `@NotNull` | Null check | "NotNull" (required=true) |
| `@NotBlank` | Non-empty string | "NotBlank" (required=true) |
| `@NotEmpty` | Non-empty collection/string | "NotEmpty" (required=true) |
| `@Size(min, max)` | Collection/string size | "Size: min=M, max=N" |
| `@Min(value)` | Numeric minimum | "Min: value" |
| `@Max(value)` | Numeric maximum | "Max: value" |
| `@Positive` | Positive number | "Positive" |
| `@PositiveOrZero` | Non-negative number | "PositiveOrZero" |
| `@Negative` | Negative number | "Negative" |
| `@NegativeOrZero` | Non-positive number | "NegativeOrZero" |
| `@Pattern(regexp)` | Regex match | "Pattern: regexp" |
| `@Email` | Email format | "Email" |
| `@Temporal(TIMESTAMP)` | Temporal format | "Temporal: TIMESTAMP" |
| `@Future` | Future date/time | "Future" |
| `@FutureOrPresent` | Future or now | "FutureOrPresent" |
| `@Past` | Past date/time | "Past" |
| `@PastOrPresent` | Past or now | "PastOrPresent" |
| `@Valid` | Cascade validation | "Valid (nested)" |
| `@Validated` | Group validation | "Validated" |

### 2c. _context Behavior (include_context=true)

**For declarative annotations:**
```json
{
  "field": "user.email",
  "type": "String",
  "required": true,
  "rules": "NotNull, Email",
  "_context": "// src/dto/UserDto.java:45\n@NotNull @Email private String email;"
}
```

**For imperative validation (validation framework calls):**
```json
{
  "field": "TODO_AI_ENRICH",
  "type": "TODO_AI_ENRICH",
  "required": false,
  "rules": "TODO_AI_ENRICH",
  "_context": "// src/service/HoldService.java:120-130\nTcbsValidator.doValidate(request, context);"
}
```

The `_context` field provides:
- Source location: `// filePath:line` or `// filePath:line1-line2` for multi-line calls
- Raw code snippet: Extracted annotation or validation call (first 200-300 chars)
- Purpose: AI enrichment pass can analyze this to infer field names and populate `field`, `type`, `rules`

### 2d. Limitations

- **Imperative/business-rule validation:** Service-layer validation like `TcbsValidator.doValidate()` cannot be statically extracted. Emit placeholder entries with `_context` pointing to the validation call site.
- **External validation frameworks:** Validation in external JARs (custom validators, third-party frameworks) may not be detected if not via standard annotations.
- **Cross-field/conditional validation:** Rules that depend on multiple fields or runtime state are not extractable (e.g., "field A is required if field B is not null").
- **Database lookups:** Validation that queries the database (e.g., unique constraint checks) are not statically determinable.

---

### 3. externalDependencies.messaging.inbound

**Purpose:** Document event listeners and message consumers the endpoint depends on (or the application listens to during request processing).

**Schema:**
```typescript
type MessagingInbound = {
  topic: string;              // Topic/queue/exchange name (e.g., "events.hold-created")
  payload: string;            // Expected payload type (e.g., "HoldCreatedEvent")
  consumptionLogic: string;    // What the consumer does with the message
  _context?: string;          // (When include_context=true) listener method + location
};
```

**Example Output (include_context=false):**
```json
{
  "messaging": {
    "inbound": [
      {
        "topic": "events.hold-created",
        "payload": "HoldCreatedEvent",
        "consumptionLogic": "OnHoldCreatedEventListener.onHoldCreated()"
      },
      {
        "topic": "treasury-commands",
        "payload": "SetCashAvailableCommand",
        "consumptionLogic": "EventQueueListener.processQueueMessage()"
      }
    ]
  }
}
```

### 3a. Detection Strategy

**Chain-based approach:** Scan `ChainNode.annotations` JSON for event listeners discovered during trace execution.

```
For each node in chain:
  If node.annotations contains @EventListener or @TransactionalEventListener:
    Extract listener method details:
      - Method name: node.name
      - Event type: first parameter of listener method
      - Topic: derived from method name or constant annotations
```

**Graph-query-based approach:** Execute Cypher query to find all inbound listeners in codebase (for dependency insight).

```cypher
MATCH (m:Method)
WHERE m.annotations CONTAINS '@RabbitListener' OR m.annotations CONTAINS '@KafkaListener' OR m.annotations CONTAINS '@JmsListener'
RETURN m.name, m.annotations, m.filePath, m.parameters, m.content
```

From results:
- `@RabbitListener(queues="queue-name")` → topic = "queue-name"
- `@KafkaListener(topics="topic-name")` → topic = "topic-name"
- `@JmsListener(destination="queue-name")` → topic = "queue-name"
- Method first parameter type → payload type
- Method implementation → consumptionLogic

### 3b. Algorithm: Extract Inbound Messaging

**Input:**
- Call chain from executeTrace
- executeQuery function for Cypher queries
- repoId

**Output:** `externalDependencies.messaging.inbound` array

**Steps:**

**Part 1: Event listeners in call chain**
```
For each node in chain:
  If node.annotations is present:
    annotations = JSON.parse(node.annotations)
    
    For each ann in annotations:
      If ann.name === '@EventListener' or ann.name === '@TransactionalEventListener':
        
        // Get first parameter to infer event type
        payload = extractFirstParameterType(node.parameters)
        
        // Generate consumption logic description
        consumptionLogic = `${getEnclosingClass(node)}.${node.name}()`
        
        inbound.push({
          topic: "TODO_AI_ENRICH",  // Can't infer from annotation
          payload,
          consumptionLogic,
          _context: (if include_context) // filePath:line\nmethod source
        })
```

**Part 2: Graph query for message broker listeners** (async, when include_context=true)
```
query = `
  MATCH (m:Method)
  WHERE m.annotations CONTAINS '@RabbitListener'
     OR m.annotations CONTAINS '@KafkaListener'
     OR m.annotations CONTAINS '@JmsListener'
  RETURN m.name, m.annotations, m.filePath, m.parameters, m.content
`

results = await executeQuery(repoId, query, {})

For each result:
  If includes @RabbitListener:
    topic = extractAttributeFromAnnotation(m.annotations, 'queues')
    payloadType = extractFirstParameterType(m.parameters)
  Else if includes @KafkaListener:
    topic = extractAttributeFromAnnotation(m.annotations, 'topics')
    payloadType = extractFirstParameterType(m.parameters)
  Else if includes @JmsListener:
    topic = extractAttributeFromAnnotation(m.annotations, 'destination')
    payloadType = extractFirstParameterType(m.parameters)
  
  consumptionLogic = extractClassMethodPair(m.filePath, m.name)
  
  inbound.push({
    topic,
    payload: payloadType,
    consumptionLogic,
    _context: (if include_context) // filePath:line\n{method header}
  })
```

**Signature Change:** `extractMessaging()` becomes async
```typescript
async function extractMessaging(
  chain: ChainNode[],
  includeContext: boolean,
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId?: string
): Promise<{
  outbound: MessagingOutbound[];
  inbound: MessagingInbound[];
}> {
  const inbound: MessagingInbound[] = [];
  const outbound = extractMessagingOutbound(chain, includeContext); // Existing logic
  
  // Part 1: Event listeners in chain
  for (const node of chain) {
    if (node.annotations) {
      const inboundFromChain = extractInboundFromChain(node);
      inbound.push(...inboundFromChain);
    }
  }
  
  // Part 2: Broker listeners via graph query
  if (includeContext && executeQuery && repoId) {
    const brokerListeners = await extractBrokerListeners(executeQuery, repoId);
    inbound.push(...brokerListeners);
  }
  
  return { outbound, inbound };
}
```

**Update call site in `buildDocumentation()`:**
```typescript
// OLD:
const { outbound, inbound } = extractMessaging(chain, includeContext);

// NEW (make the function call await):
const { outbound, inbound } = await extractMessaging(
  chain,
  includeContext,
  executeQuery,
  repoId
);
```

### 3c. _context Behavior (include_context=true)

**For event listeners in chain:**
```json
{
  "topic": "TODO_AI_ENRICH",
  "payload": "HoldCreatedEvent",
  "consumptionLogic": "OnHoldCreatedEventListener.onHoldCreated()",
  "_context": "// src/listener/OnHoldCreatedEventListener.java:42\npublic void onHoldCreated(HoldCreatedEvent event) {"
}
```

**For broker listeners from graph query:**
```json
{
  "topic": "treasury-commands",
  "payload": "SetCashAvailableCommand",
  "consumptionLogic": "EventQueueListener.processQueueMessage()",
  "_context": "// src/listener/EventQueueListener.java:50-65\n@KafkaListener(topics=\"treasury-commands\")\npublic void processQueueMessage(SetCashAvailableCommand cmd) {..."
}
```

### 3d. Limitations

- **Topic inference:** Topic names from `@EventListener` cannot be inferred (listeners don't specify topic). Emit `topic: "TODO_AI_ENRICH"` and rely on AI enrichment.
- **Consumer group discovery:** Message broker listeners may be scattered across services. Graph query only returns listeners in the indexed service.
- **Async event publishers:** In-process event publishing via `ApplicationEventPublisher.publishEvent()` is hard to correlate with listeners without dataflow analysis.
- **Dynamic topic names:** Topics defined as constants or properties are not resolved.

---

### 4. externalDependencies.messaging.outbound (gaps)

**Current:** Only `rabbitTemplate.convertAndSend()` and generic `.send()` are detected.

**Gaps to fill:** Add detection for Kafka, Spring Event Publishing, and Stream Bridge patterns.

**Implementation:** In `trace-executor.ts extractMetadata()`, add new regex patterns and detection logic.

### 4a. New Patterns for Outbound Messaging

| Pattern | Example | Detection |
|---------|---------|-----------|
| Kafka | `kafkaTemplate.send("topic", message)` | New pattern: `/kafkaTemplate\\.send/` |
| Kafka w/ ProducerRecord | `kafkaTemplate.send(new ProducerRecord<>("topic", msg))` | Regex: `/kafkaTemplate\\.send\\s*\\(\\s*new\\s+ProducerRecord/ OR topic in param1` |
| Spring Events | `applicationEventPublisher.publishEvent(new OrderEvent())` | Enhanced: `/publishEvent\\s*\\(\\s*new\\s+(\\w+Event)/ → extract topic from event class name` |
| Stream Bridge | `streamBridge.send("binding", message)` | New pattern: `/streamBridge\\.send/ → first arg is binding name` |

### 4b. Algorithm Updates for trace-executor.ts

**Current code (line ~140):**
```typescript
const TOPIC_LITERAL_PATTERN = /convertAndSend\s*\(\s*"([^"]{1,100})/g;
const TOPIC_VAR_PATTERN = /convertAndSend\s*\(\s*(\w+)/g;
```

**Add new patterns:**
```typescript
// Kafka template patterns
const KAFKA_TOPIC_LITERAL = /kafkaTemplate\.send\s*\(\s*"([^"]{1,100})/g;
const KAFKA_TOPIC_VAR = /kafkaTemplate\.send\s*\(\s*(\w+)/g;
const KAFKA_PRODUCER_RECORD = /kafkaTemplate\.send\s*\(\s*new\s+ProducerRecord<[^>]*>\s*\(\s*"([^"]{1,100})/g;

// Spring event publishing
const SPRING_EVENT_PATTERN = /publishEvent\s*\(\s*new\s+(\w+Event)/g;

// Stream Bridge
const STREAM_BRIDGE_BINDING = /streamBridge\.send\s*\(\s*"([^"]{1,100})/g;
const STREAM_BRIDGE_VAR = /streamBridge\.send\s*\(\s*(\w+)/g;
```

**Update extractMetadata() function:**
```typescript
function extractMetadata(content: string | undefined): ChainNode['metadata'] {
  // ... existing code ...
  
  // Extract Kafka topics (literal)
  KAFKA_TOPIC_LITERAL.lastIndex = 0;
  let match;
  while ((match = KAFKA_TOPIC_LITERAL.exec(content)) !== null) {
    const topic = match[1];
    if (!metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'kafkaTemplate.send')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: false,
        callerMethod: 'kafkaTemplate.send',
      });
    }
  }
  
  // Extract Kafka topics (variable)
  KAFKA_TOPIC_VAR.lastIndex = 0;
  while ((match = KAFKA_TOPIC_VAR.exec(content)) !== null) {
    const topicVar = match[1];
    if (!topicVar.startsWith('"') && !topicVar.startsWith("'")) {
      if (!metadata.messagingDetails.some(d => d.topic === topicVar && d.callerMethod === 'kafkaTemplate.send')) {
        metadata.messagingDetails.push({
          topic: topicVar,
          topicIsVariable: true,
          callerMethod: 'kafkaTemplate.send',
        });
      }
    }
  }
  
  // Extract Spring events
  SPRING_EVENT_PATTERN.lastIndex = 0;
  while ((match = SPRING_EVENT_PATTERN.exec(content)) !== null) {
    const eventClass = match[1];
    // Derive topic from event class name: OrderCreatedEvent → order-created or orderCreated
    const topic = camelCaseToKebab(eventClass.replace(/Event$/, ''));
    if (!metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'publishEvent')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: false,
        callerMethod: 'publishEvent',
      });
    }
  }
  
  // Extract Stream Bridge bindings
  STREAM_BRIDGE_BINDING.lastIndex = 0;
  while ((match = STREAM_BRIDGE_BINDING.exec(content)) !== null) {
    const binding = match[1];
    if (!metadata.messagingDetails.some(d => d.topic === binding && d.callerMethod === 'streamBridge.send')) {
      metadata.messagingDetails.push({
        topic: binding,
        topicIsVariable: false,
        callerMethod: 'streamBridge.send',
      });
    }
  }
  
  // ... rest of function ...
}
```

### 4c. Example Outbound Extractions

**Input code:**
```java
@PostMapping("/orders")
public void createOrder(@RequestBody OrderRequest req) {
  // Kafka
  kafkaTemplate.send("order.created", createEvent(req));
  
  // Spring events
  applicationEventPublisher.publishEvent(new OrderProcessedEvent(req));
  
  // Stream Bridge
  streamBridge.send("payment-channel", new PaymentRequest(req.amount));
  
  // Rabbit (existing)
  rabbitTemplate.convertAndSend("order-queue", req);
}
```

**Output (without include_context):**
```json
{
  "messaging": {
    "outbound": [
      {
        "topic": "order.created",
        "payload": "TODO_AI_ENRICH",
        "trigger": "TODO_AI_ENRICH",
        "callerMethod": "kafkaTemplate.send"
      },
      {
        "topic": "order-processed",
        "payload": "TODO_AI_ENRICH",
        "trigger": "TODO_AI_ENRICH",
        "callerMethod": "publishEvent"
      },
      {
        "topic": "payment-channel",
        "payload": "TODO_AI_ENRICH",
        "trigger": "TODO_AI_ENRICH",
        "callerMethod": "streamBridge.send"
      },
      {
        "topic": "order-queue",
        "payload": "TODO_AI_ENRICH",
        "trigger": "TODO_AI_ENRICH",
        "callerMethod": "convertAndSend"
      }
    ]
  }
}
```

---

## _context Convention

The `_context` field is a metadata enrichment mechanism for AI-powered documentation generation.

**Behavior:**

- **Gated by `include_context=true` flag** — omitted when `include_context=false`
- **Format:** String field containing source location + code snippet
  - Pattern: `// filePath:lineNumber[-endLineNumber]\n{code snippet (0-300 chars)}`
  - Example: `// src/dto/UserDto.java:42\n@NotNull @Email private String email;`
- **Purpose:**
  - AI enrichment pass can analyze raw source code + context to populate `description`, `rules`, `consumptionLogic` fields
  - Eliminates need for complex NLP — AI sees actual annotation text and variable names
  - Acts as "training data" for AI to infer semantic meaning

**Examples:**

| Scenario | _context | AI Enrichment Target |
|----------|----------|---------------------|
| Empty `description` on param | `// src/BondHoldController.java:42\n@PathVariable Long bondId` | Populate `description: "Bond identifier"` based on variable name + context |
| Empty `rules` on validation | `// src/dto/HoldDto.java:50\n@Size(min=1, max=100) String remarks` | Populate `rules: "Size: min=1, max=100"` + infer meaning |
| `TODO_AI_ENRICH` payload | `// src/service/HoldService.java:120\nTcbsValidator.doValidate(request, context);` | AI analyzes call to infer what request fields are validated, populate `field` and `rules` |
| Empty `consumptionLogic` | `// src/listener/HoldEventListener.java:60\npublic void onHoldApproved(HoldApprovedEvent evt) { holdService.process(evt); }` | Populate `consumptionLogic: "HoldEventListener.onHoldApproved() → HoldService.process()"` |

---

## Known Limitations

### Parameters (specs.request.params)

- **Unannotated DTO parameters** (bean-style `@ModelAttribute` without explicit annotation) are not extractable statically. Requires bean resolver analysis.
- **Parameter name extraction from compiled bytecode:** If source is unavailable, parameter names may be `arg0`, `arg1`, etc.

### Validation (specs.request.validation)

- **Imperative validation** (business-logic validation in service layer, e.g., `TcbsValidator.doValidate()`) is not statically extractable. Emitted as `TODO_AI_ENRICH` placeholders with `_context` for AI enrichment.
- **External validation frameworks** in third-party JARs may not be detected.
- **Cross-field validation** (e.g., "field A required if field B is present") not statically determinable.
- **Database constraint validation** (unique constraints, foreign keys) requires runtime analysis.

### Messaging Inbound (externalDependencies.messaging.inbound)

- **Topic inference from @EventListener:** Event listeners don't specify topic names. Emitted as `topic: "TODO_AI_ENRICH"` and require AI enrichment by analyzing listener semantics.
- **In-process event publishing correlations:** Difficult to correlate `ApplicationEventPublisher.publishEvent(FooEvent)` with `@EventListener void onFooEvent(FooEvent e)` without dataflow analysis.
- **Distributed messaging:** Graph query only returns listeners in the indexed service. Cross-service subscriptions not visible.
- **Dynamic topic names:** Topics/queues defined as properties or constants are not statically resolved.

### Messaging Outbound (externalDependencies.messaging.outbound)

- **Dynamic topic names:** Topics in variables or constants require constant resolution (planned for future enhancement).
- **Parameterized kafkaTemplate.send():** Topics passed as method parameters require dataflow analysis.

---

## Business Rules

### Parameter Extraction

1. **@PathVariable always required** — URI template segments cannot be optional in REST semantics
2. **@RequestParam defaults to required=true** — unless explicitly `required=false`
3. **@RequestHeader defaults to required=true** — unless explicitly `required=false`
4. **Framework-injected types skipped** — `HttpServletRequest`, `Model`, `Principal`, custom resolvers like `TcbsJWT` are filtered out

### Validation Rule Extraction

1. **Presence of @NotNull/@NotBlank/@NotEmpty sets required=true**
2. **Multiple validation annotations combined with commas** — e.g., `@NotNull @Size(min=1, max=100)` → `rules: "NotNull, Size: min=1, max=100"`
3. **Rules extracted from ALL annotations** — not just first match
4. **Nested field validation:** If `@RequestBody UserDto` has field `user` with nested `Email` class, validation rules for `user.email` included as separate entries

### Messaging Detection

1. **Outbound:** Only explicit template calls detected (rabbitTemplate, kafkaTemplate, streamBridge, publishEvent)
2. **Inbound:** Only listeners with `@EventListener`, `@TransactionalEventListener`, `@RabbitListener`, `@KafkaListener`, `@JmsListener` detected
3. **Deduplication:** Multiple identical messaging calls to same topic → single entry in array

---

## Notes

### Edge Cases

**Annotation attribute parsing:**
- Complex attributes like `@RequestParam(defaultValue = SomeConstant.VALUE)` → skip enrichment
- Nested annotations like `@Constraint(validatedBy = {MyValidator.class})` → emit rule, skip nested class analysis

**Type resolution:**
- Generic types like `List<User>` → inner type `User` resolved for validation
- Wrapper types like `Optional<Integer>` → unwrapped to `Integer` for validation
- Unknown types → include in output but mark source as 'external'

**Messaging correlation:**
- If `publishEvent(new HoldEvent())` and `@EventListener void onHoldEvent(HoldEvent)` found → same topic inferred by AI enrichment, not automated
- `applicationEventPublisher` may be injected or autowired — both forms detected

### Performance Considerations

- **Graph query for inbound listeners:** One async Cypher query per endpoint (include_context=true only)
- **Annotation parsing:** Regex extraction scales O(n) with content length, acceptable for single-endpoint docs
- **Field resolution:** Nested DTO field resolution limited to 3-level depth to avoid circular references

### Testing Strategy

See `gitnexus/test/unit/document-endpoint.test.ts` for unit tests:
- Parameter extraction from handler.parameters JSON
- Validation rule parsing from @Xxx annotations
- Outbound messaging detection from trace metadata
- _context field inclusion when include_context=true
- Error handling for invalid JSON, missing schema, graph query failures

---

## Implementation Files

**Modified:**
- `gitnexus/src/mcp/local/document-endpoint.ts`
  - Add `extractRequestParams(handler, includeContext)` function
  - Add `extractValidationRules(handler, bodySchema, chain, includeContext)` function
  - Update `extractMessaging()` to be async and add inbound detection
  - Update `buildDocumentation()` to await extractMessaging

- `gitnexus/src/mcp/local/trace-executor.ts`
  - Add `KAFKA_TOPIC_LITERAL`, `KAFKA_TOPIC_VAR`, `KAFKA_PRODUCER_RECORD` patterns
  - Add `SPRING_EVENT_PATTERN`, `STREAM_BRIDGE_BINDING`, `STREAM_BRIDGE_VAR` patterns
  - Update `extractMetadata()` to process new patterns
  - Add helper: `camelCaseToKebab(str)` for event class → topic conversion

**New (test files):**
- `gitnexus/test/unit/document-endpoint.test.ts` — add test cases for params, validation, inbound messaging
- `gitnexus/test/unit/trace-executor.test.ts` — add test cases for new Kafka/Spring Event/Stream Bridge patterns

---

## Acceptance Criteria

1. `specs.request.params` populated with all annotated parameters (path, query, header, cookie)
2. `specs.request.validation` populated with all validation rules from annotations and request body fields
3. `externalDependencies.messaging.inbound` populated with event listeners and broker consumers
4. `externalDependencies.messaging.outbound` extended with Kafka, Spring Events, Stream Bridge patterns
5. All `_context` fields correctly formatted and populated when `include_context=true`
6. Unit tests pass for all extraction algorithms
7. Backward compatibility: existing outputs (summary, downstreamApis, persistence) unchanged
