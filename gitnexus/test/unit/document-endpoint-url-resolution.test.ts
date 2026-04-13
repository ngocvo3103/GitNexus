/**
 * Unit Tests: Document Endpoint URL Resolution (WI-2)
 *
 * Tests endpoint string construction using resolvedValue, pathConstants, and staticParts.
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
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(),
}));

// Import after mocks are set up
import { documentEndpoint, deriveDisplayName } from '../../src/mcp/local/document-endpoint.js';
import * as endpointQuery from '../../src/mcp/local/endpoint-query.js';
import * as traceExecutor from '../../src/mcp/local/trace-executor.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

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
  builderDetails: [],
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

/**
 * Creates a mock executeQuery that dispatches based on query content.
 * This avoids brittle sequential mock index tracking.
 */
function createMockExecuteQuery(responses: { queryPattern: RegExp; response: any }[]) {
  return vi.fn().mockImplementation(async (_repoId: string, query: string) => {
    for (const { queryPattern, response } of responses) {
      if (queryPattern.test(query)) {
        return response;
      }
    }
    return [];
  });
}

describe('URL resolution endpoint construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: verification query returns the handler UID (method exists)
    // This mock is overridden per-test for custom handler UIDs
    vi.mocked(executeParameterized).mockImplementation(async (_repoId: string, query: string, params: any) => {
      if (query.includes('m.uid') && params?.uid) {
        // Return the uid to indicate method exists
        return [{ uid: params.uid }];
      }
      return [];
    });
  });

  /**
   * EP: resolvedValue is HTTP URL → endpoint shows resolved URL
   * urlExpression='bondService.getUrl()' → serviceName='bond', variableRefs=[]
   * Pass 1 resolves @Value → propertyKey='bond.url' → resolvedValue='https://api.example.com'
   */
  it('resolvedValue HTTP URL → endpoint uses resolved URL', async () => {
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

    const mockExecuteQuery = createMockExecuteQuery([
      // findEnclosingClass: has c.filePath in WHERE
      { queryPattern: /c\.filePath/, response: [{ name: 'DataController' }] },
      // resolveValueAnnotation: class query - returns Class with fields containing @Value for bondService
      { queryPattern: /MATCH \(c:Class\)/, response: [{
        fields: JSON.stringify([{
          name: 'bondService',
          annotationAttrs: [{ name: '@Value', attrs: { '0': '${bond.url}' } }]
        }]),
        className: 'DataController'
      }] },
      // resolvePropertyValue for 'bond.url'
      { queryPattern: /MATCH \(p:Property\)/, response: [{ content: 'https://api.example.com', filePath: 'application.yml' }] },
      // resolveStaticFieldValue: static final check
      { queryPattern: /static.*final|modifiers/, response: [] },
    ]);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/DataController.java:getData',
        name: 'getData',
        kind: 'Method',
        filePath: 'src/controllers/DataController.java',
        depth: 0,
        content: 'public String getData() { return restTemplate.getForObject(bondService.getUrl()); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'bondService.getUrl()' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/data',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.endpoint).toBe('GET https://api.example.com');
  });

  /**
   * EP: resolvedValue is path (starts with /) → endpoint shows resolved path
   */
  it('resolvedValue path → endpoint uses resolved path', async () => {
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

    const mockExecuteQuery = createMockExecuteQuery([
      { queryPattern: /c\.filePath/, response: [{ name: 'OrderController' }] },
      { queryPattern: /MATCH \(c:Class\)/, response: [{
        fields: JSON.stringify([{
          name: 'orderService',
          annotationAttrs: [{ name: '@Value', attrs: { '0': '${order.path}' } }]
        }]),
        className: 'OrderController'
      }] },
      { queryPattern: /MATCH \(p:Property\)/, response: [{ content: '/api/v1/orders', filePath: 'application.yml' }] },
      { queryPattern: /static.*final|modifiers/, response: [] },
    ]);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/OrderController.java:createOrder',
        name: 'createOrder',
        kind: 'Method',
        filePath: 'src/controllers/OrderController.java',
        depth: 0,
        content: 'public void createOrder() { restTemplate.postForObject(orderService.getPath(), request); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'orderService.getPath()' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/orders',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.endpoint).toBe('POST /api/v1/orders');
  });

  /**
   * EP: resolvedValue is null → falls back to staticParts
   */
  it('resolvedValue null → falls back to staticParts', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/users',
        controller: 'UserController',
        handler: 'getUsers',
        filePath: 'src/controllers/UserController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createMockExecuteQuery([
      { queryPattern: /findEnclosingClass|MATCH.*Class.*WHERE.*filePath/, response: [] },
    ]);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/UserController.java:getUsers',
        name: 'getUsers',
        kind: 'Method',
        filePath: 'src/controllers/UserController.java',
        depth: 0,
        content: 'public List<User> getUsers() { return restTemplate.getForObject("https://api.example.com/v2/users"); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: '"https://api.example.com/v2/users"' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/users',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.endpoint).toBe('GET https://api.example.com/v2/users');
  });

  /**
   * EP: pathConstants present → uses pathConstants (existing behavior, takes priority)
   */
  it('pathConstants present → uses pathConstants endpoint', async () => {
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

    // LIMIT_URI is a same-class static final constant
    // Use mockImplementation to dispatch based on params
    const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string, params: any) => {
      // findEnclosingClass
      if (params?.filePath) {
        return [{ name: 'LimitController' }];
      }
      // resolveValueAnnotation: classNamePattern = '.LimitController' indicates the class context
      // The className param is the pattern being searched for, not the actual class
      if (params?.classNamePattern === '.LimitController') {
        // resolveValueAnnotation: query contains field name (bondSettlementService or LIMIT_URI)
        // For LIMIT_URI, return empty (it's not an @Value annotated field)
        if (query.includes('bondSettlementService') || query.includes('LIMIT_URI')) {
          return [];
        }
        // Default: return class data
        return [{
          fields: JSON.stringify([{
            name: 'LIMIT_URI',
            modifiers: ['static', 'final'],
            value: '/limits/used'
          }])
        }];
      }
      return [];
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/LimitController.java:checkLimit',
        name: 'checkLimit',
        kind: 'Method',
        filePath: 'src/controllers/LimitController.java',
        depth: 0,
        content: 'public void checkLimit() { restTemplate.postForObject(LIMIT_URI, input); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'LIMIT_URI' }],
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
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.endpoint).toBe('POST /limits/used');
  });

  /**
   * EP: staticParts only → uses staticParts endpoint
   */
  it('staticParts only → uses staticParts endpoint', async () => {
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

    const mockExecuteQuery = createMockExecuteQuery([
      { queryPattern: /findEnclosingClass|MATCH.*Class.*WHERE.*filePath/, response: [] },
    ]);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/HealthController.java:health',
        name: 'health',
        kind: 'Method',
        filePath: 'src/controllers/HealthController.java',
        depth: 0,
        content: 'public String health() { return "OK"; }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: '"https://health.api.com/status"' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/health',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api.endpoint).toBe('GET https://health.api.com/status');
  });

  /**
   * Invariant: resolvedValue without http or / prefix → does NOT trigger resolvedValue branch
   */
  it('resolvedValue without http or / prefix → falls back to staticParts', async () => {
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

    // resolvedValue='localhost:8080' does NOT start with http or /
    const mockExecuteQuery = createMockExecuteQuery([
      { queryPattern: /findEnclosingClass|MATCH.*Class.*WHERE.*filePath/, response: [{ className: 'ConfigController' }] },
      { queryPattern: /MATCH.*Class.*WHERE.*hostService/, response: [{
        fields: JSON.stringify([{
          name: 'hostService',
          annotationAttrs: [{ name: '@Value', attrs: { '0': '${server.host}' } }]
        }]),
        className: 'ConfigController'
      }] },
      { queryPattern: /MATCH.*Property.*WHERE.*server\.host/, response: [{ content: 'localhost:8080', filePath: 'application.yml' }] },
      { queryPattern: /resolveStaticFieldValue|MATCH.*Class.*WHERE.*host/, response: [] },
    ]);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/ConfigController.java:getConfig',
        name: 'getConfig',
        kind: 'Method',
        filePath: 'src/controllers/ConfigController.java',
        depth: 0,
        content: 'public String getConfig() { restTemplate.getForObject(hostService.getHost() + "/config"); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'hostService.getHost() + "/config"' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/config',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    // resolvedValue "localhost:8080" does not start with http or / → should not be used
    expect(api.endpoint).not.toContain('localhost:8080');
    expect(api.endpoint).toContain('GET');
  });

  /**
   * Invariant: resolutionDetails still populated when using resolvedValue branch
   */
  it('resolvedValue branch → resolutionDetails still populated', async () => {
    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/info',
        controller: 'InfoController',
        handler: 'getInfo',
        filePath: 'src/controllers/InfoController.java',
        line: 25,
      }],
    });

    // Use mockImplementation
    const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string, params: any) => {
      // findEnclosingClass: params has filePath
      if (params?.filePath && !params?.className) {
        return [{ name: 'InfoController' }];
      }
      // resolveValueAnnotation: params has className and classNamePattern
      // Returns class data for InfoController - resolveValueAnnotation finds the field internally
      if (params?.className && params?.classNamePattern) {
        return [{
          fields: JSON.stringify([{
            name: 'infoService',
            annotationAttrs: [{ name: '@Value', attrs: { '0': '${info.url}' } }]
          }]),
          className: 'InfoController'
        }];
      }
      // resolvePropertyValue: params has propertyKey
      if (params?.propertyKey) {
        return [{ content: 'https://info.api.com', filePath: 'application.yml' }];
      }
      return [];
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/InfoController.java:getInfo',
        name: 'getInfo',
        kind: 'Method',
        filePath: 'src/controllers/InfoController.java',
        depth: 0,
        content: 'public String getInfo() { restTemplate.getForObject(infoService.getUrl()); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'infoService.getUrl()' }],
        },
        callees: [],
      }],
      root: 'testHandler',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/info',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const api = result.result.externalDependencies.downstreamApis[0];
    expect(api._context).toBeDefined();
    expect(api.resolutionDetails?.resolvedValue).toBe('https://info.api.com');
  });
});

