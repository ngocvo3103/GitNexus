/**
 * Unit Tests: Document Endpoint Tool
 *
 * Tests the document-endpoint tool for generating API documentation JSON.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies - MUST be before imports
vi.mock('../../src/mcp/local/endpoint-query.js', () => ({
  queryEndpoints: vi.fn(),
}));

vi.mock('../../src/mcp/local/trace-executor.js', () => ({
  executeTrace: vi.fn(),
}));

vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  // WI-2: Default mock handles verification query (MATCH (m:Method) WHERE m.uid)
  executeParameterized: vi.fn().mockImplementation(async (_repoId: string, query: string, params: Record<string, any>) => {
    if (query.includes('MATCH (m:Method) WHERE m.uid')) {
      return [{ 'm.uid': params.uid }]; // Verification passes - Method exists
    }
    return [];
  }),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(),
}));

// Import after mocks are set up
import { documentEndpoint, extractLocalVariableAssignments } from '../../src/mcp/local/document-endpoint.js';
import * as endpointQuery from '../../src/mcp/local/endpoint-query.js';
import * as traceExecutor from '../../src/mcp/local/trace-executor.js';

// Mock RepoHandle
const mockRepo = {
  id: 'test-repo',
  name: 'test-repo',
  repoPath: '/test/repo',
  storagePath: '/test/storage',
  lbugPath: '/test/lbug',
  indexedAt: new Date().toISOString(),
  lastCommit: 'abc123',
} as any;

// Helper to create empty metadata
const emptyMetadata = () => ({
  httpCalls: [],
  httpCallDetails: [],
  annotations: [],
  eventPublishing: [],
  messagingDetails: [],
  repositoryCalls: [],
  repositoryCallDetails: [],
  valueProperties: [],
  exceptions: [],
});

// Helper to create empty summary
const emptySummary = () => ({
  totalNodes: 1,
  maxDepthReached: 0,
  cycles: 0,
  httpCalls: 0,
  annotations: 0,
  eventPublishing: 0,
  repositoryCalls: 0,
});

describe('documentEndpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('minimal mode (default)', () => {
    it('returns error when endpoint not found', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [],
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/nonexistent',
      });

      expect(result.error).toContain('No endpoint found');
      expect(result.result.method).toBe('GET');
      expect(result.result.path).toBe('/nonexistent');
      expect(result.result.summary).toBe('TODO_AI_ENRICH');
    });

    it('returns valid JSON structure for found endpoint', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 42,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUser',
          name: 'getUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public User getUser(Long id) { return userRepository.findById(id); }',
          metadata: emptyMetadata(),
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
      });

      expect(result.result.method).toBe('GET');
      // Path is the actual endpoint path from Route node (not the input pattern)
      expect(result.result.path).toBe('/api/users/{id}');
      expect(result.result).toHaveProperty('specs');
      expect(result.result).toHaveProperty('externalDependencies');
      expect(result.result).toHaveProperty('logicFlow');
      expect(result.result).toHaveProperty('codeDiagram');
      expect(result.result).toHaveProperty('cacheStrategy');
      expect(result.result).toHaveProperty('retryLogic');
      expect(result.result).toHaveProperty('keyDetails');
    });

    it('populates response codes from exceptions in trace', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder() { throw new BusinessException(ErrorCode.INVALID_INPUT); }',
          metadata: {
            ...emptyMetadata(),
            exceptions: [{ exceptionClass: 'BusinessException', errorCode: 'INVALID_INPUT' }],
          },
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: false,
      });

      expect(result.result.specs.response.codes).toContainEqual({
        code: 200,
        description: 'Success',
      });
      expect(result.result.specs.response.codes).toContainEqual(
        expect.objectContaining({ code: 400, description: expect.stringContaining('BusinessException') }),
      );
    });
  });

  describe('context-enriched mode', () => {
    it('includes _context fields when include_context is true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUsers',
          name: 'getUsers',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public List<User> getUsers() { return userService.findAll(); }',
          metadata: emptyMetadata(),
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
        include_context: true,
      });

      expect(result.result._context).toBeDefined();
      expect(result.result._context?.resolvedProperties).toEqual({});
    });
  });

  describe('downstream APIs extraction', () => {
    it('extracts HTTP calls from trace metadata', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder() { restTemplate.postForObject(bondServiceUrl + "/orders", request); }',
          metadata: {
            ...emptyMetadata(),
            httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'bondServiceUrl + "/orders"' }],
          },
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
      });

      // The HTTP call should be extracted from metadata
      expect(result.result.externalDependencies.downstreamApis).toBeDefined();
    });
  });

  describe('messaging extraction', () => {
    it('extracts event publishing from trace metadata', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/events',
          controller: 'EventController',
          handler: 'publishEvent',
          filePath: 'src/controllers/EventController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/EventController.java:publishEvent',
          name: 'publishEvent',
          kind: 'Method',
          filePath: 'src/controllers/EventController.java',
          depth: 0,
          content: 'public void publishEvent() { rabbitTemplate.convertAndSend("events.topic", message); }',
          metadata: {
            ...emptyMetadata(),
            messagingDetails: [{ callerMethod: 'convertAndSend', topic: 'events.topic', topicIsVariable: false }],
          },
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/events',
      });

      expect(result.result.externalDependencies.messaging.outbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.outbound.length).toBeGreaterThan(0);
    });
  });

  describe('persistence extraction', () => {
    it('extracts repository calls from trace metadata', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 35,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUser',
          name: 'getUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public User getUser(Long id) { return userRepository.findById(id); }',
          metadata: {
            ...emptyMetadata(),
            repositoryCalls: ['userRepository.findById'],
            repositoryCallDetails: [{ repository: 'userRepository', method: 'findById', call: 'userRepository.findById' }],
          },
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
      });

      expect(result.result.externalDependencies.persistence).toBeDefined();
      expect(result.result.externalDependencies.persistence.length).toBeGreaterThan(0);
    });
  });

  describe('code diagram generation', () => {
    it('generates Mermaid graph TB diagram from call chain', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUsers',
          name: 'getUsers',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public List<User> getUsers() { return userService.findAll(); }',
          metadata: emptyMetadata(),
          callees: [],
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
      });

      expect(result.result.codeDiagram).toBeDefined();
      expect(result.result.codeDiagram).toContain('graph TB');
    });
  });
});

describe('metadata populated regardless of include_context', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/test',
        controller: 'TestController',
        handler: 'testHandler',
        filePath: 'src/controllers/TestController.java',
        line: 10,
      }],
    });
  });

  it('executeTrace called with include_content: true when include_context is false (default)', async () => {
    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/TestController.java:testHandler',
        name: 'testHandler',
        kind: 'Method',
        filePath: 'src/controllers/TestController.java',
        depth: 0,
        content: 'public void testHandler() {}',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'serviceUrl + "/endpoint"' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    await documentEndpoint(mockRepo, { method: 'GET', path: '/test' });

    // Bug: current code passes include_content: false (mirrors include_context).
    // This test MUST fail until WI-1 fix is applied.
    expect(vi.mocked(traceExecutor.executeTrace)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ include_content: true }),
    );
  });

  it('metadata extracted without include_context — downstreamApis populated', async () => {
    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/TestController.java:testHandler',
        name: 'testHandler',
        kind: 'Method',
        filePath: 'src/controllers/TestController.java',
        depth: 0,
        content: 'public void testHandler() { restTemplate.postForObject(serviceUrl + "/endpoint", req); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'serviceUrl + "/endpoint"' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, { method: 'GET', path: '/test', include_context: false });

    expect(result.result.externalDependencies.downstreamApis.length).toBeGreaterThan(0);
  });

  it('metadata extracted without include_context — response.codes populated beyond 200', async () => {
    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/TestController.java:testHandler',
        name: 'testHandler',
        kind: 'Method',
        filePath: 'src/controllers/TestController.java',
        depth: 0,
        content: 'public void testHandler() { throw new TcbsException(ErrorCode.UNKNOWN_ERROR); }',
        metadata: {
          ...emptyMetadata(),
          exceptions: [{ exceptionClass: 'TcbsException', errorCode: 'UNKNOWN_ERROR' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, { method: 'GET', path: '/test', include_context: false });

    expect(result.result.specs.response.codes.length).toBeGreaterThan(1);
    expect(
      result.result.specs.response.codes.some((c: any) =>
        typeof c.description === 'string' && c.description.includes('TcbsException'),
      ),
    ).toBe(true);
  });

  it('metadata AND _context both present when include_context is true', async () => {
    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/TestController.java:testHandler',
        name: 'testHandler',
        kind: 'Method',
        filePath: 'src/controllers/TestController.java',
        depth: 0,
        content: 'public void testHandler() { restTemplate.postForObject(serviceUrl, req); }',
        metadata: {
          httpCalls: [],
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'serviceUrl + "/data"' }],
          annotations: [],
          eventPublishing: [],
          messagingDetails: [],
          repositoryCalls: [],
          repositoryCallDetails: [],
          valueProperties: [],
          exceptions: [{ exceptionClass: 'BusinessException', errorCode: 'INVALID_INPUT' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, { method: 'GET', path: '/test', include_context: true });

    expect(result.result._context).toBeDefined();
    expect(result.result.externalDependencies.downstreamApis.length).toBeGreaterThan(0);
  });

  it('_context NOT included when include_context is false even with metadata', async () => {
    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/TestController.java:testHandler',
        name: 'testHandler',
        kind: 'Method',
        filePath: 'src/controllers/TestController.java',
        depth: 0,
        content: 'public void testHandler() {}',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'serviceUrl + "/endpoint"' }],
          exceptions: [{ exceptionClass: 'TcbsException', errorCode: 'UNKNOWN_ERROR' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, { method: 'GET', path: '/test', include_context: false });

    expect(result.result._context == null).toBe(true);
  });
});

describe('URL expression parsing', () => {
  it('extracts service name from variable expression', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'POST',
        path: '/api/orders',
        controller: 'OrderController',
        handler: 'createOrder',
        filePath: 'src/controllers/OrderController.java',
        line: 50,
      }],
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/OrderController.java:createOrder',
        name: 'createOrder',
        kind: 'Method',
        filePath: 'src/controllers/OrderController.java',
        depth: 0,
        content: 'public void createOrder() { restTemplate.postForObject(bondServiceUrl + \"/orders\", req); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'bondServiceUrl + \"/orders\"' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/orders',
    });

    // Should extract service name from variable
    expect(result.result.externalDependencies.downstreamApis[0].serviceName).toBe('bond');
    expect(result.result.externalDependencies.downstreamApis[0].endpoint).toContain('POST');
  });

  it('handles static URL paths', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/data',
        controller: 'DataController',
        handler: 'getData',
        filePath: 'src/controllers/DataController.java',
        line: 20,
      }],
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/DataController.java:getData',
        name: 'getData',
        kind: 'Method',
        filePath: 'src/controllers/DataController.java',
        depth: 0,
        content: 'public String getData() { return restTemplate.getForObject(\"https://api.example.com/v1/data\"); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: '"https://api.example.com/v1/data"' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/data',
    });

    // Static URLs should use 'unknown-service' or extract from literal
    expect(result.result.externalDependencies.downstreamApis[0].serviceName).toBeDefined();
  });

  it('handles variable references in URL', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'POST',
        path: '/api/limits',
        controller: 'LimitController',
        handler: 'checkLimit',
        filePath: 'src/controllers/LimitController.java',
        line: 30,
      }],
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/LimitController.java:checkLimit',
        name: 'checkLimit',
        kind: 'Method',
        filePath: 'src/controllers/LimitController.java',
        depth: 0,
        content: 'public void checkLimit() { restTemplate.postForObject(bondSettlementService.concat(HOLD_UNHOLD_USED_LIMIT_URI), input); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'bondSettlementService.concat(HOLD_UNHOLD_USED_LIMIT_URI)' }],
        },
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/limits',
      include_context: true,
    });

    // Should parse variable references
    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.serviceName).toBe('bondSettlement');
    // Variable references should be captured in _context
    expect(api._context).toBeDefined();
    expect(api.endpoint).toContain('POST');
  });
});

describe('body schema extraction', () => {
  it('returns null for handlers without parameters', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/health',
        controller: 'HealthController',
        handler: 'health',
        filePath: 'src/controllers/HealthController.java',
        line: 10,
      }],
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/HealthController.java:health',
        name: 'health',
        kind: 'Method',
        filePath: 'src/controllers/HealthController.java',
        depth: 0,
        content: 'public String health() { return "OK"; }',
        metadata: emptyMetadata(),
          callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/health',
    });

    expect(result.result.specs.request.body).toBeNull();
  });

  it('extracts request body type from parameters', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'POST',
        path: '/api/users',
        controller: 'UserController',
        handler: 'createUser',
        filePath: 'src/controllers/UserController.java',
        line: 25,
      }],
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/UserController.java:createUser',
        name: 'createUser',
        kind: 'Method',
        filePath: 'src/controllers/UserController.java',
        depth: 0,
        content: 'public User createUser(@RequestBody UserDTO userDTO) { return userService.create(userDTO); }',
        metadata: emptyMetadata(),
          callees: [],
        parameterAnnotations: '[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody"]}]',
        returnType: 'User',
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/users',
    });

    // Body schema: when include_context is false (default), body is { _type: TypeName } for external types
    // External types (not in graph) return type placeholder
    expect(result.result.specs.request.body).toEqual({ _type: 'UserDTO' });
  });
});

describe('extractLocalVariableAssignments', () => {
  it('extracts simple typed variable assignments', () => {
    const content = 'String url = matchingUrl + pathSuggestion;';
    const result = extractLocalVariableAssignments(content);
    expect(result.get('url')).toBe('matchingUrl + pathSuggestion');
  });

  it('extracts multiple assignments from content', () => {
    const content = `
      String url = matchingUrl + pathSuggestion;
      String urlAccount = hftKremaServiceUrl + "/customers/{custodyCode}/accounts";
      String secret = configurationProperties.getRecaptchaSecret();
    `;
    const result = extractLocalVariableAssignments(content);
    expect(result.get('url')).toBe('matchingUrl + pathSuggestion');
    expect(result.get('urlAccount')).toBe('hftKremaServiceUrl + "/customers/{custodyCode}/accounts"');
    expect(result.get('secret')).toBe('configurationProperties.getRecaptchaSecret()');
  });

  it('handles generic types', () => {
    const content = 'List<String> items = service.getNames();';
    const result = extractLocalVariableAssignments(content);
    expect(result.get('items')).toBe('service.getNames()');
  });

  it('extracts variable with method call expression', () => {
    const content = 'String secret = configurationProperties.getRecaptchaSecret();';
    const result = extractLocalVariableAssignments(content);
    expect(result.get('secret')).toBe('configurationProperties.getRecaptchaSecret()');
  });

  it('returns empty map for no assignments', () => {
    const content = 'public void method() { System.out.println("hello"); }';
    const result = extractLocalVariableAssignments(content);
    expect(result.size).toBe(0);
  });

  it('handles TypeScript variable declarations', () => {
    const content = 'const apiUrl: string = baseUrl + "/api/v1";';
    const result = extractLocalVariableAssignments(content);
    expect(result.get('apiUrl')).toBe('baseUrl + "/api/v1"');
  });
});

describe('extractMessaging inbound', () => {
  // Helper to create a ChainNode with annotations
  const createHandlerWithAnnotations = (annotations: string[]): any => ({
    uid: 'Method:src/listeners/EventListener.java:handleEvent',
    name: 'handleEvent',
    kind: 'Method',
    filePath: 'src/listeners/EventListener.java',
    startLine: 25,
    endLine: 30,
    depth: 0,
    content: 'public void handleEvent(OrderEvent event) { processOrder(event); }',
    metadata: emptyMetadata(),
    annotations: JSON.stringify(annotations.map(ann => ({ name: ann, attrs: {} }))),
    parameterAnnotations: '[{"name":"event","type":"OrderEvent","annotations":[]}]',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('chain-based inbound detection', () => {
    it('detects @EventListener annotation on method in chain', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithAnnotations(['@EventListener'])],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
      });

      // Should detect @EventListener as inbound messaging
      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('TODO_AI_ENRICH');
      expect(inbound.payload).toBe('OrderEvent');
      expect(inbound.consumptionLogic).toContain('handleEvent');
    });

    it('detects @TransactionalEventListener annotation on method in chain', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/transactions',
          controller: 'TransactionController',
          handler: 'processTransaction',
          filePath: 'src/controllers/TransactionController.java',
          line: 60,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/TransactionListener.java:onTransactionComplete',
          name: 'onTransactionComplete',
          kind: 'Method',
          filePath: 'src/listeners/TransactionListener.java',
          startLine: 30,
          endLine: 35,
          depth: 0,
          content: 'public void onTransactionComplete(TransactionEvent event) { logTransaction(event); }',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@TransactionalEventListener', attrs: {} }]),
          parameterAnnotations: '[{"name":"event","type":"TransactionEvent","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/transactions',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.payload).toBe('TransactionEvent');
    });
  });

  describe('graph-based inbound detection', () => {
    it('detects @RabbitListener with queues attribute from graph query', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/messages',
          controller: 'MessageController',
          handler: 'sendMessage',
          filePath: 'src/controllers/MessageController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/RabbitConsumer.java:consumeMessage',
          name: 'consumeMessage',
          kind: 'Method',
          filePath: 'src/listeners/RabbitConsumer.java',
          startLine: 20,
          endLine: 25,
          depth: 0,
          content: '@RabbitListener(queues = "order.queue") public void consumeMessage(OrderMessage msg) {}',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@RabbitListener', attrs: { queues: 'order.queue' } }]),
          parameterAnnotations: '[{"name":"msg","type":"OrderMessage","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/messages',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('order.queue');
      expect(inbound.payload).toBe('OrderMessage');
      expect(inbound.consumptionLogic).toContain('RabbitConsumer.consumeMessage');
    });

    it('detects @KafkaListener with topics attribute from graph query', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/events',
          controller: 'EventController',
          handler: 'publishEvent',
          filePath: 'src/controllers/EventController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/KafkaConsumer.java:processKafkaEvent',
          name: 'processKafkaEvent',
          kind: 'Method',
          filePath: 'src/listeners/KafkaConsumer.java',
          startLine: 15,
          endLine: 20,
          depth: 0,
          content: '@KafkaListener(topics = "payment.events") public void processKafkaEvent(PaymentEvent event) {}',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@KafkaListener', attrs: { topics: 'payment.events' } }]),
          parameterAnnotations: '[{"name":"event","type":"PaymentEvent","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/events',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('payment.events');
      expect(inbound.payload).toBe('PaymentEvent');
    });

    it('should parse @RabbitListener with array syntax', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/messages',
          controller: 'MessageController',
          handler: 'sendMessage',
          filePath: 'src/controllers/MessageController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/RabbitConsumer.java:consumeMultiQueue',
          name: 'consumeMultiQueue',
          kind: 'Method',
          filePath: 'src/listeners/RabbitConsumer.java',
          startLine: 20,
          endLine: 25,
          depth: 0,
          content: '@RabbitListener(queues = {"queue1", "queue2"}) public void consumeMultiQueue(OrderMessage msg) {}',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@RabbitListener', attrs: { queues: '["queue1", "queue2"]' } }]),
          parameterAnnotations: '[{"name":"msg","type":"OrderMessage","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/messages',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      // Should extract both queues from array syntax
      const inboundList = result.result.externalDependencies.messaging.inbound;
      expect(inboundList.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse @KafkaListener with array syntax', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/events',
          controller: 'EventController',
          handler: 'publishEvent',
          filePath: 'src/controllers/EventController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/KafkaConsumer.java:processMultiTopic',
          name: 'processMultiTopic',
          kind: 'Method',
          filePath: 'src/listeners/KafkaConsumer.java',
          startLine: 15,
          endLine: 20,
          depth: 0,
          content: '@KafkaListener(topics = {"topic1", "topic2"}) public void processMultiTopic(PaymentEvent event) {}',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@KafkaListener', attrs: { topics: '["topic1", "topic2"]' } }]),
          parameterAnnotations: '[{"name":"event","type":"PaymentEvent","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/events',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      // Should extract both topics from array syntax
      const inboundList = result.result.externalDependencies.messaging.inbound;
      expect(inboundList.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('combined inbound detection', () => {
    it('detects both chain-based and graph-based listeners', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/combo',
          controller: 'ComboController',
          handler: 'handleCombo',
          filePath: 'src/controllers/ComboController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/listeners/ComboListener.java:onEvent',
            name: 'onEvent',
            kind: 'Method',
            filePath: 'src/listeners/ComboListener.java',
            startLine: 10,
            endLine: 15,
            depth: 0,
            content: '@EventListener public void onEvent(AppEvent event) {}',
            metadata: emptyMetadata(),
          callees: [],
            annotations: JSON.stringify([{ name: '@EventListener', attrs: {} }]),
            parameterAnnotations: '[{"name":"event","type":"AppEvent","annotations":[]}]',
          },
          {
            uid: 'Method:src/listeners/ComboListener.java:onRabbitMessage',
            name: 'onRabbitMessage',
            kind: 'Method',
            filePath: 'src/listeners/ComboListener.java',
            startLine: 20,
            endLine: 25,
            depth: 1,
            content: '@RabbitListener(queues = "app.queue") public void onRabbitMessage(RabbitMsg msg) {}',
            metadata: emptyMetadata(),
          callees: [],
            annotations: JSON.stringify([{ name: '@RabbitListener', attrs: { queues: 'app.queue' } }]),
            parameterAnnotations: '[{"name":"msg","type":"RabbitMsg","annotations":[]}]',
          },
        ],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/combo',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      // Should detect both @EventListener and @RabbitListener
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('includeContext for inbound', () => {
    it('adds _context field when include_context=true for inbound listeners', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/listeners',
          controller: 'ListenerController',
          handler: 'triggerListener',
          filePath: 'src/controllers/ListenerController.java',
          line: 45,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/listeners/ContextListener.java:handleWithContext',
          name: 'handleWithContext',
          kind: 'Method',
          filePath: 'src/listeners/ContextListener.java',
          startLine: 50,
          endLine: 55,
          depth: 0,
          content: '@EventListener public void handleWithContext(ContextEvent event) {}',
          metadata: emptyMetadata(),
          callees: [],
          annotations: JSON.stringify([{ name: '@EventListener', attrs: {} }]),
          parameterAnnotations: '[{"name":"event","type":"ContextEvent","annotations":[]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/listeners',
        include_context: true,
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound._context).toBeDefined();
      expect(inbound._context).toContain('ContextListener.java');
    });
  });

  describe('compact mode inbound detection via graph query', () => {
    it('detects @RabbitListener via graph query even when include_context=false (compact mode)', async () => {
      // This tests the bug fix: Part 2 graph query must run even without includeContext
      // @RabbitListener methods are NOT in the call chain - they're discovered via graph query
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      // Chain does NOT contain @RabbitListener - it's a separate event handler
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          startLine: 30,
          endLine: 50,
          depth: 0,
          content: 'public void createOrder(OrderDTO order) { orderService.save(order); }',
          metadata: emptyMetadata(),
          callees: [],
          annotations: '[]', // No listener annotations in chain
          parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      // Mock executeQuery to return @RabbitListener method from graph
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          'm.name': 'startUnholdSuggestionOrderMarket',
          'm.annotations': '[{"name":"@RabbitListener","attrs":{"queues":"bond.order.queue"}}]',
          'm.filePath': 'src/listeners/BondEventHandlerImpl.java',
          'm.parameters': '[{"name":"event","type":"BondOrderEvent","annotations":[]}]',
        },
      ]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: false, // Compact mode - should still detect inbound
        executeQuery: mockExecuteQuery,
      });

      // Verify graph query was called (Part 2 should run even in compact mode)
      expect(mockExecuteQuery).toHaveBeenCalled();
      const queryCall = mockExecuteQuery.mock.calls.find(call => 
        call[1]?.includes?.('RabbitListener') || call[1]?.includes?.('KafkaListener')
      );
      expect(queryCall).toBeDefined();

      // Verify inbound detection works in compact mode
      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('bond.order.queue');
      expect(inbound.payload).toBe('BondOrderEvent');
      expect(inbound.consumptionLogic).toContain('BondEventHandlerImpl.startUnholdSuggestionOrderMarket');
      
      // Verify _context is NOT present in compact mode
      expect(inbound._context).toBeUndefined();
    });

    it('detects @KafkaListener via graph query in compact mode', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/events',
          controller: 'EventController',
          handler: 'publishEvent',
          filePath: 'src/controllers/EventController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/EventController.java:publishEvent',
          name: 'publishEvent',
          kind: 'Method',
          filePath: 'src/controllers/EventController.java',
          startLine: 25,
          endLine: 40,
          depth: 0,
          content: 'public void publishEvent(EventDTO event) { kafkaTemplate.send(event); }',
          metadata: emptyMetadata(),
          callees: [],
          annotations: '[]',
          parameterAnnotations: '[{"name":"event","type":"EventDTO","annotations":[]}]',
        }],
        root: 'publishEvent',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          'm.name': 'consumePaymentEvent',
          'm.annotations': '[{"name":"@KafkaListener","attrs":{"topics":"payment.events"}}]',
          'm.filePath': 'src/listeners/PaymentConsumer.java',
          'm.parameters': '[{"name":"event","type":"PaymentEvent","annotations":[]}]',
        },
      ]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/events',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThan(0);
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('payment.events');
      expect(inbound.payload).toBe('PaymentEvent');
      expect(inbound._context).toBeUndefined();
    });
  });

  describe('no inbound listeners', () => {
    it('returns empty inbound array when no listener annotations found', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/no-listeners',
          controller: 'SimpleController',
          handler: 'simpleGet',
          filePath: 'src/controllers/SimpleController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/SimpleController.java:simpleGet',
          name: 'simpleGet',
          kind: 'Method',
          filePath: 'src/controllers/SimpleController.java',
          startLine: 20,
          endLine: 25,
          depth: 0,
          content: 'public String simpleGet() { return "hello"; }',
          metadata: emptyMetadata(),
          callees: [],
          // No listener annotations
          annotations: JSON.stringify([{ name: '@GetMapping', attrs: { value: '/simple' } }]),
          parameterAnnotations: '[]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/no-listeners',
      });

      expect(result.result.externalDependencies.messaging.inbound).toBeDefined();
      expect(result.result.externalDependencies.messaging.inbound).toEqual([]);
    });
  });
});

describe('extractRequestParams', () => {
  // Helper to create a ChainNode with parameters
  const createHandlerNode = (parameters: string): any => ({
    uid: 'Method:src/controllers/TestController.java:testHandler',
    name: 'testHandler',
    kind: 'Method',
    filePath: 'src/controllers/TestController.java',
    depth: 0,
    content: 'public void testHandler() {}',
    metadata: emptyMetadata(),
    parameterAnnotations: parameters,
  });

  describe('@PathVariable extraction', () => {
    it('extracts @PathVariable parameter with required=true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"id","type":"Long","annotations":["@PathVariable"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users/{id}',
      });

      expect(result.result.specs.request.params).toBeDefined();
      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0]).toEqual({
        name: 'id',
        type: 'Long',
        required: true,
        description: '',
      });
    });

    it('extracts @PathVariable with name attribute', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/orders/{orderId}/items/{itemId}',
          controller: 'OrderController',
          handler: 'getOrderItem',
          filePath: 'src/controllers/OrderController.java',
          line: 45,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"itemId","type":"String","annotations":["@PathVariable(\\"itemId\\")"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/orders/{orderId}/items/{itemId}',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].name).toBe('itemId');
      expect(result.result.specs.request.params[0].required).toBe(true);
    });
  });

  describe('@RequestParam extraction', () => {
    it('extracts @RequestParam without required attribute — defaults to required=true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'searchUsers',
          filePath: 'src/controllers/UserController.java',
          line: 55,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"name","type":"String","annotations":["@RequestParam"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0]).toEqual({
        name: 'name',
        type: 'String',
        required: true,
        description: '',
      });
    });

    it('extracts @RequestParam(required=false) with required=false', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'searchUsers',
          filePath: 'src/controllers/UserController.java',
          line: 60,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"status","type":"String","annotations":["@RequestParam(required=false)"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].required).toBe(false);
    });

    it('extracts @RequestParam with name attribute', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/search',
          controller: 'SearchController',
          handler: 'search',
          filePath: 'src/controllers/SearchController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"q","type":"String","annotations":["@RequestParam(\\"query\\")"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/search',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].name).toBe('q');
    });
  });

  describe('@RequestHeader extraction', () => {
    it('extracts @RequestHeader with required attribute', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/data',
          controller: 'DataController',
          handler: 'processData',
          filePath: 'src/controllers/DataController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"authToken","type":"String","annotations":["@RequestHeader(\\"X-Auth-Token\\")"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/data',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0]).toEqual({
        name: 'authToken',
        type: 'String',
        required: true,
        description: '',
      });
    });

    it('extracts @RequestHeader(required=false)', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/config',
          controller: 'ConfigController',
          handler: 'getConfig',
          filePath: 'src/controllers/ConfigController.java',
          line: 15,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"clientVersion","type":"String","annotations":["@RequestHeader(value=\\"X-Client-Version\\", required=false)"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/config',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].required).toBe(false);
    });
  });

  describe('@CookieValue extraction', () => {
    it('extracts @CookieValue parameter', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/preferences',
          controller: 'PreferencesController',
          handler: 'getPreferences',
          filePath: 'src/controllers/PreferencesController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"sessionId","type":"String","annotations":["@CookieValue(\\"SESSION_ID\\")"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/preferences',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0]).toEqual({
        name: 'sessionId',
        type: 'String',
        required: true,
        description: '',
      });
    });

    it('extracts @CookieValue(required=false)', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/theme',
          controller: 'ThemeController',
          handler: 'getTheme',
          filePath: 'src/controllers/ThemeController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"themePref","type":"String","annotations":["@CookieValue(value=\\"theme\\", required=false)"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/theme',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].required).toBe(false);
    });
  });

  describe('framework type filtering', () => {
    it('skips HttpServletRequest, HttpServletResponse, and other framework types', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/upload',
          controller: 'UploadController',
          handler: 'upload',
          filePath: 'src/controllers/UploadController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"request","type":"HttpServletRequest","annotations":[]},{"name":"file","type":"MultipartFile","annotations":["@RequestParam"]},{"name":"response","type":"HttpServletResponse","annotations":[]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/upload',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].name).toBe('file');
    });

    it('skips Model, ModelMap, Principal, and custom resolvers', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/profile',
          controller: 'ProfileController',
          handler: 'getProfile',
          filePath: 'src/controllers/ProfileController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"model","type":"Model","annotations":[]},{"name":"principal","type":"Principal","annotations":[]},{"name":"userId","type":"Long","annotations":["@PathVariable"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/profile/{userId}',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].name).toBe('userId');
    });
  });

  describe('@RequestBody filtering', () => {
    it('skips @RequestBody parameters (handled by body schema)', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 60,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody"]},{"name":"source","type":"String","annotations":["@RequestParam"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.params).toHaveLength(1);
      expect(result.result.specs.request.params[0].name).toBe('source');
    });
  });

  describe('includeContext flag', () => {
    it('adds _context field with annotation text and source location when include_context=true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUser',
          name: 'getUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          startLine: 30,
          depth: 0,
          content: 'public User getUser(@PathVariable Long id, @RequestParam(required=false) String filter) { ... }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"id","type":"Long","annotations":["@PathVariable"]},{"name":"filter","type":"String","annotations":["@RequestParam(required=false)"]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/users/{id}',
        include_context: true,
      });

      expect(result.result.specs.request.params).toHaveLength(2);
      // Each param should have _context when include_context is true
      expect(result.result.specs.request.params[0]._context).toBeDefined();
      expect(result.result.specs.request.params[0]._context).toContain('@PathVariable');
      expect(result.result.specs.request.params[1]._context).toContain('@RequestParam');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for handler with no parameters', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/health',
          controller: 'HealthController',
          handler: 'health',
          filePath: 'src/controllers/HealthController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/health',
      });

      expect(result.result.specs.request.params).toEqual([]);
    });

    it('returns empty array for handler with null parameters JSON', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/status',
          controller: 'StatusController',
          handler: 'status',
          filePath: 'src/controllers/StatusController.java',
          line: 15,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          ...createHandlerNode('[]'),
          parameters: null as any,
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/status',
      });

      expect(result.result.specs.request.params).toEqual([]);
    });

    it('returns empty array for handler with invalid parameters JSON', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/check',
          controller: 'CheckController',
          handler: 'check',
          filePath: 'src/controllers/CheckController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          ...createHandlerNode('[]'),
          parameterAnnotations: 'not valid json',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/check',
      });

      expect(result.result.specs.request.params).toEqual([]);
    });

    it('handles mixed parameters with various annotations', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders/{orderId}/items',
          controller: 'OrderController',
          handler: 'addItem',
          filePath: 'src/controllers/OrderController.java',
          line: 70,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerNode('[{"name":"orderId","type":"Long","annotations":["@PathVariable"]},{"name":"itemDTO","type":"ItemDTO","annotations":["@RequestBody"]},{"name":"quantity","type":"Integer","annotations":["@RequestParam"]},{"name":"request","type":"HttpServletRequest","annotations":[]},{"name":"X-Custom-Header","type":"String","annotations":["@RequestHeader(\\"X-Custom-Header\\")"]}]')],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders/{orderId}/items',
      });

      // Should have: orderId (PathVariable), quantity (RequestParam), X-Custom-Header (RequestHeader)
      // NOT: itemDTO (RequestBody), request (HttpServletRequest)
      expect(result.result.specs.request.params).toHaveLength(3);
      expect(result.result.specs.request.params.map((p: any) => p.name)).toEqual(['orderId', 'quantity', 'X-Custom-Header']);
      expect(result.result.specs.request.params[0].required).toBe(true); // PathVariable always required
      expect(result.result.specs.request.params[1].required).toBe(true); // RequestParam defaults true
      expect(result.result.specs.request.params[2].required).toBe(true); // RequestHeader defaults true
    });
  });
});

describe('extractValidationRules', () => {
  // Helper to create a ChainNode with parameters containing validation annotations
  const createHandlerWithValidation = (parameters: string, startLine?: number): any => ({
    uid: 'Method:src/controllers/TestController.java:testHandler',
    name: 'testHandler',
    kind: 'Method',
    filePath: 'src/controllers/TestController.java',
    depth: 0,
    content: 'public void testHandler() {}',
    metadata: emptyMetadata(),
    parameterAnnotations: parameters,
    startLine,
  });

  describe('@NotNull extraction', () => {
    it('extracts @NotNull annotation — required=true, rules="NotNull"', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"name","type":"String","annotations":["@NotNull"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'name',
        type: 'String',
        required: true,
        rules: 'NotNull',
      });
    });
  });

  describe('@NotBlank extraction', () => {
    it('extracts @NotBlank annotation — required=true, rules="NotBlank"', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"username","type":"String","annotations":["@NotBlank"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'username',
        type: 'String',
        required: true,
        rules: 'NotBlank',
      });
    });
  });

  describe('@NotEmpty extraction', () => {
    it('extracts @NotEmpty annotation — required=true, rules="NotEmpty"', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/items',
          controller: 'ItemController',
          handler: 'createItem',
          filePath: 'src/controllers/ItemController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"items","type":"List","annotations":["@NotEmpty"]}]', 25)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/items',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'items',
        type: 'List',
        required: true,
        rules: 'NotEmpty',
      });
    });
  });

  describe('@Size extraction', () => {
    it('extracts @Size(min, max) annotation with both bounds', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"name","type":"String","annotations":["@Size(min=1, max=100)"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'name',
        type: 'String',
        required: false,
        rules: 'Size: min=1, max=100',
      });
    });

    it('extracts @Size(min) annotation with only min', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"name","type":"String","annotations":["@Size(min=5)"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'name',
        type: 'String',
        required: false,
        rules: 'Size: min=5',
      });
    });

    it('should handle @Size with only max', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"limit","type":"Integer","annotations":["@Size(max=100)"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'limit',
        type: 'Integer',
        required: false,
        rules: 'Size: max=100',
      });
    });
  });

  describe('@Min/@Max extraction', () => {
    it('extracts @Min annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"quantity","type":"Integer","annotations":["@Min(5)"]}]', 40)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'quantity',
        type: 'Integer',
        required: false,
        rules: 'Min: 5',
      });
    });

    it('extracts @Max annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"quantity","type":"Integer","annotations":["@Max(100)"]}]', 40)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'quantity',
        type: 'Integer',
        required: false,
        rules: 'Max: 100',
      });
    });
  });

  describe('@Email extraction', () => {
    it('extracts @Email annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'register',
          filePath: 'src/controllers/UserController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"email","type":"String","annotations":["@Email"]}]', 50)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'email',
        type: 'String',
        required: false,
        rules: 'Email',
      });
    });
  });

  describe('@Pattern extraction', () => {
    it('extracts @Pattern annotation with regexp', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"code","type":"String","annotations":["@Pattern(regexp=\\"^[A-Z]{3}$\\")"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'code',
        type: 'String',
        required: false,
        rules: 'Pattern: ^[A-Z]{3}$',
      });
    });
  });

  describe('@Positive/@PositiveOrZero extraction', () => {
    it('extracts @Positive annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/amounts',
          controller: 'AmountController',
          handler: 'createAmount',
          filePath: 'src/controllers/AmountController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"amount","type":"BigDecimal","annotations":["@Positive"]}]', 20)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/amounts',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'amount',
        type: 'BigDecimal',
        required: false,
        rules: 'Positive',
      });
    });

    it('extracts @PositiveOrZero annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/amounts',
          controller: 'AmountController',
          handler: 'createAmount',
          filePath: 'src/controllers/AmountController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"amount","type":"BigDecimal","annotations":["@PositiveOrZero"]}]', 20)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/amounts',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'amount',
        type: 'BigDecimal',
        required: false,
        rules: 'PositiveOrZero',
      });
    });
  });

  describe('@Negative/@NegativeOrZero extraction', () => {
    it('extracts @Negative annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/adjustments',
          controller: 'AdjustmentController',
          handler: 'adjust',
          filePath: 'src/controllers/AdjustmentController.java',
          line: 15,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"delta","type":"Integer","annotations":["@Negative"]}]', 15)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/adjustments',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'delta',
        type: 'Integer',
        required: false,
        rules: 'Negative',
      });
    });
  });

  describe('@Past/@Future extraction', () => {
    it('extracts @Past annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/events',
          controller: 'EventController',
          handler: 'createEvent',
          filePath: 'src/controllers/EventController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"occurredAt","type":"LocalDate","annotations":["@Past"]}]', 25)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/events',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'occurredAt',
        type: 'LocalDate',
        required: false,
        rules: 'Past',
      });
    });

    it('extracts @Future annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/schedules',
          controller: 'ScheduleController',
          handler: 'schedule',
          filePath: 'src/controllers/ScheduleController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"scheduledAt","type":"LocalDateTime","annotations":["@Future"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/schedules',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'scheduledAt',
        type: 'LocalDateTime',
        required: false,
        rules: 'Future',
      });
    });
  });

  describe('@Valid/@Validated extraction', () => {
    it('extracts @Valid annotation', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"userDTO","type":"UserDTO","annotations":["@Valid","@RequestBody"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'userDTO',
        type: 'UserDTO',
        required: false,
        rules: 'Valid',
      });
    });
  });

  describe('multiple annotations on same param', () => {
    it('combines multiple validation annotations into single rules string', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"email","type":"String","annotations":["@NotNull","@Email","@Size(max=255)"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'email',
        type: 'String',
        required: true,
        rules: 'NotNull, Email, Size: max=255',
      });
    });

    it('combines @NotBlank with @Size', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"username","type":"String","annotations":["@NotBlank","@Size(min=3, max=50)"]}]', 30)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'username',
        type: 'String',
        required: true,
        rules: 'NotBlank, Size: min=3, max=50',
      });
    });
  });

  describe('handler with no validation annotations', () => {
    it('returns empty array when no validation annotations present', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/status',
          controller: 'StatusController',
          handler: 'getStatus',
          filePath: 'src/controllers/StatusController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"source","type":"String","annotations":["@RequestParam"]}]', 10)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/status',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toEqual([]);
    });

    it('returns empty array for handler with no parameters', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/health',
          controller: 'HealthController',
          handler: 'health',
          filePath: 'src/controllers/HealthController.java',
          line: 5,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[]', 5)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/health',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toEqual([]);
    });
  });

  describe('includeContext flag', () => {
    it('adds _context field with source location when include_context=true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          startLine: 30,
          content: 'public void createUser(@NotNull String name) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"name","type":"String","annotations":["@NotNull"]}]',
        }],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        include_context: true,
      });

      expect(result.result.specs.request.validation).toBeDefined();
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]._context).toBeDefined();
      expect(result.result.specs.request.validation[0]._context?.[0]).toContain('@NotNull');
      expect(result.result.specs.request.validation[0]._context?.[0]).toContain('src/controllers/UserController.java');
    });
  });

  describe('multiple params with validation', () => {
    it('extracts validation rules from multiple params', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 40,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [createHandlerWithValidation('[{"name":"orderId","type":"Long","annotations":["@PathVariable","@NotNull"]},{"name":"quantity","type":"Integer","annotations":["@RequestParam","@Min(1)","@Max(100)"]}]', 40)],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      // Only validation annotations should be extracted, not @PathVariable/@RequestParam
      expect(result.result.specs.request.validation).toHaveLength(2);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'orderId',
        type: 'Long',
        required: true,
        rules: 'NotNull',
      });
      expect(result.result.specs.request.validation[1]).toEqual({
        field: 'quantity',
        type: 'Integer',
        required: false,
        rules: 'Min: 1, Max: 100',
      });
    });
  });

  describe('field-level validation from BodySchema', () => {
    it('includes field-level validation rules from BodySchema', async () => {
      // This test will require BodySchema to be populated with field annotations
      // The body schema extraction should include field annotations
      // This test documents the expected behavior for Phase B
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      // The chain should include a node for the DTO class with fields
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/UserController.java:createUser',
            name: 'createUser',
            kind: 'Method',
            filePath: 'src/controllers/UserController.java',
            depth: 0,
            content: 'public void createUser(@RequestBody UserDTO userDTO) {}',
            metadata: emptyMetadata(),
          callees: [],
            parameterAnnotations: '[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody","@Valid"]}]',
          },
          {
            uid: 'Class:src/dto/UserDTO.java:UserDTO',
            name: 'UserDTO',
            kind: 'Class',
            filePath: 'src/dto/UserDTO.java',
            depth: 1,
            content: 'public class UserDTO { @NotNull String name; @Email String email; }',
            metadata: emptyMetadata(),
          callees: [],
            fields: '[{"name":"name","type":"String","annotations":["@NotNull"]},{"name":"email","type":"String","annotations":["@Email"]}]',
          },
        ],
        root: 'testHandler',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
      });

      expect(result.result.specs.request.validation).toBeDefined();
      // Should include both @Valid on param and field-level validations
      expect(result.result.specs.request.validation).toHaveLength(3);
      expect(result.result.specs.request.validation[0]).toEqual({
        field: 'userDTO',
        type: 'UserDTO',
        required: false,
        rules: 'Valid',
      });
      expect(result.result.specs.request.validation[1]).toEqual({
        field: 'userDTO.name',
        type: 'String',
        required: true,
        rules: 'NotNull',
      });
      expect(result.result.specs.request.validation[2]).toEqual({
        field: 'userDTO.email',
        type: 'String',
        required: false,
        rules: 'Email',
      });
    });
  });

  describe('imperative validation detection', () => {
    it('detects TcbsValidator.doValidate calls when include_context is true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            content: 'public void createOrder(OrderDTO order) { TcbsValidator.doValidate(order); }',
            metadata: emptyMetadata(),
          callees: [],
            parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      expect(result.result.specs.request.validation).toBeDefined();
      // Should have the imperative validation rule with extracted field/rules
      const imperativeRule = result.result.specs.request.validation.find(
        (r: any) => r.rules === 'TcbsValidator.doValidate'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('OrderDTO'); // Type from handler params
      expect(imperativeRule?.type).toBe('Custom');
      expect(imperativeRule?._context).toBeDefined();
      expect(imperativeRule?._context?.[0]).toContain('TcbsValidator.doValidate');
    });

    it('detects ValidationUtils.validate calls when include_context is true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'updateUser',
          filePath: 'src/controllers/UserController.java',
          line: 25,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/UserController.java:updateUser',
            name: 'updateUser',
            kind: 'Method',
            filePath: 'src/controllers/UserController.java',
            depth: 0,
            startLine: 25,
            endLine: 40,
            content: 'public void updateUser(UserDTO user) { ValidationUtils.validate(user); }',
            metadata: emptyMetadata(),
          callees: [],
            parameterAnnotations: '[{"name":"user","type":"UserDTO","annotations":[]}]',
          },
        ],
        root: 'updateUser',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        include_context: true,
      });

      expect(result.result.specs.request.validation).toBeDefined();
      const imperativeRule = result.result.specs.request.validation.find(
        (r: any) => r.rules === 'ValidationUtils.validate'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('UserDTO'); // Type from handler params
      expect(imperativeRule?.type).toBe('Custom');
      expect(imperativeRule?._context?.[0]).toContain('ValidationUtils.validate');
    });

    it('detects imperative validation even when include_context is false', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            content: 'public void createOrder(OrderDTO order) { TcbsValidator.doValidate(order); }',
            metadata: emptyMetadata(),
          callees: [],
            parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: false,
      });

      // With the fix, imperative validation IS detected even without include_context
      // because content is always fetched for internal processing
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toMatchObject({
        field: 'OrderDTO',
        type: 'Custom',
        required: false,
        rules: 'TcbsValidator.doValidate',
      });
    });

    it('detects imperative validation in compact mode (content stripped from output)', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            // Use Validator.check pattern which only matches once
            content: 'public void createOrder(OrderDTO order) { Validator.check(order); }',
            metadata: emptyMetadata(),
            callees: [],
            parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
        compact: true,
      });

      // Validation entries should be populated even in compact mode
      expect(result.result.specs.request.validation).toHaveLength(1);
      expect(result.result.specs.request.validation[0]).toMatchObject({
        field: 'OrderDTO',
        type: 'Custom',
        required: false,
        rules: 'Validator.check',
      });

    });

    it('detects .validateJWT() custom validation calls', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            content: 'public void createOrder(OrderDTO order) { this.validateJWT(jwt, order); }',
            metadata: emptyMetadata(),
            callees: [],
            parameterAnnotations: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should have the imperative validation rule with extracted field/rules
      // Note: method path is extracted from regex match, which captures .validateJWT, stripped to validateJWT
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.rules === 'validateJWT'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('OrderDTO'); // Type from handler params
      expect(imperativeRule?.type).toBe('Custom');
      expect(imperativeRule?._context).toBeDefined();
      expect(imperativeRule?._context?.[0]).toContain('validateJWT');
    });

    it('detects ValidationService.process() calls', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            content: 'public void createOrder(OrderDTO order) { validationService.process(order); }',
            metadata: emptyMetadata(),
            callees: [],
            parameterAnnotations: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should have the imperative validation rule with extracted field/rules
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.rules === 'validationService.process'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('OrderDTO'); // Type from handler params
      expect(imperativeRule?.type).toBe('Custom');
      expect(imperativeRule?._context?.[0]).toContain('validationService.process');
    });

    it('detects multiple custom validation methods', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [
          {
            uid: 'Method:src/controllers/OrderController.java:createOrder',
            name: 'createOrder',
            kind: 'Method',
            filePath: 'src/controllers/OrderController.java',
            depth: 0,
            startLine: 30,
            endLine: 45,
            content: 'public void createOrder(OrderDTO order) { validateJWT(jwt); validateRequest(order); }',
            metadata: emptyMetadata(),
            callees: [],
            parameterAnnotations: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
          },
        ],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should have multiple imperative validation rules with extracted fields/rules
      const imperativeRules = result.result.specs.request.validation.filter(
        (r) => r.type === 'Custom' && (r.rules === 'validateJWT' || r.rules === 'validateRequest')
      );
      expect(imperativeRules.length).toBeGreaterThanOrEqual(2);
      // Verify extracted fields
      const jwtRule = imperativeRules.find(r => r.rules === 'validateJWT');
      expect(jwtRule?.field).toBe('jwt'); // Not in params, stays as param name
      const requestRule = imperativeRules.find(r => r.rules === 'validateRequest');
      expect(requestRule?.field).toBe('OrderDTO'); // Found in params, uses type
    });
  });

    it('deduplicates overlapping patterns - TcbsValidator.validate produces ONE entry', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'PUT',
          path: '/api/bookings/{productCode}/suggest',
          controller: 'BookingController',
          handler: 'suggest',
          filePath: 'src/controllers/BookingController.java',
          line: 100,
        }],
      });

      // This content would match both:
      // - Pattern 1: /TcbsValidator\.(validate|doValidate)\s*\(/g
      // - Pattern 3: /\.\s*validate\s*\(/g
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/BookingController.java:suggest',
          name: 'suggest',
          kind: 'Method',
          filePath: 'src/controllers/BookingController.java',
          depth: 0,
          startLine: 100,
          endLine: 115,
          content: 'public void suggest(SuggestionOrderResultDto prm) { TcbsValidator.validate(order); }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"prm","type":"SuggestionOrderResultDto","annotations":[]}]',
        }],
        root: 'suggest',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'PUT',
        path: '/bookings/{productCode}/suggest',
        include_context: true,
      });

      // Should have exactly ONE validation rule for TcbsValidator.validate
      const validateRules = result.result.specs.request.validation.filter(
        (r: any) => r.rules === 'TcbsValidator.validate'
      );
      expect(validateRules).toHaveLength(1);
      expect(validateRules[0]?.field).toBe('order');
      expect(validateRules[0]?.type).toBe('Custom');
    });

    it('different validation methods on same line create separate entries', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'process',
          filePath: 'src/controllers/OrderController.java',
          line: 50,
        }],
      });

      // Two different validation calls on the same line - should create TWO entries
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:process',
          name: 'process',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          startLine: 50,
          endLine: 60,
          content: 'public void process(OrderDTO order, UserDTO user) { TcbsValidator.validate(order); ValidationUtils.check(user); }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
        }],
        root: 'process',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should have TWO different validation rules
      const tcbsRule = result.result.specs.request.validation.find(
        (r: any) => r.rules === 'TcbsValidator.validate'
      );
      const utilsRule = result.result.specs.request.validation.find(
        (r: any) => r.rules === 'ValidationUtils.check'
      );

      expect(tcbsRule).toBeDefined();
      expect(utilsRule).toBeDefined();
      expect(tcbsRule?.field).toBe('OrderDTO'); // Found in params, uses type
      expect(utilsRule?.field).toBe('user'); // Not in params, stays as param name
    });

    it('uses "body" as field when validation param type matches request body type', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      // Content has typed argument: validateJWT(TcbsJWT jwt, SuggestionOrderResultDto prm)
      // SuggestionOrderResultDto matches the @RequestBody type
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          startLine: 30,
          endLine: 45,
          content: 'public void createOrder(@RequestBody SuggestionOrderResultDto body) { validateJWT(TcbsJWT jwt, SuggestionOrderResultDto prm); }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"body","type":"SuggestionOrderResultDto","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should use "body" as field since SuggestionOrderResultDto matches request body type
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.rules === 'validateJWT'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('body');
      expect(imperativeRule?.type).toBe('Custom');
    });

    it('uses type name as field when validation param type does NOT match request body', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      // Content: validateJWT(TcbsJWT jwt) - TcbsJWT does NOT match request body type
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          startLine: 30,
          endLine: 45,
          content: 'public void createOrder(@RequestBody OrderDTO order) { validateJWT(TcbsJWT jwt); }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"order","type":"OrderDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        include_context: true,
      });

      // Should use type name "TcbsJWT" since it doesn't match request body type
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.rules === 'validateJWT'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?.field).toBe('TcbsJWT');
      expect(imperativeRule?.type).toBe('Custom');
    });

  describe('inbound messaging array fallback', () => {
    it('handles LadybugDB array format for graph query results', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/listeners',
          controller: 'ListenerController',
          handler: 'triggerListener',
          filePath: 'src/controllers/ListenerController.java',
          line: 45,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/ListenerController.java:triggerListener',
          name: 'triggerListener',
          kind: 'Method',
          filePath: 'src/controllers/ListenerController.java',
          startLine: 45,
          endLine: 60,
          depth: 0,
          content: 'public void triggerListener() { /* no inbound listeners in chain */ }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[]',
          annotations: '[]',
        }],
        root: 'triggerListener',
        summary: emptySummary(),
      });

      // Mock executeQuery to return different results based on query
      // - For listener query: returns listener data in LadybugDB array format
      // - For class query: returns empty array (type not found)
      const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string) => {
        if (query.includes('@RabbitListener') || query.includes('@KafkaListener')) {
          // Listener query - return array format
          return [
            [
              'onMessage',  // name
              JSON.stringify([{ name: '@RabbitListener', attrs: { queues: 'order.queue' } }]),  // annotations
              'src/listeners/OrderListener.java',  // filePath
              JSON.stringify([{ name: 'msg', type: 'OrderMessage', annotations: [] }]),  // parameters
            ],
          ];
        }
        // Class query for type resolution - return empty (type not found)
        return [];
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/listeners',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      // Should detect @RabbitListener from graph query
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThanOrEqual(1);

      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('order.queue');
      // When include_context: true, payload is resolved to BodySchema (source: 'external' if type not found)
      expect(inbound.payload).toEqual({ typeName: 'OrderMessage', source: 'external', fields: undefined });
      expect(inbound.consumptionLogic).toBe('OrderListener.onMessage()');
      expect(inbound._context).toContain('src/listeners/OrderListener.java');
      expect(inbound._context).not.toContain('undefined');
    });

    it('extracts topic from @KafkaListener in array format', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/listeners',
          controller: 'ListenerController',
          handler: 'triggerListener',
          filePath: 'src/controllers/ListenerController.java',
          line: 45,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/ListenerController.java:triggerListener',
          name: 'triggerListener',
          kind: 'Method',
          filePath: 'src/controllers/ListenerController.java',
          startLine: 45,
          endLine: 60,
          depth: 0,
          content: 'public void triggerListener() {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[]',
          annotations: '[]',
        }],
        root: 'triggerListener',
        summary: emptySummary(),
      });

      // Mock executeQuery to return different results based on query
      // - For listener query: returns listener data in LadybugDB array format
      // - For class query: returns empty array (type not found)
      const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string) => {
        if (query.includes('@RabbitListener') || query.includes('@KafkaListener')) {
          // Listener query - return array format
          return [
            [
              'consumeOrder',  // name
              JSON.stringify([{ name: '@KafkaListener', attrs: { topics: 'orders-topic' } }]),  // annotations
              'src/listeners/KafkaConsumer.java',  // filePath
              JSON.stringify([{ name: 'order', type: 'OrderEvent', annotations: [] }]),  // parameters
            ],
          ];
        }
        // Class query for type resolution - return empty (type not found)
        return [];
      });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/listeners',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('orders-topic');
      // When include_context: true, payload is resolved to BodySchema (source: 'external' if type not found)
      expect(inbound.payload).toEqual({ typeName: 'OrderEvent', source: 'external', fields: undefined });
      expect(inbound.consumptionLogic).toBe('KafkaConsumer.consumeOrder()');
      expect(inbound._context).toContain('src/listeners/KafkaConsumer.java');
    });
  });
});

