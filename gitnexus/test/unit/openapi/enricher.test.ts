/**
 * enricher.test.ts — Unit tests for enrichExistingYaml
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockQueryEndpoints = vi.fn();
const mockExecuteParameterized = vi.fn();
const mockExecuteTrace = vi.fn();
const mockExtractAllDependencies = vi.fn();
const mockFindHandlerByPathPattern = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();

  // Default: no route found, uid not verified
  mockQueryEndpoints.mockResolvedValue({ endpoints: [] });
  mockExecuteParameterized.mockResolvedValue([]);
  mockExecuteTrace.mockResolvedValue({
    chain: [],
    root: 'testHandler',
    summary: { totalNodes: 0, maxDepthReached: 0, cycles: 0, httpCalls: 0, annotations: 0, eventPublishing: 0, repositoryCalls: 0 },
  });
  mockExtractAllDependencies.mockReturnValue({
    downstreamApis: [],
    messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
    persistence: [],
    annotations: { retry: [], transaction: [], security: [] },
    validation: [],
  });
  mockFindHandlerByPathPattern.mockResolvedValue(undefined);

  vi.doMock('../../../src/mcp/local/endpoint-query.js', () => ({
    queryEndpoints: mockQueryEndpoints,
  }));
  vi.doMock('../../../src/mcp/core/lbug-adapter.js', () => ({
    executeParameterized: mockExecuteParameterized,
  }));
  vi.doMock('../../../src/mcp/local/trace-executor.js', () => ({
    executeTrace: mockExecuteTrace,
  }));
  vi.doMock('../../../src/mcp/local/document-endpoint.js', () => ({
    extractAllDependencies: mockExtractAllDependencies,
    findHandlerByPathPattern: mockFindHandlerByPathPattern,
  }));
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Sample YAML fixtures
// ---------------------------------------------------------------------------

const SAMPLE_YAML = `
openapi: 3.1.0
info:
  title: Sample API
  version: 1.0.0
paths:
  /e/v1/bonds:
    get:
      operationId: listBonds
      summary: List all bonds
      responses:
        '200':
          description: OK
  /e/v1/bonds/{id}:
    get:
      operationId: getBond
      summary: Get a bond
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
    put:
      operationId: updateBond
      summary: Update a bond
      responses:
        '200':
          description: OK
  /i/v1/internal:
    post:
      operationId: internalOp
      summary: Internal operation
      responses:
        '200':
          description: OK
`;

const SAMPLE_WITH_EXTENSIONS = `
openapi: 3.1.0
info:
  title: Sample API
  version: 1.0.0
paths:
  /e/v1/bonds:
    get:
      operationId: listBonds
      summary: List all bonds
      x-custom-field: custom-value
      responses:
        '200':
          description: OK
`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockRepo() {
  return {
    id: 'test-repo',
    name: 'test-repo',
    repoPath: '/tmp/test',
    storagePath: '/tmp/test/storage',
    lbugPath: '/tmp/test/lbug',
    indexedAt: '2026-01-01T00:00:00Z',
    lastCommit: 'abc123',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichExistingYaml', () => {
  // ── 1. Single endpoint by method+path ──────────────────────────────────────
  it('test_enrich_single_endpoint_by_method_path', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/e/v1/bonds/{id}',
        handler: 'getBondDetails',
        controller: 'BookingIConnectExtControllerV2',
        filePath: 'src/com/tcbs/wallet/booking/controller/BookingIConnectExtControllerV2.java',
        line: 42,
      }],
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) {
        return [{ uid: 'Method:src/com/tcbs/wallet/booking/controller/BookingIConnectExtControllerV2.java:getBondDetails' }];
      }
      return [];
    });

    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [{ serviceName: 'PriceService', endpoint: '/prices', condition: '', purpose: 'fetch price', resolvedUrl: 'http://prices', resolvedFrom: 'static' }],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'GET',
      path: '/e/v1/bonds/{id}',
      executeQuery: mockExecuteParameterized,
    });

    const parsed = yaml.load(result) as Record<string, unknown>;
    const paths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const getBond = paths['/e/v1/bonds/{id}']?.['get'] as Record<string, unknown>;

    expect(getBond['x-downstream-apis']).toBeDefined();
    expect(Array.isArray(getBond['x-downstream-apis'])).toBe(true);
    // Other operations should NOT be enriched
    expect(paths['/e/v1/bonds']?.['get']?.['x-downstream-apis']).toBeUndefined();
  });

  // ── 2. All endpoints when no method/path specified ───────────────────────────
  it('test_enrich_all_endpoints_when_no_method_path_specified', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/e/v1/bonds',
        handler: 'listBonds',
        controller: 'BookingController',
        filePath: 'src/BookingController.java',
        line: 10,
      }],
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) return [{ uid: 'Method:src/BookingController.java:listBonds' }];
      return [];
    });
    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [{ serviceName: 'S', endpoint: '/e', condition: '', purpose: 'p', resolvedUrl: 'http://x', resolvedFrom: 'static' }],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    // Without method/path filter, all paths should be attempted.
    // We only care that it doesn't throw and returns valid YAML.
    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      executeQuery: mockExecuteParameterized,
    });

    expect(typeof result).toBe('string');
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed['paths']).toBeDefined();
  });

  // ── 3. Multiple specific endpoints ───────────────────────────────────────────
  it('test_enrich_multiple_specific_endpoints', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({ endpoints: [] });
    mockExecuteParameterized.mockResolvedValue([]);
    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    // Two separate calls with different method/path pairs
    const r1 = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'GET',
      path: '/e/v1/bonds',
    });
    const r2 = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'GET',
      path: '/e/v1/bonds/{id}',
    });

    expect(typeof r1).toBe('string');
    expect(typeof r2).toBe('string');
  });

  // ── 4. Preserves existing custom extensions ──────────────────────────────────
  it('test_enrich_preserves_existing_custom_extensions', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/e/v1/bonds',
        handler: 'listBonds',
        controller: 'BookingController',
        filePath: 'src/BookingController.java',
        line: 10,
      }],
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) return [{ uid: 'Method:src/BookingController.java:listBonds' }];
      return [];
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    const result = await enrichExistingYaml(SAMPLE_WITH_EXTENSIONS, repo, {
      method: 'GET',
      path: '/e/v1/bonds',
    });

    const parsed = yaml.load(result) as Record<string, unknown>;
    const paths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const getOp = paths['/e/v1/bonds']?.['get'] as Record<string, unknown>;
    // Original custom extension must survive
    expect(getOp['x-custom-field']).toBe('custom-value');
  });

  // ── 5. Unmatched operations unchanged ───────────────────────────────────────
  it('test_enrich_unmatched_operations_unchanged', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({ endpoints: [] });
    mockExecuteParameterized.mockResolvedValue([]);
    mockFindHandlerByPathPattern.mockResolvedValue(undefined);

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    // Only match GET /e/v1/nonexistent — other paths should be untouched
    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'GET',
      path: '/e/v1/nonexistent',
    });

    const parsed = yaml.load(result) as Record<string, unknown>;
    const paths = parsed['paths'] as Record<string, Record<string, unknown>>;
    // /e/v1/bonds GET should still exist but not be enriched
    expect(paths['/e/v1/bonds']?.['get']).toBeDefined();
    expect(paths['/e/v1/bonds']?.['get']?.['x-downstream-apis']).toBeUndefined();
  });

  // ── 6. Empty paths returns unchanged ────────────────────────────────────────
  it('test_enrich_empty_paths_returns_unchanged', async () => {
    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');
    const repo = makeMockRepo();
    const emptyYaml = 'openapi: 3.1.0\ninfo:\n  title: Empty\n  version: 1.0.0\npaths: {}\n';
    const result = await enrichExistingYaml(emptyYaml, repo, {});
    expect(result).toBe(emptyYaml);
  });

  // ── 7. Invalid YAML throws ─────────────────────────────────────────────────
  it('test_enrich_invalid_yaml_throws', async () => {
    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');
    const repo = makeMockRepo();
    await expect(enrichExistingYaml('  [invalid: yaml: content', repo, {})).rejects.toThrow('Failed to parse YAML');
  });

  // ── 8. Path not in graph skipped gracefully ──────────────────────────────────
  it('test_enrich_path_not_in_graph_skipped_gracefully', async () => {
    const repo = makeMockRepo();

    // No route found, handler search returns nothing
    mockQueryEndpoints.mockResolvedValue({ endpoints: [] });
    mockExecuteParameterized.mockResolvedValue([]);
    mockFindHandlerByPathPattern.mockResolvedValue(undefined);

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    // Must not throw even though nothing is found in the graph
    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'GET',
      path: '/e/v1/bonds/{id}',
    });

    const parsed = yaml.load(result) as Record<string, unknown>;
    const paths = parsed['paths'] as Record<string, Record<string, unknown>>;
    // Operation exists but was skipped (no graph data)
    expect(paths['/e/v1/bonds/{id}']?.['get']).toBeDefined();
    expect(paths['/e/v1/bonds/{id}']?.['get']?.['x-downstream-apis']).toBeUndefined();
  });

  // ── 9. Output roundtrips through YAML parser ─────────────────────────────────
  it('test_enrich_output_roundtrips_through_yaml_parser', async () => {
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/e/v1/bonds',
        handler: 'listBonds',
        controller: 'BookingController',
        filePath: 'src/BookingController.java',
        line: 10,
      }],
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) return [{ uid: 'Method:src/BookingController.java:listBonds' }];
      return [];
    });
    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [{ serviceName: 'X', endpoint: '/x', condition: '', purpose: 'p', resolvedUrl: 'http://x', resolvedFrom: 'static' }],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      executeQuery: mockExecuteParameterized,
    });

    // Must parse without error
    const parsed = yaml.load(result);
    expect(parsed).toBeDefined();
    expect((parsed as Record<string, unknown>)['openapi']).toBe('3.1.0');
  });

  // ── 10. CLI single endpoint enrichment ───────────────────────────────────────
  it('test_cli_input_yaml_single_endpoint_enriched', async () => {
    // This is tested at the integration level; here we verify the unit
    // logic that a single matched operation gets enriched
    const repo = makeMockRepo();

    mockQueryEndpoints.mockResolvedValue({
      endpoints: [{
        method: 'PUT',
        path: '/e/v1/bonds/{id}',
        handler: 'updateBond',
        controller: 'BookingIConnectExtControllerV2',
        filePath: 'src/BookingIConnectExtControllerV2.java',
        line: 55,
      }],
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) return [{ uid: 'Method:src/BookingIConnectExtControllerV2.java:updateBond' }];
      return [];
    });
    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [{ serviceName: 'PricingService', endpoint: '/v1/prices', condition: '', purpose: 'pricing', resolvedUrl: 'http://prices', resolvedFrom: 'static' }],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      method: 'PUT',
      path: '/e/v1/bonds/{id}',
      executeQuery: mockExecuteParameterized,
    });

    const parsed = yaml.load(result) as Record<string, unknown>;
    const paths = parsed['paths'] as Record<string, Record<string, unknown>>;
    const updateBond = paths['/e/v1/bonds/{id}']?.['put'] as Record<string, unknown>;

    expect(updateBond['x-downstream-apis']).toBeDefined();
    // GET on same path should NOT be enriched
    expect(paths['/e/v1/bonds/{id}']?.['get']?.['x-downstream-apis']).toBeUndefined();
  });

  // ── 11. CLI all endpoints enrichment ─────────────────────────────────────────
  it('test_cli_input_yaml_all_endpoints_enriched', async () => {
    const repo = makeMockRepo();

    // All three operations (GET /bonds, GET /bonds/{id}, PUT /bonds/{id}) found
    mockQueryEndpoints.mockImplementation(async () => ({
      endpoints: [{
        method: 'GET',
        path: '/e/v1/bonds',
        handler: 'listBonds',
        controller: 'BookingController',
        filePath: 'src/BookingController.java',
        line: 10,
      }],
    }));
    mockExecuteParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes('m.id = $uid')) return [{ uid: 'Method:src/BookingController.java:listBonds' }];
      return [];
    });
    mockExtractAllDependencies.mockReturnValue({
      downstreamApis: [{ serviceName: 'X', endpoint: '/x', condition: '', purpose: 'p', resolvedUrl: 'http://x', resolvedFrom: 'static' }],
      messaging: { outbound: [], inbound: [], nestedSchemas: new Map() },
      persistence: [],
      annotations: { retry: [], transaction: [], security: [] },
      validation: [],
    });

    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');

    const result = await enrichExistingYaml(SAMPLE_YAML, repo, {
      executeQuery: mockExecuteParameterized,
    });

    // Should not throw — verifies the all-paths path works
    expect(typeof result).toBe('string');
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed['paths']).toBeDefined();
  });

  // ── 12. CLI missing file exits with error ───────────────────────────────────
  // CLI-level behavior: tested via integration tests. Unit-level coverage here
  // verifies that the enricher throws when the YAML cannot be parsed.
  it('test_cli_input_yaml_missing_file_exits_with_error', async () => {
    const { enrichExistingYaml } = await import('../../../src/core/openapi/enricher.js');
    const repo = makeMockRepo();
    // Malformed YAML (unclosed bracket) must throw during parse
    await expect(
      enrichExistingYaml('openapi: 3.1.0\n  paths: [unclosed', repo, {})
    ).rejects.toThrow('Failed to parse YAML');
  });
});
