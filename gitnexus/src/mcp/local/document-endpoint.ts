/**
 * Document Endpoint Tool
 *
 * Generates API documentation JSON from the GitNexus knowledge graph.
 * Supports two modes:
 * - Minimal (default): Schema-valid JSON with TODO_AI_ENRICH placeholders
 * - Context-enriched: Same JSON + _context fields with source snippets
 */

import type { RepoHandle } from './local-backend.js';
import type { CrossRepoContext } from './cross-repo-context.js';
import { executeParameterized } from '../core/lbug-adapter.js';
import { executeTrace, type ChainNode } from './trace-executor.js';
import { queryEndpoints, type EndpointInfo } from './endpoint-query.js';
import { generateId } from '../../lib/utils.js';
import { shouldSkipSchema, extractGenericInnerType, extractPackagePrefix } from '../../core/ingestion/type-extractors/shared.js';

/** Placeholder for AI enrichment - used throughout for fields requiring manual input */
const TODO_AI_ENRICH = 'TODO_AI_ENRICH';

/** Spring annotations that map request parameters */
const REQUEST_PARAM_ANNOTATIONS = new Set([
  '@PathVariable', '@RequestParam', '@RequestHeader', '@CookieValue'
]);

/** Event listener annotations for inbound messaging detection */
const EVENT_LISTENER_ANNOTATIONS = new Set([
  '@EventListener', '@TransactionalEventListener', '@RabbitListener', '@KafkaListener'
]);

