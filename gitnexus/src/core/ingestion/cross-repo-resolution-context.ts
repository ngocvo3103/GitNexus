/**
 * WI-3: Cross-Repo Resolution Context
 *
 * Coordinates cross-repo symbol resolution across multiple indexed repositories.
 * Uses Tier 1-3 from ResolutionContext for local resolution, then Tier 4 for external repos.
 */

import type { ResolutionContext, TieredCandidates } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';
import type { CrossRepoRegistry } from './cross-repo-registry.js';
import type { SymbolDefinition } from './symbol-table.js';
import { extractPackagePrefix } from './type-extractors/shared.js';

/**
 * Interface for querying external repositories.
 * Implemented by LocalBackend or similar.
 */
export interface ExternalRepoQuery {
  /**
   * Query a symbol definition from an external repository.
   * @param repoId The external repository ID
   * @param symbolName The symbol to look up
   * @returns Array of symbol definitions or null if not found
   */
  querySymbol(repoId: string, symbolName: string): Promise<SymbolDefinition[] | null>;
}

/**
 * Cross-repo resolution context that orchestrates Tier 4 resolution.
 *
 * Usage:
 * 1. Create with ResolutionContext (for Tiers 1-3), CrossRepoRegistry, and query interface
 * 2. Call resolveAcrossRepos() to resolve symbols across multiple repos
 */
export interface CrossRepoResolutionContext {
  /**
   * Resolve a symbol across multiple repositories.
   *
   * Resolution order:
   * 1. Try Tier 1-3 in primary repo
   * 2. If not found, query external repos (Tier 4)
   *
   * @param symbol The symbol name to resolve
   * @param fromFile The source file (for Tier 1-3 resolution)
   * @param primaryRepoId The primary repository to search first
   * @returns TieredCandidates with attribution, or null if not found
   */
  resolveAcrossRepos(
    symbol: string,
    fromFile: string,
    primaryRepoId: string
  ): Promise<TieredCandidates | null>;
}

/**
 * Create a CrossRepoResolutionContext.
 *
 * @param localContext ResolutionContext for Tiers 1-3 local resolution
 * @param registry CrossRepoRegistry for package -> repoId mapping
 * @param externalQuery Interface for querying external repositories
 * @returns CrossRepoResolutionContext instance
 */
export function createCrossRepoResolutionContext(
  localContext: ResolutionContext,
  registry: CrossRepoRegistry,
  externalQuery: ExternalRepoQuery
): CrossRepoResolutionContext {
  const resolveAcrossRepos = async (
    symbol: string,
    fromFile: string,
    primaryRepoId: string
  ): Promise<TieredCandidates | null> => {
    // Tier 1-3: Try local resolution first
    const localResult = localContext.resolve(symbol, fromFile);
    if (localResult && localResult.candidates.length > 0) {
      // Found in primary repo via Tiers 1-3
      return localResult;
    }

    // Tier 4: External resolution
    // Extract package prefix from symbol to find which repo might have it
    const packagePrefix = extractPackagePrefix(symbol);
    
    // Determine which repos to search
    let depRepoIds: string[] = [];

    if (packagePrefix) {
      // Try to find the specific repo by package prefix
      const depRepoId = registry.findDepRepo(packagePrefix);
      if (depRepoId && depRepoId !== primaryRepoId) {
        depRepoIds = [depRepoId];
      } else {
        // FALLBACK: Package prefix not found in registry, search all dependency repos
        // This handles cases where fully qualified names aren't mapped but simple names work
        const allRepos = registry.listRepos() ?? [];
        depRepoIds = allRepos
          .filter(r => r.repoId !== primaryRepoId)
          .map(r => r.repoId);
      }
    } else {
      // For simple class names (no package prefix), search all dependency repos
      // First try to match the symbol name directly in the registry
      const directMatch = registry.findDepRepo(symbol);
      if (directMatch && directMatch !== primaryRepoId) {
        depRepoIds = [directMatch];
      } else {
        const allRepos = registry.listRepos() ?? [];
        depRepoIds = allRepos
          .filter(r => r.repoId !== primaryRepoId)
          .map(r => r.repoId);
      }
    }

    if (depRepoIds.length === 0) {
      return null;
    }

    // Query external repositories for the symbol
    // Try each repo in order and return the first match
    for (const depRepoId of depRepoIds) {
      try {
        const externalDefs = await externalQuery.querySymbol(depRepoId, symbol);
        if (externalDefs && externalDefs.length > 0) {
          // Return Tier 4 result
          return {
            candidates: externalDefs,
            tier: 'external',
            repoId: depRepoId,
            confidence: TIER_CONFIDENCE['external'],
          };
        }
      } catch {
        // External query failed for this repo, try next
        continue;
      }
    }

    // No match found in any external repo
    return null;
  };

  return {
    resolveAcrossRepos,
  };
}