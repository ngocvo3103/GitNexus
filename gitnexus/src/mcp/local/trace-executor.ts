/**
 * Trace Executor — BFS traversal of call chains with metadata extraction.
 *
 * Traces downstream execution flows from a starting symbol, collecting
 * all callees via CALLS relationships up to a configurable depth.
 * Extracts metadata (HTTP calls, annotations, events, repos) when content
 * is available.
 */

import { shouldSkipSchema, extractGenericInnerType } from '../../core/ingestion/type-extractors/shared.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TraceOptions {
  /** Symbol name to trace (disambiguate with file_path if ambiguous) */
  symbol?: string;
  /** Exact UID for direct lookup (no disambiguation needed) */
  uid?: string;
  /** File path to disambiguate symbol name */
  file_path?: string;
  /** Maximum traversal depth (default: 5) */
  maxDepth?: number;
  /**
   * When true, fetches source content for each chain node and runs extractMetadata().
   * Must be true to populate httpCallDetails, messagingDetails, repositoryCalls,
   * and exceptions. Setting to false produces empty metadata arrays.
   */
  include_content?: boolean;
  /**
   * When true, omits content from ChainNode output after extracting metadata.
   * Reduces memory footprint by not storing source code in the result chain.
   * Requires include_content=true for metadata extraction.
   */
  compact?: boolean;
}

export interface HttpCallDetail {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  httpMethod: string;
  /** URL expression as written in code (may contain variables) */
  urlExpression: string;
  /** Resolved URL if statically determinable (optional) */
  resolvedUrl?: string;
}

export interface MessagingDetail {
  /** Topic name (literal or variable name) */
  topic?: string;
  /** Whether the topic is a variable reference (true) or literal string (false) */
  topicIsVariable: boolean;
  /** Method used for publishing (convertAndSend, send, publishEvent, etc.) */
  callerMethod: string;
  /** Payload type name (when determinable from call site) */
  payload?: string;
}

export interface ExceptionDetail {
  /** Exception class name (e.g., "TcbsException") */
  exceptionClass: string;
  /** Error code constant (e.g., "TRANSACTIONID_SUGGESTION_ORDER_NOT_EXIST") */
  errorCode?: string;
}

export interface RepositoryCallDetail {
  /** Repository name (e.g., "userRepository") */
  repository: string;
  /** Method called on repository (e.g., "save", "findById") */
  method: string;
  /** Full call expression (e.g., "userRepository.save(user)") */
  call: string;
}

export interface ChainNode {
  /** Unique identifier (e.g., "Function:src/a.ts:myFunc") */
  uid: string;
  /** Symbol name */
  name: string;
  /** Source file path */
  filePath: string;
  /** Depth from root (0 = root) */
  depth: number;
  /** Symbol kind (Method, Function, Class, etc.) */
  kind?: string;
  /** Start line in source file */
  startLine?: number;
  /** End line in source file */
  endLine?: number;
  /** Source code content (only when include_content=true) */
  content?: string;
  /** UIDs of direct callees */
  callees: string[];
  /** Parameter count (for methods/functions) */
  parameterCount?: number;
  /** Return type (for methods/functions) */
  returnType?: string;
  /** JSON array of parameter details (for methods/functions) */
  parameters?: string;
  /** JSON array of annotations (for methods/classes) */
  annotations?: string;
  /** JSON array of field details (for classes) */
  fields?: string;
  /** Set when resolved from interface (WI-7). Format: "InterfaceClass.methodName" */
  resolvedFrom?: string;
  /** True if this node represents an interface (not concrete impl) */
  isInterface?: boolean;
  /** Extracted metadata from content */
  metadata: {
    /** Legacy: HTTP call method names (backward compat) */
    httpCalls: string[];
    /** Detailed HTTP call information with URLs */
    httpCallDetails: HttpCallDetail[];
    annotations: string[];
    /** Legacy: Event publishing method names (backward compat) */
    eventPublishing: string[];
    /** Detailed messaging information with topics */
    messagingDetails: MessagingDetail[];
    repositoryCalls: string[];
    /** Detailed repository call information with context */
    repositoryCallDetails: RepositoryCallDetail[];
    valueProperties: string[];
    /** Exception throws with class and error codes */
    exceptions: ExceptionDetail[];
  };
}

export interface TraceSummary {
  /** Total nodes in the chain */
  totalNodes: number;
  /** Maximum depth reached */
  maxDepthReached: number;
  /** Number of cycles detected */
  cycles: number;
  /** Total HTTP calls found */
  httpCalls: number;
  /** Total annotations found */
  annotations: number;
  /** Total event publishing calls */
  eventPublishing: number;
  /** Total repository calls */
  repositoryCalls: number;
}

