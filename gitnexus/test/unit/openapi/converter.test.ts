import { describe, it, expect } from 'vitest';
import {
  bodySchemaToOpenAPISchema,
  convertToOpenAPIPathItem,
  convertToOpenAPIDocument,
  generateSchemaName,
  shouldExtractToComponents,
  type BodySchema,
} from '../../../src/core/openapi/index.js';

describe('bodySchemaToOpenAPISchema', () => {
  it('handles null/undefined input', () => {
    expect(bodySchemaToOpenAPISchema(null)).toEqual({});
    expect(bodySchemaToOpenAPISchema(undefined)).toEqual({});
  });

  it('converts primitive types', () => {
    const schema: BodySchema = {
      typeName: 'String',
      source: 'primitive',
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.type).toBe('string');
  });

  it('converts integer types', () => {
    const schema: BodySchema = {
      typeName: 'Integer',
      source: 'primitive',
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.type).toBe('integer');
  });

  it('converts object with fields', () => {
    const schema: BodySchema = {
      typeName: 'User',
      source: 'indexed',
      fields: [
        { name: 'id', type: 'Long', annotations: ['@NotNull'] },
        { name: 'name', type: 'String', annotations: ['@NotBlank', '@Size(max=100)'] },
        { name: 'email', type: 'String', annotations: ['@Email'] },
      ],
    };
    const result = bodySchemaToOpenAPISchema(schema);

    expect(result.type).toBe('object');
    expect(result.properties).toBeDefined();
    expect(result.properties?.id).toBeDefined();
    expect(result.properties?.id.type).toBe('integer');
    expect(result.properties?.name.type).toBe('string');
    expect(result.required).toContain('id');
    expect(result.required).toContain('name');
    expect(result.properties?.email.format).toBe('email');
  });

  it('converts container types (List)', () => {
    const schema: BodySchema = {
      typeName: 'List<User>',
      source: 'indexed',
      isContainer: true,
    };
    const result = bodySchemaToOpenAPISchema(schema);

    expect(result.type).toBe('array');
    expect(result.items).toBeDefined();
    // Unknown types (User) default to 'string' in the TYPE_MAP
    expect(result.items?.type).toBe('string');
  });
});

describe('convertToOpenAPIPathItem', () => {
  it('converts a simple GET endpoint', () => {
    const result = {
      method: 'GET',
      path: '/users/{id}',
      summary: 'Get user by ID',
      specs: {
        request: {
          params: [
            { name: 'id', type: 'Long', required: true, description: 'User ID' },
          ],
          body: null,
          validation: [],
        },
        response: {
          body: { typeName: 'User', source: 'indexed', fields: [] } as BodySchema,
          codes: [{ code: 200, description: 'Success' }],
        },
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result, components, { extractSchemas: true });

    expect(pathItem.get).toBeDefined();
    expect(pathItem.get?.summary).toBe('Get user by ID');
    expect(pathItem.get?.operationId).toBe('get_users_id');
    expect(pathItem.get?.parameters).toBeDefined();
    expect(pathItem.get?.parameters?.length).toBe(1);
    expect(pathItem.get?.responses['200']).toBeDefined();
  });

  it('converts a POST endpoint with request body', () => {
    const result = {
      method: 'POST',
      path: '/users',
      summary: 'Create user',
      specs: {
        request: {
          params: [],
          body: {
            typeName: 'CreateUserRequest',
            source: 'indexed',
            fields: [
              { name: 'name', type: 'String', annotations: ['@NotBlank'] },
              { name: 'email', type: 'String', annotations: ['@Email'] },
            ],
          } as BodySchema,
          validation: [],
        },
        response: {
          body: { typeName: 'User', source: 'indexed', fields: [] } as BodySchema,
          codes: [{ code: 201, description: 'Created' }],
        },
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result, components, { extractSchemas: true });

    expect(pathItem.post).toBeDefined();
    expect(pathItem.post?.requestBody).toBeDefined();
    expect(pathItem.post?.requestBody?.content['application/json']).toBeDefined();
    expect(pathItem.post?.responses['201']).toBeDefined();
  });
});

describe('convertToOpenAPIDocument', () => {
  it('creates a valid OpenAPI document', () => {
    const results = [
      {
        method: 'GET',
        path: '/users',
        summary: 'List users',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: {
            body: { typeName: 'List', source: 'primitive', isContainer: true } as BodySchema,
            codes: [{ code: 200, description: 'Success' }],
          },
        },
      },
      {
        method: 'POST',
        path: '/users',
        summary: 'Create user',
        specs: {
          request: {
            params: [],
            body: { typeName: 'CreateUserRequest', source: 'indexed', fields: [] } as BodySchema,
            validation: [],
          },
          response: {
            body: { typeName: 'User', source: 'indexed', fields: [] } as BodySchema,
            codes: [{ code: 201, description: 'Created' }],
          },
        },
      },
    ];

    const doc = convertToOpenAPIDocument(results, { title: 'Test API', version: '1.0.0' });

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Test API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.paths['/users']).toBeDefined();
    expect(doc.paths['/users'].get).toBeDefined();
    expect(doc.paths['/users'].post).toBeDefined();
  });

  it('normalizes paths with colon parameters', () => {
    const results = [
      {
        method: 'GET',
        path: '/users/:id',
        summary: 'Get user',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'OK' }] },
        },
      },
    ];

    const doc = convertToOpenAPIDocument(results);
    expect(doc.paths['/users/{id}']).toBeDefined();
  });
});

describe('generateSchemaName', () => {
  it('generates valid schema names', () => {
    expect(generateSchemaName('User')).toBe('User');
    expect(generateSchemaName('CreateUserRequest')).toBe('CreateUserRequest');
    expect(generateSchemaName('List<User>')).toBe('ListUser');
    expect(generateSchemaName('Map<String, Object>')).toBe('MapStringObject');
  });
});

describe('shouldExtractToComponents', () => {
  it('returns true for named indexed types with fields', () => {
    const schema: BodySchema = {
      typeName: 'User',
      source: 'indexed',
      fields: [{ name: 'id', type: 'Long', annotations: [] }],
    };
    expect(shouldExtractToComponents(schema)).toBe(true);
  });

  it('returns false for primitive types', () => {
    const schema: BodySchema = {
      typeName: 'String',
      source: 'primitive',
    };
    expect(shouldExtractToComponents(schema)).toBe(false);
  });

  it('returns false for container types', () => {
    const schema: BodySchema = {
      typeName: 'List<User>',
      source: 'indexed',
      isContainer: true,
    };
    expect(shouldExtractToComponents(schema)).toBe(false);
  });
});