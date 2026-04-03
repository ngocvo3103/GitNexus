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