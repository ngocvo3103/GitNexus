/**
 * OpenAPI Converter - Convert DocumentEndpointResult to OpenAPI Document
 */

import type {
  OpenAPIDocument,
  OpenAPIPathItem,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPIResponse,
  OpenAPISchema,
  OpenAPIComponents,
} from './types.js';
import { createOpenAPIDocument } from './types.js';
import {
  bodySchemaToOpenAPISchema,
  generateSchemaName,
  shouldExtractToComponents,
  createSchemaRef,
  mapType,
  type BodySchema,
} from './schema-builder.js';
import {
  bodySchemaToJsonExample,
  type DocumentEndpointResult,
  type ParamInfo,
  type ResponseCode,
} from '../../mcp/local/document-endpoint.js';

/** Map HTTP methods to OpenAPI operation keys */
const METHOD_MAP: Record<string, keyof OpenAPIPathItem> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
  PATCH: 'patch',
  OPTIONS: 'options',
  HEAD: 'head',
  TRACE: 'trace',
};

/**
 * Normalize path to OpenAPI format
 * Converts :param to {param}
 */
function normalizePath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

/**
 * Convert ParamInfo to OpenAPI Parameter
 */
function paramToOpenAPIParameter(param: ParamInfo): OpenAPIParameter {
  const location = param.location ?? 'query';
  
  const cleanName = param.name.replace(/[{}@]/g, '').trim();
  
  return {
    name: cleanName,
    in: location,
    description: param.description || `${cleanName} parameter`,
    required: param.required,
    schema: {
      type: mapType(param.type),
    },
  };
}

/**
 * Convert body to OpenAPI RequestBody
 */
function bodyToRequestBody(
  body: BodySchema | Record<string, unknown> | Record<string, unknown>[] | null,
  components: OpenAPIComponents,
  extractSchemas: boolean
): OpenAPIRequestBody | undefined {
  if (!body) return undefined;
  
  let schema: OpenAPISchema;
  
  if (isBodySchema(body)) {
    if (extractSchemas && shouldExtractToComponents(body)) {
      const schemaName = generateSchemaName(body.typeName);

      // Add to components
      if (!components.schemas) {
        components.schemas = {};
      }
      components.schemas[schemaName] = bodySchemaToOpenAPISchema(body);

      schema = createSchemaRef(schemaName);
    } else {
      schema = bodySchemaToOpenAPISchema(body);
    }
  } else {
    // Raw JSON object/array - use as example schema
    schema = {
      type: Array.isArray(body) ? 'array' : 'object',
      example: body,
    };
  }

  let requestBody: OpenAPIRequestBody = {
    description: 'Request body',
    required: true,  // @RequestBody is required by default in Spring
    content: {
      'application/json': {
        schema,
      },
    },
  };

  // Attach example for BodySchema
  if (isBodySchema(body) && body.fields && body.fields.length > 0) {
    const example = bodySchemaToJsonExample(body);
    if (example) {
      requestBody.content['application/json'].example = example;
    }
  }

  return requestBody;
}

/**
 * Type guard for BodySchema
 */
function isBodySchema(body: unknown): body is BodySchema {
  return (
    typeof body === 'object' &&
    body !== null &&
    'typeName' in body &&
    'source' in body
  );
}

/**
 * Convert response codes to OpenAPI responses
 */
