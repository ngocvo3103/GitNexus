/**
 * Endpoint Query - Query Route nodes from the knowledge graph
 *
 * Exposes HTTP endpoints detected during ingestion (Spring routes, Laravel routes, etc.)
 * as queryable resources for MCP tools and CLI.
 */

import type { RepoHandle } from './local-backend.js';
import { executeParameterized } from '../core/lbug-adapter.js';

export interface EndpointInfo {
  method: string;
  path: string;
  controller?: string;
  handler?: string;
  filePath?: string;
  line?: number;
}

export async function queryEndpoints(
  repo: RepoHandle,
  options?: {
    method?: string;
    path?: string;
  }
): Promise<{ endpoints: EndpointInfo[] }> {
  // Build query with optional filters
  let cypher = `
    MATCH (r:Route)
  `;

  const params: Record<string, any> = {};

  // Add WHERE clause for filters
  const conditions: string[] = [];
  if (options?.method) {
    conditions.push('r.httpMethod = $method');
    params.method = options.method.toUpperCase();
  }
  if (options?.path) {
    conditions.push('r.routePath CONTAINS $path');
    params.path = options.path;
  }

  if (conditions.length > 0) {
    cypher += '\n  WHERE ' + conditions.join(' AND ');
  }

  cypher += `
    RETURN r.httpMethod AS method, r.routePath AS path,
           r.controllerName AS controller, r.methodName AS handler,
           r.filePath AS filePath, r.lineNumber AS line
    ORDER BY LENGTH(r.routePath) DESC, r.httpMethod
  `;

  const rows = await executeParameterized(repo.id, cypher, params);

  const endpoints: EndpointInfo[] = rows.map((row: any) => ({
    method: row.method ?? row[0],
    path: row.path ?? row[1],
    controller: row.controller ?? row[2] ?? undefined,
    handler: row.handler ?? row[3] ?? undefined,
    filePath: row.filePath ?? row[4] ?? undefined,
    line: row.line ?? row[5] ?? undefined,
  }));

  return { endpoints };
}