/**
 * WI-3: Cross-Repo Registry
 *
 * Manages cross-repo dependency tracking for Tier 4 resolution.
 * Loads manifests from indexed repos and provides package->repoId mapping.
 */

import fs from 'fs/promises';
import path from 'path';
import { readManifest, type RepoManifest } from '../../storage/repo-manifest.js';
import { getGlobalDir } from '../../storage/repo-manager.js';

/**
 * Dependency information with ecosystem details.
 */
export interface DependencyInfo {
  name: string;
  version: string;
  groupId?: string;     // Maven only
  artifactId?: string;  // Maven only
  ecosystem: 'maven' | 'npm' | 'go' | 'cargo' | 'pip';
}

/**
 * Registry entry for each indexed repository.
 */
interface RegistryEntry {
  repoId: string;
  repoPath: string;
  manifest: RepoManifest | null;
}

/**
 * Global registry file structure (~/.gitnexus/registry.json)
 */
interface GlobalRegistry {
  repos: Array<{
    repoId: string;
    path: string;
  }>;
}

/**
 * CrossRepoRegistry provides package prefix -> repoId mapping
 * for cross-repo symbol resolution (Tier 4).
 *
 * Usage:
 * 1. Create instance
 * 2. Call load() to populate registry
 * 3. Use findDepRepo() to map packages to repos
 */
export class CrossRepoRegistry {
  private entries: Map<string, RegistryEntry> = new Map();
  private packageToRepo: Map<string, string> = new Map();
  private unscopedIndex: Map<string, string> = new Map();
  private reverseDepMap: Map<string, Set<string>> = new Map(); // unscoped name -> repoId for npm scoped packages
  private loaded = false;

  /**
   * Initialize registry from explicit repo infos (alternative to load()).
   * Used by LocalBackend for multi-repo scenarios.
   *
   * @param repoInfos Array of {repoId, repoPath, storagePath} for each registered repo
   */
  async initialize(repoInfos: Array<{ repoId: string; repoPath: string; storagePath?: string }>): Promise<void> {
    if (this.loaded) return;

    this.entries.clear();
    this.packageToRepo.clear();
    this.reverseDepMap.clear();

    // Load manifests in parallel
    const manifestPromises = repoInfos.map(async (info) => {
      // Try repoPath first (standard location), then storagePath (test compatibility)
      let manifest = await readManifest(info.repoPath);
      if (!manifest && info.storagePath) {
        manifest = await readManifest(info.storagePath);
      }
      return {
        repoId: info.repoId,
        repoPath: info.repoPath,
        manifest,
      };
    });

    const results = await Promise.all(manifestPromises);

    // Build lookup maps
    for (const entry of results) {
      this.entries.set(entry.repoId, entry);

      // Build package -> repoId mapping from dependencies
      if (entry.manifest) {
        for (const dep of entry.manifest.dependencies) {
          this.packageToRepo.set(dep, entry.repoId);

          // For Maven groupId:artifactId format, also index just the groupId
          // This allows findDepRepo('com.example:other-lib') to match 'com.example:maven-lib'
          if (dep.includes(':')) {
            const [groupId] = dep.split(':');
            if (!this.packageToRepo.has(groupId)) {
              this.packageToRepo.set(groupId, entry.repoId);
            }
          }

          // For npm scoped packages (@scope/name), also index unscoped name
          // This allows fuzzy matching without O(n) iteration
          if (dep.startsWith('@') && dep.includes('/')) {
            const unscoped = dep.split('/')[1];
            if (unscoped && !this.unscopedIndex.has(unscoped)) {
              this.unscopedIndex.set(unscoped, entry.repoId);
            }
          }
        }
      }
    }

    // WI-1: Build reverse map for artifactId -> repoName matching
    // When artifactId matches a registered repo name, map to that PROVIDER repo
    // (not the consumer repo that declares the dependency)
    for (const entry of results) {
      if (entry.manifest) {
        for (const dep of entry.manifest.dependencies) {
          if (dep.includes(':')) {
            const artifactId = dep.split(':')[1];
            // Map the dependency to its PROVIDER repo. Exact artifactId==repoId
            // wins; otherwise a unique prefix-tolerant match (#46) so e.g.
            // artifactId `exception-handler` binds to repo `bond-exception-handler`.
            const providerRepoId = this.resolveArtifactToRepo(artifactId);
            if (providerRepoId) {
              this.packageToRepo.set(dep, providerRepoId);
              // Also map groupId for subpackage matching (always overwrite to provider)
              const groupId = dep.split(':')[0];
              this.packageToRepo.set(groupId, providerRepoId);
            }
          }
        }
      }
    }

    // Mark as loaded before building reverseDepMap so findDepRepo works
    this.loaded = true;

    // Build reverse dependency map: provider repoId -> set of consumer repoIds
    this.reverseDepMap.clear();
    for (const entry of results) {
      if (entry.manifest) {
        for (const dep of entry.manifest.dependencies) {
          const providerRepoId = this.findDepRepo(dep);
          // A repo is never a cross-repo consumer of itself (#46): the groupId
          // fallback in findDepRepo can otherwise resolve a consumer's own
          // coordinate back to itself, producing a spurious self-reference.
          if (providerRepoId && providerRepoId !== entry.repoId) {
            let consumers = this.reverseDepMap.get(providerRepoId);
            if (!consumers) {
              consumers = new Set<string>();
              this.reverseDepMap.set(providerRepoId, consumers);
            }
            consumers.add(entry.repoId);
          }
        }
      }
    }
  }

