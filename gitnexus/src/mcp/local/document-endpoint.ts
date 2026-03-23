/**
 * Document Endpoint Tool
 *
 * Generates API documentation JSON from the GitNexus knowledge graph.
 * Supports two modes:
 * - Minimal (default): Schema-valid JSON with TODO_AI_ENRICH placeholders
 * - Context-enriched: Same JSON + _context fields with source snippets
 */

import type { RepoHandle } from './local-backend.js';
import { executeParameterized } from '../core/lbug-adapter.js';
import { executeTrace, type ChainNode } from './trace-executor.js';
import { queryEndpoints, type EndpointInfo } from './endpoint-query.js';
import { generateId } from '../../lib/utils.js';

// ============================================================================
// Types
// ============================================================================

export interface DocumentEndpointOptions {
  method: string;
  path: string;
  depth?: number;
  include_context?: boolean;
  repo?: string;
}

export interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ValidationRule {
  field: string;
  type: string;
  required: boolean;
  rules: string;
}

export interface ResponseCode {
  code: number;
  description: string;
}

export interface BodySchema {
  typeName: string;
  source: 'indexed' | 'external' | 'primitive';
  fields?: Array<{ name: string; type: string; annotations: string[] }>;
}

export interface DownstreamApi {
  serviceName: string;
  endpoint: string;
  condition: string;
  purpose: string;
  _context?: string;
  resolvedUrl?: string;
  resolutionDetails?: {
    serviceField?: string;
    serviceValue?: string;
    pathConstants?: { name: string; value: string }[];
  };
}

export interface MessagingOutbound {
  topic: string;
  payload: string;
  trigger: string;
  _context?: string;
}

export interface MessagingInbound {
  topic: string;
  payload: string;
  consumptionLogic: string;
}

export interface PersistenceInfo {
  database: string;
  tables: string;
  storedProcedures: string;
}

export interface CacheStrategy {
  population: Array<{
    cacheName: string;
    keyPattern: string;
    ttl: string;
    trigger: string;
  }>;
  invalidation: Array<{
    cacheName: string;
    strategy: string;
    trigger: string;
  }>;
  update: Array<{
    cacheName: string;
    strategy: string;
    trigger: string;
  }>;
  flow: string;
}

export interface RetryLogic {
  operation: string;
  maxAttempts: string;
  backoff: string;
  recovery: string;
}

export interface KeyDetails {
  transactionManagement: string[];
  businessRules: string[];
  security: string[];
}

