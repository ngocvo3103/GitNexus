/**
 * enricher.ts — Selective OpenAPI YAML enrichment
 *
 * Parses a service-wide OpenAPI YAML, resolves selected operations against the graph,
 * traces call chains, extracts external dependencies, and embeds them as x-extensions.
 */
import yaml from 'js-yaml';
import { extractAllDependencies, type ExternalDeps } from '../../mcp/local/document-endpoint.js';
import { embedXExtensions } from './converter.js';
import type { RepoHandle } from '../../mcp/local/local-backend.js';
import { queryEndpoints } from '../../mcp/local/endpoint-query.js';
import { findHandlerByPathPattern } from '../../mcp/local/document-endpoint.js';
import { executeTrace } from '../../mcp/local/trace-executor.js';
import { executeParameterized } from '../../mcp/core/lbug-adapter.js';
import { generateId } from '../../lib/utils.js';

export interface EnrichOptions {
  /** HTTP method to filter on (e.g. 'GET', 'POST'). Omit to enrich all paths. */
  method?: string;
  /** OpenAPI path pattern to filter on (e.g. '/e/v1/bonds'). Omit to enrich all paths. */
  path?: string;
  /** Output file path. Computed from input if not given. */
  outputPath?: string;
  /**
   * Optional injected query executor.
   * Defaults to executeParameterized against repo.id.
   */
  executeQuery?: (repoId: string, query: string, params: Record<string, unknown>) => Promise<any[]>;
  /** Max trace depth passed to executeTrace (default: 10). */
  maxDepth?: number;
}

/** Internal per-operation working state */
interface OperationTarget {
  method: string;
  path: string;
  operation: Record<string, unknown>;
  pathKey: string;
}

/**
 * Checks whether `method` + `pathPattern` match a given OpenAPI path item and its operations.
 * Returns the matching operation object(s) keyed by the path string.
 */
function collectMatchingOperations(
  doc: Record<string, unknown>,
  methodFilter: string | undefined,
  pathFilter: string | undefined
): OperationTarget[] {
  const paths = doc['paths'] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const targets: OperationTarget[] = [];
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathKey.startsWith('/')) continue;
    // Path filter — substring match (case-sensitive, consistent with queryEndpoints CONTAINS)
    if (pathFilter && !pathKey.includes(pathFilter)) continue;

    const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
    for (const m of methods) {
      const op = pathItem[m] as Record<string, unknown> | undefined;
      if (!op) continue;
      // Method filter
      if (methodFilter && m.toUpperCase() !== methodFilter.toUpperCase()) continue;
      targets.push({ method: m.toUpperCase(), path: pathKey, operation: op, pathKey });
    }
  }
  return targets;
}

/**
 * Resolves an OpenAPI operation's path+method to a Route node or handler search result.
 * Returns the resolved route, or undefined if not found.
 */
async function resolveRoute(
  repo: RepoHandle,
  method: string,
  path: string,
  executeQuery: (repoId: string, query: string, params: Record<string, unknown>) => Promise<unknown[]>
): Promise<{ handler: string; filePath: string; line: number } | undefined> {
  try {
    const result = await queryEndpoints(repo, { method, path });
    if (result.endpoints.length > 0) {
      const e = result.endpoints[0];
      return { handler: e.handler ?? '', filePath: e.filePath ?? '', line: e.line ?? 0 };
    }
  } catch {
    // fall through to fallback
  }
  // Fallback: handler search by path pattern
  return findHandlerByPathPattern(repo, method, path) as Promise<{ handler: string; filePath: string; line: number } | undefined>;
}

/**
 * Verifies that a handler UID exists in the graph (returns true) or not (returns false).
 * On query error, returns false to skip the operation gracefully.
 */
async function verifyHandlerUid(
  repo: RepoHandle,
  handlerUid: string
): Promise<boolean> {
  try {
    const result = await executeParameterized(repo.id,
      `MATCH (m:Method) WHERE m.id = $uid RETURN m.id LIMIT 1`,
      { uid: handlerUid }
    );
    return (result?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Enriches an existing OpenAPI YAML document by resolving selected operations
 * against the graph database, extracting their call chains, and embedding
 * external dependency information as x-extension fields.
 *
 * @param yamlContent  Raw YAML string (single document)
 * @param repo         RepoHandle for the target repository
 * @param options      EnrichOptions (method/path filters, outputPath, executeQuery)
 * @returns Enriched YAML string; original content returned unchanged on parse failure
 */
export async function enrichExistingYaml(
  yamlContent: string,
  repo: RepoHandle,
  options: EnrichOptions = {}
): Promise<string> {
  const { method: methodFilter, path: pathFilter, executeQuery: injectedQuery } = options;
  const maxDepth = options.maxDepth ?? 10;

  const executeQuery: (repoId: string, query: string, params: Record<string, unknown>) => Promise<unknown[]> =
    injectedQuery ??
    ((repoId, q, p) => executeParameterized(repoId, q, p) as Promise<unknown[]>);

  // ── 1. Parse ──────────────────────────────────────────────────────────────────
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
    if (doc === null || typeof doc !== 'object') {
      // Not a valid YAML object — return as-is
      return yamlContent;
    }
  } catch (err) {
    throw new Error(`Failed to parse YAML: ${(err as Error).message}`);
  }

  const paths = doc['paths'] as Record<string, Record<string, unknown>> | undefined;
  if (!paths || Object.keys(paths).length === 0) {
    // No paths — nothing to enrich
    return yamlContent;
  }

  // ── 2. Collect operations to enrich ─────────────────────────────────────────
  const targets = collectMatchingOperations(doc, methodFilter, pathFilter);
  if (targets.length === 0) {
    // No matching operations — return unchanged
    return yamlContent;
  }

  // ── 3. Enrich all target operations in parallel ─────────────────────────────────
  await Promise.all(
    targets.map(async ({ method, path, operation }) => {
      // (a) Resolve route in graph
      const route = await resolveRoute(repo, method, path, executeQuery);
      if (!route) return; // Not found — skip gracefully

      // (b) Build handler UID
      const handlerUid = route.handler && route.filePath
        ? generateId('Method', `${route.filePath}:${route.handler}`)
        : undefined;
      if (!handlerUid) return;

      // (c) Verify handler UID exists in graph
      const isValid = await verifyHandlerUid(repo, handlerUid);
      if (!isValid) return;

      // (d) Trace call chain
      const traceResult = await executeTrace(executeQuery, repo.id, {
        uid: handlerUid,
        include_content: true,
        compact: true,
        maxDepth,
      });

      if (traceResult.error) return;

      // (e) Extract dependencies from chain
      const deps: ExternalDeps = await extractAllDependencies(traceResult.chain, path, method, executeQuery, repo.id);

      // (f) Embed x-extensions onto the operation object (mutates doc)
      embedXExtensions(operation as unknown as Parameters<typeof embedXExtensions>[0], deps);
    })
  );

  // ── 4. Serialize ─────────────────────────────────────────────────────────────
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}