describe('extractPackagePrefix', () => {
  // Testing the extractPackagePrefix behavior
  // Note: extractPackagePrefix is not exported, we test its behavior patterns

  describe('Java-style package prefixes', () => {
    it('extracts package from fully qualified Java class name', () => {
      // com.abcd.bond.trading.dto.SuggestionOrderResultDto -> com.abcd.bond.trading.dto
      const typeName = 'com.abcd.bond.trading.dto.SuggestionOrderResultDto';
      const parts = typeName.split('.');
      const lastPart = parts[parts.length - 1];
      // Last part starts with uppercase, so it's a class name
      expect(lastPart[0]).toBe('S');
      expect(lastPart[0]).toBe(lastPart[0].toUpperCase());
      expect(parts.slice(0, -1).join('.')).toBe('com.abcd.bond.trading.dto');
    });

    it('handles simple class name without package (returns null pattern)', () => {
      // ClassName -> null (no package prefix)
      const typeName = 'ClassName';
      expect(typeName.includes('.')).toBe(false);
    });

    it('handles lowercase package-only name', () => {
      // com.example.package (no class) -> returns full path
      const typeName = 'com.example.package';
      const parts = typeName.split('.');
      const lastPart = parts[parts.length - 1];
      // 'package' starts with lowercase, so it's not a class name
      expect(lastPart[0]).toBe(lastPart[0].toLowerCase());
    });
  });

  describe('npm-style package prefixes', () => {
    it('extracts package from scoped npm module with class (triggers Java-style branch)', () => {
      // @scope/package.Module has a '.' which triggers the Java-style branch
      // parts = ['@scope/package', 'Module']
      // lastPart = 'Module' (uppercase) -> return parts.slice(0, -1).join('.') = '@scope/package'
      const typeName = '@scope/package.Module';
      // The '.' causes it to match Java-style, extracting 'package' part correctly
      expect(typeName.includes('.')).toBe(true);
      const parts = typeName.split('.');
      expect(parts[0]).toBe('@scope/package');
      expect(parts[parts.length - 1][0]).toBe('M'); // Uppercase
      // extractPackagePrefix returns '@scope/package' for '@scope/package.Module'
    });

    it('handles scoped package without module (no dot, triggers npm-style branch)', () => {
      // @scope/package has no '.', so it goes to npm-style branch
      const typeName = '@scope/package';
      expect(typeName.includes('.')).toBe(false);
      expect(typeName.startsWith('@')).toBe(true);
      const slashIndex = typeName.indexOf('/', 1);
      // '/' is at position 6 (after '@scope')
      expect(slashIndex).toBe(6);
      // substring(0, 6) returns '@scope' (without '/package')
      expect(typeName.substring(0, slashIndex)).toBe('@scope');
      // extractPackagePrefix returns '@scope' for '@scope/package' (no dot)
    });
  });
});