export interface DocumentEndpointResult {
  method: string;
  path: string;
  summary: string;
  specs: {
    request: {
      params: ParamInfo[];
      body: Record<string, unknown> | BodySchema | null;
      validation: ValidationRule[];
    };
    response: {
      body: Record<string, unknown> | BodySchema | null;
      codes: ResponseCode[];
    };
  };
  externalDependencies: {
    downstreamApis: DownstreamApi[];
    messaging: {
      outbound: MessagingOutbound[];
      inbound: MessagingInbound[];
    };
    persistence: PersistenceInfo[];
  };
  logicFlow: string;
  codeDiagram: string;
  cacheStrategy: CacheStrategy;
  retryLogic: RetryLogic[];
  keyDetails: KeyDetails;
  _context?: {
    summaryContext?: string;
    callChain?: ChainNode[];
    resolvedProperties?: Record<string, string>;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fallback handler search when Route nodes don't exist.
 * Searches for Java methods with @XxxMapping annotations matching the path.
 */
async function findHandlerByPathPattern(
  repo: RepoHandle,
  method: string,
  pathPattern: string
): Promise<EndpointInfo | undefined> {
  // Query for Method nodes with request mapping annotations in content
  const cypher = `
    MATCH (m:Method)
    WHERE m.filePath CONTAINS 'Controller'
      AND m.content CONTAINS $mappingAnnotation
      AND m.content CONTAINS $pathFragment
    RETURN m.name AS handler,
           m.filePath AS filePath,
           m.startLine AS line,
           m.content AS content
    LIMIT 20
  `;

  // Try different mapping annotations based on HTTP method
  const methodToAnnotation: Record<string, string[]> = {
    'GET': ['GetMapping', 'RequestMapping'],
    'POST': ['PostMapping', 'RequestMapping'],
    'PUT': ['PutMapping', 'RequestMapping'],
    'DELETE': ['DeleteMapping', 'RequestMapping'],
    'PATCH': ['PatchMapping', 'RequestMapping'],
  };

  const upperMethod = method.toUpperCase();
  const annotations = methodToAnnotation[upperMethod] || ['Mapping'];
  const paths = pathPattern.split('/').filter(p => p.length > 0);

  // Collect all candidates with their scores
  interface Candidate {
    handler: string;
    filePath: string;
    line: number;
    content: string;
    score: number;
    annotationPath?: string;  // Extracted path from annotation
  }
  const candidates: Candidate[] = [];

  for (const annotation of annotations) {
    // Try each path segment as a fragment
    for (const pathFrag of paths) {
      if (pathFrag.length < 2) continue;

      try {
        const rows = await executeParameterized(repo.id, cypher, {
          mappingAnnotation: annotation,
          pathFragment: pathFrag,
        });

        if (rows && rows.length > 0) {
          for (const row of rows) {
            const handler = row.handler ?? row[0];
            const filePath = row.filePath ?? row[1];
            const line = row.line ?? row[2];
            const content = row.content ?? row[3] ?? '';

            // Score this candidate
            let score = 0;

            // Check for HTTP method specification in annotation
            // @PutMapping gets +150, @RequestMapping(method = PUT) gets +140
            const hasSpecificAnnotation = new RegExp(`@${upperMethod}Mapping`, 'i').test(content);
            const hasMethodAttribute = new RegExp(`@RequestMapping[^)]*method\\s*=\\s*RequestMethod\\.${upperMethod}`, 'i').test(content);
            
            if (hasSpecificAnnotation) score += 150;
            else if (hasMethodAttribute) score += 140;
            else if (annotation === 'RequestMapping') score -= 50; // Generic RequestMapping without method

            // Extract the path from the annotation
            const pathMatch = content.match(new RegExp(`@(?:${upperMethod}Mapping|RequestMapping)\\s*\\(\\s*[^)]*value\\s*=\\s*["']([^"']+)["']`, 'i'))
              || content.match(new RegExp(`@(?:${upperMethod}Mapping|RequestMapping)\\s*\\(\\s*["']([^"']+)["']`, 'i'));
            
            // Store extracted path for returning in result
            const annotationPath = pathMatch ? pathMatch[1] : undefined;
            
            if (pathMatch) {
              // Check if path ends with key segments
              const lastPathSegment = paths[paths.length - 1];
              if (annotationPath!.includes(lastPathSegment)) score += 100;
              
              // Check for exact suffix match (ignoring class-level prefix)
              const searchSuffix = '/' + paths.slice(-2).join('/');
              if (annotationPath!.endsWith(searchSuffix) || annotationPath === '/' + paths[paths.length - 1]) {
                score += 200;
              }
              
              // Penalize length difference
              const lengthDiff = Math.abs(annotationPath!.length - pathPattern.length);
              score -= Math.min(lengthDiff, 50); // Cap penalty
            }

            // Bonus if method name hints at HTTP operation
            const methodHints: Record<string, string[]> = {
              'PUT': ['unhold', 'update', 'put', 'edit', 'modify', 'replace'],
              'POST': ['create', 'add', 'post', 'save', 'insert', 'new'],
              'GET': ['get', 'find', 'list', 'search', 'query', 'fetch', 'read'],
              'DELETE': ['delete', 'remove', 'destroy'],
              'PATCH': ['patch', 'partial'],
            };
            const hints = methodHints[upperMethod] || [];
            const handlerLower = handler.toLowerCase();
            for (const hint of hints) {
              if (handlerLower.includes(hint)) {
                score += 30;
                break;
              }
            }

            // Check for external/internal controller distinction
            // External APIs typically have "Ext", "PioExt", "External" in file path
            // Internal APIs typically have "Internal" in file path
            const isExternal = filePath.toLowerCase().includes('ext') || 
                               filePath.toLowerCase().includes('external') ||
                               filePath.toLowerCase().includes('pio');
            const isInternal = filePath.toLowerCase().includes('internal');
            
            // Check if search path suggests external vs internal
            const searchPathLower = pathPattern.toLowerCase();
            const suggestsExternal = searchPathLower.includes('/e/') || 
                                     searchPathLower.includes('/external/') ||
                                     searchPathLower.startsWith('/e');
            const suggestsInternal = searchPathLower.includes('/i/') || 
                                     searchPathLower.includes('/internal/') ||
                                     searchPathLower.startsWith('/i');
            
            // Boost score for matching controller type
            if (isExternal && suggestsExternal) score += 80;
            if (isInternal && suggestsInternal) score += 80;
            if (isExternal && suggestsInternal) score -= 50; // Mismatch penalty
            if (isInternal && suggestsExternal) score -= 50; // Mismatch penalty

            // Deduplicate by handler + filePath
            if (!candidates.some(c => c.handler === handler && c.filePath === filePath)) {
              candidates.push({ handler, filePath, line, content, score, annotationPath });
            }
          }
        }
      } catch (e) {
        // Continue to next pattern on error
        continue;
      }
    }
  }

  // Sort by score (highest first) and return best match
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return {
    method: method.toUpperCase(),
    path: best.annotationPath || pathPattern,
    handler: best.handler,
    filePath: best.filePath,
    line: best.line,
  };
}

// ============================================================================
// Main Function
// ============================================================================

export async function documentEndpoint(
  repo: RepoHandle,
  options: DocumentEndpointOptions
): Promise<{ result: DocumentEndpointResult; error?: string }> {
  const { method, path, depth = 10, include_context = false } = options;

  // Step 1: Try to find the Route node (may fail if Route table doesn't exist)
  let route: EndpointInfo | undefined;
  
  try {
    const endpointsResult = await queryEndpoints(repo, { method, path });
    if (endpointsResult.endpoints && endpointsResult.endpoints.length > 0) {
      // Take the first match (most relevant)
      route = endpointsResult.endpoints[0];
    }
  } catch (err: any) {
    // Route table may not exist yet — fall back to handler search
  }

  // Fallback: If no Route nodes exist, search for handler methods directly
  if (!route) {
    const fallbackResult = await findHandlerByPathPattern(repo, method, path);
    if (fallbackResult) {
      route = fallbackResult;
    } else {
      return {
        result: createEmptyResult(method, path),
        error: `No endpoint found for ${method} ${path}`,
      };
    }
  }

  // Construct the handler UID from route info
  // Format: Method:filePath:methodName
  const handlerUid = route.handler && route.filePath
    ? generateId('Method', `${route.filePath}:${route.handler}`)
    : undefined;

  if (!handlerUid) {
    return {
      result: createEmptyResult(method, path),
      error: `Could not construct handler UID for route at ${route.filePath}:${route.line}`,
    };
  }

  // Step 2: Build the executeQuery function from repo
  const executeQuery = async (_repoId: string, query: string, params: Record<string, any>) => {
    return executeParameterized(repo.id, query, params);
  };

  // Step 3: Trace the handler method
  const traceResult = await executeTrace(
    executeQuery,
    repo.id,
    { uid: handlerUid, maxDepth: depth, include_content: true }
  );

  if (traceResult.error) {
    return {
      result: createEmptyResult(method, path),
      error: traceResult.error,
    };
  }

  // Step 4: Build the documentation
  // Use route.path (actual endpoint path) instead of input pattern
  const result = await buildDocumentation(method, route.path, route, traceResult.chain, include_context, executeQuery, repo.id);

  return { result };
}

// ============================================================================
// Helper Functions
// ============================================================================

function createEmptyResult(method: string, path: string): DocumentEndpointResult {
  return {
    method,
    path,
    summary: 'TODO_AI_ENRICH',
    specs: {
      request: {
        params: [],
        body: null,
        validation: [],
      },
      response: {
        body: null,
        codes: [{ code: 200, description: 'Success' }],
      },
    },
    externalDependencies: {
      downstreamApis: [],
      messaging: { outbound: [], inbound: [] },
      persistence: [],
    },
    logicFlow: 'TODO_AI_ENRICH',
    codeDiagram: '',
    cacheStrategy: { population: [], invalidation: [], update: [], flow: '' },
    retryLogic: [],
    keyDetails: { transactionManagement: [], businessRules: [], security: [] },
  };
}

async function buildDocumentation(
  method: string,
  path: string,
  route: EndpointInfo,
  chain: ChainNode[],
  includeContext: boolean,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string
): Promise<DocumentEndpointResult> {
  const result = createEmptyResult(method, path);

  // Extract HTTP calls for downstreamApis
  const downstreamApis = await extractDownstreamApis(chain, executeQuery, repoId, includeContext);
  
  // Filter internal fields for schema compliance when includeContext is false
  if (includeContext) {
    result.externalDependencies.downstreamApis = downstreamApis;
  } else {
    // Remove internal enrichment fields for schema-compliant output
    result.externalDependencies.downstreamApis = downstreamApis.map(api => ({
      serviceName: api.serviceName,
      endpoint: api.endpoint,
      condition: api.condition,
      purpose: api.purpose,
    }));
  }

  // Extract messaging for outbound/inbound
  const { outbound, inbound } = extractMessaging(chain, includeContext);
  result.externalDependencies.messaging.outbound = outbound;
  result.externalDependencies.messaging.inbound = inbound;

  // Extract persistence (repository calls)
  const persistence = extractPersistence(chain);
  result.externalDependencies.persistence = persistence;

  // Extract exceptions for response codes
  const exceptionCodes = extractExceptionCodes(chain);
  result.specs.response.codes = [
    { code: 200, description: 'Success' },
    ...exceptionCodes,
  ];

  // Extract annotations for keyDetails
  const { transaction, retry, security } = extractAnnotations(chain);
  result.keyDetails.transactionManagement = transaction;
  result.retryLogic = retry;
  result.keyDetails.security = security;

  // Extract request and response body schemas
  const { requestBody, responseBody } = await extractBodySchemas(chain, executeQuery, repoId);

  // Convert to JSON example for schema-compliant output
  // When includeContext is true, keep full BodySchema for AI enrichment
  // When includeContext is false, output JSON example or null
  if (includeContext) {
    result.specs.request.body = requestBody;
    result.specs.response.body = responseBody;
  } else {
    result.specs.request.body = bodySchemaToJsonExample(requestBody);
    result.specs.response.body = bodySchemaToJsonExample(responseBody);
  }

  // Generate code diagram
  result.codeDiagram = generateCodeDiagram(chain);

  // Generate logic flow placeholder
  result.logicFlow = 'TODO_AI_ENRICH';

  // Add context if requested
  if (includeContext) {
    result._context = {
      callChain: chain,
      resolvedProperties: {},
    };
    result._context.summaryContext = `Handler: ${route.controller}.${route.handler}() → Chain: ${chain.map(n => n.name).join(' → ')}`;
  }

  return result;
}

async function extractDownstreamApis(
  chain: ChainNode[],
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  includeContext: boolean
): Promise<DownstreamApi[]> {
  const apis: DownstreamApi[] = [];
  const seen = new Set<string>();

  for (const node of chain) {
    for (const detail of node.metadata.httpCallDetails) {
      const key = `${detail.httpMethod}:${detail.urlExpression}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Parse URL expression to extract components
      const parsed = parseUrlExpression(detail.urlExpression);

      // Find enclosing class for field resolution
      const className = await findEnclosingClass(executeQuery, repoId, node.filePath);

      // Resolve service variable if present
      let serviceValue: string | null = null;
      let propertyKey: string | null = null;

      if (parsed.serviceName && className) {
        // Try to resolve @Value annotation for the service field
        const resolved = await resolveValueAnnotation(executeQuery, repoId, className, parsed.serviceName + 'Service');
        if (resolved.propertyKey) {
          propertyKey = resolved.propertyKey;
          serviceValue = resolved.rawValue;
        }
      }

      // Resolve URI constants
      const pathConstants: { name: string; value: string }[] = [];
      for (const varRef of parsed.variableRefs) {
        if (className) {
          const value = await resolveStaticFieldValue(executeQuery, repoId, className, varRef);
          if (value) {
            pathConstants.push({ name: varRef, value });
          }
        }
      }

      // Build resolved URL
      let resolvedUrl = detail.urlExpression;
      if (pathConstants.length > 0) {
        // Replace constant references with their values
        for (const pc of pathConstants) {
          resolvedUrl = resolvedUrl.replace(new RegExp(`\\b${pc.name}\\b`, 'g'), pc.value);
        }
      }

      // Determine service name
      const serviceName = propertyKey || parsed.serviceName || 'unknown-service';

      // Build endpoint string - simplified: HTTP_METHOD + /path
      let endpoint: string;
      if (pathConstants.length > 0) {
        // Use resolved path constant
        endpoint = `${detail.httpMethod} ${pathConstants[0].value}`;
      } else if (parsed.staticParts.length > 0) {
        // Use static parts if available
        endpoint = `${detail.httpMethod} ${parsed.staticParts.join('')}`;
      } else {
        // Fall back to original expression
        endpoint = `${detail.httpMethod} ${detail.urlExpression}`;
      }

      apis.push({
        serviceName,
        endpoint,
        condition: 'TODO_AI_ENRICH',
        purpose: 'TODO_AI_ENRICH',
        resolvedUrl: resolvedUrl !== detail.urlExpression ? resolvedUrl : undefined,
        resolutionDetails: (propertyKey || pathConstants.length > 0) ? {
          serviceField: parsed.serviceName ? parsed.serviceName + 'Service' : undefined,
          serviceValue: serviceValue || undefined,
          pathConstants: pathConstants.length > 0 ? pathConstants : undefined,
        } : undefined,
        ...(includeContext && {
          _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content?.slice(0, 200)}...`,
        }),
      });
    }
  }

  return apis;
}