export function codesToResponses(
  codes: ResponseCode[],
  body: BodySchema | Record<string, unknown> | Record<string, unknown>[] | null,
  components: OpenAPIComponents,
  extractSchemas: boolean
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {};

  // Define standard error response schema (for components registration)
  const errorSchema: OpenAPISchema = {
    type: 'object',
    properties: {
      code: { type: 'integer' },
      message: { type: 'string' }
    }
  };

  // Add ErrorResponse to components once
  if (!components.schemas) {
    components.schemas = {};
  }
  components.schemas['ErrorResponse'] = errorSchema;

  for (const code of codes) {
    const statusCode = String(code.code);
    const isErrorStatus = statusCode.startsWith('4') || statusCode.startsWith('5');

    let schema: OpenAPISchema | undefined;

    if (isErrorStatus) {
      // Use $ref to ErrorResponse for error responses
      schema = createSchemaRef('ErrorResponse');
    } else if (body) {
      // Use actual body schema for success responses
      if (isBodySchema(body)) {
        if (extractSchemas && shouldExtractToComponents(body)) {
          const schemaName = generateSchemaName(body.typeName);

          if (!components.schemas) {
            components.schemas = {};
          }
          components.schemas[schemaName] = bodySchemaToOpenAPISchema(body);

          schema = createSchemaRef(schemaName);
        } else {
          schema = bodySchemaToOpenAPISchema(body);
        }
      } else {
        schema = {
          type: Array.isArray(body) ? 'array' : 'object',
          example: body,
        };
      }
    }

    // Build response with example for success responses
    const response: OpenAPIResponse = {
      description: code.description || `Status ${statusCode}`,
    };

    if (schema) {
      response.content = {
        'application/json': {
          schema,
        },
      };
      // Attach example for BodySchema success responses
      if (!isErrorStatus && isBodySchema(body) && body.fields && body.fields.length > 0) {
        const example = bodySchemaToJsonExample(body);
        if (example) {
          response.content['application/json'].example = example;
        }
      }
    }

        // Merge descriptions when multiple codes share the same HTTP status
    if (responses[statusCode]) {
      const existing = responses[statusCode];
      const incoming = code.description || `Status ${statusCode}`;
      existing.description = existing.description
        ? `${existing.description} | ${incoming}`
        : incoming;
    } else {
      responses[statusCode] = response;
    }
  }
  
  // Ensure at least a default response exists
  if (Object.keys(responses).length === 0) {
    responses.default = {
      description: 'Default response',
    };
  }
  
  return responses;
}

/**
 * Convert single DocumentEndpointResult to OpenAPI Path Item
 */
export function convertToOpenAPIPathItem(
  result: DocumentEndpointResult,
  components: OpenAPIComponents,
  options: ConvertOptions = {}
): OpenAPIPathItem {
  const opts = { extractSchemas: true, ...options };
  
  const method = result.method.toUpperCase();
  const operationKey = METHOD_MAP[method];
  
  if (!operationKey) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }
  
  // Build operation
  const operation: OpenAPIOperation = {
    summary: result.summary || `${method} ${result.path}`,
    responses: codesToResponses(
      result.specs.response.codes,
      result.specs.response.body,
      components,
      opts.extractSchemas
    ),
  };
  
  // Add operationId (clean version of method + path)
  operation.operationId = generateOperationId(method, result.path);
  
  // Add parameters
  if (result.specs.request.params.length > 0) {
    operation.parameters = result.specs.request.params.map(paramToOpenAPIParameter);
  }
  
  // Add request body
  const requestBody = bodyToRequestBody(
    result.specs.request.body,
    components,
    opts.extractSchemas
  );
  if (requestBody) {
    operation.requestBody = requestBody;
  }
  
  // Build Markdown description for human-readable summary in Swagger UI
  if (result.externalDependencies) {
    const description = buildDependencyDescription(result.externalDependencies);
    if (description) {
      operation.description = description;
    }
  }
  
  // Build path item with single operation
  const pathItem: OpenAPIPathItem = {
    [operationKey]: operation,
  };
  
  return pathItem;
}

/**
 * Generate operationId from method and path
 */
function generateOperationId(method: string, path: string): string {
  const normalizedPath = path
    .replace(/[{}]/g, '')    // Remove curly braces
    .replace(/[/:-]/g, '_')  // Replace / and : with _
    .replace(/_+/g, '_')      // Collapse multiple underscores
    .replace(/^_|_$/g, '');  // Remove leading/trailing underscores
  
  // Ensure underscore between method and path
  const pathPart = normalizedPath.startsWith('_') ? normalizedPath.slice(1) : normalizedPath;
  
  return `${method.toLowerCase()}_${pathPart}`;
}

/**
 * Build Markdown-formatted description of external dependencies
 */
