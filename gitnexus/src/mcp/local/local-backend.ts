/**
 * Local Backend (Multi-Repo)
 * 
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { initLbug, executeQuery, executeParameterized, closeLbug, isLbugReady } from '../core/lbug-adapter.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { readManifest, type RepoManifest } from '../../storage/repo-manifest.js';
import { CrossRepoRegistry } from '../../core/ingestion/cross-repo-registry.js';
import { documentEndpoint, type DocumentEndpointOptions } from './document-endpoint.js';
import type { CrossRepoContext } from './cross-repo-context.js';
import { queryEndpoints, type EndpointInfo } from './endpoint-query.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') || p.includes('.spec.') ||
    p.includes('__tests__/') || p.includes('__mocks__/') ||
    p.includes('/test/') || p.includes('/tests/') ||
    p.includes('/testing/') || p.includes('/fixtures/') ||
    p.endsWith('_test.go') || p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') || p.endsWith('_test.rb') || p.includes('/spec/') ||
    p.includes('/test_') || p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY',
  'OVERRIDES', 'ACCESSES', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL',
  'ENTRY_POINT_OF', 'WRAPS', 'CONTAINS'
]);

/**
 * Confidence floors per relation type for impact analysis.
 * Used when no stored graph confidence is available.
 * Higher = more trustworthy relationship (structural containment).
 * Lower = potentially indirect/observational relationship.
 */
export const IMPACT_RELATION_CONFIDENCE: Record<string, number> = {
  CALLS: 0.9,          // direct function reference
  IMPORTS: 0.9,        // direct module import
  EXTENDS: 0.85,       // statically verifiable inheritance
  IMPLEMENTS: 0.85,    // statically verifiable contract
  OVERRIDES: 0.85,     // statically verifiable override
  HAS_METHOD: 0.95,    // structural containment (method in class)
  HAS_PROPERTY: 0.95,  // structural containment (field in class)
  ACCESSES: 0.8,       // may be indirect read/write
  CONTAINS: 0.95,      // folder/file structural containment
};

/** Regex to detect write operations in user-supplied Cypher queries */
export const CYPHER_WRITE_RE = /(?<!:)\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH)\b/i;

/** Check if a Cypher query contains write operations */
export function isWriteQuery(query: string): boolean {
  return CYPHER_WRITE_RE.test(query);
}

/** Structured error logging for query failures — replaces empty catch blocks */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`GitNexus [${context}]: ${msg}`);
}

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

