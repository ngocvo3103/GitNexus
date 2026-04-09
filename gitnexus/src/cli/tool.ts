/**
 * Direct CLI Tool Commands
 * 
 * Exposes GitNexus tools (query, context, impact, cypher) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 * 
 * Usage:
 *   gitnexus query "authentication flow"
 *   gitnexus context --name "validateUser"
 *   gitnexus impact --target "AuthService" --direction upstream
 *   gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 * 
 * Note: Output goes to stdout via fs.writeSync(fd 1), bypassing LadybugDB's
 * native module which captures the Node.js process.stdout stream during init.
 * See the output() function for details (#324).
 */

import { writeSync } from 'node:fs';
import { resolve } from 'path';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { ensureHeap } from './heap-utils.js';

/**
 * Validates that the user-provided output path is safe to use.
 * Prevents path traversal attacks by ensuring the resolved path
 * stays within allowed directories (cwd, home, /tmp, /var/tmp).
 */
function validateOutputPath(userPath: string): string {
  const resolved = resolve(userPath);

  // Check for path traversal sequences
  if (userPath.includes('..')) {
    console.error('Error: --outputPath cannot contain ".." sequences');
    process.exit(1);
  }

  // Resolve to absolute and verify it's within safe boundaries
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  const safeRoots = [cwd, home, '/tmp', '/var/tmp'].filter(Boolean);

  const isSafe = safeRoots.some(root => resolved.startsWith(resolve(root)));

  if (!isSafe) {
    console.error(`Error: --outputPath must be within current directory, home, or /tmp`);
    process.exit(1);
  }

  return resolved;
}

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('GitNexus: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }
  return _backend;
}

/**
 * Write tool output to stdout using low-level fd write.
 *
 * LadybugDB's native module captures Node.js process.stdout during init,
 * but the underlying OS file descriptor 1 (stdout) remains intact.
 * By using fs.writeSync(1, ...) we bypass the Node.js stream layer
 * and write directly to the real stdout fd (#324).
 *
 * Falls back to stderr if the fd write fails (e.g., broken pipe).
 */

/**
 * JSON replacer that converts Map instances to plain objects.
 * JavaScript's JSON.stringify serializes Map as {} — this replacer
 * preserves nestedSchemas entries (and any other Map-valued fields)
 * in CLI JSON output without modifying in-memory data structures.
 */
const mapReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Map ? Object.fromEntries(value) : value;

function output(data: any): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, mapReplacer, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') {
      // Consumer closed the pipe (e.g., `gitnexus cypher ... | head -1`)
      // Exit cleanly per Unix convention
      process.exit(0);
    }
    // Fallback: stderr (previous behavior, works on all platforms)
    process.stderr.write(text + '\n');
  }
}