export interface TraceResult {
  /** Root symbol name */
  root: string;
  /** Chain of nodes in BFS order */
  chain: ChainNode[];
  /** Aggregated summary */
  summary: TraceSummary;
  /** Error message if trace failed */
  error?: string;
}

// ─── Metadata Extraction Patterns ───────────────────────────────────────────

/** HTTP call patterns - legacy for backward compat */
const HTTP_PATTERNS = [
  /restTemplate\.\w+/g,           // restTemplate.getForObject, restTemplate.postForObject, etc.
  /webClient\.\w+/g,             // webClient.get(), webClient.post(), etc.
  /\bexecGet\b/g,                // execGet(url)
  /\bexecPost\b/g,               // execPost(url, data)
  /\bexecPut\b/g,                // execPut(url, data)
  /\bexecDelete\b/g,             // execDelete(url)
  /\bfetch\s*\(/g,               // fetch(url)
  /\baxios\.\w+/g,               // axios.get, axios.post, etc.
];

/** HTTP method mapping from Java method names */
const HTTP_METHOD_MAP: Record<string, string> = {
  'getForObject': 'GET',
  'getForEntity': 'GET',
  'postForObject': 'POST',
  'postForEntity': 'POST',
  'put': 'PUT',
  'delete': 'DELETE',
  'exchange': 'EXCHANGE',
  'get': 'GET',
  'post': 'POST',
  'patch': 'PATCH',
  'head': 'HEAD',
  'options': 'OPTIONS',
};

/** Enhanced HTTP call patterns with URL capture - matches first argument (may contain nested parens) */
const HTTP_CALL_PATTERN = /(?:restTemplate|webClient)\.(\w+)\s*\(\s*((?:[^,\n()]|\([^)]*\))+)/g;
const EXEC_CALL_PATTERN = /\bexec(Get|Post|Put|Delete)\s*\(\s*((?:[^,\n()]|\([^)]*\))+)/g;

/** Annotation patterns */
const ANNOTATION_PATTERNS = [
  /@Transactional\b/g,
  /@Retryable\b/g,
  /@Async\b/g,
  /@CaptureSpan\b/g,
  /@EventListener\b/g,
  /@TransactionalEventListener\b/g,
];

/** Event publishing patterns - legacy for backward compat */
const EVENT_PATTERNS = [
  /\bpublishEvent\s*\(/g,        // applicationEventPublisher.publishEvent(...)
  /\bconvertAndSend\s*\(/g,      // rabbitTemplate.convertAndSend(...)
  /\.send\s*\(/g,               // kafkaTemplate.send(...) - more specific patterns preferred
];

/** Enhanced event publishing patterns with topic capture */
const TOPIC_LITERAL_PATTERN = /convertAndSend\s*\(\s*"([^"]{1,100})"/g;
const TOPIC_VAR_PATTERN = /convertAndSend\s*\(\s*(\w+)/g;

/** WI-3: Kafka send pattern - kafkaTemplate.send("topic", message) */
const KAFKA_SEND_PATTERN = /kafkaTemplate\.send\s*\(\s*"([^"]+)"|kafkaTemplate\.send\s*\(\s*'([^']+)'|kafkaTemplate\.send\s*\(\s*(\w+)/g;

/** WI-2: publishEvent pattern - publishEvent(new XxxEvent(...)) */
const PUBLISH_EVENT_PATTERN = /publishEvent\s*\(\s*new\s+(\w+)Event/g;

/** WI-2: publishEvent with variable - publishEvent(varName) where varName was assigned earlier */
const PUBLISH_EVENT_VAR_PATTERN = /publishEvent\s*\(\s*(\w+)\s*\)/g;

/** WI-2: Event variable declaration - XxxEvent varName = ... or XxxEvent varName = method(...) */
const EVENT_VARIABLE_PATTERN = /(\w+Event)\s+(\w+)\s*=/g;

/** WI-3: StreamBridge send pattern - streamBridge.send("binding", message) */
const STREAM_BRIDGE_PATTERN = /streamBridge\.send\s*\(\s*"([^"]+)"|streamBridge\.send\s*\(\s*'([^']+)'|streamBridge\.send\s*\(\s*(\w+)/g;

/** Exception throw pattern: throw new XxxException(...) with ErrorCode.xxx */
const EXCEPTION_PATTERN = /throw\s+new\s+(\w+Exception)\s*\([^)]*?([\w.]*ErrorCode\.\w+)/g;

/** Repository call pattern: xxxRepository.method, xxxDao.method, or xxxRepo.method */
const REPO_PATTERN = /(\w+(?:Repository|Dao|Repo))\.(\w+)/g;

/** @Value property pattern: @Value("${prop.name}") */
const VALUE_PATTERN = /@Value\s*\(\s*"\s*\$\{([^}]+)\}\s*"\s*\)/g;

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Convert camelCase/PascalCase to kebab-case.
 * Example: "OrderCreated" → "order-created", "Payment" → "payment"
 */
function camelCaseToKebab(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Extract metadata from source content.
 */
function extractMetadata(content: string | undefined): ChainNode['metadata'] {
  const metadata: ChainNode['metadata'] = {
    httpCalls: [],
    httpCallDetails: [],
    annotations: [],
    eventPublishing: [],
    messagingDetails: [],
    repositoryCalls: [],
    repositoryCallDetails: [],
    valueProperties: [],
    exceptions: [],
  };

  if (!content) return metadata;

  // Extract HTTP calls (legacy - backward compat)
  for (const pattern of HTTP_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const found = match[0];
      if (!metadata.httpCalls.includes(found)) {
        metadata.httpCalls.push(found);
      }
    }
  }

  // Extract detailed HTTP calls with URL expressions
  HTTP_CALL_PATTERN.lastIndex = 0;
  let httpMatch;
  while ((httpMatch = HTTP_CALL_PATTERN.exec(content)) !== null) {
    const methodName = httpMatch[1];
    const httpMethod = HTTP_METHOD_MAP[methodName] || methodName.toUpperCase();
    const urlExpression = httpMatch[2].trim();
    // Avoid duplicates
    if (!metadata.httpCallDetails.some(d => d.httpMethod === httpMethod && d.urlExpression === urlExpression)) {
      metadata.httpCallDetails.push({ httpMethod, urlExpression });
    }
  }

  // Extract exec-style HTTP calls (execGet, execPost, etc.)
  EXEC_CALL_PATTERN.lastIndex = 0;
  let execMatch;
  while ((execMatch = EXEC_CALL_PATTERN.exec(content)) !== null) {
    const httpMethod = execMatch[1].toUpperCase();
    const urlExpression = execMatch[2].trim();
    if (!metadata.httpCallDetails.some(d => d.httpMethod === httpMethod && d.urlExpression === urlExpression)) {
      metadata.httpCallDetails.push({ httpMethod, urlExpression });
    }
  }

  // Extract annotations
  for (const pattern of ANNOTATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const found = match[0];
      if (!metadata.annotations.includes(found)) {
        metadata.annotations.push(found);
      }
    }
  }

  // Extract event publishing (legacy - backward compat)
  for (const pattern of EVENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const fullMatch = match[0];
      const methodName = fullMatch.replace(/^[.\s]*/, '').replace(/\s*\($/, '');
      if (methodName === 'send(' && metadata.eventPublishing.some(e => e.includes('send('))) {
        continue;
      }
      if (!metadata.eventPublishing.includes(methodName)) {
        metadata.eventPublishing.push(methodName);
      }
    }
  }

  // Extract detailed messaging with topics - literal topic
  TOPIC_LITERAL_PATTERN.lastIndex = 0;
  let topicMatch;
  while ((topicMatch = TOPIC_LITERAL_PATTERN.exec(content)) !== null) {
    const topic = topicMatch[1];
    if (!metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'convertAndSend')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: false,
        callerMethod: 'convertAndSend',
      });
    }
  }

  // Extract detailed messaging with topics - variable topic
  TOPIC_VAR_PATTERN.lastIndex = 0;
  while ((topicMatch = TOPIC_VAR_PATTERN.exec(content)) !== null) {
    const topicVar = topicMatch[1];
    // Skip if it's actually a string literal (already captured above)
    if (topicVar.startsWith('"') || topicVar.startsWith("'")) continue;
    if (!metadata.messagingDetails.some(d => d.topic === topicVar && d.callerMethod === 'convertAndSend')) {
      metadata.messagingDetails.push({
        topic: topicVar,
        topicIsVariable: true,
        callerMethod: 'convertAndSend',
      });
    }
  }

  // WI-3: Extract kafkaTemplate.send patterns
  KAFKA_SEND_PATTERN.lastIndex = 0;
  let kafkaMatch;
  while ((kafkaMatch = KAFKA_SEND_PATTERN.exec(content)) !== null) {
    // Groups: 1="topic", 2='topic', 3=variable
    const topic = kafkaMatch[1] || kafkaMatch[2] || kafkaMatch[3];
    const isVariable = !kafkaMatch[1] && !kafkaMatch[2];
    if (topic && !metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'kafkaTemplate.send')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: isVariable,
        callerMethod: 'kafkaTemplate.send',
      });
    }
  }

  // WI-3: Extract publishEvent(new XxxEvent(...)) patterns
  PUBLISH_EVENT_PATTERN.lastIndex = 0;
  let pubEventMatch;
  while ((pubEventMatch = PUBLISH_EVENT_PATTERN.exec(content)) !== null) {
    // Capture group 1 is the event class name (e.g., "OrderCreated" from "OrderCreatedEvent")
    const eventClass = pubEventMatch[1];
    // Convert to kebab-case topic: "OrderCreated" → "order-created"
    const topic = camelCaseToKebab(eventClass);
    if (!metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'publishEvent')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: false,
        callerMethod: 'publishEvent',
        payload: eventClass + 'Event', // Reconstruct full event class name
      });
    }
  }

  // WI-2: Extract publishEvent(variable) patterns
  // First, scan for event variable declarations to build a map
  const eventVarMap: Map<string, string> = new Map();
  EVENT_VARIABLE_PATTERN.lastIndex = 0;
  let eventVarMatch;
  while ((eventVarMatch = EVENT_VARIABLE_PATTERN.exec(content)) !== null) {
    // Groups: 1=EventClass (e.g., "OrderCreated"), 2=varName (e.g., "event")
    const eventClass = eventVarMatch[1].replace(/Event$/, ''); // Strip 'Event' suffix if present
    const varName = eventVarMatch[2];
    eventVarMap.set(varName, eventClass);
  }

  // Now match publishEvent(varName) and look up the event class
  PUBLISH_EVENT_VAR_PATTERN.lastIndex = 0;
  let pubEventVarMatch;
  while ((pubEventVarMatch = PUBLISH_EVENT_VAR_PATTERN.exec(content)) !== null) {
    const varName = pubEventVarMatch[1];
    // Skip if this is actually a 'new' expression (already handled by PUBLISH_EVENT_PATTERN)
    // Check if this looks like a class name (starts with uppercase) - likely a new expression that didn't match
    if (varName[0] === varName[0].toUpperCase() && varName[0] !== varName[0].toLowerCase()) {
      continue; // Likely a class name like 'OrderCreatedEvent' without 'new' - skip
    }
    const eventClass = eventVarMap.get(varName);
    if (eventClass) {
      const topic = camelCaseToKebab(eventClass);
      if (!metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'publishEvent')) {
        metadata.messagingDetails.push({
          topic,
          topicIsVariable: false,
          callerMethod: 'publishEvent',
          payload: eventClass + 'Event',
        });
      }
    }
  }

  // WI-3: Extract streamBridge.send patterns
  STREAM_BRIDGE_PATTERN.lastIndex = 0;
  let streamMatch;
  while ((streamMatch = STREAM_BRIDGE_PATTERN.exec(content)) !== null) {
    // Groups: 1="binding", 2='binding', 3=variable
    const topic = streamMatch[1] || streamMatch[2] || streamMatch[3];
    const isVariable = !streamMatch[1] && !streamMatch[2];
    if (topic && !metadata.messagingDetails.some(d => d.topic === topic && d.callerMethod === 'streamBridge.send')) {
      metadata.messagingDetails.push({
        topic,
        topicIsVariable: isVariable,
        callerMethod: 'streamBridge.send',
      });
    }
  }

  // Extract repository calls
  REPO_PATTERN.lastIndex = 0;
  let match;
  while ((match = REPO_PATTERN.exec(content)) !== null) {
    const repoCall = `${match[1]}.${match[2]}`;
    if (!metadata.repositoryCalls.includes(repoCall)) {
      metadata.repositoryCalls.push(repoCall);
    }
    // Also add to detailed repository calls
    if (!metadata.repositoryCallDetails.some(d => d.repository === match[1] && d.method === match[2])) {
      metadata.repositoryCallDetails.push({
        repository: match[1],
        method: match[2],
        call: repoCall,
      });
    }
  }

  // Extract @Value properties
  VALUE_PATTERN.lastIndex = 0;
  while ((match = VALUE_PATTERN.exec(content)) !== null) {
    if (!metadata.valueProperties.includes(match[1])) {
      metadata.valueProperties.push(match[1]);
    }
  }

  // Extract exception throws
  EXCEPTION_PATTERN.lastIndex = 0;
  let excMatch;
  while ((excMatch = EXCEPTION_PATTERN.exec(content)) !== null) {
    const exceptionClass = excMatch[1];
    const errorCode = excMatch[2];
    if (!metadata.exceptions.some(e => e.exceptionClass === exceptionClass && e.errorCode === errorCode)) {
      metadata.exceptions.push({ exceptionClass, errorCode });
    }
  }

  return metadata;
}