export interface RepoHandle {
  id: string;          // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private crossRepoRegistry: CrossRepoRegistry | null = null;
  private crossRepoInitPromise: Promise<void> | null = null;

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    await this.refreshRepos();
    return this.repos.size > 0;
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private async refreshRepos(): Promise<void> {
    const entries = await listRegisteredRepos({ validate: true });
    const freshIds = new Set<string>();

    for (const entry of entries) {
      const id = this.repoId(entry.name, entry.path);
      freshIds.add(id);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // Clean up any leftover KuzuDB files from before the LadybugDB migration.
      // If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
      const kuzu = await cleanupOldKuzuFiles(storagePath);
      if (kuzu.found && kuzu.needsReindex) {
        console.error(`GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`);
      }

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      this.repos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      this.contextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    // Prune repos that no longer exist in the registry
    for (const id of this.repos.keys()) {
      if (!freshIds.has(id)) {
        this.repos.delete(id);
        this.contextCache.delete(id);
        this.initializedRepos.delete(id);
      }
    }
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string): string {
    const base = name.toLowerCase();
    // Check for name collision with a different path
    for (const [id, handle] of this.repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string): Promise<RepoHandle> {
    const result = this.resolveRepoFromCache(repoParam);
    if (result) return result;

    // Miss — refresh registry and try once more
    await this.refreshRepos();
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) return retried;

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }
    if (repoParam) {
      const names = [...this.repos.values()].map(h => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }
    const names = [...this.repos.values()].map(h => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    if (this.repos.size === 0) return null;

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      // Match by id
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
      // Match by name (case-insensitive)
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase() === paramLower) return handle;
      }
      // Match by path (substring)
      const resolved = path.resolve(repoParam);
      for (const handle of this.repos.values()) {
        if (handle.repoPath === resolved) return handle;
      }
      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }
      return null;
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    return null; // Multiple repos, no param — ambiguous
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // Always check the actual pool — the idle timer may have evicted the connection
    if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) return;

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

    try {
      await initLbug(repoId, handle.lbugPath);
      this.initializedRepos.add(repoId);
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(repoId);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   */
  async listRepos(): Promise<Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }>> {
    await this.refreshRepos();
    return [...this.repos.values()].map(h => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    if (method === 'list_repos') {
      return this.listRepos();
    }

    // Cross-repo routing: if repos[] is provided, use multi-repo handler
    if (params?.repos && Array.isArray(params.repos) && params.repos.length > 0) {
      return this.callToolMultiRepo(method, params);
    }

    // Single-repo routing (backward compatible)
    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);

    switch (method) {
      case 'query':
        return this.query(repo, params);
      case 'cypher': {
        const raw = await this.cypher(repo, params);
        return this.formatCypherAsMarkdown(raw);
      }
      case 'context':
        return this.context(repo, params);
      case 'impact':
        return this.impact(repo, params);
      case 'detect_changes':
        return this.detectChanges(repo, params);
      case 'rename':
        return this.rename(repo, params);
      case 'endpoints':
        return this.endpoints(repo, params);
      case 'document-endpoint':
        return this.documentEndpoint(repo, params);
      case 'api_impact':
        return this.apiImpact(repo, params);
      case 'route_map':
        return this.routeMap(repo, params);
      case 'shape_check':
        return this.shapeCheck(repo, params);
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, params);
      case 'explore':
        return this.context(repo, { name: params?.name, ...params });
      case 'overview':
        return this.overview(repo, params);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  /**
   * Multi-repo tool dispatch.
   * Executes queries across multiple repos in parallel and aggregates results.
   * Each result includes _repoId attribution.
   */
  private async callToolMultiRepo(method: string, params: any): Promise<any> {
    const repoIds: string[] = params.repos;

    switch (method) {
      case 'query': {
        // Query each repo in parallel and aggregate results
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.query(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate results with _repoId attribution
        const aggregated = {
          processes: [] as any[],
          process_symbols: [] as any[],
          definitions: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            // Add _repoId to each item
            if (result.processes) {
              aggregated.processes.push(...result.processes.map((p: any) => ({ ...p, _repoId: repoId })));
            }
            if (result.process_symbols) {
              aggregated.process_symbols.push(...result.process_symbols.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.definitions) {
              aggregated.definitions.push(...result.definitions.map((d: any) => ({ ...d, _repoId: repoId })));
            }
          }
        }

        return aggregated;
      }

      case 'cypher': {
        // Execute cypher on multiple repos in parallel
        const cypherQuery = params.query;
        const raw = await this.queryMultipleRepos(repoIds, cypherQuery);
        // Aggregate results with _repoId and format as markdown
        return this.formatMultiRepoCypherResult(raw);
      }

      case 'context': {
        // Query context from multiple repos
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.context(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate candidates from all repos
        const aggregated: any = {
          status: 'found',
          candidates: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            if (result.status === 'ambiguous' && result.candidates) {
              // Add _repoId to each candidate
              aggregated.candidates.push(...result.candidates.map((c: any) => ({ ...c, _repoId: repoId })));
            } else if (result.status === 'found' && result.symbol) {
              // Found in one repo, return with _repoId
              aggregated.symbol = { ...result.symbol, _repoId: repoId };
              aggregated.repoId = repoId;
            }
          }
        }

        // If we found an exact match, return it
        if (aggregated.symbol) {
          return { status: 'found', symbol: aggregated.symbol, _repoId: aggregated.repoId };
        }

        // Otherwise return aggregated candidates
        if (aggregated.candidates.length > 0) {
          aggregated.status = 'ambiguous';
        } else {
          aggregated.status = 'not_found';
        }

        return aggregated;
      }

      case 'impact': {
        // Run impact analysis on multiple repos
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.impact(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate impact results
        const aggregated: any = {
          target: params.target,
          direction: params.direction,
          byDepth: { d1: [], d2: [], d3: [] },
          affected_processes: [],
          affected_modules: [],
          errors: [],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            // Aggregate byDepth with _repoId
            if (result.byDepth?.d1) {
              aggregated.byDepth.d1.push(...result.byDepth.d1.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.byDepth?.d2) {
              aggregated.byDepth.d2.push(...result.byDepth.d2.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.byDepth?.d3) {
              aggregated.byDepth.d3.push(...result.byDepth.d3.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.affected_processes) {
              aggregated.affected_processes.push(...result.affected_processes.map((p: any) => ({ ...p, _repoId: repoId })));
            }
            if (result.affected_modules) {
              aggregated.affected_modules.push(...result.affected_modules.map((m: any) => ({ ...m, _repoId: repoId })));
            }
          }
        }

        // Calculate aggregate risk
        aggregated.risk = this.calculateAggregateRisk(results.map((r) => r.result));

        return aggregated;
      }

      default:
        throw new Error(`Tool '${method}' does not support multi-repo queries. Use single 'repo' parameter instead.`);
    }
  }

  /**
   * Format multi-repo cypher results as markdown.
   */
  private formatMultiRepoCypherResult(results: Array<{ repoId: string; results: unknown[] }>): any {
    // Check if any repo had errors
    const allRows: any[] = [];
    const errors: { repoId: string; error: string }[] = [];

    for (const { repoId, results: rows } of results) {
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row === 'object' && 'error' in row) {
            errors.push({ repoId, error: (row as any).error });
          } else {
            allRows.push({ ...(row as object), _repoId: repoId });
          }
        }
      }
    }

    if (allRows.length === 0 && errors.length > 0) {
      return { error: errors.map((e) => `${e.repoId}: ${e.error}`).join('; ') };
    }

    if (allRows.length === 0) {
      return [];
    }

    // Format as markdown table
    return this.formatCypherAsMarkdown(allRows);
  }

  /**
   * Calculate aggregate risk from multi-repo impact results.
   */
  private calculateAggregateRisk(results: any[]): string {
    const risks = results
      .filter((r) => r && r.risk)
      .map((r) => r.risk);

    if (risks.includes('CRITICAL')) return 'CRITICAL';
    if (risks.includes('HIGH')) return 'HIGH';
    if (risks.includes('MEDIUM')) return 'MEDIUM';
    if (risks.includes('LOW')) return 'LOW';
    return 'NONE';
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   * 
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(repo: RepoHandle, params: {
    query: string;
    task_context?: string;
    goal?: string;
    limit?: number;
    max_symbols?: number;
    include_content?: boolean;
  }): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    
    await this.ensureInitialized(repo.id);
    
    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();
    
    // Step 1: Run hybrid search to get matching symbols
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const [bm25Results, semanticResults] = await Promise.all([
      this.bm25Search(repo, searchQuery, searchLimit),
      this.semanticSearch(repo, searchQuery, searchLimit),
    ]);
    
    // Merge via reciprocal rank fusion
    const scoreMap = new Map<string, { score: number; data: any }>();
    
    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }
    
    for (let i = 0; i < semanticResults.length; i++) {
      const result = semanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }
    
    const merged = Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, searchLimit);
    
    // Step 2: For each match with a nodeId, trace to process(es)
    const processMap = new Map<string, { id: string; label: string; heuristicLabel: string; processType: string; stepCount: number; totalScore: number; cohesionBoost: number; symbols: any[] }>();
    const definitions: any[] = []; // standalone symbols not in any process
    
    for (const [_, item] of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        // File-level results go to definitions
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }
      
      // Find processes this symbol participates in
      let processRows: any[] = [];
      try {
        processRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.nodeId });
      } catch (e) { logQueryError('query:process-lookup', e); }

      // Get cluster membership + cohesion (cohesion used as internal ranking signal)
      let cohesion = 0;
      let module: string | undefined;
      try {
        const cohesionRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `, { nodeId: sym.nodeId });
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
          module = cohesionRows[0].module ?? cohesionRows[0][1];
        }
      } catch (e) { logQueryError('query:cluster-info', e); }

      // Optionally fetch content
      let content: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeParameterized(repo.id, `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `, { nodeId: sym.nodeId });
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch (e) { logQueryError('query:content-fetch', e); }
      }

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(module ? { module } : {}),
        ...(includeContent && content ? { content } : {}),
      };
      
      if (processRows.length === 0) {
        // Symbol not in any process — goes to definitions
        definitions.push(symbolEntry);
      } else {
        // Add to each process it belongs to
        for (const row of processRows) {
          const pid = row.pid ?? row[0];
          const label = row.label ?? row[1];
          const hLabel = row.heuristicLabel ?? row[2];
          const pType = row.processType ?? row[3];
          const stepCount = row.stepCount ?? row[4];
          const step = row.step ?? row[5];
          
          if (!processMap.has(pid)) {
            processMap.set(pid, {
              id: pid,
              label,
              heuristicLabel: hLabel,
              processType: pType,
              stepCount,
              totalScore: 0,
              cohesionBoost: 0,
              symbols: [],
            });
          }
          
          const proc = processMap.get(pid)!;
          proc.totalScore += item.score;
          proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
          proc.symbols.push({
            ...symbolEntry,
            process_id: pid,
            step_index: step,
          });
        }
      }
    }
    
    // Step 3: Rank processes by aggregate score + internal cohesion boost
    const rankedProcesses = Array.from(processMap.values())
      .map(p => ({
        ...p,
        priority: p.totalScore + (p.cohesionBoost * 0.1), // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    
    // Step 4: Build response
    const processes = rankedProcesses.map(p => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));
    
    const processSymbols = rankedProcesses.flatMap(p =>
      p.symbols.slice(0, maxSymbolsPerProcess).map(s => ({
        ...s,
        // remove internal fields
      }))
    );
    
    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    
    return {
      processes,
      process_symbols: dedupedSymbols,
      definitions: definitions.slice(0, 20), // cap standalone definitions
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
    let bm25Results;
    try {
      bm25Results = await searchFTSFromLbug(query, limit, repo.id);
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return [];
    }
    
    const results: any[] = [];
    
    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 3
        `, { filePath: fullPath });
        
        if (symbols.length > 0) {
          for (const sym of symbols) {
            results.push({
              nodeId: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              startLine: sym.startLine || sym[4],
              endLine: sym.endLine || sym[5],
              bm25Score: bm25Result.score,
            });
          }
        } else {
          const fileName = fullPath.split('/').pop() || fullPath;
          results.push({
            name: fileName,
            type: 'File',
            filePath: bm25Result.filePath,
            bm25Score: bm25Result.score,
          });
        }
      } catch {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    }
    
    return results;
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(repo.id, `MATCH (e:CodeEmbedding) RETURN COUNT(*) AS cnt LIMIT 1`);
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.6
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;
      
      const embResults = await executeQuery(repo.id, vectorQuery);
      
      if (embResults.length === 0) return [];
      
      const results: any[] = [];
      
      for (const embRow of embResults) {
        const nodeId = embRow.nodeId ?? embRow[0];
        const distance = embRow.distance ?? embRow[1];
        
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
        
        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;
        
        try {
          const nodeQuery = label === 'File'
            ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;

          const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance,
              startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
              endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
            });
          }
        } catch {}
      }
      
      return results;
    } catch {
      // Expected when embeddings are disabled — silently fall back to BM25-only
      return [];
    }
  }

  async executeCypher(repoName: string, query: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return this.cypher(repo, { query });
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    // Block write operations (defense-in-depth — DB is already read-only)
    if (CYPHER_WRITE_RE.test(params.query)) {
      return { error: 'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.' };
    }

    try {
      const result = await executeQuery(repo.id, params.query);
      return result;
    } catch (err: any) {
      return { error: err.message || 'Query failed' };
    }
  }

  /**
   * Format raw Cypher result rows as a markdown table for LLM readability.
   * Falls back to raw result if rows aren't tabular objects.
   */
  private formatCypherAsMarkdown(result: any): any {
    if (!Array.isArray(result) || result.length === 0) return result;

    const firstRow = result[0];
    if (typeof firstRow !== 'object' || firstRow === null) return result;

    const keys = Object.keys(firstRow);
    if (keys.length === 0) return result;

    const header = '| ' + keys.join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const dataRows = result.map((row: any) =>
      '| ' + keys.map(k => {
        const v = row[k];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }).join(' | ') + ' |'
    );

    return {
      markdown: [header, separator, ...dataRows].join('\n'),
      row_count: result.length,
    };
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in LadybugDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<string, { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }>();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, { ids: [c.id], totalSymbols: symbols, weightedCohesion: cohesion * symbols, largest: c });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter(c => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(repo: RepoHandle, params: { showClusters?: boolean; showProcesses?: boolean; limit?: number }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const limit = params.limit || 20;
    const result: any = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };
    
    if (params.showClusters !== false) {
      try {
        // Fetch more raw communities than the display limit so aggregation has enough data
        const rawLimit = Math.max(limit * 5, 200);
        const clusters = await executeQuery(repo.id, `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `);
        const rawClusters = clusters.map((c: any) => ({
          id: c.id || c[0],
          label: c.label || c[1],
          heuristicLabel: c.heuristicLabel || c[2],
          cohesion: c.cohesion || c[3],
          symbolCount: c.symbolCount || c[4],
        }));
        result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
      } catch {
        result.clusters = [];
      }
    }
    
    if (params.showProcesses !== false) {
      try {
        const processes = await executeQuery(repo.id, `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `);
        result.processes = processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        }));
      } catch {
        result.processes = [];
      }
    }
    
    return result;
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(repo: RepoHandle, params: {
    name?: string;
    uid?: string;
    file_path?: string;
    include_content?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { name, uid, file_path, include_content } = params;
    
    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }
    
    // Step 1: Find the symbol
    let symbols: any[];
    
    if (uid) {
      symbols = await executeParameterized(repo.id, `
        MATCH (n {id: $uid})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 1
      `, { uid });
    } else {
      const isQualified = name!.includes('/') || name!.includes(':');

      let whereClause: string;
      let queryParams: Record<string, any>;
      if (file_path) {
        whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
        queryParams = { symName: name!, filePath: file_path };
      } else if (isQualified) {
        whereClause = `WHERE n.id = $symName OR n.name = $symName`;
        queryParams = { symName: name! };
      } else {
        whereClause = `WHERE n.name = $symName`;
        queryParams = { symName: name! };
      }

      symbols = await executeParameterized(repo.id, `
        MATCH (n) ${whereClause}
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 10
      `, queryParams);
    }
    
    if (symbols.length === 0) {
      return { error: `Symbol '${name || uid}' not found` };
    }
    
    // context() returns the semantically meaningful result rather than
    // triggering ambiguous disambiguation (#480).
    // labels(n)[0] returns empty string in LadybugDB, so we resolve the
    // preferred node by re-querying with explicit label filters, scoped to
    // the candidate IDs already in symbols.
    //
    // Guard: only attempt Class-preference when at least one candidate has an
    // empty/unknown type (LadybugDB limitation) or is a Constructor — meaning
    // the ambiguity may be a Class/Constructor name collision rather than two
    // genuinely distinct symbols (e.g. two Functions in different files).
    //
    // resolvedLabel is set here and threaded to Step 3 to avoid a redundant
    // classCheck round-trip later.
    let resolvedLabel = '';
    if (symbols.length > 1 && !uid) {
      const hasAmbiguousType = symbols.some((s: any) => {
        const t = s.type || s[2] || '';
        return t === '' || t === 'Constructor';
      });
      if (hasAmbiguousType) {
        const candidateIds = symbols.map((s: any) => s.id || s[0]).filter(Boolean);
        const PREFER_LABELS = ['Class', 'Interface'];
        let preferred: any = null;
        for (const label of PREFER_LABELS) {
          const match = await executeParameterized(repo.id, `
            MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1
          `, { candidateIds }).catch(() => []);
          if (match.length > 0) {
            preferred = symbols.find((s: any) => (s.id || s[0]) === (match[0].id || match[0][0]));
            if (preferred) { resolvedLabel = label; break; }
          }
        }
        if (preferred) symbols = [preferred];
      }
    }

    // If still multiple symbols after disambiguation, return ambiguous status
    if (symbols.length > 1) {
      return {
        status: 'ambiguous',
        candidates: symbols.map((s: any) => ({
          uid: s.id || s[0],
          name: s.name || s[1],
          kind: s.type || s[2],
          filePath: s.filePath || s[3],
          startLine: s.startLine || s[4],
          endLine: s.endLine || s[5],
        })),
      };
    }

    // Step 3: Build full context
    const sym = symbols[0];
    const symId = sym.id || sym[0];

    // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
    // those point to Constructor and File nodes respectively. Fetch those
    // extra incoming refs and merge them in so context() shows real callers.
    //
    // Determine if this is a Class/Interface node. If resolvedLabel was set
    // during disambiguation (Step 2), use it directly — no extra round-trip.
    // Otherwise fall back to a single label check only when the type field is
    // empty (LadybugDB labels(n)[0] limitation).
    const symRawType = sym.type || sym[2] || '';
    let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
    if (!isClassLike && symRawType === '') {
      try {
        // Single UNION query instead of two serial round-trips.
        const typeCheck = await executeParameterized(repo.id, `
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `, { symId });
        isClassLike = typeCheck.length > 0;
      } catch { /* not a Class/Interface node */ }
    } else if (!isClassLike) {
      isClassLike = symRawType === 'Class' || symRawType === 'Interface';
    }

    // Categorized incoming refs
    const incomingRows = await executeParameterized(repo.id, `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `, { symId });

    // Expand incoming refs for Class/Interface nodes: callers via Constructor/File
    if (isClassLike) {
      try {
        // Run both incoming-ref queries in parallel — they are independent.
        const [ctorIncoming, fileIncoming] = await Promise.all([
          executeParameterized(repo.id, `
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `, { symId }),
          executeParameterized(repo.id, `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `, { symId }),
        ]);

        // Deduplicate by (relType, uid) — a caller can have multiple relation
        // types to the same target (e.g. both IMPORTS and CALLS), and each
        // must be preserved so every category appears in the output.
        const seenKeys = new Set(
          incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
        );
        for (const r of [...ctorIncoming, ...fileIncoming]) {
          const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
          if (!seenKeys.has(key)) { seenKeys.add(key); incomingRows.push(r); }
        }
      } catch (e) {
        logQueryError('context:class-incoming-expansion', e);
      }
    }

    // Categorized outgoing refs
    const outgoingRows = await executeParameterized(repo.id, `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'OVERRIDES', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `, { symId });

    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(repo.id, `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `, { symId });
    } catch (e) { logQueryError('context:process-participation', e); }
    
    // Helper to categorize refs
    const categorize = (rows: any[]) => {
      const cats: Record<string, any[]> = {};
      for (const row of rows) {
        const relType = (row.relType || row[0] || '').toLowerCase();
        const entry = {
          uid: row.uid || row[1],
          name: row.name || row[2],
          filePath: row.filePath || row[3],
          kind: row.kind || row[4],
        };
        if (!cats[relType]) cats[relType] = [];
        cats[relType].push(entry);
      }
      return cats;
    };
    
    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        kind: isClassLike ? (resolvedLabel || 'Class') : (sym.type || sym[2]),
        filePath: sym.filePath || sym[3],
        startLine: sym.startLine || sym[4],
        endLine: sym.endLine || sym[5],
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
      },
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      processes: processRows.map((r: any) => ({
        id: r.pid || r[0],
        name: r.label || r[1],
        step_index: r.step || r[2],
        step_count: r.stepCount || r[3],
      })),
    };
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(repo: RepoHandle, params: { name: string; type: 'symbol' | 'cluster' | 'process' }): Promise<any> {
    await this.ensureInitialized(repo.id);
    const { name, type } = params;
    
    if (type === 'symbol') {
      return this.context(repo, { name });
    }
    
    if (type === 'cluster') {
      const clusters = await executeParameterized(repo.id, `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `, { clusterName: name });
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
      }));

      let totalSymbols = 0, weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }

      const members = await executeParameterized(repo.id, `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `, { clusterName: name });
      
      return {
        cluster: {
          id: rawClusters[0].id,
          label: rawClusters[0].heuristicLabel || rawClusters[0].label,
          heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
          cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
          symbolCount: totalSymbols,
          subCommunities: rawClusters.length,
        },
        members: members.map((m: any) => ({
          name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
        })),
      };
    }
    
    if (type === 'process') {
      const processes = await executeParameterized(repo.id, `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `, { processName: name });
      if (processes.length === 0) return { error: `Process '${name}' not found` };

      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeParameterized(repo.id, `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `, { procId });
      
      return {
        process: {
          id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
        })),
      };
    }
    
    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(repo: RepoHandle, params: {
    scope?: string;
    base_ref?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const scope = params.scope || 'unstaged';
    const { execFileSync } = await import('child_process');

    // Build git diff args based on scope (using execFileSync to avoid shell injection)
    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '--name-only'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '--name-only'];
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', params.base_ref, '--name-only'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '--name-only'];
        break;
    }

    let changedFiles: string[];
    try {
      const output = execFileSync('git', diffArgs, { cwd: repo.repoPath, encoding: 'utf-8' });
      changedFiles = output.trim().split('\n').filter(f => f.length > 0);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
    
    if (changedFiles.length === 0) {
      return {
        summary: { changed_count: 0, affected_count: 0, risk_level: 'none', message: 'No changes detected.' },
        changed_symbols: [],
        affected_processes: [],
      };
    }
    
    // Map changed files to indexed symbols
    const changedSymbols: any[] = [];
    for (const file of changedFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n) WHERE n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          LIMIT 20
        `, { filePath: normalizedFile });
        for (const sym of symbols) {
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            change_type: 'Modified',
          });
        }
      } catch (e) { logQueryError('detect-changes:file-symbols', e); }
    }

    // Find affected processes
    const affectedProcesses = new Map<string, any>();
    for (const sym of changedSymbols) {
      try {
        const procs = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.id });
        for (const proc of procs) {
          const pid = proc.pid || proc[0];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[1],
              process_type: proc.processType || proc[2],
              step_count: proc.stepCount || proc[3],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: sym.name,
            step: proc.step || proc[4],
          });
        }
      } catch (e) { logQueryError('detect-changes:process-lookup', e); }
    }

    const processCount = affectedProcesses.size;
    const risk = processCount === 0 ? 'low' : processCount <= 5 ? 'medium' : processCount <= 15 ? 'high' : 'critical';
    
    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: changedFiles.length,
        risk_level: risk,
      },
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }

  /**
   * API Impact tool — analyze an HTTP route's response shape, consumers, and mismatches.
   *
   * Queries Route nodes and their FETCHES consumer edges to determine:
   * - Which consumers (fetch() callers) depend on this route
   * - Whether consumer code accesses fields not present in the handler's response shape
   * - Risk level based on consumer count and mismatch severity
   */
  private async apiImpact(repo: RepoHandle, params: {
    route?: string;
    file?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    // Build the route lookup query
    let routeWhere = '';
    const routeParams: Record<string, any> = {};

    if (params.route) {
      routeWhere = 'WHERE r.name = $route';
      routeParams.route = params.route;
    } else if (params.file) {
      routeWhere = 'WHERE r.filePath = $file';
      routeParams.file = params.file;
    }

    // Find the route(s) — may return multiple if same file has multiple methods
    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys,
             r.middleware AS middleware
    `, routeParams);

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    // Build results — one entry per matched route
    const routes: any[] = [];
    let allMismatches: any[] = [];
    let totalConsumers = 0;

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const responseKeys: string[] = row.responseKeys || row[3] || [];
      const errorKeys: string[] = row.errorKeys || row[4] || [];
      const middleware: string[] = row.middleware || row[5] || [];

      // Find consumers: functions that FETCHES this route (via CodeRelation edges)
      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[r:CodeRelation {type: 'FETCHES'}]->(rout:Route)
        WHERE rout.id = $routeId
        RETURN c.id AS consumerId, c.name AS consumerName,
               c.filePath AS consumerFile, r.reason AS fetchReason
      `, { routeId });

      const consumers: any[] = [];
      const routeConsumerSet = new Set<string>();

      for (const cres of consumerRows) {
        const consumerId = cres.consumerId || cres[0];
        const consumerName = cres.consumerName || cres[1];
        const consumerFile = cres.consumerFile || cres[2];
        const fetchReason: string = cres.fetchReason || cres[3] || '';

        // Skip duplicate consumers from same file (multiple methods in same file)
        if (routeConsumerSet.has(consumerFile)) continue;
        routeConsumerSet.add(consumerFile);

        // Determine if this is a multi-fetch consumer (fetches multiple routes)
        const multiMatch = fetchReason.match(/fetches:(\d+)/);
        const attributionNote = multiMatch && parseInt(multiMatch[1]) > 1
          ? `fetches ${multiMatch[1]} routes`
          : undefined;

        // Determine confidence based on multi-fetch
        const confidence = multiMatch && parseInt(multiMatch[1]) > 1 ? 'low' : 'high';

        consumers.push({
          name: consumerName,
          file: consumerFile,
          attributionNote,
          confidence,
        });

        // Check for mismatches: consumer accesses fields not in response shape
        const keyMatch = fetchReason.match(/keys:([^|]+)/);
        if (keyMatch) {
          const accessedKeys = keyMatch[1].split(',').map((k: string) => k.trim());
          const successSet = new Set(responseKeys);
          const errorSet = new Set(errorKeys);

          for (const key of accessedKeys) {
            // Skip if key is a nested property access (e.g., "data.items")
            const topLevelKey = key.split('.')[0];
            const isSuccess = successSet.has(topLevelKey);
            const isError = errorSet.has(topLevelKey);

            if (!isSuccess && !isError) {
              allMismatches.push({
                consumer: consumerFile,
                field: topLevelKey,
                reason: `${topLevelKey} not in response shape`,
                confidence,
              });
            }
          }
        }
      }

      totalConsumers += consumers.length;

      routes.push({
        route: routeName,
        handler: handlerFile,
        responseShape: {
          success: responseKeys,
          error: errorKeys,
        },
        middleware,
        consumers,
      });
    }

    // Calculate impact summary
    const directConsumers = totalConsumers;
    let riskLevel = 'LOW';
    if (allMismatches.length > 0) {
      // Mismatches always bump risk to at least MEDIUM
      riskLevel = directConsumers >= 10 ? 'HIGH' : 'MEDIUM';
    } else if (directConsumers >= 10) {
      riskLevel = 'HIGH';
    } else if (directConsumers >= 3) {
      riskLevel = 'MEDIUM';
    }

    const impactSummary = {
      directConsumers,
      riskLevel,
    };

    // If multiple routes matched, return array format
    if (routes.length > 1) {
      return {
        routes,
        total: routes.length,
        mismatches: allMismatches,
        impactSummary,
      };
    }

    // Single route — return flat structure
    const single = routes[0];
    return {
      route: single.route,
      handler: single.handler,
      responseShape: single.responseShape,
      middleware: single.middleware,
      consumers: single.consumers,
      mismatches: allMismatches,
      impactSummary,
    };
  }

  /**
   * route_map tool — list routes with their consumers and middleware.
   * Simpler than api_impact: just returns route metadata without mismatch analysis.
   */
  private async routeMap(repo: RepoHandle, params: { route?: string; file?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    const routeWhere = params.route
      ? 'WHERE r.name = $route'
      : 'WHERE r.filePath = $file';
    const routeParams = { route: params.route, file: params.file };
    const queryParam = params.route ? 'route' : 'file';

    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys,
             r.middleware AS middleware
    `, { [queryParam]: params.route ?? params.file });

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    const routes: any[] = [];

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const middleware: string[] = row.middleware || row[5] || [];

      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[r:CodeRelation {type: 'FETCHES'}]->(rout:Route)
        WHERE rout.id = $routeId
        RETURN c.filePath AS consumerFile
      `, { routeId });

      const consumers = [...new Set(consumerRows.map((r: any) => r.consumerFile || r[0]))];

      routes.push({
        route: routeName,
        handler: handlerFile,
        middleware,
        consumers: consumers.map(f => ({ file: f })),
      });
    }

    return { routes };
  }

  /**
   * shape_check tool — list routes with their response shapes.
   * Analyzes consumer key access and identifies mismatches between
   * consumer-accessed keys and route response/error keys.
   */
  private async shapeCheck(repo: RepoHandle, params: { route?: string; file?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    const routeWhere = params.route
      ? 'WHERE r.name = $route'
      : 'WHERE r.filePath = $file';
    const queryParam = params.route ? 'route' : 'file';

    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys
    `, { [queryParam]: params.route ?? params.file });

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    const routes: any[] = [];

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const responseKeys: string[] = row.responseKeys || row[3] || [];
      const errorKeys: string[] = row.errorKeys || row[4] || [];

      // Query FETCHES edges with reason field to extract accessed keys
      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[rel:CodeRelation {type: 'FETCHES'}]->(r:Route)
        WHERE r.id = $routeId
        RETURN c.filePath AS consumerFile, rel.reason AS reason
      `, { routeId });

      // Build consumer info with key analysis
      const consumers: any[] = [];
      for (const consumerRow of consumerRows) {
        const filePath = consumerRow.consumerFile || consumerRow[0];
        const reason = consumerRow.reason || consumerRow[1] || '';

        // Parse accessed keys from reason field (format: "fetch-url-match|keys:key1,key2,...")
        const keysMatch = reason.match(/keys:([^|]+)/);
        const accessedKeys: string[] = keysMatch
          ? keysMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 0)
          : [];

        // Classify keys: errorPathKeys (in errorKeys), mismatched (not in responseKeys or errorKeys)
        const responseKeySet = new Set(responseKeys);
        const errorKeySet = new Set(errorKeys);

        const errorPathKeys: string[] = accessedKeys.filter(k => errorKeySet.has(k));
        const mismatched: string[] = accessedKeys.filter(
          k => !responseKeySet.has(k) && !errorKeySet.has(k)
        );

        consumers.push({
          filePath,
          accessedKeys,
          ...(errorPathKeys.length > 0 && { errorPathKeys }),
          ...(mismatched.length > 0 && { mismatched }),
        });
      }

      // Determine route status: MISMATCH if any consumer has mismatched keys
      const hasMismatches = consumers.some(c => c.mismatched && c.mismatched.length > 0);

      routes.push({
        route: routeName,
        handler: handlerFile,
        responseKeys,
        errorKeys,
        consumers,
        ...(hasMismatches && { status: 'MISMATCH' }),
      });
    }

    return { routes };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(repo: RepoHandle, params: {
    symbol_name?: string;
    symbol_uid?: string;
    new_name: string;
    file_path?: string;
    dry_run?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { new_name, file_path } = params;
    const dry_run = params.dry_run ?? true;

    if (!params.symbol_name && !params.symbol_uid) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }

    /** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
    const assertSafePath = (filePath: string): string => {
      const full = path.resolve(repo.repoPath, filePath);
      if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
        throw new Error(`Path traversal blocked: ${filePath}`);
      }
      return full;
    };
    
    // Step 1: Find the target symbol (reuse context's lookup)
    const lookupResult = await this.context(repo, {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    });
    
    if (lookupResult.status === 'ambiguous') {
      return lookupResult; // pass disambiguation through
    }
    if (lookupResult.error) {
      return lookupResult;
    }
    
    const sym = lookupResult.symbol;
    const oldName = sym.name;
    
    if (oldName === new_name) {
      return { error: 'New name is the same as the current name.' };
    }
    
    // Step 2: Collect edits from graph (high confidence)
    const changes = new Map<string, { file_path: string; edits: any[] }>();
    
    const addEdit = (filePath: string, line: number, oldText: string, newText: string, confidence: string) => {
      if (!changes.has(filePath)) {
        changes.set(filePath, { file_path: filePath, edits: [] });
      }
      changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
    };
    
    // The definition itself
    if (sym.filePath && sym.startLine) {
      try {
        const content = await fs.readFile(assertSafePath(sym.filePath), 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          const defRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          addEdit(sym.filePath, sym.startLine, lines[lineIdx].trim(), lines[lineIdx].replace(defRegex, new_name).trim(), 'graph');
        }
      } catch (e) { logQueryError('rename:read-definition', e); }
    }

    // All incoming refs from graph (callers, importers, etc.)
    const allIncoming = [
      ...(lookupResult.incoming.calls || []),
      ...(lookupResult.incoming.imports || []),
      ...(lookupResult.incoming.extends || []),
      ...(lookupResult.incoming.implements || []),
    ];
    
    let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit
    
    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const content = await fs.readFile(assertSafePath(ref.filePath), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(ref.filePath, i + 1, lines[i].trim(), lines[i].replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), new_name).trim(), 'graph');
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch (e) { logQueryError('rename:read-ref', e); }
    }

    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set([sym.filePath, ...allIncoming.map(r => r.filePath)].filter(Boolean));
    
    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t', 'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, { cwd: repo.repoPath, encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph
        
        try {
          const content = await fs.readFile(assertSafePath(normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              addEdit(normalizedFile, i + 1, lines[i].trim(), lines[i].replace(regex, new_name).trim(), 'text_search');
              astSearchEdits++;
            }
          }
        } catch (e) { logQueryError('rename:text-search-read', e); }
      }
    } catch (e) { logQueryError('rename:ripgrep', e); }
    
    // Step 4: Apply or preview
    const allChanges = Array.from(changes.values());
    const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);
    
    if (!dry_run) {
      // Apply edits to files
      for (const change of allChanges) {
        try {
          const fullPath = assertSafePath(change.file_path);
          let content = await fs.readFile(fullPath, 'utf-8');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          content = content.replace(regex, new_name);
          await fs.writeFile(fullPath, content, 'utf-8');
        } catch (e) { logQueryError('rename:apply-edit', e); }
      }
    }
    
    return {
      status: 'success',
      old_name: oldName,
      new_name,
      files_affected: allChanges.length,
      total_edits: totalEdits,
      graph_edits: graphEdits,
      text_search_edits: astSearchEdits,
      changes: allChanges,
      applied: !dry_run,
    };
  }

  private async impact(repo: RepoHandle, params: {
    target: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
  }): Promise<any> {
    try {
      return await this._impactImpl(repo, params);
    } catch (err: any) {
      // Return structured error instead of crashing (#321)
      return {
        error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed',
        target: { name: params.target },
        direction: params.direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
        suggestion: 'The graph query failed — try gitnexus context <symbol> as a fallback',
      };
    }
  }

  private async _impactImpl(repo: RepoHandle, params: {
    target: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { target, direction } = params;
    const maxDepth = params.maxDepth || 3;
    const rawRelTypes = params.relationTypes && params.relationTypes.length > 0
      ? params.relationTypes.filter(t => VALID_RELATION_TYPES.has(t))
      : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const relationTypes = rawRelTypes.length > 0 ? rawRelTypes : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;

    const relTypeFilter = relationTypes.map(t => `'${t}'`).join(', ');
    const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

    // Resolve target by name, preferring Class/Interface over Constructor
    // (fix #480: Java class and constructor share the same name).
    // labels(n)[0] returns empty string in LadybugDB, so we use explicit
    // label-typed sub-queries in a single UNION ordered by priority to avoid
    // up to 6 serial round-trips for non-Class targets.
    let sym: any = null;
    let symType = '';

    try {
      const rows = await executeParameterized(repo.id, `
        MATCH (n:\`Class\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 0 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Interface\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 1 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Function\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 2 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Method\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 3 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Constructor\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 4 AS priority LIMIT 1
      `, { targetName: target }).catch(() => []);

      if (rows.length > 0) {
        // Pick the row with the lowest priority value (Class wins over Constructor)
        const best = rows.reduce((a: any, b: any) =>
          (a.priority ?? a[3] ?? 99) <= (b.priority ?? b[3] ?? 99) ? a : b,
        );
        sym = best;
        const priorityToLabel = ['Class', 'Interface', 'Function', 'Method', 'Constructor'];
        symType = priorityToLabel[best.priority ?? best[3]] ?? '';
      }
    } catch { /* fall through to unlabeled match */ }

    // Fall back to unlabeled match for any other node type
    if (!sym) {
      const rows = await executeParameterized(repo.id, `
        MATCH (n)
        WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 1
      `, { targetName: target });
      if (rows.length > 0) { sym = rows[0]; symType = sym.type || sym[2] || ''; }
    }

    if (!sym) return { error: `Target '${target}' not found` };

    const symId = sym.id || sym[0];

    const impacted: any[] = [];
    const visited = new Set<string>([symId]);
    let frontier = [symId];
    let traversalComplete = true;

    // Fix #480: For Java (and other JVM) Class/Interface nodes, CALLS edges
    // point to Constructor nodes and IMPORTS edges point to File nodes — not
    // the Class/Interface itself. Seed the frontier with the Constructor(s)
    // and owning File so the BFS traversal finds those edges naturally.
    // The owning File is kept only as an internal seed (frontier/visited) and
    // is NOT added to impacted — it is the definition container, not an
    // upstream dependent. The BFS will discover IMPORTS edges on it naturally.
    if (symType === 'Class' || symType === 'Interface') {
      try {
        // Run both seed queries in parallel — they are independent.
        const [ctorRows, fileRows] = await Promise.all([
          executeParameterized(repo.id, `
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `, { symId }),
          // Restrict to DEFINES edges only — other File->Class edge types (if
          // any) should not be treated as the owning file relationship.
          executeParameterized(repo.id, `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `, { symId }),
        ]);

        for (const r of ctorRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) { visited.add(rid); frontier.push(rid); }
        }
        for (const r of fileRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }
      } catch (e) {
        logQueryError('impact:class-node-expansion', e);
      }
    }

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      
      // Batch frontier nodes into a single Cypher query per depth level
      const idList = frontier.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      const query = direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;
      
      try {
        const related = await executeQuery(repo.id, query);
        
        for (const rel of related) {
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';
          
          if (!includeTests && isTestFilePath(filePath)) continue;
          
          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType: rel.relType || rel[5],
              confidence: rel.confidence || rel[6] || 1.0,
            });
          }
        }
      } catch (e) {
        logQueryError('impact:depth-traversal', e);
        // Break out of depth loop on query failure but return partial results
        // collected so far, rather than silently swallowing the error (#321)
        traversalComplete = false;
        break;
      }
      
      frontier = nextFrontier;
    }
    
    const grouped: Record<number, any[]> = {};
    for (const item of impacted) {
      if (!grouped[item.depth]) grouped[item.depth] = [];
      grouped[item.depth].push(item);
    }

    // ── Enrichment: affected processes, modules, risk ──────────────
    const directCount = (grouped[1] || []).length;
    let affectedProcesses: any[] = [];
    let affectedModules: any[] = [];

    if (impacted.length > 0) {
      const allIdsArr = impacted.map(i => i.id);
      const d1IdsArr = (grouped[1] || []).map((i: any) => i.id);

      // Chunk IDs into batches of 100 for parameterized queries
      const CHUNK_SIZE = 100;
      const chunkIds = (ids: string[]): string[][] => {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
          chunks.push(ids.slice(i, i + CHUNK_SIZE));
        }
        return chunks;
      };

      // Affected processes: which execution flows are broken and at which step
      const maxChunks = parseInt(process.env.IMPACT_MAX_CHUNKS || '999999', 10);
      const processChunks = chunkIds(allIdsArr);
      const processRows: any[] = [];
      const processedIds: string[] = [];
      let chunksProcessed = 0;
      for (const chunk of processChunks) {
        if (chunksProcessed >= maxChunks) {
          traversalComplete = false;
          break;
        }
        processedIds.push(...chunk);
        const result = await executeParameterized(repo.id, `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN $ids
          RETURN p.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep, p.stepCount AS stepCount
          ORDER BY hits DESC
          LIMIT 20
        `, { ids: chunk }).catch(() => []);
        processRows.push(...result);
        chunksProcessed++;
      }

      // Re-aggregate and limit to top 20 after merging all chunks
      const aggregatedProcesses = new Map<string, any>();
      for (const row of processRows) {
        const key = row.name;
        if (aggregatedProcesses.has(key)) {
          const existing = aggregatedProcesses.get(key);
          existing.hits += row.hits;
          if (row.minStep < existing.minStep) existing.minStep = row.minStep;
        } else {
          aggregatedProcesses.set(key, { ...row });
        }
      }
      const topProcesses = Array.from(aggregatedProcesses.values())
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20);

      const [moduleRows, directModuleRows] = await Promise.all([
        executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${processedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]
          RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `).catch(() => []),
        d1IdsArr.length > 0 ? executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${d1IdsArr.filter(id => processedIds.includes(id)).map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]
          RETURN DISTINCT c.heuristicLabel AS name
        `).catch(() => []) : Promise.resolve([]),
      ]);

      affectedProcesses = topProcesses.map((r: any) => ({
        name: r.name || r[0],
        total_hits: r.hits || r[1],
        broken_at_step: r.minStep ?? r[2],
        step_count: r.stepCount ?? r[3],
      }));

      const directModuleSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name || r[0];
        return {
          name,
          hits: r.hits || r[1],
          impact: directModuleSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // Risk scoring
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
      risk = 'CRITICAL';
    } else if (directCount >= 15 || processCount >= 3 || moduleCount >= 3 || impacted.length >= 100) {
      risk = 'HIGH';
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
    }

    return {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
      },
      direction,
      impactedCount: impacted.length,
      risk,
      ...(!traversalComplete && { partial: true }),
      summary: {
        direct: directCount,
        processes_affected: processCount,
        modules_affected: moduleCount,
      },
      affected_processes: affectedProcesses,
      affected_modules: affectedModules,
      byDepth: grouped,
    };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(repo.id, `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `);
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `);
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const clusters = await executeParameterized(repo.id, `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `, { clusterName: name });
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0, weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(repo.id, `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `, { clusterName: name });

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const processes = await executeParameterized(repo.id, `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `, { processName: name });
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(repo.id, `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `, { procId });

    return {
      process: {
        id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
      })),
    };
  }

  /**
   * Document Endpoint tool — Generate API documentation JSON.
   */
  private async documentEndpoint(repo: RepoHandle, params: any): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    // Ensure cross-registry is initialized (lazy init on first access)
    if (!this.crossRepoRegistry) {
      if (!this.crossRepoInitPromise) {
        this.crossRepoInitPromise = this.initCrossRepoRegistry();
      }
      await this.crossRepoInitPromise;
    }
    
    // Create cross-repo context
    const crossRepo: CrossRepoContext = {
      findDepRepo: (prefix) => this.findDepRepo(prefix),
      queryMultipleRepos: (ids, query, p) => this.queryMultipleRepos(ids, query, p),
      listDepRepos: async () => {
        const repos = this.crossRepoRegistry!.listRepos();
        return repos.map(r => r.repoId).filter(id => id !== repo.id);
      }
    };

    const options: DocumentEndpointOptions = {
      method: params.method,
      path: params.path,
      depth: params.depth ?? 10,
      include_context: params.include_context ?? false,
      compact: params.compact ?? false,
      openapi: params.openapi ?? false,
      repo: params.repo,
      crossRepo,
    };
    return documentEndpoint(repo, options);
  }

  /**
   * Endpoints tool — query Route nodes for HTTP endpoints.
   */
  private async endpoints(
    repo: RepoHandle,
    params?: { method?: string; path?: string }
  ): Promise<{ endpoints: EndpointInfo[] }> {
    await this.ensureInitialized(repo.id);
    return queryEndpoints(repo, params);
  }

  // ─── Cross-Repo Methods ─────────────────────────────────────────────

  /**
   * Execute the same Cypher query on multiple repos in parallel.
   * Each result is attributed with its source repoId.
   * Failed repos return empty results instead of throwing.
   *
   * @param repoIds - List of repo identifiers
   * @param cypher - Cypher query to execute
   * @param params - Optional query parameters
   * @returns Array of { repoId, results } for each repo
   */
  async queryMultipleRepos(
    repoIds: string[],
    cypher: string,
    params?: Record<string, unknown>
  ): Promise<Array<{ repoId: string; results: unknown[] }>> {
    if (repoIds.length === 0) return [];

    const DEBUG = process.env.GITNEXUS_DEBUG === 'true';

    const queryPromises = repoIds.map(async (repoId) => {
      try {
        // First try direct lookup
        let handle = this.repos.get(repoId);

        // Debug logging
        if (DEBUG) {
          console.error(`[GitNexus DEBUG] queryMultipleRepos: repoId=${repoId}, handleFound=${!!handle}`);
          if (!handle) {
            console.error(`[GitNexus DEBUG] Available repos: ${[...this.repos.keys()].join(', ')}`);
          }
        }

        // If not found, try resolving by name
        if (!handle) {
          try {
            handle = await this.resolveRepo(repoId);
            if (DEBUG && handle) {
              console.error(`[GitNexus DEBUG] Resolved repoId=${repoId} to handle.id=${handle.id}`);
            }
          } catch {
            // Resolution failed
          }
        }

        if (!handle) {
          return { repoId, results: [] as unknown[], _error: 'repo_not_found' };
        }

        await this.ensureInitialized(handle.id);

        if (!isLbugReady(handle.id)) {
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] LadybugDB not ready for repo: ${repoId}`);
          }
          return { repoId, results: [] as unknown[], _error: 'ladybug_not_ready' };
        }

        const results = params
          ? await executeParameterized(handle.id, cypher, params)
          : await executeQuery(handle.id, cypher);

        if (DEBUG) {
          console.error(`[GitNexus DEBUG] queryMultipleRepos: repoId=${repoId}, resultCount=${results?.length || 0}`);
        }

        return { repoId, results: results || [] };
      } catch (err) {
        logQueryError(`queryMultipleRepos:${repoId}`, err);
        return { repoId, results: [] as unknown[], _error: err instanceof Error ? err.message : String(err) };
      }
    });

    return Promise.all(queryPromises);
  }

  /**
   * Get the manifest for a registered repo.
   * Returns null if repo is unknown or manifest doesn't exist.
   *
   * @param repoId - The repo identifier
   * @returns RepoManifest or null
   */
  async getManifest(repoId: string): Promise<RepoManifest | null> {
    try {
      const handle = await this.resolveRepo(repoId);
      // Manifest is stored at <repoPath>/.gitnexus/repo_manifest.json
      // Try repoPath first (standard location)
      let manifest = await readManifest(handle.repoPath);
      if (!manifest && handle.storagePath) {
        // Fallback: some test setups use storagePath as the repo root
        manifest = await readManifest(handle.storagePath);
      }
      return manifest;
    } catch {
      // Unknown repo or failed to read manifest
      return null;
    }
  }

  /**
   * Find which repo provides a dependency.
   * Lazy-initializes the CrossRepoRegistry on first call.
   *
   * @param depName - Dependency name (e.g., "shared-utils" or "com.example:lib")
   * @returns repoId of the providing repo, or null if not found
   */
  async findDepRepo(depName: string): Promise<string | null> {
    if (!depName) return null;

    // Lazy-initialize registry on first access with race condition guard
    if (!this.crossRepoRegistry) {
      if (!this.crossRepoInitPromise) {
        this.crossRepoInitPromise = this.initCrossRepoRegistry();
      }
      await this.crossRepoInitPromise;
    }

    return this.crossRepoRegistry.findDepRepo(depName);
  }

  /**
   * Initialize CrossRepoRegistry (extracted for lazy init).
   */
  private async initCrossRepoRegistry(): Promise<void> {
    const registry = new CrossRepoRegistry();
    const repoInfos = [...this.repos.values()].map((h) => ({
      repoId: h.id,
      repoPath: h.repoPath,
      storagePath: h.storagePath,
    }));
    await registry.initialize(repoInfos);
    this.crossRepoRegistry = registry;
  }

  async disconnect(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
    if (this.crossRepoRegistry) {
      this.crossRepoRegistry.clear();
      this.crossRepoRegistry = null;
    }
    this.crossRepoInitPromise = null;
  }
}