/** Pre-compiled regex patterns for imperative validation detection */
const IMPERATIVE_VALIDATION_PATTERNS = [
  // Framework validation methods (global flag for while loop)
  /TcbsValidator\.(validate|doValidate)\s*\(/g,
  /ValidationUtils\.(validate|check)\s*\(/g,
  /\.\s*validate\s*\(/g,
  /Validator\.(validate|check)\s*\(/g,

  // Validation service: validationService.process(), ValidationService.process()
  /\w*[Vv]alidation[Ss]ervice\w*\s*\.\s*process\s*\(/g,
  
  // Custom validation service fields: suggestionValidationServiceImpl.process()
  /\w*ValidationServiceImpl\s*\.\s*process\s*\(/g,
  
  // Custom validation methods: .validateJWT(), validateJWT(), .validateRequest()
  /(?:\.\s*)?validate[A-Z]\w*\s*\(/g,
];

// ============================================================================
// Types
// ============================================================================

/**
 * Remove empty arrays from an object at specified paths.
 * Used to clean up JSON output by omitting empty arrays.
 */
function removeEmptyArrays(obj: any, paths: string[][]): void {
  for (const path of paths) {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      current = current?.[path[i]];
      if (!current) break;
    }
    if (current) {
      const key = path[path.length - 1];
      if (Array.isArray(current[key]) && current[key].length === 0) {
        delete current[key];
      }
    }
  }
}

export interface DocumentEndpointOptions {
  method: string;
  path: string;
  depth?: number;
  include_context?: boolean;
  compact?: boolean;
  repo?: string;
  /** Optional injected query executor for testing */
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>;
  /** Optional cross-repo resolution capabilities */
  crossRepo?: CrossRepoContext;
}

export interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
  _context?: string;
}

export interface ValidationRule {
  field: string;
  type: string;
  required: boolean;
  rules: string;
  _context?: string[];
}

export interface ResponseCode {
  code: number;
  description: string;
}

export interface BodySchema {
  typeName: string;
  source: 'indexed' | 'external' | 'primitive';
  fields?: Array<{ name: string; type: string; annotations: string[] }>;
  /** Attribution for cross-repo resolution — repoId where the type was found */
  repoId?: string;
  /** Indicates the original type was a container (List, Set, array, etc.) */
  isContainer?: boolean;
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
  payload: string | BodySchema | Record<string, unknown> | Record<string, unknown>[];
  trigger: string;
  _context?: string;
}

export interface MessagingInbound {
  topic: string;
  payload: string | BodySchema | Record<string, unknown> | Record<string, unknown>[];
  consumptionLogic: string;
  _context?: string;
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
      body: Record<string, unknown> | Record<string, unknown>[] | BodySchema | null;
      validation: ValidationRule[];
    };
    response: {
      body: Record<string, unknown> | Record<string, unknown>[] | BodySchema | null;
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
 * Normalizes a path by replacing path variables with placeholders.
 * /e/v1/bonds/{id} → /e/v1/bonds/{}
 * /i/v1/customers/{tcbsId} → /i/v1/customers/{}
 * Used for structural path comparison.
 */
function normalizePathStructure(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

/**
 * Checks if two paths match structurally (same segments, ignoring variable names).
 * Normalizes both paths and compares segment by segment.
 * Non-placeholder segments must match exactly (case-insensitive).
 * Placeholder segments match any corresponding segment.
 */
function pathsMatchStructurally(inputPath: string, annotationPath: string): boolean {
  const normalizedInput = normalizePathStructure(inputPath);
  const normalizedAnnotation = normalizePathStructure(annotationPath);

  const inputSegments = normalizedInput.split('/').filter(s => s.length > 0);
  const annotationSegments = normalizedAnnotation.split('/').filter(s => s.length > 0);

  // Must have same number of segments
  if (inputSegments.length !== annotationSegments.length) {
    return false;
  }

  // Compare each segment
  for (let i = 0; i < inputSegments.length; i++) {
    const inputSeg = inputSegments[i];
    const annoSeg = annotationSegments[i];

    // Placeholders match anything
    if (inputSeg === '{}' || annoSeg === '{}') continue;

    // Non-placeholders must match exactly (case-insensitive)
    if (inputSeg.toLowerCase() !== annoSeg.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Fallback handler search when Route nodes don't exist.
 * Searches for Java methods with @XxxMapping annotations matching the path.
 * Combines class-level @RequestMapping prefix with method-level path before validation.
 */
async function findHandlerByPathPattern(
  repo: RepoHandle,
  method: string,
  pathPattern: string
): Promise<EndpointInfo | undefined> {
  // Query for Method nodes with request mapping annotations in content
  // Use larger limit to ensure we find relevant handlers before scoring
  const cypher = `
    MATCH (m:Method)
    WHERE m.filePath CONTAINS 'Controller'
      AND m.content CONTAINS $mappingAnnotation
      AND m.content CONTAINS $pathFragment
    RETURN m.name AS handler,
           m.filePath AS filePath,
           m.startLine AS line,
           m.content AS content
    LIMIT 100
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
    annotationPath?: string;  // Method-level path from annotation
    classPath?: string;        // Class-level prefix from @RequestMapping
    fullPath: string;          // Combined class + method path
    isValid: boolean;          // Structural validation passed (on fullPath)
  }
  const candidates: Candidate[] = [];

  // Cache for class-level paths to avoid repeated queries
  const classPathCache = new Map<string, string | undefined>();

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

            // Extract the method-level path from the annotation
            const pathMatch = content.match(new RegExp(`@(?:${upperMethod}Mapping|RequestMapping)\\s*\\(\\s*[^)]*value\\s*=\\s*["']([^"']+)["']`, 'i'))
              || content.match(new RegExp(`@(?:${upperMethod}Mapping|RequestMapping)\\s*\\(\\s*["']([^"']+)["']`, 'i'));
            const annotationPath = pathMatch?.[1];

            if (!annotationPath) continue; // Skip if no annotation path found

            // Get class-level prefix (cached)
            let classPath: string | undefined;
            if (classPathCache.has(filePath)) {
              classPath = classPathCache.get(filePath);
            } else {
              // Query for class-level RequestMapping prefix
              try {
                const classCypher = `
                  MATCH (c:Class)
                  WHERE c.filePath = $filePath
                  RETURN c.content AS classContent
                  LIMIT 1
                `;
                const classRows = await executeParameterized(repo.id, classCypher, { filePath: filePath });

                if (classRows && classRows.length > 0) {
                  const classContent = classRows[0].classContent ?? classRows[0][0] ?? '';

                  // Extract class-level @RequestMapping path (must be before 'class' or 'interface' keyword)
                  const classPathMatch = classContent.match(/@RequestMapping\s*\(\s*["']([^"']+)["']\s*\)\s*(?:\n\s*)*(?:@\w+\s*(?:\([^)]*\)\s*)?\s*)*(?:public\s+)?(?:class|interface)/i)
                    || classContent.match(/@RequestMapping\s*\(\s*[^)]*value\s*=\s*["']([^"']+)["'][^)]*\)\s*(?:\n\s*)*(?:@\w+\s*(?:\([^)]*\)\s*)?\s*)*(?:public\s+)?(?:class|interface)/i);

                  classPath = classPathMatch?.[1];
                }
              } catch {
                // Class query failed - continue without class path
              }
              classPathCache.set(filePath, classPath);
            }

            // Combine class prefix with method path
            const normalizedClassPath = classPath ? classPath.replace(/\/$/, '') : '';
            const normalizedMethodPath = annotationPath.startsWith('/') ? annotationPath : '/' + annotationPath;
            const fullPath = normalizedClassPath + normalizedMethodPath;

            // Score this candidate
            let score = 0;

            // Check for HTTP method specification in annotation
            const hasSpecificAnnotation = new RegExp(`@${upperMethod}Mapping`, 'i').test(content);
            const hasMethodAttribute = new RegExp(`@RequestMapping[^)]*method\\s*=\\s*RequestMethod\\.${upperMethod}`, 'i').test(content);

            if (hasSpecificAnnotation) score += 150;
            else if (hasMethodAttribute) score += 140;
            else if (annotation === 'RequestMapping') score -= 50; // Generic RequestMapping without method

            // STRUCTURAL VALIDATION: Check if FULL path (class + method) matches input path
            let isValidCandidate = true;
            if (!pathsMatchStructurally(pathPattern, fullPath)) {
              isValidCandidate = false;  // Reject - structure mismatch
            }

            // Scoring based on path match quality
            // Check if full path matches the search path
            if (fullPath === pathPattern) {
              score += 500; // Exact match - highest priority
            } else if (fullPath.length > 1 && pathPattern.startsWith(fullPath)) {
              score += 300; // Full path is prefix of search
            } else if (pathPattern.length > 1 && fullPath.startsWith(pathPattern)) {
              score += 200; // Search is prefix of full path
            }

            // Check if path ends with key segments
            const lastPathSegment = paths[paths.length - 1];
            if (fullPath.includes(lastPathSegment)) score += 100;

            // Check for exact suffix match (ignoring class-level prefix)
            const searchSuffix = '/' + paths.slice(-2).join('/');
            if (annotationPath.endsWith(searchSuffix) || annotationPath === '/' + paths[paths.length - 1]) {
              score += 200;
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
            const isExternal = filePath.toLowerCase().includes('ext') ||
                               filePath.toLowerCase().includes('external') ||
                               filePath.toLowerCase().includes('pio');
            const isInternal = filePath.toLowerCase().includes('internal');

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
              candidates.push({ handler, filePath, line, content, score, annotationPath, classPath, fullPath, isValid: isValidCandidate });
            }
          }
        }
      } catch (e) {
        // Continue to next pattern on error
        continue;
      }
    }
  }

  // Filter to only valid candidates (those that passed structural validation)
  const validCandidates = candidates.filter(c => c.isValid !== false);

  if (validCandidates.length === 0) return undefined;

  validCandidates.sort((a, b) => b.score - a.score);
  const best = validCandidates[0];

  // Use the full path (already computed during validation)
  return {
    method: method.toUpperCase(),
    path: best.fullPath,
    handler: best.handler,
    filePath: best.filePath,
    line: best.line,
  };
}

// ============================================================================
// Main Function
// ============================================================================

/** Valid HTTP methods for endpoint documentation */
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export async function documentEndpoint(
  repo: RepoHandle,
  options: DocumentEndpointOptions
): Promise<{ result: DocumentEndpointResult; error?: string }> {
  const { method, path, depth = 10, include_context = false, compact = false, crossRepo } = options;

  // Validate HTTP method
  const upperMethod = method.toUpperCase();
  if (!VALID_METHODS.has(upperMethod)) {
    return {
      result: createEmptyResult(method, path),
      error: `Invalid HTTP method: ${method}`
    };
  }

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

  // Step 2: Build the executeQuery function from repo (or use injected one for testing)
  const executeQuery = options.executeQuery ?? (async (_repoId: string, query: string, params: Record<string, any>) => {
    return executeParameterized(repo.id, query, params);
  });

  // Step 3: Trace the handler method
  const traceResult = await executeTrace(
    executeQuery,
    repo.id,
    { uid: handlerUid, maxDepth: depth, include_content: true, compact }
  );

  if (traceResult.error) {
    return {
      result: createEmptyResult(method, path),
      error: traceResult.error,
    };
  }

  // Step 4: Build the documentation
  // Use route.path (actual endpoint path) instead of input pattern
  const result = await buildDocumentation(method, route.path, route, traceResult.chain, include_context, compact, executeQuery, repo.id, crossRepo);

  return { result };
}

// ============================================================================
// Helper Functions
// ============================================================================

function createEmptyResult(method: string, path: string): DocumentEndpointResult {
  return {
    method,
    path,
    summary: TODO_AI_ENRICH,
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
    logicFlow: TODO_AI_ENRICH,
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
  compact: boolean,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  crossRepo?: CrossRepoContext
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

  // Extract request and response body schemas with nested type resolution FIRST
  // This creates the main nestedSchemas map that we'll merge into
  const { requestBody, responseBody, nestedSchemas } = await extractBodySchemas(chain, executeQuery, repoId, crossRepo);

  // Extract messaging for outbound/inbound and merge nestedSchemas
  const { outbound, inbound, nestedSchemas: messagingNestedSchemas } = await extractMessaging(chain, includeContext, executeQuery, repoId, crossRepo);
  
  // Merge messaging nestedSchemas into main nestedSchemas from body schemas
  for (const [typeName, schema] of messagingNestedSchemas) {
    nestedSchemas.set(typeName, schema);
  }
  
  // Convert payloads for compact mode, keep BodySchema for with-context mode
  if (includeContext) {
    result.externalDependencies.messaging.outbound = outbound;
    result.externalDependencies.messaging.inbound = inbound;
  } else {
    // Compact mode: convert BodySchema payloads to JSON examples
    // For external types (no fields), return just the type name string
    result.externalDependencies.messaging.outbound = outbound.map(msg => {
      if (typeof msg.payload === 'object' && msg.payload !== null) {
        const schema = msg.payload as BodySchema;
        // External types (not indexed) - return type name string
        if (schema.source === 'external' || !schema.fields) {
          return { topic: msg.topic, payload: schema.typeName, trigger: msg.trigger };
        }
        // Indexed types with fields - return JSON example
        return { topic: msg.topic, payload: bodySchemaToJsonExample(schema, nestedSchemas), trigger: msg.trigger };
      }
      return { topic: msg.topic, payload: msg.payload, trigger: msg.trigger };
    });
    
    result.externalDependencies.messaging.inbound = inbound.map(msg => {
      if (typeof msg.payload === 'object' && msg.payload !== null) {
        const schema = msg.payload as BodySchema;
        // External types (not indexed) - return type name string
        if (schema.source === 'external' || !schema.fields) {
          return { topic: msg.topic, payload: schema.typeName, consumptionLogic: msg.consumptionLogic };
        }
        // Indexed types with fields - return JSON example
        return { topic: msg.topic, payload: bodySchemaToJsonExample(schema, nestedSchemas), consumptionLogic: msg.consumptionLogic };
      }
      return { topic: msg.topic, payload: msg.payload, consumptionLogic: msg.consumptionLogic };
    });
  }

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

  // Convert to JSON example for schema-compliant output
  // When includeContext is true, keep full BodySchema for AI enrichment
  // When includeContext is false, output JSON example or null
  if (includeContext) {
    result.specs.request.body = embedNestedSchemas(requestBody, nestedSchemas);
    result.specs.response.body = embedNestedSchemas(responseBody, nestedSchemas);
  } else {
    result.specs.request.body = bodySchemaToJsonExample(requestBody, nestedSchemas);
    result.specs.response.body = bodySchemaToJsonExample(responseBody, nestedSchemas);
  }

  // Extract request parameters (PathVariable, RequestParam, RequestHeader, CookieValue)
  const handler = chain.find(n => n.depth === 0);
  if (handler) {
    result.specs.request.params = extractRequestParams(handler, includeContext);
    // Extract validation rules from handler parameters and body schema fields
    result.specs.request.validation = extractValidationRules(handler, requestBody, chain, includeContext);
  }

  // Generate code diagram
  result.codeDiagram = generateCodeDiagram(chain);

  // Generate logic flow placeholder
  result.logicFlow = TODO_AI_ENRICH;

  // Add context if requested
  if (includeContext) {
    // When compact mode, omit content from chain nodes to reduce memory
    const callChain = compact
      ? chain.map(node => ({
          uid: node.uid,
          name: node.name,
          filePath: node.filePath,
          depth: node.depth,
          kind: node.kind,
          startLine: node.startLine,
          endLine: node.endLine,
          parameterCount: node.parameterCount,
          returnType: node.returnType,
          parameterAnnotations: node.parameterAnnotations,
          annotations: node.annotations,
          callees: node.callees,
          metadata: node.metadata,
          // content is omitted for compact mode
        }))
      : chain;

    result._context = {
      callChain,
      resolvedProperties: {},
    };
    result._context.summaryContext = `Handler: ${route.controller}.${route.handler}() → Chain: ${chain.map(n => n.name).join(' → ')}`;
  }

  // Keep all required arrays even if empty - JSON schema requires them
  // Previously removed empty arrays, but schema validation requires:
  // - externalDependencies.persistence
  // - externalDependencies.messaging.outbound
  // - keyDetails.transactionManagement, businessRules, security
  // - cacheStrategy.population, invalidation, update

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
        condition: TODO_AI_ENRICH,
        purpose: TODO_AI_ENRICH,
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

/**
 * Extract request and response body schemas from the handler method's parameters and return type.
 */
async function extractBodySchemas(
  chain: ChainNode[],
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  crossRepo?: CrossRepoContext
): Promise<{ requestBody: BodySchema | null; responseBody: BodySchema | null; nestedSchemas: Map<string, BodySchema> }> {
  // Find handler node (depth 0)
  const handler = chain.find(n => n.depth === 0);
  if (!handler) {
    return { requestBody: null, responseBody: null, nestedSchemas: new Map() };
  }

  let requestBody: BodySchema | null = null;
  let responseBody: BodySchema | null = null;

  // Use separate visited sets for request and response body resolution
  // This allows the same type to be resolved for both request and response
  let requestVisited = new Set<string>();
  let responseVisited = new Set<string>();

  // Resolve @RequestBody parameter
  if (handler.parameterAnnotations) {
    try {
      const rawParams = JSON.parse(handler.parameterAnnotations);
      const params = transformParameterAnnotations(rawParams);
      const bodyParam = params.find((p: any) => p.annotations?.includes('@RequestBody'));
      if (bodyParam?.type) {
        requestBody = await resolveTypeSchema(bodyParam.type, executeQuery, repoId, requestVisited, crossRepo);
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

    responseBody = await resolveTypeSchema(returnType, executeQuery, repoId, responseVisited, crossRepo);
  }

  // Resolve all nested types for both request and response bodies
  const nestedSchemas = new Map<string, BodySchema>();
  
  // Use shared visited set for nested types to avoid redundant resolution
  const allVisited = new Set<string>();
  
  // Resolve nested types from request body
  if (requestBody) {
    const requestNested = await resolveAllNestedTypes(requestBody, executeQuery, repoId, allVisited, crossRepo);
    for (const [typeName, schema] of requestNested) {
      nestedSchemas.set(typeName, schema);
    }
  }
  
  // Resolve nested types from response body
  if (responseBody) {
    const responseNested = await resolveAllNestedTypes(responseBody, executeQuery, repoId, allVisited, crossRepo);
    for (const [typeName, schema] of responseNested) {
      nestedSchemas.set(typeName, schema);
    }
  }

  return { requestBody, responseBody, nestedSchemas };
}

/**
 * Resolve a type name to its field schema.
 */
async function resolveTypeSchema(
  typeName: string,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  visited: Set<string> = new Set(),
  crossRepo?: CrossRepoContext
): Promise<BodySchema> {
  // Check for primitive and container types
  if (shouldSkipSchema(typeName)) {
    return { typeName, source: 'primitive', fields: undefined };
  }

  // Prevent circular references
  if (visited.has(typeName)) {
    return { typeName, source: 'external', fields: undefined };
  }
  visited.add(typeName);

  // Extract generic inner type if applicable
  const innerType = extractGenericInnerType(typeName);
  if (innerType) {
    const innerSchema = await resolveTypeSchema(innerType, executeQuery, repoId, visited, crossRepo);
    return { ...innerSchema, isContainer: true };
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

    if (!rows || rows.length === 0) {
      // Try cross-repo resolution if type not found locally
      if (crossRepo) {
        const packagePrefix = extractPackagePrefix(typeName);
        const DEBUG = process.env.GITNEXUS_DEBUG === 'true';

        if (DEBUG) {
          console.error(`[GitNexus DEBUG] resolveTypeSchema: typeName=${typeName}, packagePrefix=${packagePrefix || 'none'}`);
        }

        // Determine which repos to search
        let depRepoIds: string[] = [];

        if (packagePrefix) {
          // Try to find the specific repo by package prefix
          const depRepoId = await crossRepo.findDepRepo(packagePrefix);
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] findDepRepo(${packagePrefix}) -> ${depRepoId || 'null'}`);
          }
          if (depRepoId && depRepoId !== repoId) {
            depRepoIds = [depRepoId];
          } else {
            // FALLBACK: Package prefix not found in registry, search all dependency repos
            // This handles cases where fully qualified names aren't mapped but simple names work
            depRepoIds = await crossRepo.listDepRepos();
            if (DEBUG) {
              console.error(`[GitNexus DEBUG] listDepRepos() fallback -> [${depRepoIds.join(', ')}]`);
            }
          }
        } else {
          // For simple class names, search all dependency repos
          depRepoIds = await crossRepo.listDepRepos();
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] listDepRepos() (no packagePrefix) -> [${depRepoIds.join(', ')}]`);
          }
        }
        
        if (depRepoIds.length > 0) {
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] Querying repos: [${depRepoIds.join(', ')}] for type: ${typeName}`);
          }

          const depResults = await crossRepo.queryMultipleRepos(
            depRepoIds,
            query,
            { typeName, typePattern: '.' + typeName }
          );

          if (DEBUG) {
            for (const r of depResults) {
              console.error(`[GitNexus DEBUG] Result from ${r.repoId}: ${r.results?.length || 0} rows, error=${(r as any)._error || 'none'}`);
            }
          }

          // Find first result that matches
          for (const result of depResults) {
            if (result.results?.length > 0) {
              const found = result.results[0] as { name: string; fields: string };
              const fieldsJson = found.fields;
              if (fieldsJson) {
                try {
                  const fields = JSON.parse(fieldsJson);
                  return {
                    typeName: found.name || typeName,
                    source: 'indexed',
                    fields: fields.map((f: any) => ({
                      name: f.name,
                      type: f.type,
                      annotations: f.annotations || []
                    })),
                    repoId: result.repoId
                  };
                } catch {
                  // JSON parse error — continue to next result
                }
              }
              return { typeName: found.name || typeName, source: 'indexed', fields: undefined, repoId: result.repoId };
            }
          }
        }
      }
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
 * Recursively resolves all nested types using BFS traversal.
 * Returns a Map of typeName → BodySchema for all resolved nested types.
 */
async function resolveAllNestedTypes(
  rootSchema: BodySchema | null,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  visited: Set<string>,
  crossRepo?: CrossRepoContext,
  options?: { maxDepth?: number; maxTypes?: number }
): Promise<Map<string, BodySchema>> {
  const nestedSchemas = new Map<string, BodySchema>();
  
  // Skip if no root schema or if it's not indexed
  if (!rootSchema || rootSchema.source !== 'indexed' || !rootSchema.fields) {
    return nestedSchemas;
  }

  const maxDepth = options?.maxDepth ?? 10;
  const maxTypes = options?.maxTypes ?? 100;

  // BFS queue: { typeName, depth }
  const queue: Array<{ typeName: string; depth: number }> = [];
  
  // Initialize queue with field types from root schema
  for (const field of rootSchema.fields) {
    if (!shouldSkipSchema(field.type)) {
      queue.push({ typeName: field.type, depth: 1 });
    }
  }

  while (queue.length > 0 && nestedSchemas.size < maxTypes) {
    const { typeName, depth } = queue.shift()!;
    
    // Skip if already visited (cycle detection)
    if (visited.has(typeName)) {
      continue;
    }
    
    // Skip if depth exceeded
    if (depth > maxDepth) {
      continue;
    }
    
    // Skip primitives
    if (shouldSkipSchema(typeName)) {
      continue;
    }
    
    // Extract generic inner type if applicable (List<X>, Optional<X>, X[])
    const innerType = extractGenericInnerType(typeName);
    if (innerType) {
      if (!shouldSkipSchema(innerType) && !visited.has(innerType)) {
        queue.push({ typeName: innerType, depth: depth + 1 });
      }
      continue;
    }
    
    // Resolve the type schema first (pass a copy of visited set without current type)
    const schema = await resolveTypeSchema(typeName, executeQuery, repoId, new Set(visited), crossRepo);
    
    // Mark as visited after resolution (prevents cycles in BFS, not in the resolution itself)
    visited.add(typeName);
    
    // If indexed and has fields, add to nested schemas
    if (schema.source === 'indexed' && schema.fields && schema.fields.length > 0) {
      nestedSchemas.set(typeName, schema);
      // Queue field types for further resolution
      for (const field of schema.fields) {
        if (!shouldSkipSchema(field.type) && !visited.has(field.type)) {
          queue.push({ typeName: field.type, depth: depth + 1 });
        }
      }
    }
  }

  return nestedSchemas;
}

/**
 * Recursively embeds nested schemas into field objects for with-context mode.
 * Transforms:
 *   { name: "data", type: "FooDto" }
 * Into:
 *   { name: "data", type: "FooDto", fields: [...], source: "indexed" }
 */
function embedNestedSchemas(
  schema: BodySchema | null,
  nestedSchemas: Map<string, BodySchema>,
  visited: Set<string> = new Set()
): BodySchema | null {
  // Handle null schema (no body)
  if (!schema) {
    return null;
  }

  // No fields to embed
  if (!schema.fields) {
    return schema;
  }

  // Prevent circular references
  if (visited.has(schema.typeName)) {
    return schema;
  }

  const newVisited = new Set(visited);
  newVisited.add(schema.typeName);

  const expandedFields = schema.fields.map(field => {
    // Extract inner type for generics/arrays
    const innerType = extractGenericInnerType(field.type);
    const fieldType = innerType || field.type;

    // Skip primitives and already-visited types
    if (shouldSkipSchema(fieldType)) {
      return field;
    }

    // Look up the nested schema
    const nestedSchema = nestedSchemas.get(fieldType);
    if (!nestedSchema) {
      return field;
    }

    // Recursively embed
    const embedded = embedNestedSchemas(nestedSchema, nestedSchemas, newVisited);

    // Return field with embedded nested data
    return {
      ...field,
      fields: embedded.fields,
      source: embedded.source,
      ...(embedded.isContainer !== undefined && { isContainer: embedded.isContainer }),
      ...(embedded.repoId && { repoId: embedded.repoId })
    };
  });

  return {
    ...schema,
    fields: expandedFields
  };
}

/** Framework-injected types to skip from parameter extraction */
const FRAMEWORK_INJECTED_TYPES = new Set([
  'HttpServletRequest', 'HttpServletResponse', 'Model', 'ModelMap',
  'Principal', 'Locale', 'BindingResult', 'Errors',
  'RedirectAttributes', 'SessionStatus', 'WebRequest', 'NativeWebRequest',
  'InputStream', 'OutputStream', 'Reader', 'Writer', 'HttpSession',
]);

/**
 * Transform stored parameterAnnotations format to the expected format.
 *
 * Stored format (from ingestion):
 *   [{"name":"PathVariable","argument":"productCode","parameterName":"productCode","parameterType":"String"}]
 *
 * Expected format (for extractRequestParams):
 *   [{"name":"productCode","type":"String","annotations":["@PathVariable(\"productCode\")"]}]
 */
function transformParameterAnnotations(
  stored: Array<{
    name?: string;
    argument?: string;
    parameterName?: string;
    parameterType?: string;
    type?: string;
    annotations?: string[];
  }>
): Array<{ name: string; type: string; annotations: string[] }> {
  return stored.map(p => {
    // Check if already in expected format (has annotations array)
    if (p.annotations && Array.isArray(p.annotations)) {
      // Normalize annotations to include @ prefix
      const normalizedAnnotations = p.annotations.map(a =>
        a.startsWith('@') ? a : `@${a}`
      );
      return {
        name: p.name || p.parameterName || '',
        type: p.type || p.parameterType || '',
        annotations: normalizedAnnotations
      };
    }

    // Transform from stored format
    const annotationName = p.name || '';
    const annotationArg = p.argument || '';
    const paramName = p.parameterName || '';
    const paramType = p.parameterType || '';

    // Build annotation string: @AnnotationName("argument") or @AnnotationName
    const annotationStr = annotationArg
      ? `@${annotationName}("${annotationArg}")`
      : `@${annotationName}`;

    return {
      name: paramName,
      type: paramType,
      annotations: [annotationStr]
    };
  });
}

/**
 * Extract request parameters from a handler method.
 * Filters for @PathVariable, @RequestParam, @RequestHeader, @CookieValue annotations.
 * Skips @RequestBody parameters (handled by body schema) and framework-injected types.
 */
function extractRequestParams(
  handler: ChainNode,
  includeContext: boolean
): ParamInfo[] {
  // No parameterAnnotations JSON available
  if (!handler.parameterAnnotations) {
    return [];
  }

  // Parse parameterAnnotations JSON
  let rawParams: Array<{
    name?: string;
    argument?: string;
    parameterName?: string;
    parameterType?: string;
    type?: string;
    annotations?: string[];
  }>;
  try {
    rawParams = JSON.parse(handler.parameterAnnotations);
  } catch {
    return [];
  }

  // Transform from stored format to expected format
  const params = transformParameterAnnotations(rawParams);

  const result: ParamInfo[] = [];

  for (const param of params) {
    // Skip framework-injected types
    if (FRAMEWORK_INJECTED_TYPES.has(param.type)) {
      continue;
    }

    // Skip if no annotations
    if (!param.annotations || param.annotations.length === 0) {
      continue;
    }

    // Find the relevant annotation
    const annotation = param.annotations.find((ann: string) =>
      [...REQUEST_PARAM_ANNOTATIONS].some(t => ann.startsWith(t))
    );

    if (!annotation) {
      continue;
    }

    // Skip @RequestBody parameters (handled by body schema)
    if (param.annotations.includes('@RequestBody')) {
      continue;
    }

    // Determine the annotation type
    const annType = [...REQUEST_PARAM_ANNOTATIONS].find(t => annotation.startsWith(t))!;

    // Determine required flag
    let required = true; // Default is true for all

    if (annType === '@PathVariable') {
      // @PathVariable is always required
      required = true;
    } else {
      // @RequestParam, @RequestHeader, @CookieValue - check required attribute
      // Parse annotation to check for required=false
      const requiredMatch = annotation.match(/required\s*=\s*(true|false)/i);
      if (requiredMatch) {
        required = requiredMatch[1].toLowerCase() === 'true';
      }
    }

    // Build the ParamInfo
    const paramInfo: ParamInfo = {
      name: param.name,
      type: param.type,
      required,
      description: '',
    };

    // Add _context if includeContext is true
    if (includeContext && handler.filePath && handler.startLine) {
      paramInfo._context = `// ${handler.filePath}:${handler.startLine}\n${annotation}`;
    }

    result.push(paramInfo);
  }

  return result;
}

/** Validation annotation names that indicate required fields */
const REQUIRED_ANNOTATIONS = new Set(['@NotNull', '@NotBlank', '@NotEmpty']);

/** All validation annotation names (excluding @Valid/@Validated which are markers) */
const VALIDATION_ANNOTATIONS = new Set([
  '@NotNull', '@NotBlank', '@NotEmpty',
  '@Size', '@Min', '@Max',
  '@Positive', '@PositiveOrZero', '@Negative', '@NegativeOrZero',
  '@Pattern', '@Email',
  '@Past', '@PastOrPresent', '@Future', '@FutureOrPresent',
  '@Valid', '@Validated',
]);

/**
 * Format a validation annotation to a human-readable rule string.
 * E.g., "@Size(min=1, max=100)" → "Size: min=1, max=100"
 */
function formatValidationRule(annotation: string): string {
  // Remove @ prefix
  const withoutAt = annotation.startsWith('@') ? annotation.slice(1) : annotation;

  // Extract annotation name and value
  const match = withoutAt.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return withoutAt;

  const name = match[1];
  const value = match[2];

  if (!value) {
    // No value, just return the name (e.g., "@NotNull" → "NotNull")
    return name;
  }

  // Format based on annotation type
  if (name === 'Size') {
    return `Size: ${value}`;
  }
  if (name === 'Min' || name === 'Max') {
    return `${name}: ${value}`;
  }
  if (name === 'Pattern') {
    // Extract regexp value
    const regexpMatch = value.match(/regexp\s*=\s*"([^"]+)"/);
    if (regexpMatch) {
      return `Pattern: ${regexpMatch[1]}`;
    }
    return `Pattern: ${value}`;
  }

  // Default: return name with value
  return `${name}: ${value}`;
}

/**
 * Extract ValidationRule from a list of annotations.
 * Returns empty array if no validation annotations found.
 */
function extractValidationFromAnnotations(
  annotations: string[],
  fieldName: string,
  fieldType: string,
  includeContext: boolean,
  filePath?: string,
  startLine?: number
): ValidationRule[] {
  // Filter validation annotations
  const validationAnns = annotations.filter((ann: string) => {
    const name = ann.startsWith('@') ? ann.slice(1) : ann;
    const baseName = name.split('(')[0];
    return VALIDATION_ANNOTATIONS.has(`@${baseName}`);
  });

  if (validationAnns.length === 0) {
    return [];
  }

  // Determine if required
  const required = validationAnns.some((ann: string) => {
    const baseName = ann.split('(')[0];
    return REQUIRED_ANNOTATIONS.has(baseName);
  });

  // Format rules
  const formattedRules = validationAnns
    .map(formatValidationRule)
    .join(', ');

  const rule: ValidationRule = {
    field: fieldName,
    type: fieldType,
    required,
    rules: formattedRules,
  };

  // Add _context if includeContext is true (as array for grouping)
  if (includeContext && filePath && startLine) {
    const annText = validationAnns.join(' ');
    rule._context = [`// ${filePath}:${startLine}\n${annText}`];
  }

  return [rule];
}

/**
 * Find fields from Class nodes in the chain for a given type.
 */
function findFieldsInChain(
  chain: ChainNode[],
  typeName: string
): Array<{ name: string; type: string; annotations: string[] }> | null {
  // Find Class node matching the type name
  const classNode = chain.find(n => n.name === typeName && n.kind === 'Class');
  if (!classNode || !classNode.fields) {
    return null;
  }

  try {
    return JSON.parse(classNode.fields);
  } catch {
    return null;
  }
}

/**
 * Extract validation rules from handler parameters and body schema fields.
 */
function extractValidationRules(
  handler: ChainNode,
  requestBody: BodySchema | null,
  chain: ChainNode[],
  includeContext: boolean
): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // Parse parameterAnnotations JSON
  if (!handler.parameterAnnotations) {
    return rules;
  }

  let rawParams: Array<{
    name?: string;
    argument?: string;
    parameterName?: string;
    parameterType?: string;
    type?: string;
    annotations?: string[];
  }>;
  try {
    rawParams = JSON.parse(handler.parameterAnnotations);
  } catch {
    return rules;
  }

  // Transform from stored format to expected format
  const params = transformParameterAnnotations(rawParams);

    for (const param of params) {
    if (!param.annotations || param.annotations.length === 0) {
      continue;
    }

    // Extract validation rules using helper
    const paramRules = extractValidationFromAnnotations(
      param.annotations,
      param.name,
      param.type,
      includeContext,
      handler.filePath,
      handler.startLine
    );
    rules.push(...paramRules);
  }

  // Include field-level validation rules from BodySchema or chain nodes
  // Find the @RequestBody parameter to get the param name prefix
  const bodyParam = params.find((p: { name: string; type: string; annotations: string[] }) =>
    p.annotations?.includes('@RequestBody')
  );

  if (bodyParam) {
    // First try requestBody.fields (from database query)
    // Then fall back to finding Class nodes in the chain with fields
    const fields = requestBody?.fields || findFieldsInChain(chain, bodyParam.type);

    if (fields && fields.length > 0) {
      const prefix = `${bodyParam.name}.`;

      // Find the Class node for context (once, before the loop)
      const classNode = chain.find(n => n.name === bodyParam.type && n.kind === 'Class');

      for (const field of fields) {
        if (!field.annotations || field.annotations.length === 0) {
          continue;
        }

        // Extract validation rules using helper
        const fieldRules = extractValidationFromAnnotations(
          field.annotations,
          `${prefix}${field.name}`,
          field.type,
          includeContext,
          classNode?.filePath,
          classNode?.startLine
        );
        rules.push(...fieldRules);
      }
    }
  }

  // Part 3: Imperative validation detection
  // Always run this - it's the primary validation source for Java codebases
  // (which use imperative validation via method calls, not annotation-based validation)
  const seenValidations = new Set<string>();  // Dedup by (filePath, line, match.index)

  for (const node of chain) {
    if (!node.content) continue;
    for (const pattern of IMPERATIVE_VALIDATION_PATTERNS) {
      pattern.lastIndex = 0;  // Reset regex state for reuse
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(node.content)) !== null) {
        // WI-3: Extract meaningful field and rules from validation calls
        const matchedText = match[0];

        // Extract method name/path (e.g., "TcbsValidator.validate" or "process")
        // Strip leading dot if present (from patterns like .validateJWT)
        const methodMatch = matchedText.match(/([\w.]+)\s*\(/);
        const rawPath = methodMatch?.[1] || TODO_AI_ENRICH;
        const methodPath = rawPath.startsWith('.') ? rawPath.slice(1) : rawPath;

        // Dedup by (file, line, method name) to prevent overlapping patterns from creating duplicates
        const key = `${node.filePath}:${node.startLine}:${methodPath}`;
        if (seenValidations.has(key)) continue;
        seenValidations.add(key);

        // Extract type from last parameter to determine what's being validated
        const argsMatch = node.content.slice(match.index).match(/\(([^)]*)\)/);
        let fieldName = TODO_AI_ENRICH;
        let paramType: string | undefined;

        if (argsMatch) {
          const args = argsMatch[1].split(',').map(a => a.trim());
          if (args.length > 0) {
            const lastArg = args[args.length - 1];
            // Handle both "Type name" and just "name" formats
            const parts = lastArg.split(/\s+/);
            if (parts.length >= 2) {
              // "SuggestionOrderResultDto prm" → type=SuggestionOrderResultDto, name=prm
              paramType = parts[0];
              fieldName = parts[parts.length - 1];
            } else {
              // Just "prm" → no type info
              fieldName = parts[0];
            }
          }
        }

        // If we have a fieldName but no paramType, look it up in handler parameters
        if (fieldName !== TODO_AI_ENRICH && !paramType) {
          const param = params.find((p: { name: string; type: string }) => p.name === fieldName);
          if (param) {
            paramType = param.type;
          }
        }

        // Map type to request body if it matches
        if (paramType && requestBody?.typeName && paramType === requestBody.typeName) {
          fieldName = 'body';  // Validates the whole request body
        } else if (paramType) {
          // Use the type name for other types (e.g., TcbsJWT → "TcbsJWT")
          fieldName = paramType;
        }
        // else: keep fieldName as TODO_AI_ENRICH or the parameter name

        // Build rule object conditionally
        const rule: ValidationRule = {
          field: fieldName,
          type: 'Custom',
          required: false,
          rules: methodPath,
        };
        if (includeContext) {
          rule._context = [`// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content.slice(match.index, match.index + 200)}...`];
        }
        rules.push(rule);
      }
    }
  }

  // WI-2: Group validations by (field, rules) - collect contexts as array
  const grouped = new Map<string, ValidationRule>();
  for (const rule of rules) {
    const key = `${rule.field}|${rule.rules}`;
    if (grouped.has(key)) {
      const existing = grouped.get(key)!;
      // Append context to array if present
      if (rule._context) {
        if (!existing._context) {
          existing._context = [];
        }
        existing._context.push(...(Array.isArray(rule._context) ? rule._context : [rule._context]));
      }
    } else {
      grouped.set(key, { ...rule });
    }
  }
  return Array.from(grouped.values());
}

