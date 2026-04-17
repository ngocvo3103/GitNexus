/**
 * Unit Tests: Endpoint Query
 *
 * Tests fallback query logic when Route nodes don't exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock executeParameterized before importing the module
vi.mock('../../../src/mcp/core/lbug-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

import { queryEndpoints, queryAllEndpoints } from '../../../src/mcp/local/endpoint-query.js';
import { executeParameterized } from '../../../src/mcp/core/lbug-adapter.js';

const mockExecuteParameterized = vi.mocked(executeParameterized);

describe('queryEndpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Route nodes exist', () => {
    it('returns Route nodes without fallback', async () => {
      // Mock Route query returns results
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: 'Method:src/controllers/UserController.java:getUsers',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'GET' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toEqual({
        method: 'GET',
        path: '/api/users',
        controller: 'UserController',
        handler: 'getUsers',
        filePath: 'src/controllers/UserController.java',
        line: 42,
        handlerUid: 'Method:src/controllers/UserController.java:getUsers',
      });

      // Verify only one query was called (no fallback)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });

    it('filters Route nodes by path', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 55,
          handlerUid: 'Method:src/controllers/UserController.java:getUser',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { path: 'users' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].path).toBe('/api/users/{id}');
    });
  });

  describe('Route empty', () => {
    it('returns empty endpoints when Route query returns empty', async () => {
      // Route query returns empty - queryEndpoints does NOT fall back to Method nodes
      // (Method fallback is handled at the document-endpoint.ts level, not in queryEndpoints)
      mockExecuteParameterized.mockResolvedValueOnce([]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(0);
      // Verify only one query was called (Route only, no Method fallback in queryEndpoints)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });

    it('returns empty when Route query returns empty with method filter', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'DELETE' }
      );

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });

    it('returns empty when Route query returns empty with path filter', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { path: 'users' }
      );

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });
  });

  describe('Neither Route nodes exist', () => {
    it('returns empty array when Route query returns empty', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });
  });

  describe('Result mapping', () => {
    it('maps result with undefined optional fields', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/health',
          controller: undefined,
          handler: undefined,
          filePath: undefined,
          line: undefined,
          handlerUid: undefined,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toEqual({
        method: 'GET',
        path: '/health',
        controller: undefined,
        handler: undefined,
        filePath: undefined,
        line: undefined,
        handlerUid: undefined,
      });
    });
  });

  describe('Exact match priority', () => {
    it('returns exact match when method and path are both provided', async () => {
      // Exact match query returns one result
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'PUT',
          path: '/i/v2/orders/ibond/{id}/sign',
          controller: 'OrderIBondIntControllerV2',
          handler: 'signContract',
          filePath: 'src/main/java/com/tcbs/bond/trading/controller/internal/v2/OrderIBondIntControllerV2.java',
          line: 164,
          handlerUid: 'Method:src/main/java/com/tcbs/bond/trading/controller/internal/v2/OrderIBondIntControllerV2.java:signContract',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'PUT', path: '/i/v2/orders/ibond/{id}/sign' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].path).toBe('/i/v2/orders/ibond/{id}/sign');
      expect(result.endpoints[0].handler).toBe('signContract');

      // Verify exact match query was called first (one call, no CONTAINS fallback)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
      const cypher = mockExecuteParameterized.mock.calls[0][1] as string;
      expect(cypher).toContain('r.routePath = $path');
      expect(cypher).not.toContain('CONTAINS');
    });

    it('falls back to CONTAINS when exact match returns no results', async () => {
      // Exact match returns empty
      mockExecuteParameterized.mockResolvedValueOnce([]);
      // CONTAINS fallback returns results
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users/search',
          controller: 'UserController',
          handler: 'searchUsers',
          filePath: 'src/controllers/UserController.java',
          line: 80,
          handlerUid: 'Method:src/controllers/UserController.java:searchUsers',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'GET', path: 'users' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].path).toBe('/api/users/search');

      // Two calls: exact match (empty), then CONTAINS (results)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
      const exactCypher = mockExecuteParameterized.mock.calls[0][1] as string;
      const containsCypher = mockExecuteParameterized.mock.calls[1][1] as string;
      expect(exactCypher).toContain('r.routePath = $path');
      expect(containsCypher).toContain('CONTAINS');
    });

    it('does not use exact match when only method is provided (no path)', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: 'Method:src/controllers/UserController.java:getUsers',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'GET' }
      );

      expect(result.endpoints).toHaveLength(1);
      // Only one call — CONTAINS query (no exact match since path not provided)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
      const cypher = mockExecuteParameterized.mock.calls[0][1] as string;
      expect(cypher).not.toContain('r.routePath = $path');
      expect(cypher).toContain('r.httpMethod = $method');
    });

    it('does not use exact match when only path is provided (no method)', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'getUser',
          filePath: 'src/controllers/UserController.java',
          line: 55,
          handlerUid: 'Method:src/controllers/UserController.java:getUser',
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { path: 'users' }
      );

      expect(result.endpoints).toHaveLength(1);
      // Only one call — CONTAINS query (no exact match since method not provided)
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
      const cypher = mockExecuteParameterized.mock.calls[0][1] as string;
      expect(cypher).not.toContain('r.routePath = $path');
      expect(cypher).toContain('CONTAINS');
    });
  });

  describe('Error handling', () => {
    it('propagates error when Route query fails', async () => {
      mockExecuteParameterized.mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(queryEndpoints({ id: 'test-repo', path: '/test' }))
        .rejects.toThrow('Database connection failed');

      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });

    it('propagates error when fallback query fails', async () => {
      // Route query returns empty - Method fallback is NOT in queryEndpoints scope
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty

      // queryEndpoints doesn't fall back to Method, so no second call
      // and therefore no error to propagate
      const result = await queryEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });
  });
});

describe('queryAllEndpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Empty result', () => {
    it('returns empty endpoints when no Route nodes exist', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });

    it('calls executeParameterized with empty params', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(mockExecuteParameterized).toHaveBeenCalledWith(
        'test-repo',
        expect.stringContaining('MATCH (r:Route)'),
        {}
      );
    });
  });

  describe('Single result', () => {
    it('returns one endpoint with all fields populated', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: 'Method:src/controllers/UserController.java:getUsers',
        },
      ]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toEqual({
        method: 'GET',
        path: '/api/users',
        controller: 'UserController',
        handler: 'getUsers',
        filePath: 'src/controllers/UserController.java',
        line: 42,
        handlerUid: 'Method:src/controllers/UserController.java:getUsers',
      });
    });
  });

  describe('Multiple results', () => {
    it('returns multiple endpoints with all fields mapped correctly', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: 'Method:src/controllers/UserController.java:getUsers',
        },
        {
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 55,
          handlerUid: 'Method:src/controllers/UserController.java:createUser',
        },
        {
          method: 'DELETE',
          path: '/api/users/{id}',
          controller: 'UserController',
          handler: 'deleteUser',
          filePath: 'src/controllers/UserController.java',
          line: 68,
          handlerUid: 'Method:src/controllers/UserController.java:deleteUser',
        },
      ]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(3);
      expect(result.endpoints[0]).toEqual({
        method: 'GET',
        path: '/api/users',
        controller: 'UserController',
        handler: 'getUsers',
        filePath: 'src/controllers/UserController.java',
        line: 42,
        handlerUid: 'Method:src/controllers/UserController.java:getUsers',
      });
      expect(result.endpoints[1]).toEqual({
        method: 'POST',
        path: '/api/users',
        controller: 'UserController',
        handler: 'createUser',
        filePath: 'src/controllers/UserController.java',
        line: 55,
        handlerUid: 'Method:src/controllers/UserController.java:createUser',
      });
      expect(result.endpoints[2]).toEqual({
        method: 'DELETE',
        path: '/api/users/{id}',
        controller: 'UserController',
        handler: 'deleteUser',
        filePath: 'src/controllers/UserController.java',
        line: 68,
        handlerUid: 'Method:src/controllers/UserController.java:deleteUser',
      });
    });
  });

  describe('Undefined optional fields', () => {
    it('maps undefined optional fields to undefined', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/health',
          controller: undefined,
          handler: undefined,
          filePath: undefined,
          line: undefined,
          handlerUid: undefined,
        },
      ]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toEqual({
        method: 'GET',
        path: '/health',
        controller: undefined,
        handler: undefined,
        filePath: undefined,
        line: undefined,
        handlerUid: undefined,
      });
    });
  });

  describe('Query structure', () => {
    it('includes OPTIONAL MATCH for CALLS edge to resolve handlerUid', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      const cypher = mockExecuteParameterized.mock.calls[0][1];
      expect(cypher).toContain('OPTIONAL MATCH (r)-[:CodeRelation {type: \'CALLS\'}]->(m:Method)');
      expect(cypher).toContain('m.id AS handlerUid');
    });

    it('does not include WHERE clause in cypher query', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      const cypher = mockExecuteParameterized.mock.calls[0][1];
      expect(cypher).not.toContain('WHERE');
    });

    it('passes empty params object to executeParameterized', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]);

      await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      const params = mockExecuteParameterized.mock.calls[0][2];
      expect(params).toEqual({});
      expect(Object.keys(params)).toHaveLength(0);
    });

    it('returns handlerUid from CALLS edge', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: 'Method:src/controllers/UserController.java:getUsers',
        },
      ]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].handlerUid).toBe('Method:src/controllers/UserController.java:getUsers');
    });

    it('sets handlerUid to undefined when CALLS edge returns null', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'getUsers',
          filePath: 'src/controllers/UserController.java',
          line: 42,
          handlerUid: null,
        },
      ]);

      const result = await queryAllEndpoints({ id: 'test-repo', path: '/test' });

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].handlerUid).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('propagates error when database query fails', async () => {
      mockExecuteParameterized.mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(queryAllEndpoints({ id: 'test-repo', path: '/test' }))
        .rejects.toThrow('Database connection failed');

      expect(mockExecuteParameterized).toHaveBeenCalledTimes(1);
    });
  });
});
