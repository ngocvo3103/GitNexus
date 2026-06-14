import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateAgainstSchema,
  loadSchema,
  getDefaultSchemaPath,
  clearCache,
  formatValidationErrors,
} from '../../src/utils/schema-validator.js';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('schema-validator', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('getDefaultSchemaPath', () => {
    it('should return path to bundled schema', () => {
      const path = getDefaultSchemaPath();
      expect(path).toContain('schemas');
      expect(path).toContain('api-context-schema.json');
    });

    it('should point to existing file', () => {
      const path = getDefaultSchemaPath();
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('loadSchema', () => {
    it('should load bundled schema by default', () => {
      const schema = loadSchema();
      expect(schema).toBeDefined();
      expect((schema as any).$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect((schema as any).required).toBeDefined();
      expect((schema as any).required).toContain('method');
      expect((schema as any).required).toContain('path');
    });

    it('should cache schema on subsequent calls', () => {
      const schema1 = loadSchema();
      const schema2 = loadSchema();
      expect(schema1).toBe(schema2);
    });

    it('should throw error for non-existent custom schema', () => {
      expect(() => loadSchema('/non/existent/path/schema.json')).toThrow('Schema file not found');
    });

    it('should load custom schema from path', () => {
      // Create a temporary schema file
      const tempDir = join(tmpdir(), 'gitnexus-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      const tempSchemaPath = join(tempDir, 'test-schema.json');
      const customSchema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { test: { type: 'string' } },
      };
      writeFileSync(tempSchemaPath, JSON.stringify(customSchema));

      try {
        clearCache();
        const schema = loadSchema(tempSchemaPath);
        expect(schema).toBeDefined();
        expect((schema as any).properties.test.type).toBe('string');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('validateAgainstSchema', () => {
    it('should validate compliant output', () => {
      const compliantData = {
        method: 'GET',
        path: '/api/users',
        summary: 'Get all users from the system',
        specs: {
          request: {
            params: [],
            body: null,
            validation: [],
          },
          response: {
            body: { typeName: 'UserList', source: 'indexed' },
            codes: [{ code: 200, description: 'Success' }],
          },
        },
        externalDependencies: {
          downstreamApis: [],
          messaging: { outbound: [], inbound: [] },
          persistence: [],
        },
        logicFlow: 'sequenceDiagram\n  Client->>Server: Request',
        codeDiagram: 'graph TB\n  A --> B',
        cacheStrategy: {
          population: [],
          invalidation: [],
          update: [],
          flow: '',
        },
        retryLogic: [],
        keyDetails: {
          transactionManagement: [],
          businessRules: [],
          security: [],
        },
      };

      const result = validateAgainstSchema(compliantData);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should fail validation for missing required fields', () => {
      const incompleteData = {
        method: 'GET',
        path: '/api/users',
        // missing summary, specs, etc.
      };

      const result = validateAgainstSchema(incompleteData);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should fail validation for invalid method', () => {
      const invalidData = {
        method: 'INVALID', // Not in enum
        path: '/api/users',
        summary: 'Get all users',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'Success' }] },
        },
        externalDependencies: {
          downstreamApis: [],
          messaging: { outbound: [], inbound: [] },
          persistence: [],
        },
        logicFlow: '',
        codeDiagram: '',
        cacheStrategy: { population: [], invalidation: [], update: [], flow: '' },
        retryLogic: [],
        keyDetails: { transactionManagement: [], businessRules: [], security: [] },
      };

      const result = validateAgainstSchema(invalidData);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should fail validation for invalid path pattern', () => {
      const invalidPathData = {
        method: 'GET',
        path: 'api/users', // Missing leading /
        summary: 'Get all users',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'Success' }] },
        },
        externalDependencies: {
          downstreamApis: [],
          messaging: { outbound: [], inbound: [] },
          persistence: [],
        },
        logicFlow: '',
        codeDiagram: '',
        cacheStrategy: { population: [], invalidation: [], update: [], flow: '' },
        retryLogic: [],
        keyDetails: { transactionManagement: [], businessRules: [], security: [] },
      };

      const result = validateAgainstSchema(invalidPathData);
      expect(result.valid).toBe(false);
    });

    it('should fail validation for short summary', () => {
      const shortSummaryData = {
        method: 'GET',
        path: '/api/users',
        summary: 'Short', // minLength 10
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'Success' }] },
        },
        externalDependencies: {
          downstreamApis: [],
          messaging: { outbound: [], inbound: [] },
          persistence: [],
        },
        logicFlow: '',
        codeDiagram: '',
        cacheStrategy: { population: [], invalidation: [], update: [], flow: '' },
        retryLogic: [],
        keyDetails: { transactionManagement: [], businessRules: [], security: [] },
      };

      const result = validateAgainstSchema(shortSummaryData);
      expect(result.valid).toBe(false);
    });

    it('should validate with custom schema path', () => {
      const tempDir = join(tmpdir(), 'gitnexus-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      const tempSchemaPath = join(tempDir, 'custom-schema.json');
      const customSchema = {
        type: 'object',
        required: ['test'],
        properties: { test: { type: 'string' } },
      };
      writeFileSync(tempSchemaPath, JSON.stringify(customSchema));

      try {
        clearCache();
        const result = validateAgainstSchema({ test: 'value' }, undefined, tempSchemaPath);
        expect(result.valid).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('formatValidationErrors', () => {
    it('should return empty string for valid result', () => {
      const formatted = formatValidationErrors({ valid: true });
      expect(formatted).toBe('');
    });

    it('should format errors for invalid result', () => {
      const formatted = formatValidationErrors({
        valid: false,
        errors: [
          { path: 'root', message: 'must have required property' },
          { path: '/method', message: 'must be equal to one of the allowed values' },
        ],
      });
      expect(formatted).toContain('root');
      expect(formatted).toContain('/method');
      expect(formatted).toContain('must have required property');
    });
  });

  describe('clearCache', () => {
    it('should clear cached schema', () => {
      loadSchema(); // Load and cache
      clearCache();
      // After clear, should be able to load again
      const schema = loadSchema();
      expect(schema).toBeDefined();
    });
  });
});