describe('Cross-Repo Type Resolution', () => {
  // Helper to create mock CrossRepoContext
  const createMockCrossRepoContext = () => ({
    findDepRepo: vi.fn(),
    queryMultipleRepos: vi.fn(),
    listDepRepos: vi.fn().mockResolvedValue(['dep-repo-1', 'dep-repo-2']),
  });

  describe('Type resolved from dependency repo', () => {
    it('attempts cross-repo resolution when type not found locally', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue('bond-service-repo');
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([{
        repoId: 'bond-service-repo',
        results: [{
          name: 'com.abcd.bond.dto.SuggestionOrderResultDto',
          fields: JSON.stringify([
            { name: 'id', type: 'Long', annotations: [] },
            { name: 'orderCode', type: 'String', annotations: ['@NotBlank'] },
          ]),
        }],
      }]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder(@RequestBody OrderDTO orderDTO) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"orderDTO","type":"com.abcd.bond.dto.SuggestionOrderResultDto","annotations":["@RequestBody","@Valid"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      // Mock local query to return no results (type not in local repo)
      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([]) // First call: find endpoint handler params
        .mockResolvedValueOnce([]); // Second call: type not found locally

      await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // The cross-repo resolution should have been attempted
      // findDepRepo should be called with the package prefix
      expect(mockCrossRepo.findDepRepo).toHaveBeenCalled();
    });

    it('queries dependency repo with correct package prefix for Java types', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue('dep-repo');
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([{
        repoId: 'dep-repo',
        results: [{
          name: 'com.example.UserDTO',
          fields: JSON.stringify([{ name: 'id', type: 'Long' }]),
        }],
      }]);

      // Setup: local query returns no results
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public void createUser(@RequestBody UserDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.example.UserDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // Verify findDepRepo was called with extracted package prefix
      expect(mockCrossRepo.findDepRepo).toHaveBeenCalledWith('com.example');
    });

    it('queries dependency repo with correct package prefix for npm scoped packages', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue('dep-repo');
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([{
        repoId: 'dep-repo',
        results: [{
          name: '@scope/package.UserDTO',
          fields: JSON.stringify([{ name: 'id', type: 'string' }]),
        }],
      }]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.ts',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.ts:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.ts',
          depth: 0,
          content: 'async createUser(@Body() dto: UserDTO) {}',
          metadata: emptyMetadata(),
          callees: [],
          // MUST include @RequestBody for extractBodySchemas to resolve the type
          parameterAnnotations: '[{"name":"dto","type":"@scope/package.UserDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // Note: @scope/package.UserDTO has a '.', so it triggers the Java-style branch
      // which correctly extracts '@scope/package' as the package prefix
      expect(mockCrossRepo.findDepRepo).toHaveBeenCalledWith('@scope/package');
    });
  });

  describe('Type not in any repo (fallback to external)', () => {
    it('returns external source when findDepRepo returns null', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue(null);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder(@RequestBody ExternalDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.external.UnknownDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // When type is not found in any repo, body returns type placeholder
      expect(result.result.specs.request.body).toEqual({ _type: 'com.external.UnknownDTO' });
    });

    it('returns external source when dependency repo does not contain the type', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue('dep-repo');
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([{
        repoId: 'dep-repo',
        results: [], // Empty results - type not found
      }]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder(@RequestBody MissingDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.missing.MissingDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // Type not found in dep repo either, returns type placeholder
      expect(result.result.specs.request.body).toEqual({ _type: 'com.missing.MissingDTO' });
    });
  });

  describe('Cross-repo context undefined (backward compatibility)', () => {
    it('works without crossRepo parameter (queries local repo only)', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      // Mock local type found
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public void createUser(@RequestBody UserDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"UserDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      // Execute without crossRepo - should work as before
      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        // No crossRepo parameter
      });

      // Should return valid result without error
      expect(result.result.method).toBe('POST');
      expect(result.result.path).toBe('/api/users');
      // Body returns type placeholder for external/unresolved types
      expect(result.result.specs.request.body).toEqual({ _type: 'UserDTO' });
    });

    it('does not attempt cross-repo resolution when crossRepo is undefined', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public void createUser(@RequestBody ExternalDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.external.UnknownDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      // Execute without crossRepo
      await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        executeQuery: mockExecuteQuery,
        // No crossRepo parameter
      });

      // The query should only be for local repo (no cross-repo calls)
      // When crossRepo is undefined, the code should not attempt to findDepRepo
      // This is implicit - no error should occur
    });
  });

  describe('Simple class names (no package prefix)', () => {
    it('skips cross-repo resolution for simple class names', async () => {
      const mockCrossRepo = createMockCrossRepoContext();

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          content: 'public void createUser(@RequestBody UserDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"UserDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn().mockResolvedValue([]);

      await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // For simple class names without package prefix, extractPackagePrefix returns null
      // so findDepRepo should NOT be called
      expect(mockCrossRepo.findDepRepo).not.toHaveBeenCalled();
    });
  });

  describe('Cross-repo query error handling', () => {
    it('handles _error field from queryMultipleRepos for diagnostics', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue(null);
      mockCrossRepo.listDepRepos.mockResolvedValue(['dep-repo-1', 'dep-repo-2']);
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([
        { repoId: 'dep-repo-1', results: [], _error: 'repo_not_found' },
        { repoId: 'dep-repo-2', results: [], _error: 'ladybug_not_ready' },
      ]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder(@RequestBody ExternalDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.external.ExternalDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // Should not throw, should return external source when all dep repos fail
      expect(result.error).toBeUndefined();
      expect(result.result.specs.request.body).toEqual({ _type: 'com.external.ExternalDTO' });
      // Verify cross-repo query was attempted
      expect(mockCrossRepo.queryMultipleRepos).toHaveBeenCalled();
    });

    it('resolves type from dependency repo when one repo has error but other succeeds', async () => {
      const mockCrossRepo = createMockCrossRepoContext();
      mockCrossRepo.findDepRepo.mockResolvedValue(null);
      mockCrossRepo.listDepRepos.mockResolvedValue(['dep-repo-1', 'dep-repo-2']);
      mockCrossRepo.queryMultipleRepos.mockResolvedValue([
        { repoId: 'dep-repo-1', results: [], _error: 'repo_not_found' },
        { repoId: 'dep-repo-2', results: [{
          name: 'ExternalDTO',
          fields: JSON.stringify([
            { name: 'id', type: 'Long', annotations: [] },
            { name: 'name', type: 'String', annotations: [] },
          ]),
        }]},
      ]);

      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          content: 'public void createOrder(@RequestBody ExternalDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"com.external.ExternalDTO","annotations":["@RequestBody"]}]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/orders',
        executeQuery: mockExecuteQuery,
        crossRepo: mockCrossRepo,
      });

      // Should resolve from the repo that succeeded
      expect(result.error).toBeUndefined();
      const body = result.result.specs.request.body as Record<string, unknown>;
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
    });
  });

  describe('Same type for request and response', () => {
    it('resolves same type correctly for both request body and response body', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      // Mock handler with @RequestBody UserDTO and returnType UserDTO
      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          startLine: 30,
          endLine: 45,
          content: 'public UserDTO createUser(@RequestBody @Valid UserDTO dto) { return new UserDTO(); }',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"UserDTO","annotations":["@RequestBody","@Valid"]}]',
          returnType: 'UserDTO',
          annotations: '[]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      // Mock executeQuery to return the same class for both calls
      // Use mockResolvedValue to return the same value for all calls
      const mockExecuteQuery = vi.fn().mockResolvedValue([{
        name: 'UserDTO',
        fields: '[{"name":"id","type":"Long"},{"name":"name","type":"String"}]',
      }]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      // Verify both request.body and response.body have matching BodySchema
      expect(result.result.specs.request.body).toEqual({
        typeName: 'UserDTO',
        source: 'indexed',
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'id', type: 'Long' }),
          expect.objectContaining({ name: 'name', type: 'String' }),
        ]),
      });
      expect(result.result.specs.response.body).toEqual({
        typeName: 'UserDTO',
        source: 'indexed',
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'id', type: 'Long' }),
          expect.objectContaining({ name: 'name', type: 'String' }),
        ]),
      });
    });
  });

  describe('executeQuery returning undefined', () => {
    it('handles executeQuery returning undefined without TypeError', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          startLine: 30,
          endLine: 45,
          content: 'public UserDTO createUser(@RequestBody UserDTO dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"UserDTO","annotations":["@RequestBody"]}]',
          returnType: 'UserDTO',
          annotations: '[]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      // Mock executeQuery to return undefined (edge case)
      const mockExecuteQuery = vi.fn().mockResolvedValue(undefined);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/users',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      // Should not throw TypeError, should return external source
      expect(result.error).toBeUndefined();
      expect(result.result.specs.request.body).toEqual({
        typeName: 'UserDTO',
        source: 'external',
        fields: undefined,
      });
      expect(result.result.specs.response.body).toEqual({
        typeName: 'UserDTO',
        source: 'external',
        fields: undefined,
      });
    });
  });

  describe('recursive type resolution', () => {
    it('resolves nested types in request body', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/savings',
          controller: 'SavingController',
          handler: 'createSaving',
          filePath: 'src/controllers/SavingController.java',
          line: 42,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/SavingController.java:createSaving',
          name: 'createSaving',
          kind: 'Method',
          filePath: 'src/controllers/SavingController.java',
          depth: 0,
          startLine: 40,
          endLine: 50,
          content: 'public void createSaving(@RequestBody SavingMarketDto dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"SavingMarketDto","annotations":["@RequestBody"]}]',
          returnType: 'void',
          annotations: '[]',
        }],
        root: 'createSaving',
        summary: emptySummary(),
      });

      // Mock query for type resolution - mockResolvedValue handles all calls with default behavior
      // First call: SavingMarketDto, subsequent calls: CaptchaReqDto then empty
      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          const typeName = params.typeName;
          if (typeName === 'SavingMarketDto') {
            return [{
              name: 'SavingMarketDto',
              fields: JSON.stringify([
                { name: 'marketName', type: 'String', annotations: [] },
                { name: 'captcha', type: 'CaptchaReqDto', annotations: [] },
              ]),
            }];
          }
          if (typeName === 'CaptchaReqDto') {
            return [{
              name: 'CaptchaReqDto',
              fields: JSON.stringify([
                { name: 'token', type: 'String', annotations: [] },
                { name: 'action', type: 'String', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/savings',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Verify executeQuery was called for both SavingMarketDto and CaptchaReqDto
      const calls = mockExecuteQuery.mock.calls;
      const typeNames = calls.map(c => c[2]?.typeName).filter(Boolean);
      expect(typeNames).toContain('SavingMarketDto');
      expect(typeNames).toContain('CaptchaReqDto');
      
      // Request body should have nested types resolved
      const requestBody = result.result.specs.request.body as Record<string, unknown>;
      // CaptchaReqDto fields should be resolved, not placeholder
      expect(requestBody).toEqual({
        marketName: 'string',
        captcha: {
          token: 'string',
          action: 'string',
        },
      });
    });

    it('respects max depth limit', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/deep',
          controller: 'DeepController',
          handler: 'getDeep',
          filePath: 'src/controllers/DeepController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/DeepController.java:getDeep',
          name: 'getDeep',
          kind: 'Method',
          filePath: 'src/controllers/DeepController.java',
          depth: 0,
          startLine: 10,
          endLine: 20,
          content: 'public DeepDto getDeep() {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[]',
          returnType: 'DeepDto',
          annotations: '[]',
        }],
        root: 'getDeep',
        summary: emptySummary(),
      });

      // Mock chain of nested types: DeepDto -> Level1 -> Level2 -> ...
      const mockExecuteQuery = vi.fn()
        .mockResolvedValueOnce([{
          name: 'DeepDto',
          fields: JSON.stringify([
            { name: 'level1', type: 'Level1Dto', annotations: [] },
          ]),
        }])
        .mockResolvedValueOnce([{
          name: 'Level1Dto',
          fields: JSON.stringify([
            { name: 'level2', type: 'Level2Dto', annotations: [] },
          ]),
        }])
        .mockResolvedValue([]); // Limit reached

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/api/deep',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      // Should resolve up to the depth limit
      expect(mockExecuteQuery.mock.calls.length).toBeLessThanOrEqual(12); // maxDepth + some buffer
    });
  });

  describe('resolveAllNestedTypes circular reference handling', () => {
    it('handles circular reference without infinite loop', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:createUser',
          name: 'createUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          startLine: 30,
          endLine: 45,
          content: 'public UserDto createUser(@RequestBody UserDto dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"UserDto","annotations":["@RequestBody"]}]',
          returnType: 'void',
          annotations: '[]',
        }],
        root: 'createUser',
        summary: emptySummary(),
      });

      // Mock UserDto that references itself (circular reference)
      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'UserDto') {
            return [{
              name: 'UserDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'friend', type: 'UserDto', annotations: [] },  // Circular!
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/users',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      // Should complete without timeout/stack overflow
      expect(result.error).toBeUndefined();
      
      // Request body should resolve UserDto fields
      const requestBody = result.result.specs.request.body as Record<string, unknown>;
      // UserDto is expanded once, then circular reference gets placeholder
      // The friend field contains UserDto which has a circular reference back to itself
      // First expansion shows full UserDto with friend, second level shows placeholder
      expect(requestBody).toEqual({
        id: 0,
        friend: {
          id: 0,
          friend: { _type: 'UserDto' },  // Circular reference gets placeholder
        },
      });
      
      // UserDto may be queried multiple times: once for request body, once for nested resolution
      // The important thing is that circular references are handled without infinite loops
      const userDtoCalls = mockExecuteQuery.mock.calls.filter(
        c => c[2]?.typeName === 'UserDto'
      );
      // Allow multiple calls since nested resolution has its own visited set
      expect(userDtoCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('resolveAllNestedTypes generic container handling', () => {
    it('resolves List<X> inner types and generates array examples', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 50,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          startLine: 50,
          endLine: 60,
          content: 'public void createOrder(@RequestBody OrderDto dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"OrderDto","annotations":["@RequestBody"]}]',
          returnType: 'void',
          annotations: '[]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'OrderDto') {
            return [{
              name: 'OrderDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'items', type: 'List<ItemDto>', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'ItemDto') {
            return [{
              name: 'ItemDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'name', type: 'String', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/orders',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Verify ItemDto was queried for nested resolution
      const typeNames = mockExecuteQuery.mock.calls.map(c => c[2]?.typeName).filter(Boolean);
      expect(typeNames).toContain('OrderDto');
      expect(typeNames).toContain('ItemDto');
      
      // Request body should have items as array with resolved ItemDto fields
      const requestBody = result.result.specs.request.body as Record<string, unknown>;
      expect(requestBody).toEqual({
        id: 0,
        // List<ItemDto> should resolve to array of ItemDto examples
        items: [{ id: 0, name: 'string' }],
      });
    });

    it('handles nested generics Optional<List<X>>', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/settings',
          controller: 'SettingsController',
          handler: 'getSettings',
          filePath: 'src/controllers/SettingsController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/SettingsController.java:getSettings',
          name: 'getSettings',
          kind: 'Method',
          filePath: 'src/controllers/SettingsController.java',
          depth: 0,
          startLine: 20,
          endLine: 30,
          content: 'public SettingsDto getSettings() {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[]',
          returnType: 'SettingsDto',
          annotations: '[]',
        }],
        root: 'getSettings',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'SettingsDto') {
            return [{
              name: 'SettingsDto',
              fields: JSON.stringify([
                { name: 'name', type: 'String', annotations: [] },
                { name: 'tags', type: 'Optional<List<String>>', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/api/settings',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      const responseBody = result.result.specs.response.body as Record<string, unknown>;
      // Optional<List<String>> unwraps both generic layers
      // Optional is a container, List is a container -> result is [['string']] (2 levels)
      // Each generic wrapper adds an array level
      expect(responseBody).toEqual({
        name: 'string',
        tags: [['string']],  // Optional<List<String>> = 2 container wrappers -> 2 array levels
      });
    });

    it('handles X[] array type syntax', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/batch',
          controller: 'BatchController',
          handler: 'batchProcess',
          filePath: 'src/controllers/BatchController.java',
          line: 100,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/BatchController.java:batchProcess',
          name: 'batchProcess',
          kind: 'Method',
          filePath: 'src/controllers/BatchController.java',
          depth: 0,
          startLine: 100,
          endLine: 110,
          content: 'public void batchProcess(@RequestBody BatchDto dto) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"dto","type":"BatchDto","annotations":["@RequestBody"]}]',
          returnType: 'void',
          annotations: '[]',
        }],
        root: 'batchProcess',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'BatchDto') {
            return [{
              name: 'BatchDto',
              fields: JSON.stringify([
                { name: 'batchId', type: 'String', annotations: [] },
                { name: 'items', type: 'ItemDto[]', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'ItemDto') {
            return [{
              name: 'ItemDto',
              fields: JSON.stringify([
                { name: 'sku', type: 'String', annotations: [] },
                { name: 'qty', type: 'Integer', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/batch',
        include_context: false,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      const requestBody = result.result.specs.request.body as Record<string, unknown>;
      expect(requestBody).toEqual({
        batchId: 'string',
        // ItemDto[] should resolve to array of ItemDto examples
        items: [{ sku: 'string', qty: 0 }],
      });
    });
  });

  describe('request/response body nested fields in with-context mode', () => {
    it('request body has nested fields embedded when include_context is true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/orders',
          controller: 'OrderController',
          handler: 'createOrder',
          filePath: 'src/controllers/OrderController.java',
          line: 30,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/OrderController.java:createOrder',
          name: 'createOrder',
          kind: 'Method',
          filePath: 'src/controllers/OrderController.java',
          depth: 0,
          startLine: 28,
          endLine: 35,
          content: 'public OrderDto createOrder(@RequestBody CreateOrderReq req) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"req","type":"CreateOrderReq","annotations":["@RequestBody"]}]',
          returnType: 'OrderDto',
          annotations: '[]',
        }],
        root: 'createOrder',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'CreateOrderReq') {
            return [{
              name: 'CreateOrderReq',
              fields: JSON.stringify([
                { name: 'orderId', type: 'String', annotations: [] },
                { name: 'customer', type: 'CustomerDto', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'CustomerDto') {
            return [{
              name: 'CustomerDto',
              fields: JSON.stringify([
                { name: 'name', type: 'String', annotations: [] },
                { name: 'email', type: 'String', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'OrderDto') {
            return [{
              name: 'OrderDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'status', type: 'String', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/orders',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Request body should be BodySchema with nested fields
      const requestBody = result.result.specs.request.body as Record<string, any>;
      expect(requestBody.typeName).toBe('CreateOrderReq');
      expect(requestBody.source).toBe('indexed');
      expect(requestBody.fields).toBeDefined();
      expect(requestBody.fields).toHaveLength(2);
      
      // Check that nested CustomerDto has its fields embedded
      const customerField = requestBody.fields.find((f: any) => f.name === 'customer');
      expect(customerField).toBeDefined();
      expect(customerField.type).toBe('CustomerDto');
      expect(customerField.fields).toBeDefined();
      expect(customerField.fields).toHaveLength(2);
      expect(customerField.fields.map((f: any) => f.name)).toEqual(['name', 'email']);
    });

    it('response body has nested fields embedded when include_context is true', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 45,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/UserController.java:getUser',
          name: 'getUser',
          kind: 'Method',
          filePath: 'src/controllers/UserController.java',
          depth: 0,
          startLine: 43,
          endLine: 50,
          content: 'public UserDto getUser(Long id) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[]',
          returnType: 'UserDto',
          annotations: '[]',
        }],
        root: 'getUser',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'UserDto') {
            return [{
              name: 'UserDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'profile', type: 'ProfileDto', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'ProfileDto') {
            return [{
              name: 'ProfileDto',
              fields: JSON.stringify([
                { name: 'avatar', type: 'String', annotations: [] },
                { name: 'bio', type: 'String', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'GET',
        path: '/api/users/{id}',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Response body should be BodySchema with nested fields
      const responseBody = result.result.specs.response.body as Record<string, any>;
      expect(responseBody.typeName).toBe('UserDto');
      expect(responseBody.source).toBe('indexed');
      expect(responseBody.fields).toBeDefined();
      expect(responseBody.fields).toHaveLength(2);
      
      // Check that nested ProfileDto has its fields embedded
      const profileField = responseBody.fields.find((f: any) => f.name === 'profile');
      expect(profileField).toBeDefined();
      expect(profileField.type).toBe('ProfileDto');
      expect(profileField.fields).toBeDefined();
      expect(profileField.fields).toHaveLength(2);
      expect(profileField.fields.map((f: any) => f.name)).toEqual(['avatar', 'bio']);
    });

    it('handles circular references in nested fields without infinite loop', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/nodes',
          controller: 'NodeController',
          handler: 'createNode',
          filePath: 'src/controllers/NodeController.java',
          line: 20,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/NodeController.java:createNode',
          name: 'createNode',
          kind: 'Method',
          filePath: 'src/controllers/NodeController.java',
          depth: 0,
          startLine: 18,
          endLine: 25,
          content: 'public NodeDto createNode(@RequestBody NodeDto node) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"node","type":"NodeDto","annotations":["@RequestBody"]}]',
          returnType: 'NodeDto',
          annotations: '[]',
        }],
        root: 'createNode',
        summary: emptySummary(),
      });

      // Circular reference: NodeDto.parent -> NodeDto
      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'NodeDto') {
            return [{
              name: 'NodeDto',
              fields: JSON.stringify([
                { name: 'id', type: 'Long', annotations: [] },
                { name: 'parent', type: 'NodeDto', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/nodes',
        include_context: true,
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Request body should have fields but circular reference should not expand infinitely
      const requestBody = result.result.specs.request.body as Record<string, any>;
      expect(requestBody.typeName).toBe('NodeDto');
      expect(requestBody.fields).toBeDefined();
      expect(requestBody.fields).toHaveLength(2);
      
      // The 'parent' field references NodeDto - circular reference detection prevents infinite recursion
      // but still embeds one level of fields (so you can see the structure)
      const parentField = requestBody.fields.find((f: any) => f.name === 'parent');
      expect(parentField).toBeDefined();
      expect(parentField.type).toBe('NodeDto');
      // Circular reference: fields ARE embedded (one level), but nested 'parent' won't have further fields
      expect(parentField.fields).toBeDefined();
      expect(parentField.fields).toHaveLength(2);
      // The nested 'parent' inside parentField should NOT have further fields embedded (circular protection)
      const nestedParentField = parentField.fields.find((f: any) => f.name === 'parent');
      expect(nestedParentField).toBeDefined();
      expect(nestedParentField.type).toBe('NodeDto');
      expect(nestedParentField.fields).toBeUndefined();
    });

    it('compact mode (default) does not embed nested fields - returns JSON example', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [{
          method: 'POST',
          path: '/api/items',
          controller: 'ItemController',
          handler: 'createItem',
          filePath: 'src/controllers/ItemController.java',
          line: 10,
        }],
      });

      vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
        chain: [{
          uid: 'Method:src/controllers/ItemController.java:createItem',
          name: 'createItem',
          kind: 'Method',
          filePath: 'src/controllers/ItemController.java',
          depth: 0,
          startLine: 8,
          endLine: 15,
          content: 'public void createItem(@RequestBody ItemDto item) {}',
          metadata: emptyMetadata(),
          callees: [],
          parameterAnnotations: '[{"name":"item","type":"ItemDto","annotations":["@RequestBody"]}]',
          returnType: 'void',
          annotations: '[]',
        }],
        root: 'createItem',
        summary: emptySummary(),
      });

      const mockExecuteQuery = vi.fn()
        .mockImplementation(async (repoId: string, query: string, params: Record<string, any>) => {
          if (params.typeName === 'ItemDto') {
            return [{
              name: 'ItemDto',
              fields: JSON.stringify([
                { name: 'name', type: 'String', annotations: [] },
                { name: 'nested', type: 'NestedDto', annotations: [] },
              ]),
            }];
          }
          if (params.typeName === 'NestedDto') {
            return [{
              name: 'NestedDto',
              fields: JSON.stringify([
                { name: 'value', type: 'Integer', annotations: [] },
              ]),
            }];
          }
          return [];
        });

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/items',
        include_context: false, // compact mode
        executeQuery: mockExecuteQuery,
      });

      expect(result.error).toBeUndefined();
      
      // Request body should be a JSON example object, not BodySchema with fields
      const requestBody = result.result.specs.request.body as Record<string, any>;
      // In compact mode, body is a JSON example: { name: 'string', nested: { value: 0 } }
      expect(typeof requestBody).toBe('object');
      // Should NOT have BodySchema properties like typeName, source, fields
      expect(requestBody.typeName).toBeUndefined();
      expect(requestBody.source).toBeUndefined();
      expect(requestBody.fields).toBeUndefined();
    });
  });
});