  /**
   * Load registry from ~/.gitnexus/registry.json and each repo's manifest.
   * Called once at startup by LocalBackend.
   */
  async load(): Promise<void> {
    this.entries.clear();
    this.packageToRepo.clear();
    this.unscopedIndex.clear();
    this.reverseDepMap.clear();

    const globalRegistryPath = this.getGlobalRegistryPath();
    // Normalized to `{repoId, path}[]`. The on-disk format (#159 Bug-2) is a
    // BARE ARRAY `[{name, path, storagePath, ...}]` written by
    // repo-manager.writeRegistry — NOT the `{repos: [{repoId, path}]}` shape
    // this loader originally assumed (which silently loaded zero repos). Accept
    // both: bare array (derive repoId from `name`, falling back to the path
    // basename to match `initialize()`'s repoId convention) and the wrapped form.
    let repos: Array<{ repoId: string; path: string }> = [];

    try {
      const content = await fs.readFile(globalRegistryPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const rawList: any[] = Array.isArray(parsed)
        ? parsed
        : ((parsed as GlobalRegistry)?.repos ?? []);
      repos = rawList
        .filter((e) => e && typeof e.path === 'string')
        .map((e) => ({
          repoId: e.repoId ?? e.name ?? path.basename(e.path),
          path: e.path,
        }));
    } catch {
      // Global registry doesn't exist or is invalid — empty registry
      this.loaded = true;
      return;
    }

    // Load each repo's manifest
    for (const entry of repos) {
      const { repoId, path: repoPath } = entry;

      // Load manifest from repo directory
      const manifest = await readManifest(repoPath);

      this.entries.set(repoId, {
        repoId,
        repoPath,
        manifest,
      });
      // Build package -> repoId mapping from dependencies
      if (manifest) {
        for (const dep of manifest.dependencies) {
          this.packageToRepo.set(dep, repoId);
          
          // For Maven groupId:artifactId format, also index just the groupId
          if (dep.includes(':')) {
            const [groupId] = dep.split(':');
            if (!this.packageToRepo.has(groupId)) {
              this.packageToRepo.set(groupId, repoId);
            }
          }

          // For npm scoped packages (@scope/name), also index unscoped name
          if (dep.startsWith('@') && dep.includes('/')) {
            const unscoped = dep.split('/')[1];
            if (unscoped && !this.unscopedIndex.has(unscoped)) {
              this.unscopedIndex.set(unscoped, repoId);
            }
          }
        }
      }
    }

    // WI-1: Build reverse map for artifactId -> repoName matching
    // When artifactId matches a registered repo name, map to that PROVIDER repo
    // (not the consumer repo that declares the dependency)
    for (const entry of repos) {
      const manifest = this.entries.get(entry.repoId)?.manifest;
      if (manifest) {
        for (const dep of manifest.dependencies) {
          if (dep.includes(':')) {
            const artifactId = dep.split(':')[1];
            // Map the dependency to its PROVIDER repo. Exact artifactId==repoId
            // wins; otherwise a unique prefix-tolerant match (#46) so e.g.
            // artifactId `exception-handler` binds to repo `bond-exception-handler`.
            const providerRepoId = this.resolveArtifactToRepo(artifactId);
            if (providerRepoId) {
              this.packageToRepo.set(dep, providerRepoId);
              // Also map groupId for subpackage matching (always overwrite to provider)
              const groupId = dep.split(':')[0];
              this.packageToRepo.set(groupId, providerRepoId);
            }
          }
        }
      }
    }

    // Mark as loaded before building reverseDepMap so findDepRepo works
    this.loaded = true;

    // Build reverse dependency map: provider repoId -> set of consumer repoIds
    this.reverseDepMap.clear();
    for (const entry of repos) {
      const manifest = this.entries.get(entry.repoId)?.manifest;
      if (manifest) {
        for (const dep of manifest.dependencies) {
          const providerRepoId = this.findDepRepo(dep);
          // A repo is never a cross-repo consumer of itself (#46): the groupId
          // fallback in findDepRepo can otherwise resolve a consumer's own
          // coordinate back to itself, producing a spurious self-reference.
          if (providerRepoId && providerRepoId !== entry.repoId) {
            let consumers = this.reverseDepMap.get(providerRepoId);
            if (!consumers) {
              consumers = new Set<string>();
              this.reverseDepMap.set(providerRepoId, consumers);
            }
            consumers.add(entry.repoId);
          }
        }
      }
    }
  }
  /**
   * Resolve a Maven artifactId to a registered provider repoId (#46).
   * Maven artifactIds frequently differ from the GitNexus repo name. Resolution
   * is strictly LAYERED, most-specific first, and each layer is ADDITIVE — a
   * later layer is consulted only when every earlier layer returns nothing, so
   * a coordinate that already resolved keeps its exact answer:
   *   1. exact: artifactId == repoId.
   *   2. unique boundary-suffix: repo ends with `-<artifactId>` / `.<artifactId>`
   *      (e.g. `exception-handler` → `bond-exception-handler`).
   *   3. unique token-subsequence (#159): split both on `[-._]` and accept a repo
   *      whose token list contains the artifactId's tokens in order (e.g.
   *      `matching-client` → `matching-engine-client`, `tcbs-amqp-message` →
   *      `tcbs-bond-amqp-message`). Covers infix/prefix-differing names the
   *      suffix rule misses.
   * Every layer requires a UNIQUE candidate; ambiguous (>1) or none returns null,
   * so we never remap a dependency to a guessed wrong repo.
   */
  private resolveArtifactToRepo(artifactId: string): string | null {
    if (!artifactId) return null;
    if (this.entries.has(artifactId)) return artifactId; // (1) exact — unchanged fast path

    // (2) unique boundary-suffix — unchanged behavior; preserves every prior match.
    const suffixHits: string[] = [];
    for (const repoId of this.entries.keys()) {
      if (repoId.endsWith('-' + artifactId) || repoId.endsWith('.' + artifactId)) {
        suffixHits.push(repoId);
      }
    }
    if (suffixHits.length === 1) return suffixHits[0];
    if (suffixHits.length > 1) return null; // ambiguous suffix — never guess

    // (3) unique token-subsequence fallback — only reached when (1) and (2) found
    // nothing, so this is purely additive for previously-unresolved coordinates.
    const artTokens = this.tokenize(artifactId);
    if (artTokens.length === 0) return null;
    const subseqHits: string[] = [];
    for (const repoId of this.entries.keys()) {
      if (this.isTokenSubsequence(artTokens, this.tokenize(repoId))) {
        subseqHits.push(repoId);
      }
    }
    return subseqHits.length === 1 ? subseqHits[0] : null;
  }

  /** Split a Maven artifactId / repo name into lowercase tokens on `-._`. */
  private tokenize(s: string): string[] {
    return s.toLowerCase().split(/[-._]+/).filter(Boolean);
  }

  /** True iff `needle` appears as an order-preserving subsequence of `hay`. */
  private isTokenSubsequence(needle: string[], hay: string[]): boolean {
    let i = 0;
    for (const tok of hay) {
      if (i < needle.length && needle[i] === tok) i++;
    }
    return i === needle.length;
  }

  /**
   * Find repoId for a dependency given a package prefix or module name.
   *
   * @param packagePrefix Java: "com.tcbs.bond.trading.exception"
   *                      npm: "@tcbs/bond-trading" or "bond-trading"
   * @returns repoId of repo that declares this as dependency, or null if not found
   */
  findDepRepo(packagePrefix: string): string | null {
    if (!packagePrefix || !this.loaded) return null;

    // Direct match
    if (this.packageToRepo.has(packagePrefix)) {
      return this.packageToRepo.get(packagePrefix)!;
    }

    // Try matching repo name directly (for repos that are also dependencies)
    if (this.entries.has(packagePrefix)) {
      return packagePrefix;
    }

    // For Java packages, try parent package matching
    // e.g., com.tcbs.bond.trading.exception.handler -> com.tcbs.bond.trading.exception
    if (!packagePrefix.startsWith('@') && packagePrefix.includes('.')) {
      // Try progressively shorter prefixes
      const parts = packagePrefix.split('.');
      for (let i = parts.length - 1; i > 0; i--) {
        const parentPrefix = parts.slice(0, i).join('.');
        if (this.packageToRepo.has(parentPrefix)) {
          return this.packageToRepo.get(parentPrefix)!;
        }
      }
    }

    // Handle Maven groupId:artifactId format
    if (packagePrefix.includes(':')) {
      // Try groupId:artifactId -> try groupId as package prefix
      const [groupId, artifactId] = packagePrefix.split(':');
      if (this.packageToRepo.has(groupId)) {
        return this.packageToRepo.get(groupId)!;
      }
      // Try artifactId as fallback (e.g., "com.tcbs:bond-handler" might match "bond-handler")
      if (artifactId && this.packageToRepo.has(artifactId)) {
        return this.packageToRepo.get(artifactId)!;
      }
      // Try repo name match by artifactId
      if (artifactId && this.entries.has(artifactId)) {
        return artifactId;
      }
      // Try parent groupId matching
      const groupParts = groupId.split('.');
      for (let i = groupParts.length - 1; i > 0; i--) {
        const parentPrefix = groupParts.slice(0, i).join('.');
        if (this.packageToRepo.has(parentPrefix)) {
          return this.packageToRepo.get(parentPrefix)!;
        }
      }
    }

    // Use indexed lookup for npm-style scoped packages
    // Check if packagePrefix matches an unscoped name from a scoped package
    if (this.unscopedIndex.has(packagePrefix)) {
      return this.unscopedIndex.get(packagePrefix)!;
    }
    // Check reverse: if packagePrefix is scoped, try unscoped version
    if (packagePrefix.startsWith('@') && packagePrefix.includes('/')) {
      const unscoped = packagePrefix.split('/')[1];
      if (unscoped && this.unscopedIndex.has(unscoped)) {
        return this.unscopedIndex.get(unscoped)!;
      }
    }

    return null;
  }

  /**
   * Find repo by npm module name (for npm ecosystem).
   *
   * @param moduleName npm package name (e.g., "@types/express" or "express")
   * @returns repoId or null
   */
  findDepRepoNpm(moduleName: string): string | null {
    return this.findDepRepo(moduleName);
  }

  /**
   * Get manifest for a registered repository.
   *
   * @param repoId Repository identifier
   * @returns RepoManifest or null if not found
   */
  getManifest(repoId: string): RepoManifest | null {
    const entry = this.entries.get(repoId);
    return entry?.manifest ?? null;
  }

  /**
   * Find all consumer repoIds that depend on the given provider repoId.
   * Returns empty array for unknown repoId.
   */
  findConsumers(repoId: string): string[] {
    const consumers = this.reverseDepMap.get(repoId);
    return consumers ? Array.from(consumers) : [];
  }

  /**
   * List all registered repositories.
   *
   * @returns Array of repos with their manifests
   */
  listRepos(): Array<{ repoId: string; manifest: RepoManifest | null }> {
    return Array.from(this.entries.values()).map(entry => ({
      repoId: entry.repoId,
      manifest: entry.manifest,
    }));
  }

  /**
   * Check if registry has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Check if registry has been initialized (alias for isLoaded).
   * Provides compatibility with MCP version interface.
   */
  isInitialized(): boolean {
    return this.loaded;
  }

  /**
   * Clear all cached data (useful for testing).
   */
  clear(): void {
    this.entries.clear();
    this.packageToRepo.clear();
    this.unscopedIndex.clear();
    this.reverseDepMap.clear();
    this.loaded = false;
  }

  // --- Private helpers ---

  private getGlobalRegistryPath(): string {
    return path.join(getGlobalDir(), 'registry.json');
  }

  
}

/**
 * Singleton instance for global access.
 */
let registryInstance: CrossRepoRegistry | null = null;

/**
 * Get the global CrossRepoRegistry instance.
 * Lazily initializes on first call.
 */
export function getCrossRepoRegistry(): CrossRepoRegistry {
  if (!registryInstance) {
    registryInstance = new CrossRepoRegistry();
  }
  return registryInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetCrossRepoRegistry(): void {
  registryInstance = null;
}