async function extractMessaging(
  chain: ChainNode[],
  includeContext: boolean,
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId?: string,
  crossRepo?: CrossRepoContext
): Promise<{
  outbound: MessagingOutbound[];
  inbound: MessagingInbound[];
  nestedSchemas: Map<string, BodySchema>;
}> {
  const outbound: MessagingOutbound[] = [];
  const inbound: MessagingInbound[] = [];
  const seenOutbound = new Set<string>();
  const seenInbound = new Set<string>();
  const visited = new Set<string>();
  const nestedSchemas = new Map<string, BodySchema>();

  // Helper to resolve payload type to BodySchema (always when executeQuery available)
  const resolvePayload = async (typeName: string): Promise<string | BodySchema> => {
    if (typeName === TODO_AI_ENRICH) {
      return TODO_AI_ENRICH;
    }
    if (!executeQuery || !repoId) {
      return typeName;
    }
    const resolved = await resolveTypeSchema(typeName, executeQuery, repoId, visited, crossRepo);
    return resolved;
  };

  for (const node of chain) {
    // Extract outbound messaging
    for (const detail of node.metadata.messagingDetails) {
      if (detail.topic && !seenOutbound.has(detail.topic)) {
        seenOutbound.add(detail.topic);
        const payloadTypeName = detail.payload || TODO_AI_ENRICH;
        // Always resolve payload to BodySchema when executeQuery available
        const payload = executeQuery && repoId && payloadTypeName !== TODO_AI_ENRICH
          ? await resolvePayload(payloadTypeName)
          : payloadTypeName;

        outbound.push({
          topic: detail.topic,
          payload,
          trigger: TODO_AI_ENRICH,
          ...(includeContext && {
            _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\\n${node.content?.slice(0, 200)}...`,
          }),
        });
      }
    }

    // Extract inbound messaging from annotations
    if (node.annotations) {
      try {
        const annotations = JSON.parse(node.annotations);
        for (const ann of annotations) {
          const annName = ann.name;
          if (EVENT_LISTENER_ANNOTATIONS.has(annName)) {
            // Determine topic
            let topic: string;
            if (annName === '@EventListener' || annName === '@TransactionalEventListener') {
              topic = TODO_AI_ENRICH;
            } else if (annName === '@RabbitListener') {
              topic = ann.attrs?.queues || TODO_AI_ENRICH;
            } else if (annName === '@KafkaListener') {
              topic = ann.attrs?.topics || TODO_AI_ENRICH;
            } else {
              continue;
            }

            const payloadTypeName = extractPayloadFromParameters(node.parameterAnnotations);
            const consumptionLogic = buildConsumptionLogic(node.filePath!, node.name!);

            // Deduplicate by topic + consumptionLogic
            const key = `${topic}:${consumptionLogic}`;
            if (seenInbound.has(key)) continue;
            seenInbound.add(key);

            // Always resolve payload to BodySchema when executeQuery available
            const payload = executeQuery && repoId
              ? await resolvePayload(payloadTypeName)
              : payloadTypeName;

            inbound.push({
              topic,
              payload,
              consumptionLogic,
              ...(includeContext && {
                _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\\n${node.content?.slice(0, 200)}...`,
              }),
            });
          }
        }
      } catch {
        // Ignore parse errors for annotations
      }
    }
  }

  // Part 2: Graph query for broker listeners (when executeQuery provided)
  // This must run even in compact mode (includeContext=false) to detect inbound events
  // that aren't in the call chain (e.g., @RabbitListener/@KafkaListener methods)
  if (executeQuery && repoId) {
    // Query using content since annotations may not be stored
    // RabbitListener pattern: @RabbitListener(queues = { "topic" })
    // KafkaListener pattern: @KafkaListener(topics = { "topic" })
    const cypher = `
      MATCH (m:Method)
      WHERE m.content CONTAINS '@RabbitListener'
         OR m.content CONTAINS '@KafkaListener'
      RETURN m.id, m.name, m.content, m.filePath, m.parameterAnnotations
    `;
    try {
      const results = await executeQuery(repoId, cypher, {});
      for (const row of results) {
        // Extract values - Cypher returns columns like m.id, m.name, m.content, etc.
        const name = row['m.name'] ?? row.name ?? row[1];
        const content = row['m.content'] ?? row.content ?? row[2] ?? '';
        const filePath = row['m.filePath'] ?? row.filePath ?? row[3] ?? '';
        const parameterAnnotations = row['m.parameterAnnotations'] ?? row.parameterAnnotations ?? row[4];

        // Determine listener type from content
        const listenerType = content.includes('@RabbitListener') ? 'RabbitListener' as const
          : content.includes('@KafkaListener') ? 'KafkaListener' as const
          : null;

        if (!listenerType) continue;

        // Extract topic from content
        // RabbitListener: @RabbitListener(queues = { "topic" }) or queues = "topic"
        // KafkaListener: @KafkaListener(topics = { "topic" }) or topics = "topic"
        const topic = extractListenerTopicFromContent(content, listenerType);
        const payloadTypeName = extractPayloadFromParameters(parameterAnnotations);
        const consumptionLogic = buildConsumptionLogic(filePath, name);

        // Deduplicate
        const key = `${topic}:${consumptionLogic}`;
        if (seenInbound.has(key)) continue;
        seenInbound.add(key);

        // Always resolve payload to BodySchema when executeQuery available
        const payload = executeQuery && repoId
          ? await resolvePayload(payloadTypeName)
          : payloadTypeName;

        inbound.push({
          topic,
          payload,
          consumptionLogic,
          ...(includeContext && {
            _context: `// Graph query result\\n// ${filePath}\\n@${listenerType} detected`,
          }),
        });
      }
    } catch {
      // Ignore graph query errors
    }
  }

  // Resolve nested types for all payloads when executeQuery available
  // This ensures messaging payloads have full type resolution like request/response bodies
  if (executeQuery && repoId) {
    const allVisited = new Set<string>();

    // Collect all BodySchema payloads from outbound
    for (const msg of outbound) {
      if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
        const nested = await resolveAllNestedTypes(msg.payload as BodySchema, executeQuery, repoId, allVisited, crossRepo);
        for (const [typeName, schema] of nested) {
          nestedSchemas.set(typeName, schema);
        }
      }
    }

    // Collect all BodySchema payloads from inbound
    for (const msg of inbound) {
      if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
        const nested = await resolveAllNestedTypes(msg.payload as BodySchema, executeQuery, repoId, allVisited, crossRepo);
        for (const [typeName, schema] of nested) {
          nestedSchemas.set(typeName, schema);
        }
      }
    }

    // Embed nested schemas into payload fields when includeContext
    if (includeContext) {
      for (const msg of outbound) {
        if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
          msg.payload = embedNestedSchemas(msg.payload as BodySchema, nestedSchemas);
        }
      }
      for (const msg of inbound) {
        if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
          msg.payload = embedNestedSchemas(msg.payload as BodySchema, nestedSchemas);
        }
      }
    }
  }

  return { outbound, inbound, nestedSchemas };
}