export async function queryCommand(queryText: string, options?: {
  repo?: string;
  context?: string;
  goal?: string;
  limit?: string;
  content?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus query <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('query', {
    query: queryText,
    task_context: options?.context,
    goal: options?.goal,
    limit: options?.limit ? parseInt(options.limit) : undefined,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function contextCommand(name: string, options?: {
  repo?: string;
  file?: string;
  uid?: string;
  content?: boolean;
}): Promise<void> {
  if (!name?.trim() && !options?.uid) {
    console.error('Usage: gitnexus context <symbol_name> [--uid <uid>] [--file <path>]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('context', {
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function impactCommand(target: string, options?: {
  direction?: string;
  repo?: string;
  depth?: string;
  includeTests?: boolean;
}): Promise<void> {
  if (ensureHeap()) return;

  if (!target?.trim()) {
    console.error('Usage: gitnexus impact <symbol_name> [--direction upstream|downstream]');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('impact', {
      target,
      direction: options?.direction || 'upstream',
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // Belt-and-suspenders: catch infrastructure failures (getBackend, callTool transport)
    // The backend's impact() already returns structured errors for graph query failures
    output({
      error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed unexpectedly',
      target: { name: target },
      direction: options?.direction || 'upstream',
      suggestion: 'Try reducing --depth or using gitnexus context <symbol> as a fallback',
    });
    process.exit(1);
  }
}

export async function cypherCommand(query: string, options?: {
  repo?: string;
}): Promise<void> {
  if (!query?.trim()) {
    console.error('Usage: gitnexus cypher <cypher_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    query,
    repo: options?.repo,
  });
  output(result);
}

export async function documentEndpointCommand(options?: {
  method?: string;
  path?: string;
  depth?: string;
  includeContext?: boolean;
  compact?: boolean;
  openapi?: boolean;
  outputPath?: string;
  repo?: string;
  schemaPath?: string;
  strict?: boolean;
}): Promise<void> {
  if (ensureHeap()) return;

  if (!options?.method || !options?.path) {
    console.error('Usage: gitnexus document-endpoint --method <METHOD> --path <path-pattern>');
    console.error('  --method <METHOD>     HTTP method (GET, POST, PUT, DELETE, PATCH)');
    console.error('  --path <pattern>      Path pattern to match (e.g., "suggest", "/bookings/{id}")');
    console.error('  --depth <n>           Max trace depth (default: 10)');
    console.error('  --include-context     Include source context for AI enrichment');
    console.error('  --compact             Omit source content and empty arrays (use with --include-context)');
    console.error('  --openapi             Write both JSON and OpenAPI 3.1.0 YAML spec to --outputPath');
    console.error('  --outputPath <path>   Output directory for JSON and OpenAPI YAML files (required with --openapi)');
    console.error('  --schema-path <path>  Path to custom JSON schema file (default: bundled schema)');
    console.error('  --strict              Fail on schema validation errors (default: warn)');
    console.error('  --repo <name>         Target repository');
    process.exit(1);
  }

  const backend = await getBackend();
  const response = await backend.callTool('document-endpoint', {
    method: options.method,
    path: options.path,
    depth: options.depth ? parseInt(options.depth, 10) : undefined,
    include_context: options.includeContext ?? false,
    compact: options.compact ?? false,
    openapi: options.openapi ?? false,
    repo: options.repo,
  });

  // Extract the inner result from MCP response format: { result: DocumentEndpointResult }
  const result = response?.result ?? response;

  // Validate against schema if --schema-path or --strict is provided
  if (options.schemaPath || options.strict) {
    const { validateAgainstSchema, formatValidationErrors } = await import('../utils/schema-validator.js');
    const validation = validateAgainstSchema(result, undefined, options.schemaPath);

    if (!validation.valid) {
      const errorMsg = `Schema validation failed:\n${formatValidationErrors(validation)}`;

      if (options.strict) {
        console.error(errorMsg);
        process.exit(1);
      } else {
        console.error(`Warning: ${errorMsg}`);
      }
    }
  }

  // Handle --openapi mode: write both JSON and OpenAPI YAML files
  if (options.openapi) {
    if (!options.outputPath) {
      console.error('Error: --outputPath is required when using --openapi');
      process.exit(1);
    }

    const { convertToOpenAPIDocument } = await import('../core/openapi/converter.js');
    const yaml = await import('js-yaml');
    const fs = await import('fs');
    const pathMod = await import('path');

    const safeOutputPath = validateOutputPath(options.outputPath);

    // Ensure output directory exists
    fs.mkdirSync(safeOutputPath, { recursive: true });

    // Auto-generate base filename from method + path
    // e.g., PUT /e/v1/bookings/{productCode}/suggest → PUT_e_v1_bookings_productCode_suggest
    const sanitizedPath = result.path
      .replace(/^\//, '')
      .replace(/[{}]/g, '')
      .replace(/[/\-:.]/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '');
    const baseName = `${result.method.toUpperCase()}_${sanitizedPath}`;

    // Write default JSON
    const jsonPath = pathMod.join(safeOutputPath, `${baseName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, mapReplacer, 2), 'utf-8');

    // Write OpenAPI YAML
    const openApiDoc = convertToOpenAPIDocument([result], {
      title: `API - ${result.path}`,
      version: '1.0.0',
      nestedSchemas: result.nestedSchemas,
    });
    const yamlPath = pathMod.join(safeOutputPath, `${baseName}.openapi.yaml`);
    fs.writeFileSync(yamlPath, yaml.dump(openApiDoc, { lineWidth: -1, noRefs: true }), 'utf-8');

    console.error(`Written: ${jsonPath}`);
    console.error(`Written: ${yamlPath}`);
  } else {
    // Default: JSON to stdout (unchanged)
    output(result);
  }
}
