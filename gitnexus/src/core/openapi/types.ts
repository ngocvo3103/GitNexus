/**
 * OpenAPI 3.1.0 TypeScript interfaces
 * Based on https://spec.openapis.org/oas/v3.1.0.html
 */

/** OpenAPI Document root object */
export interface OpenAPIDocument {
  openapi: '3.1.0';
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPathItem>;
  components?: OpenAPIComponents;
  security?: OpenAPISecurityRequirement[];
  tags?: OpenAPITag[];
  externalDocs?: OpenAPIExternalDocs;
}

/** API metadata */
export interface OpenAPIInfo {
  title: string;
  summary?: string;
  description?: string;
  termsOfService?: string;
  contact?: OpenAPIContact;
  license?: OpenAPILicense;
  version: string;
}

/** Contact information */
export interface OpenAPIContact {
  name?: string;
  url?: string;
  email?: string;
}

/** License information */
export interface OpenAPILicense {
  name: string;
  identifier?: string;
  url?: string;
}

/** Server configuration */
export interface OpenAPIServer {
  url: string;
  description?: string;
  variables?: Record<string, OpenAPIServerVariable>;
}

/** Server variable */
export interface OpenAPIServerVariable {
  enum?: string[];
  default: string;
  description?: string;
}

/** Path Item Object - describes operations on a single path */
export interface OpenAPIPathItem {
  summary?: string;
  description?: string;
  get?: OpenAPIOperation;
  put?: OpenAPIOperation;
  post?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  options?: OpenAPIOperation;
  head?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  trace?: OpenAPIOperation;
  servers?: OpenAPIServer[];
  parameters?: OpenAPIParameter[];
}

/** Operation Object - describes a single API operation */
export interface OpenAPIOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
  operationId?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
  callbacks?: Record<string, OpenAPICallback>;
  deprecated?: boolean;
  security?: OpenAPISecurityRequirement[];
  servers?: OpenAPIServer[];
}

/** Parameter Object */
export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenAPISchema;
  example?: unknown;
  examples?: Record<string, OpenAPIExample>;
  content?: Record<string, OpenAPIMediaType>;
}

/** Request Body Object */
export interface OpenAPIRequestBody {
  description?: string;
  content: Record<string, OpenAPIMediaType>;
  required?: boolean;
}

/** Response Object */
export interface OpenAPIResponse {
  description: string;
  headers?: Record<string, OpenAPIHeader>;
  content?: Record<string, OpenAPIMediaType>;
  links?: Record<string, OpenAPILink>;
}

/** Media Type Object */
export interface OpenAPIMediaType {
  schema?: OpenAPISchema;
  example?: unknown;
  examples?: Record<string, OpenAPIExample>;
  encoding?: Record<string, OpenAPIEncoding>;
}

/** Schema Object - JSON Schema subset */
export interface OpenAPISchema {
  // Core schema properties
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  
  // Number constraints
  multipleOf?: number;
  maximum?: number;
  exclusiveMaximum?: number | boolean;
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  
  // String constraints
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
  
  // Array constraints
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  items?: OpenAPISchema;
  
  // Object constraints
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, OpenAPISchema>;
  additionalProperties?: boolean | OpenAPISchema;
  patternProperties?: Record<string, OpenAPISchema>;
  
  // Composition
  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  not?: OpenAPISchema;
  
  // Reference
  $ref?: string;
  
  // Nullable (3.0 compat)
  nullable?: boolean;
  
  // Discriminator
  discriminator?: OpenAPIDiscriminator;
  
  // XML
  xml?: OpenAPIXML;
  
  // External docs
  externalDocs?: OpenAPIExternalDocs;
  
  // Deprecated
  deprecated?: boolean;
}

/** Components Object - reusable schemas */
export interface OpenAPIComponents {
  schemas?: Record<string, OpenAPISchema>;
  responses?: Record<string, OpenAPIResponse>;
  parameters?: Record<string, OpenAPIParameter>;
  examples?: Record<string, OpenAPIExample>;
  requestBodies?: Record<string, OpenAPIRequestBody>;
  headers?: Record<string, OpenAPIHeader>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
  links?: Record<string, OpenAPILink>;
  callbacks?: Record<string, OpenAPICallback>;
  pathItems?: Record<string, OpenAPIPathItem>;
}

/** Security Scheme Object */
export interface OpenAPISecurityScheme {
  type: 'apiKey' | 'http' | 'mutualTLS' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlows;
  openIdConnectUrl?: string;
}

/** OAuth Flows */
export interface OAuthFlows {
  implicit?: OAuthFlow;
  password?: OAuthFlow;
  clientCredentials?: OAuthFlow;
  authorizationCode?: OAuthFlow;
}

/** OAuth Flow */
export interface OAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

/** Security Requirement Object */
export type OpenAPISecurityRequirement = Record<string, string[]>;

/** Example Object */
export interface OpenAPIExample {
  summary?: string;
  description?: string;
  value?: unknown;
  externalValue?: string;
}

/** Header Object */
export type OpenAPIHeader = OpenAPIParameter;

/** Link Object */
export interface OpenAPILink {
  operationRef?: string;
  operationId?: string;
  parameters?: Record<string, unknown>;
  requestBody?: unknown;
  description?: string;
  server?: OpenAPIServer;
}

/** Callback Object */
export type OpenAPICallback = Record<string, OpenAPIPathItem>;

/** Tag Object */
export interface OpenAPITag {
  name: string;
  description?: string;
  externalDocs?: OpenAPIExternalDocs;
}

/** External Documentation Object */
export interface OpenAPIExternalDocs {
  url: string;
  description?: string;
}

/** Discriminator Object */
export interface OpenAPIDiscriminator {
  propertyName: string;
  mapping?: Record<string, string>;
}

/** XML Object */
export interface OpenAPIXML {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
}

/** Encoding Object */
export interface OpenAPIEncoding {
  contentType?: string;
  headers?: Record<string, OpenAPIHeader>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

/** Helper type for creating minimal valid OpenAPI documents */
export function createOpenAPIDocument(
  title: string,
  version: string,
  paths: Record<string, OpenAPIPathItem> = {}
): OpenAPIDocument {
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
    },
    paths,
  };
}