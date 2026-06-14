/**
 * Unit Tests: extractDownstreamApis Self-Reference Exclusion (Issue #35)
 *
 * When the class-name heuristic would derive a service name matching the
 * endpoint's own controller (e.g. BondExtController → "bond-ext"), the
 * downstream API should be excluded to prevent self-referential dependencies.
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
import { documentEndpoint } from '../../src/mcp/local/document-endpoint.js';
import * as endpointQuery from '../../src/mcp/local/endpoint-query.js';
import * as traceExecutor from '../../src/mcp/local/trace-executor.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

// Type guard: narrow the union return type to the context branch
type DocumentEndpointContextResult = { result: import('../../src/mcp/local/document-endpoint.js').DocumentEndpointResult; error?: string };
function asContextResult(r: DocumentEndpointContextResult | import('../../src/mcp/local/document-endpoint.js').OpenApiModeResult): DocumentEndpointContextResult {
  return r as DocumentEndpointContextResult;
}

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
 * Configured to let all resolution passes fail so the class-name heuristic
 * is the only path that can produce a service name.
 */
function createMockExecuteQuery(enclosingClassName: string) {
  return vi.fn().mockImplementation(async (_repoId: string, query: string) => {
    // findEnclosingClass: MATCH (c:Class) WHERE c.filePath = $filePath
    if (query.includes('c.filePath')) {
      return [{ name: enclosingClassName }];
    }
    // All other queries (Property, Class with @Value, FeignClient, static final, etc.)
    // return empty results so no resolution pass succeeds before the class-name heuristic.
    return [];
  });
}

describe('extractDownstreamApis self-reference exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: verification query returns the handler UID (method exists)
    vi.mocked(executeParameterized).mockImplementation(async (_repoId: string, query: string, params: any) => {
      if (params?.uid && (query.includes('m.id') || query.includes('Method {id:'))) {
        if (query.includes('parameterAnnotations')) {
          return [{ paramAnns: '[]' }];
        }
        return [{ id: params.uid }];
      }
      return [];
    });
  });

  /**
   * Test 1: Self-reference excluded.
   * The endpoint's controller is BondExtController → "bond-ext".
   * The HTTP call node is inside the same class → class-name heuristic
   * also derives "bond-ext" → should be skipped.
   */
  it('excludes downstream API when class-name heuristic matches the current controller', async () => {
    const controller = 'BondExtController';
    // serviceNameFromClassName('BondExtController') === 'bond-ext'

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createMockExecuteQuery(controller);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/BondExtController.java:getItems',
        name: 'getItems',
        kind: 'Method',
        filePath: 'src/controllers/BondExtController.java',
        depth: 0,
        content: 'public String getItems() { return restTemplate.getForObject(targetUrl); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'targetUrl' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // The self-referential entry should be excluded
    expect(apis).toHaveLength(0);
  });

  /**
   * Test 2: Different controller allowed.
   * The endpoint's controller is BondExtController → "bond-ext".
   * The HTTP call node is inside ProductController → "product" (different).
   * Should NOT be excluded.
   */
  it('includes downstream API when class-name heuristic derives a different service name', async () => {
    const routeController = 'BondExtController';
    const callNodeClass = 'ProductController';
    // serviceNameFromClassName('ProductController') === 'product' (≠ 'bond-ext')

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller: routeController,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createMockExecuteQuery(callNodeClass);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/ProductController.java:callProduct',
        name: 'callProduct',
        kind: 'Method',
        filePath: 'src/services/ProductController.java',
        depth: 0,
        content: 'public String callProduct() { return restTemplate.getForObject(targetUrl); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'targetUrl' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe('product');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
  });

  /**
   * Test 3: No currentController (undefined).
   * When route has no controller, the class-name heuristic works as before.
   */
  it('includes downstream API when currentController is undefined (backward compat)', async () => {
    const callNodeClass = 'BondExtController';

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/items',
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
        // controller is intentionally omitted → undefined
      }],
    });

    const mockExecuteQuery = createMockExecuteQuery(callNodeClass);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/BondExtController.java:getItems',
        name: 'getItems',
        kind: 'Method',
        filePath: 'src/controllers/BondExtController.java',
        depth: 0,
        content: 'public String getItems() { return restTemplate.getForObject(targetUrl); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'targetUrl' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe('bond-ext');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
  });

  /**
   * Test 4: Empty currentController string.
   * Empty string is falsy, so the exclusion check is skipped.
   */
  it('includes downstream API when currentController is empty string', async () => {
    const callNodeClass = 'BondExtController';

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/items',
        controller: '',
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createMockExecuteQuery(callNodeClass);

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/BondExtController.java:getItems',
        name: 'getItems',
        kind: 'Method',
        filePath: 'src/controllers/BondExtController.java',
        depth: 0,
        content: 'public String getItems() { return restTemplate.getForObject(targetUrl); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'targetUrl' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe('bond-ext');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
  });
});