/**
 * Extract class name from a file path.
 * Example: "src/listeners/RabbitConsumer.java" -> "RabbitConsumer"
 */
function extractClassNameFromPath(filePath: string): string | null {
  const fileName = filePath.split('/').pop() || '';
  const match = fileName.match(/^(.+)\.(java|ts|js|kt|py|php)$/);
  return match ? match[1] : null;
}

/**
 * Extract topic from RabbitListener or KafkaListener annotation string.
 */
function extractListenerTopic(annotations: string, listenerType: 'RabbitListener' | 'KafkaListener'): string {
  const attr = listenerType === 'RabbitListener' ? 'queues' : 'topics';
  
  // Try JSON format first: [{ name: '@RabbitListener', attrs: { queues: 'value' } }]
  try {
    const parsed = JSON.parse(annotations);
    if (Array.isArray(parsed)) {
      for (const ann of parsed) {
        if (ann.name === `@${listenerType}` && ann.attrs?.[attr]) {
          return ann.attrs[attr];
        }
      }
    }
  } catch {
    // Not JSON, try regex format
  }
  
  // Regex format: queues="value" or queues={value}
  const match1 = annotations.match(new RegExp(`${attr}\\\\s*=\\\\s*"([^"]+)"`));
  if (match1) return match1[1];
  const match2 = annotations.match(new RegExp(`${attr}\\\\s*=\\\\s*\\{([^}]+)\\}`));
  if (match2) return match2[1].trim();

  return TODO_AI_ENRICH;
}

