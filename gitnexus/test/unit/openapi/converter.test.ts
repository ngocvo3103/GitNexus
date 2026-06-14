import { describe, it, expect } from 'vitest';
import {
  bodySchemaToOpenAPISchema,
  codesToResponses,
  convertToOpenAPIPathItem,
  convertToOpenAPIDocument,
  convertToOpenAPIYamlString,
  embedXExtensions,
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
    // Unknown types (User) are non-primitive → resolve to 'object'
    expect(result.items?.type).toBe('object');
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

// WI-7: @NotNull minLength constraint only applies to string types
describe('WI-7: @NotNull minLength on integer types', () => {
  const cases = [
    { type: 'String', annotation: '@NotNull', expectMinLength: true, label: '@NotNull on String → minLength 1' },
    { type: 'Long', annotation: '@NotNull', expectMinLength: false, label: '@NotNull on Long → no minLength' },
    { type: 'String', annotation: '@NotEmpty', expectMinLength: true, label: '@NotEmpty on String → minLength 1' },
    { type: 'Integer', annotation: '@NotEmpty', expectMinLength: false, label: '@NotEmpty on Integer → no minLength' },
    { type: 'String', annotation: '@NotBlank', expectMinLength: true, label: '@NotBlank on String → minLength 1' },
    { type: 'Integer', annotation: '@NotBlank', expectMinLength: false, label: '@NotBlank on Integer → no minLength' },
    { type: 'BigDecimal', annotation: '@NotNull', expectMinLength: false, label: '@NotNull on BigDecimal → no minLength' },
    { type: 'Boolean', annotation: '@NotNull', expectMinLength: false, label: '@NotNull on Boolean → no minLength' },
  ];

  cases.forEach(({ type, annotation, expectMinLength, label }) => {
    it(label, () => {
      const schema: BodySchema = {
        typeName: 'TestDto',
        source: 'indexed',
        fields: [
          { name: 'field', type, annotations: [annotation] },
        ],
      };
      const result = bodySchemaToOpenAPISchema(schema);
      if (expectMinLength) {
        expect(result.properties?.field.minLength).toBe(1);
      } else {
        expect(result.properties?.field.minLength).toBeUndefined();
      }
    });
  });
});

// WI-8: required array includes integer fields with @NotNull (not tied to minLength)
describe('WI-8: required array on top-level component schemas', () => {
  it('integer @NotNull field is in required', () => {
    const schema: BodySchema = {
      typeName: 'OrderDto',
      source: 'indexed',
      fields: [
        { name: 'id', type: 'Long', annotations: ['@NotNull'] },
        { name: 'name', type: 'String', annotations: [] },
      ],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.required).toContain('id');
    expect(result.required).not.toContain('name');
  });

  it('no required annotations → undefined/empty required', () => {
    const schema: BodySchema = {
      typeName: 'UserDto',
      source: 'indexed',
      fields: [
        { name: 'id', type: 'Long', annotations: [] },
        { name: 'name', type: 'String', annotations: [] },
      ],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.required).toBeUndefined();
  });

  it('mixed types in required', () => {
    const schema: BodySchema = {
      typeName: 'MixedDto',
      source: 'indexed',
      fields: [
        { name: 'id', type: 'Long', annotations: ['@NotNull'] },
        { name: 'count', type: 'Integer', annotations: ['@NotNull'] },
        { name: 'optional', type: 'String', annotations: [] },
      ],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.required).toContain('id');
    expect(result.required).toContain('count');
    expect(result.required).not.toContain('optional');
  });

  it('all three annotation types populate required', () => {
    const schema: BodySchema = {
      typeName: 'AllAnnotationsDto',
      source: 'indexed',
      fields: [
        { name: 'a', type: 'String', annotations: ['@NotNull'] },
        { name: 'b', type: 'String', annotations: ['@NotEmpty'] },
        { name: 'c', type: 'String', annotations: ['@NotBlank'] },
        { name: 'd', type: 'String', annotations: [] },
      ],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.required).toContain('a');
    expect(result.required).toContain('b');
    expect(result.required).toContain('c');
    expect(result.required).not.toContain('d');
  });
});

// WI-9: Date format fix and field-name heuristics
describe('WI-9: Date format and field-name heuristics', () => {
  // EP: type-based format cases
  it('Date → date-time', () => {
    const schema: BodySchema = {
      typeName: 'EventDto',
      source: 'indexed',
      fields: [{ name: 'createdAt', type: 'Date', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.properties?.createdAt.format).toBe('date-time');
  });

  it('LocalDate → date', () => {
    const schema: BodySchema = {
      typeName: 'ScheduleDto',
      source: 'indexed',
      fields: [{ name: 'birthDate', type: 'LocalDate', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.properties?.birthDate.format).toBe('date');
  });

  it('LocalDateTime → date-time', () => {
    const schema: BodySchema = {
      typeName: 'EventDto',
      source: 'indexed',
      fields: [{ name: 'eventTime', type: 'LocalDateTime', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.properties?.eventTime.format).toBe('date-time');
  });

  // Field-name heuristics: *Time → date-time
  it('field *Time → date-time when type format is undefined', () => {
    const schema: BodySchema = {
      typeName: 'UpdateDto',
      source: 'indexed',
      fields: [{ name: 'updateTime', type: 'Instant', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    // Instant already has date-time, verify field-name doesn't break it
    expect(result.properties?.updateTime.format).toBe('date-time');
  });

  it('field without time suffix → no heuristic format', () => {
    const schema: BodySchema = {
      typeName: 'StatusDto',
      source: 'indexed',
      fields: [{ name: 'username', type: 'String', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    expect(result.properties?.username.format).toBeUndefined();
  });

  it('type format overrides field-name heuristic', () => {
    const schema: BodySchema = {
      typeName: 'UserDto',
      source: 'indexed',
      fields: [{ name: 'birthdayTime', type: 'LocalDate', annotations: [] }],
    };
    const result = bodySchemaToOpenAPISchema(schema);
    // LocalDate → date, not overridden by *Time suffix
    expect(result.properties?.birthdayTime.format).toBe('date');
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

describe('codesToResponses', () => {
  it('4xx uses $ref for ErrorResponse', () => {
    const codes = [{ code: 400, description: 'Bad Request' }];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(result['400']).toBeDefined();
    expect(result['400'].content).toBeDefined();
    expect(result['400'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ErrorResponse' });
  });

  it('5xx uses $ref for ErrorResponse', () => {
    const codes = [{ code: 500, description: 'Internal Server Error' }];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(result['500']).toBeDefined();
    expect(result['500'].content).toBeDefined();
    expect(result['500'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ErrorResponse' });
  });

  it('ErrorResponse appears in components exactly once', () => {
    const codes = [
      { code: 400, description: 'Bad Request' },
      { code: 404, description: 'Not Found' },
      { code: 500, description: 'Internal Server Error' },
    ];
    const components = {};
    codesToResponses(codes, null, components, true);
    expect(components.schemas).toBeDefined();
    const schemaNames = Object.keys(components.schemas!);
    const count = schemaNames.filter(n => n === 'ErrorResponse').length;
    expect(count).toBe(1);
  });

  it('success response uses actual body schema (unaffected)', () => {
    const codes = [{ code: 200, description: 'OK' }];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(result['200']).toBeDefined();
    // Success with null body — 200 response has no schema in content
    expect(result['200'].content).toBeUndefined();
  });

  it('aggregates descriptions when multiple codes share same HTTP status', () => {
    const codes = [
      { code: 400, description: 'Validation failed' },
      { code: 400, description: 'Invalid input' },
      { code: 400, description: 'Missing required field' },
    ];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['400'].description).toBe('Validation failed | Invalid input | Missing required field');
  });

  it('preserves distinct status codes', () => {
    const codes = [
      { code: 200, description: 'OK' },
      { code: 400, description: 'Bad Request' },
      { code: 500, description: 'Internal Server Error' },
    ];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result['200']).toBeDefined();
    expect(result['400']).toBeDefined();
    expect(result['500']).toBeDefined();
  });

  it('returns default response for empty codes', () => {
    const codes: Array<{ code: number; description?: string }> = [];
    const components = {};
    const result = codesToResponses(codes, null, components, true);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['default']).toBeDefined();
    expect(result['default'].description).toBe('Default response');
  });

  it('attaches example for success BodySchema response', () => {
    const bodySchema: BodySchema = {
      typeName: 'User',
      source: 'indexed',
      fields: [
        { name: 'id', type: 'Long', annotations: ['@NotNull'] },
        { name: 'name', type: 'String', annotations: [] },
      ],
    };
    const codes = [{ code: 200, description: 'Success' }];
    const components = {};
    const result = codesToResponses(codes, bodySchema, components, true);
    expect(result['200']).toBeDefined();
    expect(result['200'].content).toBeDefined();
    expect(result['200'].content['application/json'].example).toBeDefined();
    expect(result['200'].content['application/json'].example.id).toBe(0);
    expect(result['200'].content['application/json'].example.name).toBeDefined();
  });
});

describe('external dependencies extensions', () => {
  it('includes downstream APIs in markdown description table', () => {
    const result = {
      method: 'GET',
      path: '/users/{id}',
      summary: 'Get user',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 200, description: 'OK' }] },
      },
      externalDependencies: {
        downstreamApis: [
          { serviceName: 'auth-service', name: 'auth-service', endpoint: 'POST /validate', condition: 'always', purpose: 'Validate token' },
        ],
        messaging: { outbound: [], inbound: [] },
        persistence: [],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.get).toBeDefined();
    expect(pathItem.get?.['x-downstream-apis']).toBeUndefined();
    expect(pathItem.get?.description).toBeDefined();
    expect(pathItem.get?.description).toContain('## External Dependencies');
    expect(pathItem.get?.description).toContain('**Downstream APIs:**');
    expect(pathItem.get?.description).toContain('| Service | Method | Endpoint |');
    expect(pathItem.get?.description).toContain('| auth-service | POST | /validate |');
  });

  it('includes messaging in markdown description table', () => {
    const result = {
      method: 'POST',
      path: '/users',
      summary: 'Create user',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 201, description: 'Created' }] },
      },
      externalDependencies: {
        downstreamApis: [],
        messaging: {
          outbound: [{ topic: 'user-events', trigger: 'on success' }],
          inbound: [{ topic: 'config-updates' }],
        },
        persistence: [],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.post?.['x-messaging']).toBeUndefined();
    expect(pathItem.post?.description).toBeDefined();
    expect(pathItem.post?.description).toContain('## External Dependencies');
    expect(pathItem.post?.description).toContain('**Messaging:**');
    expect(pathItem.post?.description).toContain('| Topic | Direction |');
    expect(pathItem.post?.description).toContain('| user-events | outbound |');
    expect(pathItem.post?.description).toContain('| config-updates | inbound |');
  });

  it('includes persistence in markdown description table', () => {
    const result = {
      method: 'GET',
      path: '/users',
      summary: 'List users',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 200, description: 'OK' }] },
      },
      externalDependencies: {
        downstreamApis: [],
        messaging: { outbound: [], inbound: [] },
        persistence: [
          { database: 'postgres', tables: 'users, sessions', storedProcedures: 'get_user_by_id' },
        ],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.get?.['x-persistence']).toBeUndefined();
    expect(pathItem.get?.description).toBeDefined();
    expect(pathItem.get?.description).toContain('## External Dependencies');
    expect(pathItem.get?.description).toContain('**Persistence:**');
    expect(pathItem.get?.description).toContain('| Database | Tables |');
    expect(pathItem.get?.description).toContain('| postgres | users, sessions |');
  });

  it('omits extensions when no dependencies', () => {
    const result = {
      method: 'GET',
      path: '/health',
      summary: 'Health check',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 200, description: 'OK' }] },
      },
      externalDependencies: {
        downstreamApis: [],
        messaging: { outbound: [], inbound: [] },
        persistence: [],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.get?.['x-downstream-apis']).toBeUndefined();
    expect(pathItem.get?.['x-messaging']).toBeUndefined();
    expect(pathItem.get?.['x-persistence']).toBeUndefined();
    expect(pathItem.get?.description).toBeUndefined();
  });

  it('includes all dependency types together in markdown description', () => {
    const result = {
      method: 'POST',
      path: '/orders',
      summary: 'Create order',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 201, description: 'Created' }] },
      },
      externalDependencies: {
        downstreamApis: [
          { serviceName: 'payment-service', name: 'payment-service', endpoint: 'POST /charge', condition: 'if payment required', purpose: 'Process payment' },
        ],
        messaging: {
          outbound: [{ topic: 'order-created', trigger: 'on success' }],
          inbound: [],
        },
        persistence: [
          { database: 'mysql', tables: 'orders, order_items' },
        ],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    // Extensions should NOT be present
    expect(pathItem.post?.['x-downstream-apis']).toBeUndefined();
    expect(pathItem.post?.['x-messaging']).toBeUndefined();
    expect(pathItem.post?.['x-persistence']).toBeUndefined();

    // Markdown description should contain all dependency types
    expect(pathItem.post?.description).toBeDefined();
    expect(pathItem.post?.description).toContain('## External Dependencies');
    expect(pathItem.post?.description).toContain('**Downstream APIs:**');
    expect(pathItem.post?.description).toContain('| payment-service | POST | /charge |');
    expect(pathItem.post?.description).toContain('**Messaging:**');
    expect(pathItem.post?.description).toContain('| order-created | outbound |');
    expect(pathItem.post?.description).toContain('**Persistence:**');
    expect(pathItem.post?.description).toContain('| mysql | orders, order_items |');
  });

  it('includes Markdown description with dependency summary', () => {
    const result = {
      method: 'POST',
      path: '/orders',
      summary: 'Create order',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 201, description: 'Created' }] },
      },
      externalDependencies: {
        downstreamApis: [
          { serviceName: 'payment-service', name: 'payment-service', endpoint: '/charge', condition: 'always', purpose: 'Process payment' },
        ],
        messaging: {
          outbound: [{ topic: 'order-created', trigger: 'on success' }],
          inbound: [],
        },
        persistence: [
          { database: 'mysql', tables: 'orders, order_items' },
        ],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.post?.description).toBeDefined();
    expect(pathItem.post?.description).toContain('## External Dependencies');
    expect(pathItem.post?.description).toContain('**Downstream APIs:**');
    expect(pathItem.post?.description).toContain('payment-service');
    expect(pathItem.post?.description).toContain('**Messaging:**');
    expect(pathItem.post?.description).toContain('order-created');
    expect(pathItem.post?.description).toContain('**Persistence:**');
  });

  it('uses api.name for Service column, not api.serviceName', () => {
    const result = {
      method: 'GET',
      path: '/bond-product',
      summary: 'Get bond product',
      specs: {
        request: { params: [], body: null, validation: [] },
        response: { body: null, codes: [{ code: 200, description: 'OK' }] },
      },
      externalDependencies: {
        downstreamApis: [
          {
            serviceName: 'tcbs.bond.product.url',
            name: 'bond-product',
            type: 'REST',
            service: 'tcbs.bond.product.url',
            endpoint: 'GET /bond-product',
            condition: 'TODO_AI_ENRICH',
            purpose: 'TODO_AI_ENRICH',
          },
        ],
        messaging: { outbound: [], inbound: [] },
        persistence: [],
      },
    };

    const components = {};
    const pathItem = convertToOpenAPIPathItem(result as any, components);

    expect(pathItem.get?.description).toContain('| bond-product |');
    expect(pathItem.get?.description).not.toContain('| tcbs.bond.product.url |');
    // Verify unique service count uses name
    expect(pathItem.get?.description).toContain('1 services');
  });
});

describe('nestedSchemas in components (WI-11)', () => {
  it('nested schema appears in components.schemas', () => {
    const nestedSchema: BodySchema = {
      typeName: 'OrderItem',
      source: 'indexed',
      fields: [
        { name: 'productId', type: 'Long', annotations: ['@NotNull'] },
        { name: 'quantity', type: 'Integer', annotations: [] },
      ],
    };
    const results = [
      {
        method: 'GET',
        path: '/orders',
        summary: 'List orders',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: {
            body: { typeName: 'Order', source: 'indexed', fields: [] } as BodySchema,
            codes: [{ code: 200, description: 'OK' }],
          },
        },
      },
    ];
    const nestedSchemas = new Map<string, BodySchema>([['OrderItem', nestedSchema]]);
    const doc = convertToOpenAPIDocument(results as any, {
      nestedSchemas,
    });

    expect(doc.components).toBeDefined();
    expect(doc.components?.schemas?.['OrderItem']).toBeDefined();
    expect(doc.components?.schemas?.['OrderItem'].type).toBe('object');
    expect(doc.components?.schemas?.['OrderItem'].properties?.productId).toBeDefined();
  });

  it('multiple nested schemas all appear in components', () => {
    const nested1: BodySchema = { typeName: 'Address', source: 'indexed', fields: [{ name: 'street', type: 'String', annotations: [] }] };
    const nested2: BodySchema = { typeName: 'Phone', source: 'indexed', fields: [{ name: 'number', type: 'String', annotations: [] }] };
    const results = [
      {
        method: 'GET',
        path: '/users',
        summary: 'Get users',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'OK' }] },
        },
      },
    ];
    const nestedSchemas = new Map<string, BodySchema>([['Address', nested1], ['Phone', nested2]]);
    const doc = convertToOpenAPIDocument(results as any, { nestedSchemas });

    expect(doc.components?.schemas?.['Address']).toBeDefined();
    expect(doc.components?.schemas?.['Phone']).toBeDefined();
  });

  it('empty nestedSchemas produces no extra entries', () => {
    const results = [
      {
        method: 'GET',
        path: '/health',
        summary: 'Health check',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: { body: null, codes: [{ code: 200, description: 'OK' }] },
        },
      },
    ];
    // Pass empty nestedSchemas explicitly - no nested schemas to add
    const doc = convertToOpenAPIDocument(results as any, {
      nestedSchemas: new Map(),
    });

    // No extra nested schema entries beyond what codesToResponses adds (ErrorResponse)
    // Empty Map means no additions
    expect(doc.components?.schemas?.['OrderItem']).toBeUndefined();
    expect(doc.components?.schemas?.['Address']).toBeUndefined();
  });

  it('nested schema does not overwrite existing top-level schema', () => {
    const nestedSchema: BodySchema = {
      typeName: 'User',
      source: 'indexed',
      fields: [{ name: 'extra', type: 'String', annotations: [] }],
    };
    const results = [
      {
        method: 'GET',
        path: '/users',
        summary: 'Get user',
        specs: {
          request: { params: [], body: null, validation: [] },
          response: {
            body: { typeName: 'User', source: 'indexed', fields: [{ name: 'id', type: 'Long', annotations: [] }] } as BodySchema,
            codes: [{ code: 200, description: 'OK' }],
          },
        },
      },
    ];
    const nestedSchemas = new Map<string, BodySchema>([['User', nestedSchema]]);
    const doc = convertToOpenAPIDocument(results as any, { nestedSchemas });

    // Top-level User from response body should not be overwritten by nested User
    expect(doc.components?.schemas?.['User'].properties?.id).toBeDefined();
    expect(doc.components?.schemas?.['User'].properties?.extra).toBeUndefined();
  });
});