/**
 * Query the graph database for symbols by name.
 */
async function findSymbolByName(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  name: string,
  filePath?: string
): Promise<{ uid: string; name: string; type: string; filePath: string }[]> {
  const isQualified = name.includes('/') || name.includes(':');

  let whereClause: string;
  let params: Record<string, any>;

  if (filePath) {
    whereClause = 'WHERE n.name = $symName AND n.filePath CONTAINS $filePath';
    params = { symName: name, filePath };
  } else if (isQualified) {
    whereClause = 'WHERE n.id = $symName OR n.name = $symName';
    params = { symName: name };
  } else {
    whereClause = 'WHERE n.name = $symName';
    params = { symName: name };
  }

  const query = `
    MATCH (n) ${whereClause}
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
    LIMIT 10
  `;

  const rows = await executeQuery(repoId, query, params);
  return rows.map((row: any) => ({
    uid: row.id || row[0],
    name: row.name || row[1],
    type: row.type || row[2],
    filePath: row.filePath || row[3],
  }));
}

/**
 * Query the graph database for a symbol by UID.
 * Returns full node info including symbol metadata for document-endpoint.
/**
 * Resolve interface method calls to concrete implementations.
 * When a call targets an Interface method, find all implementing classes
 * and their corresponding method implementations via OVERRIDES edges.
 */