/**
 * Extract topic from method content containing @RabbitListener or @KafkaListener.
 * Handles formats like:
 * - @RabbitListener(queues = { "topic1", "topic2" })
 * - @RabbitListener(queues = "topic")
 * - @KafkaListener(topics = { "topic1", "topic2" })
 * - @KafkaListener(topics = "${kafka.topic}")
 */
function extractListenerTopicFromContent(content: string, listenerType: 'RabbitListener' | 'KafkaListener'): string {
  const attr = listenerType === 'RabbitListener' ? 'queues' : 'topics';

  // Pattern: @RabbitListener(queues = { "topic" }) or @KafkaListener(topics = { "topic" })
  // Also handles: queues = "topic", topics = "${property}"
  const arrayPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*\\{\\s*"([^"]+)"`);
  const stringPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*"([^"]+)"`);
  const placeholderPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*\\{\\s*\\$\\{([^}]+)\\}\\s*\\}`);
  const placeholderStringPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*"\\$\\{([^}]+)\\}"`);

  // Try array format first: { "topic" }
  const arrayMatch = content.match(arrayPattern);
  if (arrayMatch) return arrayMatch[1];

  // Try string format: "topic"
  const stringMatch = content.match(stringPattern);
  if (stringMatch) return stringMatch[1];

  // Try placeholder in array: { "${property}" }
  const placeholderMatch = content.match(placeholderPattern);
  if (placeholderMatch) return `\${${placeholderMatch[1]}}`;

  // Try placeholder in string: "${property}"
  const placeholderStringMatch = content.match(placeholderStringPattern);
  if (placeholderStringMatch) return `\${${placeholderStringMatch[1]}}`;

  return TODO_AI_ENRICH;
}

