/**
 * Resolution Context
 *
 * Single implementation of tiered name resolution. Replaces the duplicated
 * tier-selection logic previously split between symbol-resolver.ts and
 * call-processor.ts.
 *
 * Resolution tiers (highest confidence first):
 * 1. Same file (lookupExactFull — authoritative)
 * 2a-named. Named binding chain (walkBindingChain via NamedImportMap)
 * 2a. Import-scoped (lookupFuzzy filtered by ImportMap)
 * 2b. Package-scoped (lookupFuzzy filtered by PackageMap)
 * 3. Global (all candidates — consumers must check candidate count)
 */

import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { createSymbolTable } from './symbol-table.js';
import type { NamedImportBinding } from './import-processor.js';
import { isFileInPackageDir } from './import-processor.js';
import { walkBindingChain } from './named-binding-processor.js';
import type { KnowledgeGraph } from '../graph/types.js';

/** Resolution tier for tracking, logging, and test assertions. */
export type ResolutionTier = 'same-file' | 'import-scoped' | 'global' | 'external';

/** Tier-selected candidates with metadata. */
export interface TieredCandidates {
  readonly candidates: readonly SymbolDefinition[];
  readonly tier: ResolutionTier;
  /** Repository ID for external tier (cross-repo resolution) */
  readonly repoId?: string;
  /** Confidence score (0-1) based on tier */
  readonly confidence: number;
}

/** Confidence scores per resolution tier. */
export const TIER_CONFIDENCE: Record<ResolutionTier, number> = {
  'same-file': 0.95,
  'import-scoped': 0.9,
  'global': 0.5,
  'external': 0.35,
};

// --- Map types ---
export type ImportMap = Map<string, Set<string>>;
export type PackageMap = Map<string, Set<string>>;
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;
export type ModuleAliasMap = Map<string, Map<string, string>>;

export interface ResolutionContext {
  /** Optional graph for D5 IMPLEMENTS edge lookups. */
  readonly graph?: KnowledgeGraph;

  /**
   * The only resolution API. Returns all candidates at the winning tier.
   *
   * Tier 3 ('global') returns ALL candidates regardless of count —
   * consumers must check candidates.length and refuse ambiguous matches.
   */
  resolve(name: string, fromFile: string): TieredCandidates | null;

  // --- Data access (for pipeline wiring, not resolution) ---
  /** Symbol table — used by parsing-processor to populate symbols. */
  readonly symbols: SymbolTable;
  /** Raw maps — used by import-processor to populate import data. */
  readonly importMap: ImportMap;
  readonly packageMap: PackageMap;
  readonly namedImportMap: NamedImportMap;
  /** Module alias map — used for Python relative imports */
  readonly moduleAliasMap?: ModuleAliasMap;

  // --- Per-file cache lifecycle ---
  enableCache(filePath: string): void;
  clearCache(): void;

  // --- Operational ---
  getStats(): { fileCount: number; globalSymbolCount: number; cacheHits: number; cacheMisses: number };
  clear(): void;

  // --- Knowledge Graph (for IMPLEMENTS traversal) ---
  /**
   * Returns node IDs of classes that implement the given interface(s).
   * Queries IMPLEMENTS edges from the KnowledgeGraph.
   * Returns empty Set if graph is undefined or no IMPLEMENTS edges exist.
   */
  findImplementations(interfaceIds: Set<string>): Set<string>;
}