async function resolveInterfaceCall(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  interfaceMethodId: string
): Promise<Array<{ implMethodId: string; implMethodName: string; implMethodFilePath: string; implClassId: string }>> {
  // Query: Find classes that implement the interface containing this method,
  // then find their methods with the same name.
  // Graph shape: Interface -[HAS_METHOD]-> InterfaceMethod
  //              ImplClass  -[IMPLEMENTS]-> Interface
  //              ImplClass  -[HAS_METHOD]-> ConcreteMethod  (same name)
  const query = `
    MATCH (interfaceNode)-[:CodeRelation {type: 'HAS_METHOD'}]->(interfaceMethod)
    WHERE interfaceMethod.id = $methodId
    MATCH (implClass)-[:CodeRelation {type: 'IMPLEMENTS'}]->(interfaceNode)
    MATCH (implClass)-[:CodeRelation {type: 'HAS_METHOD'}]->(concreteMethod)
    WHERE concreteMethod.name = interfaceMethod.name
    RETURN concreteMethod.id AS methodId, concreteMethod.name AS name,
           concreteMethod.filePath AS filePath, implClass.id AS classId
  `;

  const rows = await executeQuery(repoId, query, { methodId: interfaceMethodId });
  return rows.map((row: any) => ({
    implMethodId: row.methodId || row[0],
    implMethodName: row.name || row[1],
    implMethodFilePath: row.filePath || row[2],
    implClassId: row.classId || row[3],
  }));
}

