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
  handlerUid?: string;  // Method node id from Route→CALLS→Method edge
}

export async function queryEndpoints(
  repo: RepoHandle,
  options?: {
    method?: string;
    path?: string;
  }
): Promise<{ endpoints: EndpointInfo[] }> {
  const method = options?.method?.toUpperCase();

  // When both method and path are provided, try exact match first.
  // This prevents CONTAINS from matching longer sibling routes
  // (e.g., /ibond/{id}/sign/extend when looking for /ibond/{id}/sign).
  if (method && options?.path) {
    const exactCypher = `
      MATCH (r:Route)
      WHERE r.httpMethod = $method AND r.routePath = $path
      OPTIONAL MATCH (r)-[:CodeRelation {type: 'CALLS'}]->(m:Method)
      RETURN r.httpMethod AS method, r.routePath AS path,
             r.controllerName AS controller, r.methodName AS handler,
             r.filePath AS filePath, r.lineNumber AS line,
             m.id AS handlerUid
    `;
    const exactRows = await executeParameterized(repo.id, exactCypher, { method, path: options.path });
    if (exactRows.length > 0) {
      return {
        endpoints: exactRows.map((row: any) => ({
          method: row.method ?? row[0],
          path: row.path ?? row[1],
          controller: row.controller ?? row[2] ?? undefined,
          handler: row.handler ?? row[3] ?? undefined,
          filePath: row.filePath ?? row[4] ?? undefined,
          line: row.line ?? row[5] ?? undefined,
          handlerUid: row.handlerUid ?? row[6] ?? undefined,
        })),
      };
    }
    // No exact match — fall through to CONTAINS query
  }

  // Build CONTAINS query (fallback or when method/path not both provided)
  let cypher = `
    MATCH (r:Route)
  `;

  const params: Record<string, any> = {};
  const conditions: string[] = [];
  if (method) {
    conditions.push('r.httpMethod = $method');
    params.method = method;
  }
  if (options?.path) {
    conditions.push('r.routePath CONTAINS $path');
    params.path = options.path;
  }

  if (conditions.length > 0) {
    cypher += '\n  WHERE ' + conditions.join(' AND ');
  }

  // OPTIONAL MATCH to get the handler Method node via CodeRelation CALLS edge
  cypher += `
    OPTIONAL MATCH (r)-[:CodeRelation {type: 'CALLS'}]->(m:Method)
    RETURN r.httpMethod AS method, r.routePath AS path,
           r.controllerName AS controller, r.methodName AS handler,
           r.filePath AS filePath, r.lineNumber AS line,
           m.id AS handlerUid
    ORDER BY size(r.routePath) ASC, r.httpMethod
  `;

  const rows = await executeParameterized(repo.id, cypher, params);

  const endpoints: EndpointInfo[] = rows.map((row: any) => ({
    method: row.method ?? row[0],
    path: row.path ?? row[1],
    controller: row.controller ?? row[2] ?? undefined,
    handler: row.handler ?? row[3] ?? undefined,
    filePath: row.filePath ?? row[4] ?? undefined,
    line: row.line ?? row[5] ?? undefined,
    handlerUid: row.handlerUid ?? row[6] ?? undefined,
  }));

  return { endpoints };
}

export async function queryAllEndpoints(
  repo: RepoHandle
): Promise<{ endpoints: EndpointInfo[] }> {
  return queryEndpoints(repo);
}
