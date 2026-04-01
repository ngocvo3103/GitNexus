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

import { queryEndpoints } from '../../../src/mcp/local/endpoint-query.js';
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

  describe('Route empty, fallback to Methods', () => {
    it('queries Method nodes when Route query returns empty', async () => {
      // First call: Route query returns empty
      mockExecuteParameterized.mockResolvedValueOnce([]);

      // Second call: Method fallback query returns results
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'POST',
          path: '/api/products',
          controller: 'ProductController',
          handler: 'createProduct',
          filePath: 'src/controllers/ProductController.java',
          line: 78,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toEqual({
        method: 'POST',
        path: '/api/products',
        controller: 'ProductController',
        handler: 'createProduct',
        filePath: 'src/controllers/ProductController.java',
        line: 78,
      });

      // Verify both queries were called
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
    });

    it('filters Method nodes by method when options provided', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'DELETE',
          path: '/api/items/{id}',
          controller: 'ItemController',
          handler: 'deleteItem',
          filePath: 'src/controllers/ItemController.java',
          line: 99,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'DELETE' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].method).toBe('DELETE');
    });

    it('filters Method nodes by path when options provided', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'GET',
          path: '/api/users',
          controller: 'UserController',
          handler: 'listUsers',
          filePath: 'src/controllers/UserController.java',
          line: 30,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { path: 'users' }
      );

      // Verify fallback was called with annotations array and path filter
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
      const fallbackCall = mockExecuteParameterized.mock.calls[1];
      expect(fallbackCall[2]).toMatchObject({ path: 'users' });
      expect(fallbackCall[2]).toHaveProperty('annotations');

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].path).toBe('/api/users');
    });

    it('filters Method nodes by both method AND path', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          method: 'POST',
          path: '/api/users',
          controller: 'UserController',
          handler: 'createUser',
          filePath: 'src/controllers/UserController.java',
          line: 45,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' },
        { method: 'POST', path: 'users' }
      );

      // Verify fallback was called with both filters plus annotations
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
      const fallbackCall = mockExecuteParameterized.mock.calls[1];
      expect(fallbackCall[2]).toMatchObject({ method: 'POST', path: 'users' });
      expect(fallbackCall[2]).toHaveProperty('annotations');

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].method).toBe('POST');
    });
  });

  describe('Neither Route nor Method nodes', () => {
    it('returns empty array when both queries return empty', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockResolvedValueOnce([]); // Method empty

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(0);
      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
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
      });
    });

    it('applies defaults for missing method/path in fallback', async () => {
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockResolvedValueOnce([
        {
          // method and path missing/null — should default to 'GET' and '/'
          controller: 'FallbackController',
          handler: 'defaultHandler',
          filePath: 'src/controllers/FallbackController.java',
          line: 10,
        },
      ]);

      const result = await queryEndpoints(
        { id: 'test-repo', path: '/test' }
      );

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].method).toBe('GET');
      expect(result.endpoints[0].path).toBe('/');
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
      mockExecuteParameterized.mockResolvedValueOnce([]); // Route empty
      mockExecuteParameterized.mockRejectedValueOnce(new Error('Query timeout'));

      await expect(queryEndpoints({ id: 'test-repo', path: '/test' }))
        .rejects.toThrow('Query timeout');

      expect(mockExecuteParameterized).toHaveBeenCalledTimes(2);
    });
  });
});