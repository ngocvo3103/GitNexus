/**
 * Schema Validator Utility
 *
 * Validates document-endpoint output against api-context-schema.json
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const _require = createRequire(import.meta.url);
const Ajv = _require('ajv');

// Cache compiled validator and schema for performance
let cachedValidator: ReturnType<typeof Ajv> | null = null;
let cachedSchema: object | null = null;

/**
 * Result of schema validation
 */
export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Get the path to the default bundled schema
 */
export function getDefaultSchemaPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Schema is at gitnexus/schemas/api-context-schema.json
  // From src/utils/, go up two directories
  return join(currentDir, '..', '..', 'schemas', 'api-context-schema.json');
}

/**
 * Load schema from file (cached)
 * @param schemaPath - Optional custom schema path. If not provided, uses bundled schema.
 */
export function loadSchema(schemaPath?: string): object {
  // Return cached schema if available and no custom path
  if (cachedSchema && !schemaPath) {
    return cachedSchema;
  }

  const path = schemaPath || getDefaultSchemaPath();

  if (!existsSync(path)) {
    throw new Error(`Schema file not found: ${path}`);
  }

  const schemaContent = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(schemaContent);

  cachedSchema = parsed;
  return cachedSchema!;
}

/**
 * Get or create AJV validator (cached)
 */
export function getValidator() {
  if (cachedValidator) {
    return cachedValidator;
  }
  // allErrors: true to collect all validation errors
  // strict: false to allow schema extensions
  cachedValidator = new Ajv({ allErrors: true, strict: false });
  return cachedValidator;
}

/**
 * Validate data against JSON schema
 * @param data - The data to validate
 * @param schema - Optional schema object. If not provided, loads bundled schema.
 * @param schemaPath - Optional path to custom schema file.
 */
export function validateAgainstSchema(
  data: unknown,
  schema?: object,
  schemaPath?: string
): ValidationResult {
  const validator = getValidator();
  const schemaToUse = schema || loadSchema(schemaPath);

  try {
    const validate = validator.compile(schemaToUse as any);
    const valid = validate(data);

    if (valid) {
      return { valid: true };
    }

    const errors = (validate.errors || []).map((err: any) => ({
      path: err.instancePath || 'root',
      message: err.message || 'Unknown error',
    }));

    return { valid: false, errors };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: 'schema', message: error instanceof Error ? error.message : 'Schema compilation failed' }],
    };
  }
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.valid || !result.errors) {
    return '';
  }

  return result.errors
    .map((e) => `  - ${e.path}: ${e.message}`)
    .join('\n');
}

/**
 * Clear cached validator and schema (useful for testing)
 */
export function clearCache(): void {
  cachedValidator = null;
  cachedSchema = null;
}