function extractServiceName(urlExpression: string): string {
  // Try to extract service name from variable like ${bondSettlementService}
  const varMatch = urlExpression.match(/\$\{?(\w+)Service\}?/);
  if (varMatch) {
    const name = varMatch[1];
    // Convert camelCase to kebab-case
    return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }
  // Try to extract from URL path
  const pathMatch = urlExpression.match(/:\/\/([^/:]+)/);
  if (pathMatch) {
    return pathMatch[1].replace(/\./g, '-');
  }
  return 'unknown-service';
}

/**
 * Parse a URL expression to extract service references and constants.
 * 
 * Examples:
 * - "bondSettlementService.concat(HOLD_UNHOLD_USED_LIMIT_URI)" 
 *   -> { serviceName: "bondSettlementService", variableRefs: ["HOLD_UNHOLD_USED_LIMIT_URI"], staticParts: [] }
 * - "${serviceUrl}/api/v1" 
 *   -> { serviceName: null, variableRefs: ["serviceUrl"], staticParts: ["/api/v1"] }
 * - "http://api.example.com/v1" + path 
 *   -> { serviceName: null, variableRefs: [], staticParts: ["http://api.example.com/v1"] }
 */
function parseUrlExpression(urlExpression: string): {
  serviceName: string | null;
  variableRefs: string[];
  staticParts: string[];
} {
  const result = {
    serviceName: null as string | null,
    variableRefs: [] as string[],
    staticParts: [] as string[],
  };

  // Pattern: xxxService or ${xxx}Service
  const serviceMatch = urlExpression.match(/(\$\{)?(\w+)Service\}?/);
  if (serviceMatch) {
    result.serviceName = serviceMatch[2]; // Just the base name without 'Service'
  }

  // Extract string literals (static parts)
  const stringMatches = urlExpression.matchAll(/"([^"]+)"|'([^']+)'/g);
  for (const match of stringMatches) {
    const str = match[1] || match[2];
    if (str) result.staticParts.push(str);
  }

  // Extract variable references (UPPER_CASE constants or camelCase variables)
  // Exclude keywords and the 'Service' suffix variable
  const keywords = new Set(['if', 'else', 'for', 'while', 'return', 'new', 'null', 'true', 'false']);
  const allRefs = urlExpression.match(/\b[A-Z_][A-Z0-9_]*\b|\b[a-z][a-zA-Z0-9]*\b/g) || [];
  for (const ref of allRefs) {
    if (!keywords.has(ref) && !ref.endsWith('Service') && !result.variableRefs.includes(ref)) {
      result.variableRefs.push(ref);
    }
  }

  return result;
}