export const createResolutionContext = (graph?: KnowledgeGraph): ResolutionContext => {
  const symbols = createSymbolTable();
  const importMap: ImportMap = new Map();
  const packageMap: PackageMap = new Map();
  const namedImportMap: NamedImportMap = new Map();

  // Per-file cache state
  let cacheFile: string | null = null;
  let cache: Map<string, TieredCandidates | null> | null = null;
  let cacheHits = 0;
  let cacheMisses = 0;

  // --- Core resolution (single implementation of tier logic) ---

  const resolveUncached = (name: string, fromFile: string): TieredCandidates | null => {
    // Tier 1: Same file — authoritative match
    const localDef = symbols.lookupExactFull(fromFile, name);
    if (localDef) {
      return { candidates: [localDef], tier: 'same-file', confidence: TIER_CONFIDENCE['same-file'] };
    }

    // Get all global definitions for subsequent tiers
    const allDefs = symbols.lookupFuzzy(name);

    // Tier 2a-named: Check named bindings BEFORE empty-allDefs early return
    // because aliased imports mean lookupFuzzy('U') returns empty but we
    // can resolve via the exported name.
    const chainResult = walkBindingChain(name, fromFile, symbols, namedImportMap, allDefs);
    if (chainResult && chainResult.length > 0) {
      return { candidates: chainResult, tier: 'import-scoped', confidence: TIER_CONFIDENCE['import-scoped'] };
    }

    if (allDefs.length === 0) return null;

    // Tier 2a: Import-scoped — definition in a file imported by fromFile
    const importedFiles = importMap.get(fromFile);
    if (importedFiles) {
      const importedDefs = allDefs.filter(def => importedFiles.has(def.filePath));
      if (importedDefs.length > 0) {
        return { candidates: importedDefs, tier: 'import-scoped', confidence: TIER_CONFIDENCE['import-scoped'] };
      }
    }

    // Tier 2b: Package-scoped — definition in a package dir imported by fromFile
    const importedPackages = packageMap.get(fromFile);
    if (importedPackages) {
      const packageDefs = allDefs.filter(def => {
        for (const dirSuffix of importedPackages) {
          if (isFileInPackageDir(def.filePath, dirSuffix)) return true;
        }
        return false;
      });
      if (packageDefs.length > 0) {
        return { candidates: packageDefs, tier: 'import-scoped', confidence: TIER_CONFIDENCE['import-scoped'] };
      }
    }

    // Tier 3: Global — pass all candidates through.
    // Consumers must check candidate count and refuse ambiguous matches.
    return { candidates: allDefs, tier: 'global', confidence: TIER_CONFIDENCE['global'] };
  };

  const resolve = (name: string, fromFile: string): TieredCandidates | null => {
    // Check cache (only when enabled AND fromFile matches cached file)
    if (cache && cacheFile === fromFile) {
      if (cache.has(name)) {
        cacheHits++;
        return cache.get(name)!;
      }
      cacheMisses++;
    }

    const result = resolveUncached(name, fromFile);

    // Store in cache if active and file matches
    if (cache && cacheFile === fromFile) {
      cache.set(name, result);
    }

    return result;
  };

  // --- Cache lifecycle ---

  const enableCache = (filePath: string): void => {
    cacheFile = filePath;
    if (!cache) cache = new Map();
    else cache.clear();
  };

  const clearCache = (): void => {
    cacheFile = null;
    // Reuse the Map instance — just clear entries to reduce GC pressure at scale.
    cache?.clear();
  };

  const getStats = () => ({
    ...symbols.getStats(),
    cacheHits,
    cacheMisses,
  });

  const clear = (): void => {
    symbols.clear();
    importMap.clear();
    packageMap.clear();
    namedImportMap.clear();
    clearCache();
    cacheHits = 0;
    cacheMisses = 0;
  };

  // --- Graph-backed IMPLEMENTS traversal ---

  const findImplementations = (interfaceIds: Set<string>): Set<string> => {
    if (!graph) return new Set<string>();

    const implementingClasses = new Set<string>();
    graph.forEachRelationship(rel => {
      if (rel.type === 'IMPLEMENTS' && interfaceIds.has(rel.targetId)) {
        implementingClasses.add(rel.sourceId);
      }
    });
    return implementingClasses;
  };

  return {
    resolve,
    symbols,
    importMap,
    packageMap,
    namedImportMap,
    enableCache,
    clearCache,
    getStats,
    clear,
    findImplementations,
    get graph() { return graph; },
    set graph(g: KnowledgeGraph | undefined) { graph = g; },
  };
};