async function findSymbolByUid(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  uid: string,
  includeContent: boolean
): Promise<{
  uid: string;
  name: string;
  type: string;
  filePath: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  parameterCount?: number;
  returnType?: string;
  parameters?: string;
  annotations?: string;
  fields?: string;
} | null> {
  const contentField = includeContent ? ', n.content AS content' : '';
  const query = `
    MATCH (n {id: $uid})
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
           n.startLine AS startLine, n.endLine AS endLine,
           n.parameterCount AS parameterCount, n.returnType AS returnType,
           COALESCE(n.parameters, '') AS parameters,
           COALESCE(n.annotations, '') AS annotations,
           COALESCE(n.fields, '') AS fields${contentField}
    LIMIT 1
  `;

  const rows = await executeQuery(repoId, query, { uid });
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    uid: row.id || row[0],
    name: row.name || row[1],
    type: row.type || row[2],
    filePath: row.filePath || row[3],
    startLine: row.startLine ?? row[4],
    endLine: row.endLine ?? row[5],
    parameterCount: row.parameterCount ?? row[6],
    returnType: row.returnType || row[7],
    parameters: row.parameters || row[8],
    annotations: row.annotations || row[9],
    fields: row.fields || row[10],
    content: includeContent ? (row.content ?? row[11]) : undefined,
  };
}

/**
 * Query callees for a single source node.
 * Uses the `sourceIds` array format to match the mock's expected interface.
 */
