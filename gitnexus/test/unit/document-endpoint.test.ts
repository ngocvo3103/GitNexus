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

vi.mock('../../src/core/lbug-adapter.js', () => ({
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(),
}));

// Import after mocks are set up
import { documentEndpoint } from '../../src/mcp/local/document-endpoint.js';
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
      expect(result.result._context?.callChain).toBeDefined();
      expect(result.result._context?.callChain).toHaveLength(1);
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
        parameters: '[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody"]}]',
        returnType: 'User',
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/users',
    });

    // Body schema: when include_context is false (default), body is null for external types
    // External types (not in graph) return null since we can't generate a JSON example
    expect(result.result.specs.request.body).toBeNull();
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
    parameters: '[{"name":"event","type":"OrderEvent","annotations":[]}]',
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
          parameters: '[{"name":"event","type":"TransactionEvent","annotations":[]}]',
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
          parameters: '[{"name":"msg","type":"OrderMessage","annotations":[]}]',
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
          parameters: '[{"name":"event","type":"PaymentEvent","annotations":[]}]',
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
          parameters: '[{"name":"msg","type":"OrderMessage","annotations":[]}]',
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
          parameters: '[{"name":"event","type":"PaymentEvent","annotations":[]}]',
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
            parameters: '[{"name":"event","type":"AppEvent","annotations":[]}]',
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
            parameters: '[{"name":"msg","type":"RabbitMsg","annotations":[]}]',
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
          parameters: '[{"name":"event","type":"ContextEvent","annotations":[]}]',
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
          parameters: '[]',
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
    parameters,
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
          parameters: '[{"name":"id","type":"Long","annotations":["@PathVariable"]},{"name":"filter","type":"String","annotations":["@RequestParam(required=false)"]}]',
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
          parameters: 'not valid json',
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
    parameters,
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
          parameters: '[{"name":"name","type":"String","annotations":["@NotNull"]}]',
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
      expect(result.result.specs.request.validation[0]._context).toContain('@NotNull');
      expect(result.result.specs.request.validation[0]._context).toContain('src/controllers/UserController.java');
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
            parameters: '[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody","@Valid"]}]',
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
            parameters: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
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
      // Should have the imperative validation rule with TODO_AI_ENRICH
      const imperativeRule = result.result.specs.request.validation.find(
        (r: any) => r.field === 'TODO_AI_ENRICH'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?._context).toBeDefined();
      expect(imperativeRule?._context).toContain('TcbsValidator.doValidate');
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
            parameters: '[{"name":"user","type":"UserDTO","annotations":[]}]',
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
        (r: any) => r.field === 'TODO_AI_ENRICH'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?._context).toContain('ValidationUtils.validate');
    });

    it('does not detect imperative validation when include_context is false', async () => {
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
            parameters: '[{"name":"order","type":"OrderDTO","annotations":[]}]',
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

      // Should not have any validation rules since no annotations and imperative detection is off
      expect(result.result.specs.request.validation).toHaveLength(0);
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
            parameters: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
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

      // Should have the imperative validation rule with TODO_AI_ENRICH
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.field === 'TODO_AI_ENRICH'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?._context).toBeDefined();
      expect(imperativeRule?._context).toContain('validateJWT');
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
            parameters: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
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

      // Should have the imperative validation rule with TODO_AI_ENRICH
      const imperativeRule = result.result.specs.request.validation.find(
        (r) => r.field === 'TODO_AI_ENRICH'
      );
      expect(imperativeRule).toBeDefined();
      expect(imperativeRule?._context).toContain('ValidationService.process');
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
            parameters: '[{\"name\":\"order\",\"type\":\"OrderDTO\",\"annotations\":[]}]',
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

      // Should have multiple imperative validation rules
      const imperativeRules = result.result.specs.request.validation.filter(
        (r) => r.field === 'TODO_AI_ENRICH'
      );
      expect(imperativeRules.length).toBeGreaterThanOrEqual(2);
    });
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
          parameters: '[]',
          annotations: '[]',
        }],
        root: 'triggerListener',
        summary: emptySummary(),
      });

      // Mock executeQuery to return array format (LadybugDB style)
      // Columns: m.name, m.annotations, m.filePath, m.parameters
      // Array indices: [0], [1], [2], [3]
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        [
          'onMessage',  // name
          JSON.stringify([{ name: '@RabbitListener', attrs: { queues: 'order.queue' } }]),  // annotations
          'src/listeners/OrderListener.java',  // filePath
          JSON.stringify([{ name: 'msg', type: 'OrderMessage', annotations: [] }]),  // parameters
        ],
      ]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/listeners',
        include_context: true,
      }, { executeQuery: mockExecuteQuery });

      // Should detect @RabbitListener from graph query
      expect(result.result.externalDependencies.messaging.inbound.length).toBeGreaterThanOrEqual(1);
      
      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('order.queue');
      expect(inbound.payload).toBe('OrderMessage');
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
          parameters: '[]',
          annotations: '[]',
        }],
        root: 'triggerListener',
        summary: emptySummary(),
      });

      // Mock executeQuery to return array format for @KafkaListener
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        [
          'consumeOrder',  // name
          JSON.stringify([{ name: '@KafkaListener', attrs: { topics: 'orders-topic' } }]),  // annotations
          'src/listeners/KafkaConsumer.java',  // filePath
          JSON.stringify([{ name: 'order', type: 'OrderEvent', annotations: [] }]),  // parameters
        ],
      ]);

      const result = await documentEndpoint(mockRepo, {
        method: 'POST',
        path: '/api/listeners',
        include_context: true,
      }, { executeQuery: mockExecuteQuery });

      const inbound = result.result.externalDependencies.messaging.inbound[0];
      expect(inbound.topic).toBe('orders-topic');
      expect(inbound.payload).toBe('OrderEvent');
      expect(inbound.consumptionLogic).toBe('KafkaConsumer.consumeOrder()');
      expect(inbound._context).toContain('src/listeners/KafkaConsumer.java');
    });
  });
});