/**
 * Resolve a static final field's value from a class.
 * Returns the literal value if the field is static final, null otherwise.
 */
async function resolveStaticFieldValue(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  className: string,
  fieldName: string
): Promise<string | null> {
  const query = `
    MATCH (c:Class)
    WHERE c.name = $className OR c.name ENDS WITH $classNamePattern
    RETURN c.fields AS fields
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, {
      className,
      classNamePattern: '.' + className
    });

    if (rows.length === 0) return null;

    const fieldsJson = rows[0].fields || rows[0][0];
    if (!fieldsJson) return null;

    const fields = JSON.parse(fieldsJson);
    const field = fields.find((f: any) => f.name === fieldName);

    // Check if it's static final and has a value
    if (field?.modifiers?.includes('static') && field?.modifiers?.includes('final')) {
      return field.value || null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve @Value annotation attribute from a field.
 * Returns the property key like "service.url" from @Value("${service.url}").
 */
async function resolveValueAnnotation(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  className: string,
  fieldName: string
): Promise<{ propertyKey: string | null; rawValue: string | null }> {
  const query = `
    MATCH (c:Class)
    WHERE c.name = $className OR c.name ENDS WITH $classNamePattern
    RETURN c.fields AS fields
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, {
      className,
      classNamePattern: '.' + className
    });

    if (rows.length === 0) return { propertyKey: null, rawValue: null };

    const fieldsJson = rows[0].fields || rows[0][0];
    if (!fieldsJson) return { propertyKey: null, rawValue: null };

    const fields = JSON.parse(fieldsJson);
    const field = fields.find((f: any) => f.name === fieldName);

    if (field?.annotationAttrs) {
      const valueAnn = field.annotationAttrs.find((a: any) => a.name === '@Value');
      if (valueAnn?.attrs) {
        // attrs could be { "0": "${service.url}" } or { "value": "${service.url}" }
        const rawValue = valueAnn.attrs['0'] || valueAnn.attrs['value'];
        if (rawValue) {
          // Extract property key from ${...}
          const match = rawValue.match(/\$\{([^}]+)\}/);
          return {
            propertyKey: match ? match[1] : rawValue,
            rawValue
          };
        }
      }
    }

    return { propertyKey: null, rawValue: null };
  } catch {
    return { propertyKey: null, rawValue: null };
  }
}