describe('deriveDisplayName', () => {
  it('extracts first path segment from HTTP URL', () => {
    expect(deriveDisplayName('http://apiintsit.tcbs.com.vn/bond-settlement', 'v1', 'tcbs.bond.settlement.service.url')).toBe('bond-settlement');
  });

  it('extracts first path segment from HTTPS URL', () => {
    expect(deriveDisplayName('https://www.google.com/recaptcha/api/siteverify', 'recaptcha', 'hold.suggestion.captcha.google.url')).toBe('recaptcha');
  });

  it('strips trailing slash before extracting path segment', () => {
    expect(deriveDisplayName('http://apiintsit.tcbs.com.vn/matching-engine/', 'matching-engine', 'tcbs.matching.service.url')).toBe('matching-engine');
  });

  it('falls back to endpointServiceName when URL has no path (IP address)', () => {
    expect(deriveDisplayName('http://10.7.2.85:8092/', '10.7.2.85', 'tcbs.profile.service')).toBe('10.7.2.85');
  });

  it('falls back to fallbackName when URL has root path and endpointServiceName is null', () => {
    expect(deriveDisplayName('http://api.example.com/', null, 'fallback')).toBe('fallback');
  });

  it('falls back to endpointServiceName when resolvedValue is undefined', () => {
    expect(deriveDisplayName(undefined, 'v1', 'tcbs.bond.product.url')).toBe('v1');
  });

  it('falls back to endpointServiceName when resolvedValue is not a URL', () => {
    expect(deriveDisplayName('localhost:8080', 'v1', 'fallback')).toBe('v1');
  });

  it('extracts first path segment from multi-segment URL path', () => {
    expect(deriveDisplayName('http://apiintsit.tcbs.com.vn/hft-krema/v1/accounts', 'hft-krema', 'services.hft-krema.cashInvestments.url')).toBe('hft-krema');
  });
});
