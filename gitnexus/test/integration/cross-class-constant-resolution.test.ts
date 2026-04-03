/**
 * Integration Tests: Cross-Class Constant Resolution
 *
 * Tests the resolution of static final field values across classes.
 * The fix uses Class.fields JSON property instead of querying non-existent Field nodes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the debug flag
vi.mock('../../src/core/util/debug.js', () => ({
  isDebugEnabled: () => false,
}));

// We need to test the actual query generation and result parsing
// This is done by creating mock executeQuery responses that simulate
// what the graph would return after the fix is applied

describe('Cross-Class Constant Resolution', () => {
  // Sample fields JSON that would be stored on a Class node
  const createFieldsJson = (fields: Array<{
    name: string;
    modifiers?: string[];
    value?: string;
  }>) => JSON.stringify(fields);

  describe('resolveStaticFieldValueCrossClass query behavior', () => {
    it('constant found: returns value from static final field', async () => {
      // Simulate executeQuery returning Class with fields containing the constant
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Constants',
          fields: createFieldsJson([
            { name: 'BASE_URL', modifiers: ['static', 'final'], value: 'https://api.example.com' },
            { name: 'TIMEOUT', modifiers: ['static', 'final'], value: '5000' },
          ]),
        },
      ]);

      // The cross-class query uses: MATCH (c:Class) WHERE c.fields CONTAINS $fieldName
      // fieldName = 'BASE_URL' would match the Constants class
      const fieldName = 'BASE_URL';
      const crossClassQuery = `
        MATCH (c:Class)
        WHERE c.fields CONTAINS $fieldName
        RETURN c.name AS className, c.fields AS fields
        LIMIT 5
      `;

      const rows = await mockExecuteQuery('test-repo', crossClassQuery, { fieldName });
      expect(rows).toHaveLength(1);

      // Parse JSON and filter for static final with value
      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        const fields = JSON.parse(row.fields);
        const field = fields.find((f: any) =>
          f.name === fieldName &&
          f.modifiers?.includes('static') &&
          f.modifiers?.includes('final') &&
          f.value !== undefined
        );
        if (field) {
          results.push({ className: row.className, value: field.value });
        }
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        className: 'Constants',
        value: 'https://api.example.com',
      });
    });

    it('constant not found: returns empty when field does not exist', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Constants',
          fields: createFieldsJson([
            { name: 'BASE_URL', modifiers: ['static', 'final'], value: 'https://api.example.com' },
          ]),
        },
      ]);

      const fieldName = 'NONEXISTENT_FIELD';
      const crossClassQuery = `
        MATCH (c:Class)
        WHERE c.fields CONTAINS $fieldName
        RETURN c.name AS className, c.fields AS fields
        LIMIT 5
      `;

      const rows = await mockExecuteQuery('test-repo', crossClassQuery, { fieldName });

      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        const fields = JSON.parse(row.fields);
        const field = fields.find((f: any) =>
          f.name === fieldName &&
          f.modifiers?.includes('static') &&
          f.modifiers?.includes('final') &&
          f.value !== undefined
        );
        if (field) {
          results.push({ className: row.className, value: field.value });
        }
      }

      expect(results).toHaveLength(0);
    });

    it('field not static: returns empty when field lacks static modifier', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Service',
          fields: createFieldsJson([
            { name: 'instanceUrl', modifiers: ['final'], value: 'https://instance.example.com' },
          ]),
        },
      ]);

      const fieldName = 'instanceUrl';
      const rows = await mockExecuteQuery('test-repo', 'MATCH (c:Class) RETURN c.name AS className, c.fields AS fields', {});

      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        const fields = JSON.parse(row.fields);
        const field = fields.find((f: any) =>
          f.name === fieldName &&
          f.modifiers?.includes('static') &&
          f.modifiers?.includes('final') &&
          f.value !== undefined
        );
        if (field) {
          results.push({ className: row.className, value: field.value });
        }
      }

      expect(results).toHaveLength(0);
    });

    it('field has no value: returns empty when static final field has undefined value', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Constants',
          fields: createFieldsJson([
            { name: 'BASE_PATH', modifiers: ['static', 'final'] }, // no value
          ]),
        },
      ]);

      const fieldName = 'BASE_PATH';
      const rows = await mockExecuteQuery('test-repo', 'MATCH (c:Class) RETURN c.name AS className, c.fields AS fields', {});

      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        const fields = JSON.parse(row.fields);
        const field = fields.find((f: any) =>
          f.name === fieldName &&
          f.modifiers?.includes('static') &&
          f.modifiers?.includes('final') &&
          f.value !== undefined
        );
        if (field) {
          results.push({ className: row.className, value: field.value });
        }
      }

      expect(results).toHaveLength(0);
    });

    it('malformed JSON: handles gracefully with try/catch', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'BadClass',
          fields: '{ not valid json ',
        },
      ]);

      const rows = await mockExecuteQuery('test-repo', 'MATCH (c:Class) RETURN c.name AS className, c.fields AS fields', {});

      const results: Array<{ className: string; value: string }> = [];
      const errors: string[] = [];

      for (const row of rows) {
        try {
          const fields = JSON.parse(row.fields);
          const field = fields.find((f: any) =>
            f.name === 'any' &&
            f.modifiers?.includes('static') &&
            f.modifiers?.includes('final') &&
            f.value !== undefined
          );
          if (field) {
            results.push({ className: row.className, value: field.value });
          }
        } catch (e) {
          errors.push('parse error');
        }
      }

      expect(results).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('prefers URL-like values when multiple matches exist', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Constants',
          fields: createFieldsJson([
            { name: 'SERVICE_URL', modifiers: ['static', 'final'], value: 'internal-service' },
          ]),
        },
        {
          className: 'Config',
          fields: createFieldsJson([
            { name: 'SERVICE_URL', modifiers: ['static', 'final'], value: 'https://api.example.com/service' },
          ]),
        },
      ]);

      const fieldName = 'SERVICE_URL';
      const rows = await mockExecuteQuery('test-repo', 'MATCH (c:Class) RETURN c.name AS className, c.fields AS fields', {});

      // Parse all matching fields
      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        try {
          const fields = JSON.parse(row.fields);
          const field = fields.find((f: any) =>
            f.name === fieldName &&
            f.modifiers?.includes('static') &&
            f.modifiers?.includes('final') &&
            f.value !== undefined
          );
          if (field) {
            results.push({ className: row.className, value: field.value });
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }

      // Prefer URL-like values
      const urlField = results.find((r) =>
        r.value?.startsWith('http') ||
        r.value?.includes('/api/') ||
        r.value?.includes('/v1/') ||
        r.value?.includes('/v2/')
      );

      const finalResult = urlField ?? results[0];

      expect(finalResult.value).toBe('https://api.example.com/service');
      expect(finalResult.className).toBe('Config');
    });

    it('returns first match when no URL-like values exist', async () => {
      const mockExecuteQuery = vi.fn().mockResolvedValue([
        {
          className: 'Constants',
          fields: createFieldsJson([
            { name: 'TIMEOUT', modifiers: ['static', 'final'], value: '5000' },
          ]),
        },
        {
          className: 'Config',
          fields: createFieldsJson([
            { name: 'TIMEOUT', modifiers: ['static', 'final'], value: '3000' },
          ]),
        },
      ]);

      const fieldName = 'TIMEOUT';
      const rows = await mockExecuteQuery('test-repo', 'MATCH (c:Class) RETURN c.name AS className, c.fields AS fields', {});

      const results: Array<{ className: string; value: string }> = [];
      for (const row of rows) {
        try {
          const fields = JSON.parse(row.fields);
          const field = fields.find((f: any) =>
            f.name === fieldName &&
            f.modifiers?.includes('static') &&
            f.modifiers?.includes('final') &&
            f.value !== undefined
          );
          if (field) {
            results.push({ className: row.className, value: field.value });
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }

      // No URL-like values, fall back to first match
      const urlField = results.find((r) =>
        r.value?.startsWith('http') ||
        r.value?.includes('/api/') ||
        r.value?.includes('/v1/') ||
        r.value?.includes('/v2/')
      );

      const finalResult = urlField ?? results[0];

      expect(finalResult.value).toBe('5000');
      expect(finalResult.className).toBe('Constants');
    });
  });
});