/**
 * Find the class that contains a method at a given file path.
 */
async function findEnclosingClass(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  filePath: string
): Promise<string | null> {
  const query = `
    MATCH (c:Class)
    WHERE c.filePath = $filePath
    RETURN c.name AS name
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, { filePath });
    if (rows.length === 0) return null;
    return rows[0].name || rows[0][0];
  } catch {
    return null;
  }
}

/** Primitive and common types that don't need schema resolution */
const PRIMITIVE_TYPES = new Set([
  'String', 'string', 'Integer', 'int', 'Long', 'long', 'Double', 'double',
  'Float', 'float', 'Boolean', 'boolean', 'Void', 'void', 'Object', 'Object[]',
  'Map', 'List', 'Set', 'Optional', 'Iterable', 'Collection',
  'BigDecimal', 'BigInteger', 'Date', 'LocalDate', 'LocalDateTime',
  'Instant', 'ZonedDateTime', 'UUID', 'byte[]', 'Byte[]'
]);

/**
 * Extract request and response body schemas from the handler method's parameters and return type.
 */
async function extractBodySchemas(
  chain: ChainNode[],
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string
): Promise<{ requestBody: BodySchema | null; responseBody: BodySchema | null }> {
  // Find handler node (depth 0)
  const handler = chain.find(n => n.depth === 0);
  if (!handler) return { requestBody: null, responseBody: null };

  let requestBody: BodySchema | null = null;
  let responseBody: BodySchema | null = null;

  // Resolve @RequestBody parameter
  if (handler.parameters) {
    try {
      const params = JSON.parse(handler.parameters);
      const bodyParam = params.find((p: any) => p.annotations?.includes('@RequestBody'));
      if (bodyParam?.type) {
        requestBody = await resolveTypeSchema(bodyParam.type, executeQuery, repoId);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Resolve return type
  if (handler.returnType) {
    let returnType = handler.returnType;

    // Unwrap wrapper types like ResponseEntity<XXX>
    const wrapperMatch = returnType.match(/^(ResponseEntity|Result|Optional|Mono|Flux)<(.+)>$/);
    if (wrapperMatch) {
      returnType = wrapperMatch[2];
    }

    responseBody = await resolveTypeSchema(returnType, executeQuery, repoId);
  }

  return { requestBody, responseBody };
}

/**
 * Resolve a type name to its field schema.
 */
async function resolveTypeSchema(
  typeName: string,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  visited: Set<string> = new Set()
): Promise<BodySchema> {
  // Check for primitive types
  if (PRIMITIVE_TYPES.has(typeName)) {
    return { typeName, source: 'primitive', fields: undefined };
  }

  // Prevent circular references
  if (visited.has(typeName)) {
    return { typeName, source: 'external', fields: undefined };
  }
  visited.add(typeName);

  // Extract generic inner type if applicable
  const innerType = extractGenericInnerTypeLocal(typeName);
  if (innerType) {
    return resolveTypeSchema(innerType, executeQuery, repoId, visited);
  }

  // Query for class fields
  const query = `
    MATCH (c:Class)
    WHERE c.name = $typeName OR c.name ENDS WITH $typePattern
    RETURN c.name AS name, c.fields AS fields
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, {
      typeName,
      typePattern: '.' + typeName
    });

    if (rows.length === 0) {
      return { typeName, source: 'external', fields: undefined };
    }

    const fieldsJson = rows[0].fields || rows[0][1];
    if (!fieldsJson) {
      return { typeName, source: 'indexed', fields: undefined };
    }

    const fields = JSON.parse(fieldsJson);
    return {
      typeName: rows[0].name || typeName,
      source: 'indexed',
      fields: fields.map((f: any) => ({
        name: f.name,
        type: f.type,
        annotations: f.annotations || []
      }))
    };
  } catch {
    return { typeName, source: 'external', fields: undefined };
  }
}