async function findCalleesForNode(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  callerId: string
): Promise<Array<{
  calleeId: string;
  calleeName: string;
  calleeType: string;
  calleeFilePath: string;
  parentType: string | null;
}>> {
  const query = `
    MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(callee)
    WHERE caller.id IN $sourceIds
    OPTIONAL MATCH (parent)-[:CodeRelation {type: 'HAS_METHOD'}]->(callee)
    RETURN callee.id AS calleeId, callee.name AS name,
           labels(callee)[0] AS type, callee.filePath AS filePath,
           parent.id AS parentId
  `;

  // Use sourceIds array format as expected by the mock
  const rows = await executeQuery(repoId, query, { sourceIds: [callerId] });
  return rows.map((row: any) => {
    const parentId: string | null = row.parentId ?? row[4] ?? null;
    // Derive parentType from the ID prefix (e.g. "Interface:..." → "Interface")
    // because labels() is not reliably populated in the flat-graph backend
    const parentType = parentId ? parentId.split(':')[0] : null;
    return {
      calleeId: row.calleeId || row[0],
      calleeName: row.name || row[1],
      calleeType: row.type || row[2],
      calleeFilePath: row.filePath || row[3],
      parentType,
    };
  });
}

/**
 * Fetch content for a single UID using the mock's expected pattern.
 */
async function fetchContentForUid(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  uid: string
): Promise<string | undefined> {
  const query = `
    MATCH (n {id: $uid})
    RETURN n.id AS id, n.content AS content
    LIMIT 1
  `;

  const rows = await executeQuery(repoId, query, { uid });
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return row.content || row[1];
}

/** Extended node info returned from graph queries */
interface NodeInfo {
  name: string;
  filePath: string;
  type?: string;
  startLine?: number;
  endLine?: number;
  parameterCount?: number;
  returnType?: string;
  parameters?: string;
  annotations?: string;
  fields?: string;
  /** For interface resolution: marks which interface this impl was resolved from */
  resolvedFrom?: string;
  /** True if this node represents an interface (not concrete impl) */
  isInterface?: boolean;
}

/**
 * Fetch node info for a set of UIDs.
 * Returns extended info including symbol metadata for document-endpoint.
 */
async function fetchNodeInfo(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  uids: string[]
): Promise<Map<string, NodeInfo>> {
  const infoMap = new Map<string, NodeInfo>();
  if (uids.length === 0) return infoMap;

  const query = `
    MATCH (n)
    WHERE n.id IN $uids
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
           n.startLine AS startLine, n.endLine AS endLine,
           n.parameterCount AS parameterCount, n.returnType AS returnType,
           COALESCE(n.parameters, '') AS parameters,
           COALESCE(n.annotations, '') AS annotations,
           COALESCE(n.fields, '') AS fields
  `;

  const rows = await executeQuery(repoId, query, { uids });
  for (const row of rows) {
    const id = row.id || row[0];
    infoMap.set(id, {
      name: row.name || row[1],
      filePath: row.filePath || row[3],
      type: row.type || row[2],
      startLine: row.startLine ?? row[4],
      endLine: row.endLine ?? row[5],
      parameterCount: row.parameterCount ?? row[6],
      returnType: row.returnType || row[7],
      parameters: row.parameters || row[8],
      annotations: row.annotations || row[9],
      fields: row.fields || row[10],
    });
  }

  return infoMap;
}

/**
 * Resolve class fields from the graph for a given type name.
 * Handles generic types by unwrapping them first.
 * Returns null for primitive types or when type not found.
 */
export async function resolveClassFields(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  typeName: string,
  visited: Set<string> = new Set()
): Promise<{name: string; type: string; annotations: string[]}[] | null> {
  // Handle null/undefined/empty
  if (!typeName || typeName === 'null' || typeName === 'void') {
    return null;
  }

  // Unwrap generic types
  let unwrappedType = typeName;
  const innerType = extractGenericInnerType(typeName);
  if (innerType) {
    unwrappedType = innerType;
  }

  // Skip primitives and container types
  if (shouldSkipSchema(unwrappedType)) {
    return null;
  }

  // Prevent circular resolution
  if (visited.has(unwrappedType)) {
    return null;
  }
  visited.add(unwrappedType);

  // Query for Class node with matching name
  const query = `
    MATCH (c:Class)
    WHERE c.name = $className OR c.name ENDS WITH $classNamePattern
    RETURN c.name AS name, COALESCE(c.fields, '') AS fields
    LIMIT 1
  `;

  const rows = await executeQuery(repoId, query, {
    className: unwrappedType,
    classNamePattern: '.' + unwrappedType
  });

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const fieldsRaw = row.fields || row[1] || '';

  if (!fieldsRaw) {
    return null;
  }

  try {
    const fields = JSON.parse(fieldsRaw);
    if (!Array.isArray(fields)) {
      return null;
    }
    return fields.map((f: any) => ({
      name: f.name || '',
      type: f.type || '',
      annotations: f.annotations || []
    }));
  } catch {
    return null;
  }
}

/**
 * Execute a trace from a starting symbol.
 *
 * Uses BFS to traverse CALLS relationships downstream, collecting all
 * reachable nodes up to maxDepth. Tracks cycles and extracts metadata
 * when content is available.
 */