// WI-2: x-extension embedding
describe('x-extension embedding', () => {
  // Minimal FullDeps factory — only populate fields relevant to each test
  const makeEmpty = () => ({
    downstreamApis: [] as any[],
    messaging: { outbound: [] as any[], inbound: [] as any[], nestedSchemas: new Map() },
    persistence: [] as any[],
    annotations: { transaction: [] as string[], retry: [] as any[], security: [] as string[] },
    validation: [] as any[],
  });

  it('test_no_external_deps_produces_no_x_extensions', () => {
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, makeEmpty());
    expect(operation['x-downstream-apis']).toBeUndefined();
    expect(operation['x-messaging-outbound']).toBeUndefined();
    expect(operation['x-messaging-inbound']).toBeUndefined();
    expect(operation['x-persistence']).toBeUndefined();
    expect(operation['x-retry-logic']).toBeUndefined();
    expect(operation['x-transaction']).toBeUndefined();
    expect(operation['x-security']).toBeUndefined();
    expect(operation['x-validation-rules']).toBeUndefined();
  });

  it('test_single_downstream_api_embedded_as_x_extension', () => {
    const deps = makeEmpty();
    deps.downstreamApis = [{ serviceName: 'auth', endpoint: 'POST /validate', condition: 'always', purpose: 'auth' }];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect(operation['x-downstream-apis']).toEqual(deps.downstreamApis);
    expect(operation['x-messaging-outbound']).toBeUndefined();
  });

  it('test_multiple_downstream_apis_all_embedded', () => {
    const deps = makeEmpty();
    deps.downstreamApis = [
      { serviceName: 'auth', endpoint: 'POST /validate', condition: 'always', purpose: 'auth' },
      { serviceName: 'billing', endpoint: 'GET /charges', condition: 'always', purpose: 'billing' },
    ];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect((operation['x-downstream-apis'] as any[])).toHaveLength(2);
    expect((operation['x-downstream-apis'] as any[])[0].serviceName).toBe('auth');
    expect((operation['x-downstream-apis'] as any[])[1].serviceName).toBe('billing');
  });

  it('test_messaging_outbound_embedded_as_x_extension', () => {
    const deps = makeEmpty();
    deps.messaging.outbound = [{ topic: 'user-created', trigger: 'on success' }];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect(operation['x-messaging-outbound']).toEqual(deps.messaging.outbound);
    expect(operation['x-messaging-inbound']).toBeUndefined();
  });

  it('test_messaging_inbound_embedded_as_x_extension', () => {
    const deps = makeEmpty();
    deps.messaging.inbound = [{ topic: 'config-updates' }];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect(operation['x-messaging-inbound']).toEqual(deps.messaging.inbound);
  });

  it('test_mixed_dependencies_all_x_extension_types_present', () => {
    const deps = makeEmpty();
    deps.downstreamApis = [{ serviceName: 'auth', endpoint: 'POST /validate', condition: 'always', purpose: 'auth' }];
    deps.messaging.outbound = [{ topic: 'user-created', trigger: 'on success' }];
    deps.messaging.inbound = [{ topic: 'config-updates' }];
    deps.persistence = [{ database: 'postgres', tables: 'users' }];
    deps.annotations.retry = [{ maxAttempts: 3, delayMs: 500 }];
    deps.annotations.transaction = ['REQUIRED'];
    deps.annotations.security = ['@RolesAllowed("ADMIN")'];
    deps.validation = [{ field: 'email', rule: '@Email' }];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect(operation['x-downstream-apis']).toEqual(deps.downstreamApis);
    expect(operation['x-messaging-outbound']).toEqual(deps.messaging.outbound);
    expect(operation['x-messaging-inbound']).toEqual(deps.messaging.inbound);
    expect(operation['x-persistence']).toEqual(deps.persistence);
    expect(operation['x-retry-logic']).toEqual(deps.annotations.retry);
    expect(operation['x-transaction']).toEqual(deps.annotations.transaction);
    expect(operation['x-security']).toEqual(deps.annotations.security);
    expect(operation['x-validation-rules']).toEqual(deps.validation);
  });

  it('test_persistence_with_database_schema_embedded', () => {
    const deps = makeEmpty();
    deps.persistence = [{ database: 'postgres', tables: 'users, sessions', storedProcedures: 'get_user_by_id' }];
    const operation: OpenAPIOperation = { summary: 'Test', responses: {} };
    embedXExtensions(operation, deps);
    expect(operation['x-persistence']).toEqual(deps.persistence);
    expect((operation['x-persistence'] as any[])[0].database).toBe('postgres');
    expect((operation['x-persistence'] as any[])[0].tables).toBe('users, sessions');
  });
});