/**
 * Extract payload type from parameters (string or parsed JSON).
 */
function extractPayloadFromParameters(parameters: string | unknown): string {
  if (!parameters) return TODO_AI_ENRICH;
  try {
    const params = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
    if (Array.isArray(params) && params.length > 0 && params[0].type) {
      return params[0].type;
    }
  } catch { /* ignore parse errors */ }
  return TODO_AI_ENRICH;
}

/**
 * Build consumptionLogic string from filePath and methodName.
 */
function buildConsumptionLogic(filePath: string, methodName: string): string {
  const className = extractClassNameFromPath(filePath);
  return className && methodName ? `${className}.${methodName}()` : methodName || TODO_AI_ENRICH;
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
    database: TODO_AI_ENRICH,
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
                recovery: TODO_AI_ENRICH,
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
/**
 * Recursively unwrap nested generics to find the innermost type.
 * Returns { innermostType, depth } where depth is the number of wrapper levels.
 * e.g., 'Optional<List<String>>' → { innermostType: 'String', depth: 2 }
 * e.g., 'List<ItemDto>' → { innermostType: 'ItemDto', depth: 1 }
 */
function unwrapNestedGenerics(typeName: string): { innermostType: string; depth: number } {
  let currentType = typeName;
  let depth = 0;
  
  while (true) {
    const innerType = extractGenericInnerType(currentType);
    if (!innerType) {
      // No more generic wrappers
      break;
    }
    currentType = innerType;
    depth++;
  }
  
  return { innermostType: currentType, depth };
}

function generateJsonExample(
  fields: Array<{ name: string; type: string; annotations: string[] }>,
  nestedSchemas?: Map<string, BodySchema>,
  visited: Set<string> = new Set()
): Record<string, unknown> {
  const example: Record<string, unknown> = {};

  for (const field of fields) {
    // Check if this field has a nested schema directly
    if (nestedSchemas?.has(field.type)) {
      // Prevent circular reference - if type already visited, use placeholder
      if (visited.has(field.type)) {
        example[field.name] = { _type: field.type };
        continue;
      }
      const nestedSchema = nestedSchemas.get(field.type)!;
      example[field.name] = generateJsonExample(nestedSchema.fields, nestedSchemas, new Set(visited).add(field.type));
      continue;
    }

    // Check for generic container types (List<X>, Optional<X>, Set<X>, X[])
    // Also handle nested generics like Optional<List<String>>
    const innerType = extractGenericInnerType(field.type);
    if (innerType) {
      // Recursively unwrap nested generics
      const { innermostType, depth } = unwrapNestedGenerics(field.type);
      
      // Check if innermost type has a nested schema
      if (nestedSchemas?.has(innermostType)) {
        // Prevent circular reference in generic containers
        if (visited.has(innermostType)) {
          // Create nested array wrappers matching depth
          let result: unknown = { _type: innermostType };
          for (let i = 0; i < depth; i++) {
            result = [result];
          }
          example[field.name] = result;
          continue;
        }
        const nestedSchema = nestedSchemas.get(innermostType)!;
        const nestedFields = nestedSchema.fields || [];
        let innerExample: unknown = generateJsonExample(nestedFields, nestedSchemas, new Set(visited).add(innermostType));
        // Wrap in array for each generic level
        for (let i = 0; i < depth; i++) {
          innerExample = [innerExample];
        }
        example[field.name] = innerExample;
      } else if (shouldSkipSchema(innermostType)) {
        // Innermost type is primitive - wrap in arrays matching generic depth
        let result: unknown = getExampleValue(innermostType, field.annotations || []);
        for (let i = 0; i < depth; i++) {
          result = [result];
        }
        example[field.name] = result;
      } else {
        // Innermost type is external/unknown - return placeholder with proper nesting
        let result: unknown = { _type: innermostType };
        for (let i = 0; i < depth; i++) {
          result = [result];
        }
        example[field.name] = result;
      }
      continue;
    }

    // Fallback to getExampleValue for primitives and unknown types
    example[field.name] = getExampleValue(field.type, field.annotations || []);
  }

  return example;
}

/**
 * Convert BodySchema to JSON example object or null.
 */
function bodySchemaToJsonExample(
  schema: BodySchema | null,
  nestedSchemas?: Map<string, BodySchema>
): Record<string, unknown> | Record<string, unknown>[] | null {
  if (!schema) return null;

  // External types - return type placeholder
  if (schema.source === 'external') {
    return { _type: schema.typeName };
  }

  // Primitive types - return null (no body)
  if (schema.source === 'primitive') {
    return null;
  }

  // Indexed type with fields - generate example
  if (schema.fields && schema.fields.length > 0) {
    const example = generateJsonExample(schema.fields, nestedSchemas);
    // If it was a container type, wrap in array
    if (schema.isContainer) {
      return [example];
    }
    return example;
  }

  // Indexed type without fields - return type placeholder
  return { _type: schema.typeName };
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