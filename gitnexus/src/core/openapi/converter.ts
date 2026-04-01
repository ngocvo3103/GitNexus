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
  type ValidationRule,
} from './schema-builder.js';

/** Source types from document-endpoint.ts */
export interface DocumentEndpointResult {
  method: string;
  path: string;
  summary: string;
  specs: {
    request: {
      params: ParamInfo[];
      body: BodySchema | Record<string, unknown> | Record<string, unknown>[] | null;
      validation: ValidationRule[];
    };
    response: {
      body: BodySchema | Record<string, unknown> | Record<string, unknown>[] | null;
      codes: ResponseCode[];
    };
  };
}

export interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
  _context?: string;
}

export interface ResponseCode {
  code: number;
  description: string;
}

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
  // Determine parameter location
  let location: 'query' | 'header' | 'path' | 'cookie' = 'query';
  
  // Path parameters are in the path
  if (param.name.startsWith('{') || param.name.includes('{')) {
    location = 'path';
  } else if (param.name.startsWith('@') || param.name.toLowerCase().includes('header')) {
    location = 'header';
  } else if (pathParamRegex.test(param.name)) {
    location = 'path';
  }
  
  // Clean up parameter name
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

/** Regex to detect path parameters */
const pathParamRegex = /^{|.*\{.*\}.*$/;

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
  
  return {
    description: 'Request body',
    content: {
      'application/json': {
        schema,
      },
    },
  };
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
function codesToResponses(
  codes: ResponseCode[],
  body: BodySchema | Record<string, unknown> | Record<string, unknown>[] | null,
  components: OpenAPIComponents,
  extractSchemas: boolean
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {};
  
  for (const code of codes) {
    const statusCode = String(code.code);
    
    let schema: OpenAPISchema | undefined;
    
    if (body) {
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
    
    responses[statusCode] = {
      description: code.description || `Status ${statusCode}`,
      ...(schema && {
        content: {
          'application/json': {
            schema,
          },
        },
      }),
    };
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

/** Options for conversion */
export interface ConvertOptions {
  extractSchemas?: boolean;
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
  
  return document;
}

/** Options for document generation */
export interface DocumentOptions {
  title?: string;
  version?: string;
  extractSchemas?: boolean;
}