/**
 * Extract inner type from generic wrapper (local version for body schema).
 */
function extractGenericInnerTypeLocal(typeName: string): string | null {
  if (typeName.endsWith('[]')) {
    return typeName.slice(0, -2);
  }

  const genericMatch = typeName.match(/<([^<>]+)>$/);
  if (genericMatch) {
    const inner = genericMatch[1];
    if (inner.includes(',')) {
      const parts = inner.split(',').map(s => s.trim());
      return parts[parts.length - 1];
    }
    return inner.trim();
  }

  return null;
}

function extractMessaging(chain: ChainNode[], includeContext: boolean): {
  outbound: MessagingOutbound[];
  inbound: MessagingInbound[];
} {
  const outbound: MessagingOutbound[] = [];
  const inbound: MessagingInbound[] = [];
  const seenOutbound = new Set<string>();

  for (const node of chain) {
    for (const detail of node.metadata.messagingDetails) {
      if (detail.topic && !seenOutbound.has(detail.topic)) {
        seenOutbound.add(detail.topic);
        outbound.push({
          topic: detail.topic,
          payload: 'TODO_AI_ENRICH',
          trigger: 'TODO_AI_ENRICH',
          ...(includeContext && {
            _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content?.slice(0, 200)}...`,
          }),
        });
      }
    }
  }

  return { outbound, inbound };
}

function extractPersistence(chain: ChainNode[]): PersistenceInfo[] {
  const tables = new Set<string>();
  const repos = new Set<string>();

  for (const node of chain) {
    for (const call of node.metadata.repositoryCalls) {
      repos.add(call);
      // Extract table/entity name from repository name
      const match = call.match(/(\w+)Repository\.(\w+)/);
      if (match) {
        tables.add(match[1]);
      }
    }
  }

  if (tables.size === 0 && repos.size === 0) {
    return [];
  }

  return [{
    database: 'TODO_AI_ENRICH',
    tables: Array.from(tables).join(', ') || 'None detected',
    storedProcedures: 'None detected',
  }];
}

function extractExceptionCodes(chain: ChainNode[]): ResponseCode[] {
  const codes: ResponseCode[] = [];
  const seen = new Set<string>();

  for (const node of chain) {
    for (const exc of node.metadata.exceptions) {
      const key = `${exc.exceptionClass}:${exc.errorCode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const description = exc.errorCode
        ? `${exc.exceptionClass}: ${exc.errorCode}`
        : exc.exceptionClass;

      codes.push({
        code: 400, // Default to 400 for business exceptions
        description,
      });
    }
  }

  return codes;
}

function extractAnnotations(chain: ChainNode[]): {
  transaction: string[];
  retry: RetryLogic[];
  security: string[];
} {
  const transaction: string[] = [];
  const retry: RetryLogic[] = [];
  const security: string[] = [];
  const seenTransaction = new Set<string>();
  const seenRetry = new Set<string>();

  for (const node of chain) {
    // From node.annotations JSON
    if (node.annotations) {
      try {
        const anns = JSON.parse(node.annotations);
        for (const ann of anns) {
          if (ann.name === '@Transactional') {
            const timeout = ann.attrs?.timeout;
            const key = `@Transactional${timeout ? `(timeout=${timeout})` : ''} on ${node.name}`;
            if (!seenTransaction.has(key)) {
              seenTransaction.add(key);
              transaction.push(key);
            }
          }
          if (ann.name === '@Retryable') {
            const maxAttempts = ann.attrs?.maxAttempts || '3';
            const backoff = ann.attrs?.backoff || '@Backoff(delay=1000)';
            const key = `${node.name}:${maxAttempts}`;
            if (!seenRetry.has(key)) {
              seenRetry.add(key);
              retry.push({
                operation: node.name,
                maxAttempts: String(maxAttempts),
                backoff: String(backoff),
                recovery: 'TODO_AI_ENRICH',
              });
            }
          }
          if (ann.name === '@PreAuthorize' || ann.name === '@Secured' || ann.name === '@RolesAllowed') {
            const key = `${ann.name} on ${node.name}`;
            if (!security.includes(key)) {
              security.push(key);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // From metadata.annotations (legacy format)
    for (const ann of node.metadata.annotations) {
      if (ann.startsWith('@Transactional')) {
        const key = `${ann} on ${node.name}`;
        if (!seenTransaction.has(key)) {
          seenTransaction.add(key);
          transaction.push(key);
        }
      }
    }
  }

  return { transaction, retry, security };
}

/**
 * Get example value for a type.
 */
function getExampleValue(type: string, annotations: string[]): unknown {
  // Handle primitive types
  if (type === 'String' || type === 'string') {
    return 'string';
  }
  if (type === 'Integer' || type === 'int' || type === 'Long' || type === 'long') {
    return 0;
  }
  if (type === 'Double' || type === 'double' || type === 'Float' || type === 'float' || type === 'BigDecimal') {
    return 0.0;
  }
  if (type === 'Boolean' || type === 'boolean') {
    return false;
  }
  if (type === 'BigInteger') {
    return 0;
  }
  if (type === 'LocalDate' || type === 'Date' || type === 'Instant') {
    return '2024-01-01';
  }
  if (type === 'LocalDateTime' || type === 'ZonedDateTime' || type === 'Timestamp') {
    return '2024-01-01T00:00:00';
  }
  if (type === 'List' || type === 'Set' || type.endsWith('[]')) {
    return [];
  }
  if (type === 'Map' || type === 'Object') {
    return {};
  }
  if (type === 'void' || type === 'Void') {
    return null;
  }

  // For custom types, return type name as placeholder
  return { _type: type };
}

/**
 * Generate a JSON example object from field definitions.
 */
function generateJsonExample(
  fields: Array<{ name: string; type: string; annotations: string[] }>,
  nestedSchemas?: Map<string, { fields: Array<{ name: string; type: string; annotations: string[] }> }>
): Record<string, unknown> {
  const example: Record<string, unknown> = {};

  for (const field of fields) {
    // Check if this field has a nested schema
    if (nestedSchemas?.has(field.type)) {
      const nestedFields = nestedSchemas.get(field.type)!.fields;
      example[field.name] = generateJsonExample(nestedFields, nestedSchemas);
    } else {
      example[field.name] = getExampleValue(field.type, field.annotations || []);
    }
  }

  return example;
}

/**
 * Convert BodySchema to JSON example object or null.
 */
function bodySchemaToJsonExample(
  schema: BodySchema | null,
  nestedSchemas?: Map<string, { fields: Array<{ name: string; type: string; annotations: string[] }> }>
): Record<string, unknown> | null {
  if (!schema) return null;

  // External types - can't resolve
  if (schema.source === 'external') {
    return null;
  }

  // Primitive types - return null (no body)
  if (schema.source === 'primitive') {
    return null;
  }

  // Indexed type with fields - generate example
  if (schema.fields && schema.fields.length > 0) {
    return generateJsonExample(schema.fields, nestedSchemas);
  }

  return null;
}

function generateCodeDiagram(chain: ChainNode[]): string {
  if (chain.length === 0) return '';

  // Group nodes by depth to create layers
  const layers: Map<number, ChainNode[]> = new Map();
  for (const node of chain) {
    const depth = node.depth;
    if (!layers.has(depth)) {
      layers.set(depth, []);
    }
    layers.get(depth)!.push(node);
  }

  const lines: string[] = ['graph TB'];

  // Create subgraphs for each logical layer
  const depth0 = layers.get(0) || [];
  if (depth0.length > 0) {
    lines.push('  subgraph Controller');
    for (const node of depth0) {
      lines.push(`    A[${node.name}]`);
    }
    lines.push('  end');
  }

  const depth1 = layers.get(1) || [];
  const depth2 = layers.get(2) || [];
  const services = [...depth1, ...depth2];
  if (services.length > 0) {
    lines.push('  subgraph Service');
    services.forEach((node, i) => {
      lines.push(`    ${String.fromCharCode(66 + i)}[${node.name}]`);
    });
    lines.push('  end');
  }

  // Add edges
  // Controller -> Service
  if (depth0.length > 0 && depth1.length > 0) {
    lines.push(`  A --> ${String.fromCharCode(66)}`);
  }

  // Service -> Service/External
  if (depth1.length > 0 && depth2.length > 0) {
    lines.push(`  ${String.fromCharCode(66)} --> ${String.fromCharCode(67)}`);
  }

  return lines.join('\n');
}