function buildDependencyDescription(
  deps: DocumentEndpointResult['externalDependencies']
): string | undefined {
  const hasDownstream = deps.downstreamApis.length > 0;
  const hasMessaging = deps.messaging.outbound.length > 0 || deps.messaging.inbound.length > 0;
  const hasPersistence = deps.persistence.length > 0;
  
  if (!hasDownstream && !hasMessaging && !hasPersistence) {
    return undefined;
  }
  
  const lines: string[] = ['## External Dependencies', ''];
  
  if (hasDownstream) {
    // Count unique services
    const uniqueServices = new Set(deps.downstreamApis.map(api => api.serviceName));
    lines.push(`**Downstream APIs:** ${deps.downstreamApis.length} calls to ${uniqueServices.size} services`);
    lines.push('');
    lines.push('| Service | Method | Endpoint |');
    lines.push('|---------|--------|----------|');
    for (const api of deps.downstreamApis) {
      // Parse method and path from endpoint (e.g., "POST /v1/bond-limit/hold-unhold")
      const match = api.endpoint.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/);
      const method = match ? match[1] : '-';
      const path = match ? match[2] : api.endpoint;
      lines.push(`| ${api.serviceName} | ${method} | ${path} |`);
    }
    lines.push('');
  }
  
  if (hasMessaging) {
    lines.push(`**Messaging:** ${deps.messaging.outbound.length} outbound, ${deps.messaging.inbound.length} inbound`);
    lines.push('');
    lines.push('| Topic | Direction |');
    lines.push('|-------|-----------|');
    for (const m of deps.messaging.outbound) {
      lines.push(`| ${m.topic} | outbound |`);
    }
    for (const m of deps.messaging.inbound) {
      lines.push(`| ${m.topic} | inbound |`);
    }
    lines.push('');
  }
  
  if (hasPersistence) {
    for (const p of deps.persistence) {
      const tables = p.tables ? p.tables.split(',').map(t => t.trim()) : [];
      lines.push(`**Persistence:** ${tables.length} tables`);
      lines.push('');
      lines.push('| Database | Tables |');
      lines.push('|----------|--------|');
      lines.push(`| ${p.database} | ${tables.join(', ')} |`);
    }
  }
  
  return lines.join('\n');
}

/** Options for conversion */
export interface ConvertOptions {
  extractSchemas?: boolean;
  nestedSchemas?: Map<string, BodySchema>;
}

/**
 * Convert multiple endpoints to full OpenAPI Document
 */
export function convertToOpenAPIDocument(
  results: DocumentEndpointResult[],
  options: DocumentOptions = {}
): OpenAPIDocument {
  const opts = {
    title: 'API',
    version: '1.0.0',
    extractSchemas: true,
    ...options,
  };
  
  const components: OpenAPIComponents = {};
  const paths: Record<string, OpenAPIPathItem> = {};
  
  for (const result of results) {
    const normalizedPath = normalizePath(result.path);
    
    // Get or create path item
    if (!paths[normalizedPath]) {
      paths[normalizedPath] = {};
    }
    
    // Convert endpoint
    const pathItem = convertToOpenAPIPathItem(result, components, {
      extractSchemas: opts.extractSchemas,
    });
    
    // Merge operation into path item
    const method = result.method.toUpperCase();
    const operationKey = METHOD_MAP[method];
    if (operationKey) {
      const op = pathItem[operationKey];
      if (op) {
        // Cast to avoid TypeScript error with index access
        const pathObj = paths[normalizedPath] as Record<string, OpenAPIOperation>;
        pathObj[operationKey] = op as OpenAPIOperation;
      }
    }
  }
  
  // Build document
  const document = createOpenAPIDocument(opts.title, opts.version, paths);
  
  // Add components if any schemas were extracted
  if (components.schemas && Object.keys(components.schemas).length > 0) {
    document.components = components;
  }

  // Add nested schemas to components (don't overwrite existing top-level schemas)
  if (opts.nestedSchemas && components.schemas) {
    for (const [name, schema] of opts.nestedSchemas) {
      if (!components.schemas[name]) {
        components.schemas[name] = bodySchemaToOpenAPISchema(schema);
      }
    }
    // Re-attach if schemas were updated after document creation
    if (Object.keys(components.schemas).length > 0) {
      document.components = components;
    }
  }

  return document;
}

/** Options for document generation */
export interface DocumentOptions {
  title?: string;
  version?: string;
  extractSchemas?: boolean;
  nestedSchemas?: Map<string, BodySchema>;
}