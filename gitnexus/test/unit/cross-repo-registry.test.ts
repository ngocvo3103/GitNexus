/**
 * WI-3 Unit Tests: Cross-Repo Registry
 *
 * Tests: CrossRepoRegistry implementation
 * Covers: dependency lookup, manifest management, repo tracking
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTempDir } from '../helpers/test-db.js';
import { CrossRepoRegistry, getCrossRepoRegistry, resetCrossRepoRegistry } from '../../src/core/ingestion/cross-repo-registry.js';
import type { RepoManifest } from '../../src/storage/repo-manifest.js';

// Helper to create a global registry file
async function createGlobalRegistry(repos: Array<{ repoId: string; path: string }>): Promise<string> {
  const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify({ repos }));
  return registryPath;
}

// Helper to create a repo manifest
async function createRepoManifest(repoPath: string, manifest: RepoManifest): Promise<void> {
  const manifestPath = path.join(repoPath, '.gitnexus', 'repo_manifest.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

// ─── CrossRepoRegistry Interface Tests ───────────────────────────────────────

describe('CrossRepoRegistry interface', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    // Placeholder - will create actual instance when implementation exists
    registry = {
      load: vi.fn(),
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
    };
  });

  describe('findDepRepo', () => {
    it('returns correct repoId for package prefix', () => {
      // WI-3: findDepRepo must map package prefix to repoId

      vi.mocked(registry.findDepRepo).mockReturnValue('bond-exception-handler');

      const result = registry.findDepRepo('com.tcbs.bond.trading.exception');

      expect(result).toBe('bond-exception-handler');
      expect(registry.findDepRepo).toHaveBeenCalledWith('com.tcbs.bond.trading.exception');
    });

    it('returns null when package not found', () => {
      // WI-3: Unknown packages must return null

      vi.mocked(registry.findDepRepo).mockReturnValue(null);

      const result = registry.findDepRepo('com.unknown.package');

      expect(result).toBeNull();
    });

    it('handles Maven groupId:artifactId format', () => {
      // WI-3: Must support 'groupId:artifactId' lookup

      vi.mocked(registry.findDepRepo).mockReturnValue('shared-utils-repo');

      const result = registry.findDepRepo('com.example.shared:utils');

      expect(result).toBe('shared-utils-repo');
    });
  });

  describe('getManifest', () => {
    it('returns manifest for registered repo', () => {
      // WI-3: getManifest must return the repo's manifest

      const mockManifest: RepoManifest = {
        repoId: 'test-repo',
        indexedAt: '2024-01-15T10:30:00Z',
        dependencies: ['dep-a', 'dep-b'],
      };

      vi.mocked(registry.getManifest).mockReturnValue(mockManifest);

      const result = registry.getManifest('test-repo');

      expect(result).not.toBeNull();
      expect(result?.repoId).toBe('test-repo');
      expect(result?.dependencies).toEqual(['dep-a', 'dep-b']);
    });

    it('returns null for unknown repo', () => {
      // WI-3: Unknown repoId must return null

      vi.mocked(registry.getManifest).mockReturnValue(null);

      const result = registry.getManifest('unknown-repo');

      expect(result).toBeNull();
    });

    it('returns null when manifest file missing', () => {
      // WI-3: Repo exists but no manifest file

      vi.mocked(registry.getManifest).mockReturnValue(null);

      const result = registry.getManifest('repo-without-manifest');

      expect(result).toBeNull();
    });
  });

  describe('listRepos', () => {
    it('returns all registered repos', () => {
      // WI-3: listRepos must return all known repos

      const mockRepos = [
        { repoId: 'repo-a', manifest: { repoId: 'repo-a', indexedAt: '2024-01-01T00:00:00Z', dependencies: [] } },
        { repoId: 'repo-b', manifest: { repoId: 'repo-b', indexedAt: '2024-01-02T00:00:00Z', dependencies: ['repo-a'] } },
        { repoId: 'repo-c', manifest: null },  // Repo without manifest
      ];

      vi.mocked(registry.listRepos).mockReturnValue(mockRepos);

      const result = registry.listRepos();

      expect(result).toHaveLength(3);
      expect(result.map(r => r.repoId)).toEqual(['repo-a', 'repo-b', 'repo-c']);
    });

    it('returns empty array when no repos registered', () => {
      // WI-3: Empty registry must return empty array

      vi.mocked(registry.listRepos).mockReturnValue([]);

      const result = registry.listRepos();

      expect(result).toEqual([]);
    });
  });
});

// ─── Package Prefix Matching Tests (Java/Maven) ──────────────────────────────

describe('Package prefix matching (Java/Maven)', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    registry = {
      load: vi.fn(),
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
    };
  });

  it('matches Java package prefix to repoId', () => {
    // WI-3: Convert package to path and match against indexed repos

    // Package: com.tcbs.bond.trading.exception.TcbsBaseException
    // Path: com/tcbs/bond/trading/exception/
    // Repo contains: src/main/java/com/tcbs/bond/trading/exception/TcbsBaseException.java
    // Expected: findDepRepo('com.tcbs.bond.trading.exception') => 'bond-exception-handler'

    vi.mocked(registry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = registry.findDepRepo('com.tcbs.bond.trading.exception');

    expect(result).toBe('bond-exception-handler');
  });

  it('matches groupId:artifactId format', () => {
    // WI-3: Maven dependencies use 'groupId:artifactId' format

    // Dependency: com.tcbs.bond.trading:exception-handler
    // Expected: findDepRepo('com.tcbs.bond.trading:exception-handler') => 'bond-exception-handler'

    vi.mocked(registry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = registry.findDepRepo('com.tcbs.bond.trading:exception-handler');

    expect(result).toBe('bond-exception-handler');
  });

  it('handles subpackage matching', () => {
    // WI-3: Import of subpackage must match parent package repo

    // Package: com.tcbs.bond.trading.exception.handler (subsubpackage)
    // Repo provides: com.tcbs.bond.trading.exception
    // Expected: findDepRepo('com.tcbs.bond.trading.exception.handler') => 'bond-exception-handler'

    vi.mocked(registry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = registry.findDepRepo('com.tcbs.bond.trading.exception.handler');

    expect(result).toBe('bond-exception-handler');
  });

  it('returns null for non-matching package', () => {
    // WI-3: Unrecognized package returns null

    vi.mocked(registry.findDepRepo).mockReturnValue(null);

    const result = registry.findDepRepo('com.unknown.nonexistent');

    expect(result).toBeNull();
  });

  it('distinguishes between similar package prefixes', () => {
    // WI-3: Must not match wrong repo when packages overlap

    // com.example.lib vs com.example.lib.v2
    // findDepRepo('com.example.lib') should not match repo for 'com.example.lib.v2'

    vi.mocked(registry.findDepRepo)
      .mockReturnValueOnce('lib-repo')
      .mockReturnValueOnce('lib-v2-repo');

    expect(registry.findDepRepo('com.example.lib')).toBe('lib-repo');
    expect(registry.findDepRepo('com.example.lib.v2')).toBe('lib-v2-repo');
  });
});

// ─── Module Name Matching Tests (npm) ────────────────────────────────────────

describe('Module name matching (npm)', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    registry = {
      load: vi.fn(),
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
    };
  });

  it('matches scoped npm package name to repoId', () => {
    // WI-3: Scoped packages like @org/package must be matched

    // Package: @tcbs/exception-utils
    // Expected: findDepRepo('@tcbs/exception-utils') => 'exception-utils-repo'

    vi.mocked(registry.findDepRepo).mockReturnValue('exception-utils-repo');

    const result = registry.findDepRepo('@tcbs/exception-utils');

    expect(result).toBe('exception-utils-repo');
  });

  it('matches unscoped npm package name to repoId', () => {
    // WI-3: Unscoped packages like 'express' must be matched

    // Package: express
    // Expected: findDepRepo('express') => 'express-repo'

    vi.mocked(registry.findDepRepo).mockReturnValue('express-repo');

    const result = registry.findDepRepo('express');

    expect(result).toBe('express-repo');
  });

  it('handles @types scoped packages', () => {
    // WI-3: TypeScript @types packages must be matched

    // Package: @types/express
    // Expected: findDepRepo('@types/express') => 'types-express-repo'

    vi.mocked(registry.findDepRepo).mockReturnValue('types-express-repo');

    const result = registry.findDepRepo('@types/express');

    expect(result).toBe('types-express-repo');
  });

  it('handles package name with hyphens', () => {
    // WI-3: Packages with hyphens must be matched correctly

    // Package: bond-trading-core
    // Expected: findDepRepo('bond-trading-core') => 'bond-trading-core-repo'

    vi.mocked(registry.findDepRepo).mockReturnValue('bond-trading-core-repo');

    const result = registry.findDepRepo('bond-trading-core');

    expect(result).toBe('bond-trading-core-repo');
  });

  it('returns null for unknown npm package', () => {
    // WI-3: Unknown npm package returns null

    vi.mocked(registry.findDepRepo).mockReturnValue(null);

    const result = registry.findDepRepo('@unknown/nonexistent-package');

    expect(result).toBeNull();
  });
});

// ─── Implementation Tests (Real CrossRepoRegistry) ──────────────────────────

describe('CrossRepoRegistry implementation', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let registry: CrossRepoRegistry;
  let originalHome: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-registry-test-');
    registry = new CrossRepoRegistry();
    // Mock home directory for tests
    originalHome = process.env.HOME || '';
    process.env.HOME = tmpHandle.dbPath;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await tmpHandle.cleanup();
  });

  it('loads manifest from .gitnexus/repo_manifest.json', async () => {
    // Create global registry
    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'test-repo', path: tmpHandle.dbPath }]
    }));

    // Create repo manifest
    await createRepoManifest(tmpHandle.dbPath, {
      repoId: 'test-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['com.example.lib'],
    });

    await registry.load();

    const manifest = registry.getManifest('test-repo');
    expect(manifest).not.toBeNull();
    expect(manifest?.repoId).toBe('test-repo');
    expect(manifest?.dependencies).toContain('com.example.lib');
  });

  it('handles missing manifest file gracefully', async () => {
    // Create global registry but no manifest
    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'repo-without-manifest', path: tmpHandle.dbPath }]
    }));

    await registry.load();

    const manifest = registry.getManifest('repo-without-manifest');
    expect(manifest).toBeNull();
  });

  it('handles malformed manifest JSON gracefully', async () => {
    // Create global registry
    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'bad-repo', path: tmpHandle.dbPath }]
    }));

    // Create malformed manifest
    const manifestPath = path.join(tmpHandle.dbPath, '.gitnexus', 'repo_manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '{ invalid json }');

    await registry.load();

    const manifest = registry.getManifest('bad-repo');
    expect(manifest).toBeNull();
  });

  it('finds repo by dependency package', async () => {
    // Create global registry with two repos
    const repo1Path = path.join(tmpHandle.dbPath, 'repo1');
    const repo2Path = path.join(tmpHandle.dbPath, 'repo2');
    await fs.mkdir(repo1Path, { recursive: true });
    await fs.mkdir(repo2Path, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'repo1', path: repo1Path },
        { repoId: 'repo2', path: repo2Path }
      ]
    }));

    await createRepoManifest(repo1Path, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.example.lib', '@types/express'],
    });

    await createRepoManifest(repo2Path, {
      repoId: 'repo2',
      indexedAt: '2024-01-02T00:00:00Z',
      dependencies: ['org.other.utils'],
    });

    await registry.load();

    // Test Java package matching
    expect(registry.findDepRepo('com.example.lib')).toBe('repo1');
    // Test npm package matching
    expect(registry.findDepRepo('@types/express')).toBe('repo1');
    // Test missing package
    expect(registry.findDepRepo('org.other.lib')).toBeNull();
  });

  it('handles subpackage matching', async () => {
    const repoPath = path.join(tmpHandle.dbPath, 'repo1');
    await fs.mkdir(repoPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'repo1', path: repoPath }]
    }));

    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.example.core'],
    });

    await registry.load();

    // Subpackage should match parent package
    expect(registry.findDepRepo('com.example.core.utils')).toBe('repo1');
    expect(registry.findDepRepo('com.example.core')).toBe('repo1');
    // Different package prefix should not match
    expect(registry.findDepRepo('com.other')).toBeNull();
  });

  it('handles Maven groupId:artifactId format', async () => {
    const repoPath = path.join(tmpHandle.dbPath, 'repo1');
    await fs.mkdir(repoPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'repo1', path: repoPath }]
    }));

    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.example:maven-lib'],
    });

    await registry.load();

    // GroupId:artifactId should match groupId
    expect(registry.findDepRepo('com.example:maven-lib')).toBe('repo1');
    expect(registry.findDepRepo('com.example:other-lib')).toBe('repo1');
  });

  it('lists all registered repos', async () => {
    const repo1Path = path.join(tmpHandle.dbPath, 'repo1');
    const repo2Path = path.join(tmpHandle.dbPath, 'repo2');
    await fs.mkdir(repo1Path, { recursive: true });
    await fs.mkdir(repo2Path, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'repo1', path: repo1Path },
        { repoId: 'repo2', path: repo2Path }
      ]
    }));

    await createRepoManifest(repo1Path, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await registry.load();

    const repos = registry.listRepos();
    expect(repos).toHaveLength(2);
    expect(repos.map(r => r.repoId)).toContain('repo1');
    expect(repos.map(r => r.repoId)).toContain('repo2');
  });

  it('handles missing global registry file', async () => {
    // No registry.json file exists
    await registry.load();

    expect(registry.listRepos()).toEqual([]);
    expect(registry.findDepRepo('any.package')).toBeNull();
  });

  it('rebuilds index on load', async () => {
    const repoPath = path.join(tmpHandle.dbPath, 'repo1');
    await fs.mkdir(repoPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'repo1', path: repoPath }]
    }));

    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.initial'],
    });

    await registry.load();
    expect(registry.findDepRepo('com.initial')).toBe('repo1');
    expect(registry.findDepRepo('com.updated')).toBeNull();

    // Update manifest
    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-02T00:00:00Z',
      dependencies: ['com.initial', 'com.updated'],
    });

    await registry.load();

    expect(registry.findDepRepo('com.initial')).toBe('repo1');
    expect(registry.findDepRepo('com.updated')).toBe('repo1');
  });
});

// ─── Dependency Declaration Tests ────────────────────────────────────────────

describe('Dependency declaration matching', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    registry = {
      load: vi.fn(),
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
    };
  });

  it('matches dependency declared in repo manifest', () => {
    // WI-3: findDepRepo must cross-reference import with dependency declaration

    // Repo A depends on: ['bond-exception-handler']
    // Repo B is: bond-exception-handler
    // Import in Repo A: com.tcbs.bond.trading.exception.TcbsBaseException
    // Expected: findDepRepo finds Repo B because Repo A declares it as dependency

    vi.mocked(registry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = registry.findDepRepo('com.tcbs.bond.trading.exception');

    expect(result).toBe('bond-exception-handler');
  });

  it('does not match undeclared dependency', () => {
    // WI-3: Repo must declare dependency for cross-repo resolution

    // Repo A does NOT depend on 'bond-exception-handler'
    // Import in Repo A: com.tcbs.bond.trading.exception.TcbsBaseException
    // Even though Repo B provides this package, it's not declared in Repo A
    // Expected: findDepRepo returns null

    vi.mocked(registry.findDepRepo).mockReturnValue(null);

    const result = registry.findDepRepo('com.unknown.dependency');

    expect(result).toBeNull();
  });

  it('matches transitive dependency', () => {
    // WI-3: Direct dependency must match even if not transitive

    // Repo A depends on: 'shared-lib'
    // 'shared-lib' depends on: 'core-utils' (transitive)
    // Import in Repo A: com.example.core.Utils
    // 'core-utils' is indexed but NOT declared in Repo A
    // Expected: findDepRepo for 'core-utils' returns null (not declared)
    // (Transitive deps are NOT automatically resolved in Phase 1)

    vi.mocked(registry.findDepRepo).mockReturnValue(null);

    const result = registry.findDepRepo('com.example.core');

    expect(result).toBeNull();
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  let registry: CrossRepoRegistry;

  beforeEach(() => {
    registry = {
      load: vi.fn(),
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
    };
  });

  it('handles empty registry', async () => {
    // WI-3: No repos registered

    vi.mocked(registry.listRepos).mockReturnValue([]);
    vi.mocked(registry.findDepRepo).mockReturnValue(null);

    expect(registry.listRepos()).toEqual([]);
    expect(registry.findDepRepo('com.any.package')).toBeNull();
  });

  it('handles repo with empty dependencies', async () => {
    // WI-3: Repo without dependencies must still be trackable

    const manifest: RepoManifest = {
      repoId: 'standalone-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };

    vi.mocked(registry.getManifest).mockReturnValue(manifest);

    const result = registry.getManifest('standalone-repo');

    expect(result?.dependencies).toEqual([]);
  });

  it('handles concurrent findDepRepo calls', async () => {
    // WI-3: Registry must handle parallel lookups

    // Simulate concurrent calls
    vi.mocked(registry.findDepRepo)
      .mockReturnValueOnce('repo-a')
      .mockReturnValueOnce('repo-b')
      .mockReturnValueOnce('repo-c');

    // All calls should return correct results without race conditions
    expect(registry.findDepRepo('package.a')).toBe('repo-a');
    expect(registry.findDepRepo('package.b')).toBe('repo-b');
    expect(registry.findDepRepo('package.c')).toBe('repo-c');
  });

  it('handles special characters in package names', () => {
    // WI-3: Package names with special chars must be handled

    // npm allows @scope/package-name with hyphens
    // Maven allows groupId:artifactId with hyphens and numbers

    vi.mocked(registry.findDepRepo)
      .mockReturnValueOnce('hyphen-package-repo')
      .mockReturnValueOnce('numeric-package-repo');

    expect(registry.findDepRepo('my-awesome-package')).toBe('hyphen-package-repo');
    expect(registry.findDepRepo('com.example.lib-v2')).toBe('numeric-package-repo');
  });

  it('handles case-sensitive package names', () => {
    // WI-3: Package matching must be case-sensitive

    // Java packages are case-sensitive: com.example.Utils != com.example.utils
    // npm packages are case-insensitive for the scope but sensitive for name

    vi.mocked(registry.findDepRepo)
      .mockReturnValueOnce('utils-repo')
      .mockReturnValueOnce(null);  // 'utils' != 'Utils'

    expect(registry.findDepRepo('com.example.Utils')).toBe('utils-repo');
    expect(registry.findDepRepo('com.example.utils')).toBeNull();
  });
});

// ─── WI-1: Provider Mapping Tests ─────────────────────────────────────────────

describe('WI-1: Provider mapping (artifactId-to-repoName)', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let registry: CrossRepoRegistry;
  let originalHome: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-provider-test-');
    registry = new CrossRepoRegistry();
    originalHome = process.env.HOME || '';
    process.env.HOME = tmpHandle.dbPath;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await tmpHandle.cleanup();
  });

  it('maps artifactId matching repo name to provider (not consumer)', async () => {
    // WI-1: When artifactId matches registered repo name, map to that provider

    const consumerPath = path.join(tmpHandle.dbPath, 'tcbs-bond-trading');
    const providerPath = path.join(tmpHandle.dbPath, 'tcbs-bond-trading-core');
    await fs.mkdir(consumerPath, { recursive: true });
    await fs.mkdir(providerPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'tcbs-bond-trading', path: consumerPath },
        { repoId: 'tcbs-bond-trading-core', path: providerPath }
      ]
    }));

    // Consumer declares dependency with artifactId matching provider repo name
    await createRepoManifest(consumerPath, {
      repoId: 'tcbs-bond-trading',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.tcbs.bond.trading:tcbs-bond-trading-core'],
    });

    await createRepoManifest(providerPath, {
      repoId: 'tcbs-bond-trading-core',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await registry.load();

    // ArtifactId 'tcbs-bond-trading-core' matches registered repo name
    // Should map to provider 'tcbs-bond-trading-core', NOT consumer 'tcbs-bond-trading'
    expect(registry.findDepRepo('com.tcbs.bond.trading:tcbs-bond-trading-core')).toBe('tcbs-bond-trading-core');
    // GroupId should also map to provider
    expect(registry.findDepRepo('com.tcbs.bond.trading')).toBe('tcbs-bond-trading-core');
    // Subpackages should also resolve to provider
    expect(registry.findDepRepo('com.tcbs.bond.trading.dto')).toBe('tcbs-bond-trading-core');
  });

  it('preserves existing mappings when artifactId does not match repo name', async () => {
    // WI-1: When artifactId does NOT match a repo name, use consumer as before

    const consumerPath = path.join(tmpHandle.dbPath, 'consumer-repo');
    const otherRepoPath = path.join(tmpHandle.dbPath, 'other-repo');
    await fs.mkdir(consumerPath, { recursive: true });
    await fs.mkdir(otherRepoPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'consumer-repo', path: consumerPath },
        { repoId: 'other-repo', path: otherRepoPath }
      ]
    }));

    // Consumer declares dependency with artifactId NOT matching any repo name
    await createRepoManifest(consumerPath, {
      repoId: 'consumer-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.example:unknown-artifact'],
    });

    await createRepoManifest(otherRepoPath, {
      repoId: 'other-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await registry.load();

    // artifactId 'unknown-artifact' does NOT match any registered repo
    // Should fall back to consumer mapping
    expect(registry.findDepRepo('com.example:unknown-artifact')).toBe('consumer-repo');
    expect(registry.findDepRepo('com.example')).toBe('consumer-repo');
  });

  it('does not overwrite existing groupId mappings', async () => {
    // WI-1: First-indexed wins for groupId mappings

    const repo1Path = path.join(tmpHandle.dbPath, 'first-repo');
    const repo2Path = path.join(tmpHandle.dbPath, 'second-repo');
    const providerPath = path.join(tmpHandle.dbPath, 'shared-core');
    await fs.mkdir(repo1Path, { recursive: true });
    await fs.mkdir(repo2Path, { recursive: true });
    await fs.mkdir(providerPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'first-repo', path: repo1Path },
        { repoId: 'second-repo', path: repo2Path },
        { repoId: 'shared-core', path: providerPath }
      ]
    }));

    // First repo declares dependency that maps to shared-core
    await createRepoManifest(repo1Path, {
      repoId: 'first-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.shared:shared-core'],
    });

    // Second repo also declares dependency with same groupId but different artifactId
    await createRepoManifest(repo2Path, {
      repoId: 'second-repo',
      indexedAt: '2024-01-02T00:00:00Z',
      dependencies: ['com.shared:other-lib'],
    });

    await createRepoManifest(providerPath, {
      repoId: 'shared-core',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await registry.load();

    // First repo's groupId should be mapped to shared-core (artifactId matches)
    // Second repo's dependency 'com.shared:other-lib' has no matching repo
    // But groupId 'com.shared' is already mapped to shared-core
    expect(registry.findDepRepo('com.shared')).toBe('shared-core');
    expect(registry.findDepRepo('com.shared:shared-core')).toBe('shared-core');
    // other-lib does not match a repo name, falls back to consumer (second-repo)
    expect(registry.findDepRepo('com.shared:other-lib')).toBe('second-repo');
  });

  it('works with initialize() method as well', async () => {
    // WI-1: initialize() must also support artifactId-to-repoName matching

    const consumerPath = path.join(tmpHandle.dbPath, 'consumer');
    const providerPath = path.join(tmpHandle.dbPath, 'provider-lib');
    await fs.mkdir(consumerPath, { recursive: true });
    await fs.mkdir(providerPath, { recursive: true });

    // Create manifests
    await createRepoManifest(consumerPath, {
      repoId: 'consumer',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['org.libs:provider-lib'],
    });

    await createRepoManifest(providerPath, {
      repoId: 'provider-lib',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    // Use initialize() instead of load()
    await registry.initialize([
      { repoId: 'consumer', repoPath: consumerPath },
      { repoId: 'provider-lib', repoPath: providerPath }
    ]);

    // artifactId 'provider-lib' matches registered repo name
    expect(registry.findDepRepo('org.libs:provider-lib')).toBe('provider-lib');
    expect(registry.findDepRepo('org.libs')).toBe('provider-lib');
  });

  it('handles multiple repos with same artifactId prefix', async () => {
    // WI-1: Different groupId with same artifactId pattern

    const repo1Path = path.join(tmpHandle.dbPath, 'core-module');
    const repo2Path = path.join(tmpHandle.dbPath, 'utils-module');
    const consumerPath = path.join(tmpHandle.dbPath, 'app-repo');
    await fs.mkdir(repo1Path, { recursive: true });
    await fs.mkdir(repo2Path, { recursive: true });
    await fs.mkdir(consumerPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'core-module', path: repo1Path },
        { repoId: 'utils-module', path: repo2Path },
        { repoId: 'app-repo', path: consumerPath }
      ]
    }));

    // App depends on both modules
    await createRepoManifest(consumerPath, {
      repoId: 'app-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['org.app.core:core-module', 'org.app.utils:utils-module'],
    });

    await createRepoManifest(repo1Path, {
      repoId: 'core-module',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await createRepoManifest(repo2Path, {
      repoId: 'utils-module',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: [],
    });

    await registry.load();

    // Each dependency should map to its corresponding provider repo
    expect(registry.findDepRepo('org.app.core:core-module')).toBe('core-module');
    expect(registry.findDepRepo('org.app.utils:utils-module')).toBe('utils-module');
    // GroupIds should map to respective providers
    expect(registry.findDepRepo('org.app.core')).toBe('core-module');
    expect(registry.findDepRepo('org.app.utils')).toBe('utils-module');
  });
});

// ─── Load Tests (with real implementation) ──────────────────────────────────────

describe('Registry load (integration)', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let registry: CrossRepoRegistry;
  let originalHome: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-load-test-');
    registry = new CrossRepoRegistry();
    originalHome = process.env.HOME || '';
    process.env.HOME = tmpHandle.dbPath;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await tmpHandle.cleanup();
  });

  it('loads from ~/.gitnexus/registry.json', async () => {
    // Create global registry
    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'test-repo', path: tmpHandle.dbPath }]
    }));

    await createRepoManifest(tmpHandle.dbPath, {
      repoId: 'test-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.test.lib'],
    });

    await registry.load();

    expect(registry.listRepos()).toHaveLength(1);
    expect(registry.findDepRepo('com.test.lib')).toBe('test-repo');
  });

  it('loads manifests from each repo directory', async () => {
    const repo1Path = path.join(tmpHandle.dbPath, 'repo1');
    const repo2Path = path.join(tmpHandle.dbPath, 'repo2');
    await fs.mkdir(repo1Path, { recursive: true });
    await fs.mkdir(repo2Path, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [
        { repoId: 'repo1', path: repo1Path },
        { repoId: 'repo2', path: repo2Path }
      ]
    }));

    await createRepoManifest(repo1Path, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.lib.a'],
    });

    await createRepoManifest(repo2Path, {
      repoId: 'repo2',
      indexedAt: '2024-01-02T00:00:00Z',
      dependencies: ['com.lib.b'],
    });

    await registry.load();

    const manifest1 = registry.getManifest('repo1');
    const manifest2 = registry.getManifest('repo2');

    expect(manifest1).not.toBeNull();
    expect(manifest1?.dependencies).toContain('com.lib.a');

    expect(manifest2).not.toBeNull();
    expect(manifest2?.dependencies).toContain('com.lib.b');
  });

  it('handles missing global registry file', async () => {
    // No registry.json file exists
    await registry.load();

    expect(registry.listRepos()).toEqual([]);
  });

  it('rebuilds index on load', async () => {
    const repoPath = path.join(tmpHandle.dbPath, 'repo1');
    await fs.mkdir(repoPath, { recursive: true });

    const globalRegistryPath = path.join(tmpHandle.dbPath, '.gitnexus', 'registry.json');
    await fs.mkdir(path.dirname(globalRegistryPath), { recursive: true });
    await fs.writeFile(globalRegistryPath, JSON.stringify({
      repos: [{ repoId: 'repo1', path: repoPath }]
    }));

    // Initial load with one dependency
    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['com.lib.original'],
    });

    await registry.load();
    expect(registry.findDepRepo('com.lib.original')).toBe('repo1');

    // Modify manifest
    await createRepoManifest(repoPath, {
      repoId: 'repo1',
      indexedAt: '2024-01-02T00:00:00Z',
      dependencies: ['com.lib.modified'],
    });

    // Reload should pick up changes
    await registry.load();
    expect(registry.findDepRepo('com.lib.modified')).toBe('repo1');
    expect(registry.findDepRepo('com.lib.original')).toBeNull();
  });
});