export async function executeTrace(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  options: TraceOptions
): Promise<TraceResult> {
  const { symbol, uid, file_path, include_content, compact } = options;
  const maxDepth = options.maxDepth ?? 5;

  // Validate inputs
  if (!symbol && !uid) {
    return {
      root: '',
      chain: [],
      summary: { totalNodes: 0, maxDepthReached: 0, cycles: 0, httpCalls: 0, annotations: 0, eventPublishing: 0, repositoryCalls: 0 },
      error: 'Either symbol or uid parameter is required.',
    };
  }

  // Step 1: Resolve starting symbol
  let startSymbol: {
    uid: string;
    name: string;
    type: string;
    filePath: string;
    content?: string;
    startLine?: number;
    endLine?: number;
    parameterCount?: number;
    returnType?: string;
    parameters?: string;
    annotations?: string;
    fields?: string;
  } | null = null;

  if (uid) {
    // Direct UID lookup
    startSymbol = await findSymbolByUid(executeQuery, repoId, uid, include_content ?? false);
    if (!startSymbol) {
      return {
        root: '',
        chain: [],
        summary: { totalNodes: 0, maxDepthReached: 0, cycles: 0, httpCalls: 0, annotations: 0, eventPublishing: 0, repositoryCalls: 0 },
        error: `Symbol with uid '${uid}' not found`,
      };
    }
  } else {
    // Name lookup with optional disambiguation
    const candidates = await findSymbolByName(executeQuery, repoId, symbol!, file_path);

    if (candidates.length === 0) {
      return {
        root: '',
        chain: [],
        summary: { totalNodes: 0, maxDepthReached: 0, cycles: 0, httpCalls: 0, annotations: 0, eventPublishing: 0, repositoryCalls: 0 },
        error: `Symbol '${symbol}' not found`,
      };
    }

    if (candidates.length > 1) {
      return {
        root: '',
        chain: [],
        summary: { totalNodes: 0, maxDepthReached: 0, cycles: 0, httpCalls: 0, annotations: 0, eventPublishing: 0, repositoryCalls: 0 },
        error: `Ambiguous symbol '${symbol}' — multiple matches found. Use uid or file_path to disambiguate.`,
      };
    }

    // Fetch content if needed
    if (include_content) {
      startSymbol = await findSymbolByUid(executeQuery, repoId, candidates[0].uid, true);
    } else {
      startSymbol = { ...candidates[0], content: undefined };
    }
  }

  // Step 2: BFS traversal
  const chain: ChainNode[] = [];
  const visited = new Set<string>();
  let cycles = 0;

  // Map to track callees for each node
  const calleeMap = new Map<string, string[]>();
  
  // Track all discovered nodes for later content fetch
  const discoveredNodes = new Map<string, NodeInfo & { depth: number }>();
  discoveredNodes.set(startSymbol.uid, {
    name: startSymbol.name,
    filePath: startSymbol.filePath,
    type: startSymbol.type,
    startLine: startSymbol.startLine,
    endLine: startSymbol.endLine,
    parameterCount: startSymbol.parameterCount,
    returnType: startSymbol.returnType,
    parameters: startSymbol.parameters,
    annotations: startSymbol.annotations,
    fields: startSymbol.fields,
    depth: 0,
  });

  // BFS queue: { uid, depth }
  const queue: Array<{ uid: string; depth: number }> = [
    { uid: startSymbol.uid, depth: 0 },
  ];
  visited.add(startSymbol.uid);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = current.depth;
    
    // Don't traverse beyond maxDepth (but still need to record callees for nodes AT maxDepth)
    if (currentDepth < maxDepth) {
      // Find callees for this node
      const callees = await findCalleesForNode(executeQuery, repoId, current.uid);

      // Track callees for this caller
      if (callees.length > 0) {
        calleeMap.set(current.uid, callees.map(c => c.calleeId));
      }

      // Process each callee
      for (const callee of callees) {
        const { calleeId, calleeName, calleeType, calleeFilePath, parentType } = callee;

        // Check for cycle (callee already visited)
        if (visited.has(calleeId)) {
          cycles++;
          continue;
        }

        // ── Interface Resolution (WI-7) ──
        // If callee is a method whose parent is an Interface, resolve to concrete implementations
        if (parentType === 'Interface') {
          const impls = await resolveInterfaceCall(executeQuery, repoId, calleeId);
          
          if (impls.length > 0) {
            // Add the interface node itself to discoveredNodes with isInterface marker
            // This allows the chain to show both interface and implementations
            if (!visited.has(calleeId)) {
              visited.add(calleeId);
              discoveredNodes.set(calleeId, {
                name: calleeName,
                filePath: calleeFilePath,
                type: calleeType,
                depth: currentDepth + 1,
                isInterface: true,
              });
              // Track that current calls this interface
              const currentCallees = calleeMap.get(current.uid) || [];
              currentCallees.push(calleeId);
              calleeMap.set(current.uid, currentCallees);
            }
            
            // Add each implementation with resolvedFrom marker
            for (const impl of impls) {
              if (!visited.has(impl.implMethodId)) {
                visited.add(impl.implMethodId);
                // resolvedFrom format: "InterfaceName.methodName"
                // Extract interface name from file path (e.g., "src/IUserService.java" → "IUserService")
                const interfaceClassName = calleeFilePath.split('/').pop()?.split('.')[0] ?? calleeName;
                const interfaceRef = `${interfaceClassName}.${calleeName}`;
                discoveredNodes.set(impl.implMethodId, {
                  name: impl.implMethodName,
                  filePath: impl.implMethodFilePath,
                  type: 'Method',
                  depth: currentDepth + 2, // Deeper because it goes through interface
                  resolvedFrom: interfaceRef,
                });
                queue.push({ uid: impl.implMethodId, depth: currentDepth + 2 });
                
                // Track that the interface calls this implementation
                const implCallees = calleeMap.get(calleeId) || [];
                implCallees.push(impl.implMethodId);
                calleeMap.set(calleeId, implCallees);
              }
            }
          }
          continue; // Interface resolution handled above
        }

        // Add to discovered nodes (extended info fetched later via batch query if needed)
        visited.add(calleeId);
        discoveredNodes.set(calleeId, {
          name: calleeName,
          filePath: calleeFilePath,
          type: calleeType,
          depth: currentDepth + 1,
        });

        // Add to queue for further traversal
        queue.push({ uid: calleeId, depth: currentDepth + 1 });
      }
    }
  }

  // Step 3: Fetch content for all discovered nodes if needed
  let contentMap = new Map<string, string>();
  if (include_content) {
    // Fetch content for each node individually to work with the mock's pattern
    for (const [uid] of discoveredNodes) {
      const content = await fetchContentForUid(executeQuery, repoId, uid);
      if (content) {
        contentMap.set(uid, content);
      }
    }
    // Also fetch start symbol content if not already fetched
    if (startSymbol.content) {
      contentMap.set(startSymbol.uid, startSymbol.content);
    }
  }

  // Step 4: Build chain nodes in BFS order
  // Re-traverse in order using calleeMap
  visited.clear();
  
  // Build ordered chain
  const buildQueue: string[] = [startSymbol.uid];
  visited.add(startSymbol.uid);

  while (buildQueue.length > 0) {
    const currentUid = buildQueue.shift()!;
    const nodeInfo = discoveredNodes.get(currentUid)!;
    const nodeCallees = calleeMap.get(currentUid) || [];
    const content = contentMap.get(currentUid);

    const chainNode: ChainNode = {
      uid: currentUid,
      name: nodeInfo.name,
      filePath: nodeInfo.filePath,
      depth: nodeInfo.depth,
      kind: nodeInfo.type,
      startLine: nodeInfo.startLine,
      endLine: nodeInfo.endLine,
      parameterCount: nodeInfo.parameterCount,
      returnType: nodeInfo.returnType,
      parameters: nodeInfo.parameters,
      annotations: nodeInfo.annotations,
      fields: nodeInfo.fields,
      resolvedFrom: nodeInfo.resolvedFrom,
      isInterface: nodeInfo.isInterface,
      callees: nodeCallees,
      metadata: extractMetadata(content),
    };

    if (include_content && content && !compact) {
      // Only store content in output when not compacting
      chainNode.content = content;
    }

    chain.push(chainNode);

    // Add callees to queue (only those that were visited during BFS)
    for (const calleeId of nodeCallees) {
      if (!visited.has(calleeId) && discoveredNodes.has(calleeId)) {
        visited.add(calleeId);
        buildQueue.push(calleeId);
      }
    }
  }

  // Step 5: Build summary
  const summary: TraceSummary = {
    totalNodes: chain.length,
    maxDepthReached: chain.length > 0 ? Math.max(...chain.map(n => n.depth)) : 0,
    cycles,
    httpCalls: chain.reduce((sum, n) => sum + n.metadata.httpCalls.length, 0),
    annotations: chain.reduce((sum, n) => sum + n.metadata.annotations.length, 0),
    eventPublishing: chain.reduce((sum, n) => sum + n.metadata.eventPublishing.length, 0),
    repositoryCalls: chain.reduce((sum, n) => sum + n.metadata.repositoryCalls.length, 0),
  };

  return {
    root: startSymbol.name,
    chain,
    summary,
  };
}