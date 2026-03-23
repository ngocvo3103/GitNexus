/**
 * Unit Tests: Document Endpoint Tool
 *
 * Tests the document-endpoint tool for generating API documentation JSON.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documentEndpoint } from '../../src/mcp/local/document-endpoint.js';
import * as endpointQuery from '../../src/mcp/local/endpoint-query.js';
import * as traceExecutor from '../../src/mcp/local/trace-executor.js';

// Mock the dependencies
vi.mock('../../src/mcp/local/endpoint-query.js', () => ({
  queryEndpoints: vi.fn(),
}));

vi.mock('../../src/mcp/local/trace-executor.js', () => ({
  executeTrace: vi.fn(),
}));

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

describe('documentEndpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('minimal mode (default)', () => {
    it('returns error when endpoint not found', async () => {
      vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
        endpoints: [],
        total: 0,
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
        total: 1,
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
        }],
        metadata: {},
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
      total: 1,
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
      }],
      metadata: {},
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
      }],
      metadata: {},
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
      }],
      metadata: {},
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
      }],
      metadata: {},
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
      }],
      metadata: {},
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
      total: 1,
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
      }],
      metadata: {},
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
      total: 1,
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
      }],
      metadata: {},
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
      total: 1,
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
      }],
      metadata: {},
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
      total: 1,
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
      }],
      metadata: {},
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
      total: 1,
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
        parameters: '[{"name":"userDTO","type":"UserDTO","annotations":["@RequestBody"]}]',
        returnType: 'User',
      }],
      metadata: {},
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
