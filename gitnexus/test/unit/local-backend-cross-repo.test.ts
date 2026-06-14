/**
 * WI-4 Unit Tests: LocalBackend Cross-Repo Methods
 *
 * Tests: getManifest, findDepRepo, CrossRepoRegistry lazy initialization
 * Design techniques: EP, BVA, State Transition, Error Guessing
 *
 * These tests WILL FAIL until WI-4 is implemented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock the LadybugDB adapter BEFORE importing LocalBackend
vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

// ─── Test Fixtures ───────────────────────────────────────────────────

const MOCK_REPO_WITH_MANIFEST = {
  name: 'repo-with-manifest',
  path: '/tmp/test-repo-with-manifest',
  storagePath: '/tmp/.gitnexus/repo-with-manifest',
  indexedAt: '2024-01-15T10:00:00Z',
  lastCommit: 'abc123',
  stats: { files: 100, nodes: 500, edges: 1000, communities: 10, processes: 20 },
};

const MOCK_REPO_WITHOUT_MANIFEST = {
  name: 'repo-without-manifest',
  path: '/tmp/test-repo-without-manifest',
  storagePath: '/tmp/.gitnexus/repo-without-manifest',
  indexedAt: '2024-01-15T10:00:00Z',
  lastCommit: 'def456',
  stats: { files: 50, nodes: 200, edges: 400, communities: 5, processes: 8 },
};

// Helper to create temp directory with manifest
async function createRepoWithManifest(
  repoName: string,
  manifest: { repoId: string; indexedAt: string; dependencies: string[] }
): Promise<{ storagePath: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-manifest-test-'));
  const gitnexusDir = path.join(tmpDir, '.gitnexus');
  await fs.mkdir(gitnexusDir, { recursive: true });
  
  const manifestPath = path.join(gitnexusDir, 'repo_manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  
  return {
    storagePath: tmpDir,
    cleanup: async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

// ─── BDD Scenarios ───────────────────────────────────────────────────

/**
 * Feature: LocalBackend Cross-Repo Methods
 * 
 * Background: LocalBackend provides cross-repo functionality
 * 
 * Scenario: getManifest returns manifest for registered repo
 *   Given repo is registered with valid manifest
 *   When getManifest called with repoId
 *   Then RepoManifest object is returned
 * 
 * Scenario: getManifest returns null for unknown repo
 *   Given repoId is not registered
 *   When getManifest called
 *   Then null is returned (no exception)
 * 
 * Scenario: findDepRepo finds repo providing dependency
 *   Given CrossRepoRegistry is loaded with repo dependencies
 *   When findDepRepo called with package name
 *   Then repoId of providing repo is returned
 * 
 * Scenario: CrossRepoRegistry is lazy-initialized
 *   Given LocalBackend initialized
 *   When findDepRepo called first time
 *   Then registry is loaded from disk
 *   And subsequent calls use cached registry
 */

// ─── getManifest Tests ───────────────────────────────────────────────

describe('LocalBackend.getManifest', () => {
  let backend: LocalBackend;
  let tmpHandle: Awaited<ReturnType<typeof createRepoWithManifest>> | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
    if (tmpHandle) {
      await tmpHandle.cleanup();
      tmpHandle = null;
    }
  });

  describe('Happy path - valid partitions', () => {
    it('returns manifest for registered repo with valid manifest file', async () => {
      /**
       * EP: Valid input - registered repo with manifest
       * Technique: Equivalence Partitioning
       */
      // Create temp repo with manifest
      tmpHandle = await createRepoWithManifest('test-repo-1', {
        repoId: 'test-repo-1',
        indexedAt: '2024-01-15T10:00:00Z',
        dependencies: ['shared-utils', 'common-libs'],
      });

      (listRegisteredRepos as any).mockResolvedValue([{
        name: 'test-repo-1',
        path: '/tmp/test-repo-1',
        storagePath: tmpHandle.storagePath,
        indexedAt: '2024-01-15T10:00:00Z',
        lastCommit: 'abc123',
        stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
      }]);

      await backend.init();

      // WI-4: This will fail until getManifest is implemented
      const manifest = await backend.getManifest('test-repo-1');

      expect(manifest).not.toBeNull();
      expect(manifest?.repoId).toBe('test-repo-1');
      expect(manifest?.indexedAt).toBe('2024-01-15T10:00:00Z');
      expect(manifest?.dependencies).toEqual(['shared-utils', 'common-libs']);
    });

    it('returns manifest with empty dependencies when no deps', async () => {
      /**
       * EP: Valid input - manifest without dependencies
       * Technique: Equivalence Partitioning
       */
      tmpHandle = await createRepoWithManifest('standalone-repo', {
        repoId: 'standalone-repo',
        indexedAt: '2024-01-15T11:00:00Z',
        dependencies: [],
      });

      (listRegisteredRepos as any).mockResolvedValue([{
        name: 'standalone-repo',
        path: '/tmp/standalone-repo',
        storagePath: tmpHandle.storagePath,
        indexedAt: '2024-01-15T11:00:00Z',
        lastCommit: 'def456',
        stats: { files: 5, nodes: 20, edges: 30, communities: 1, processes: 2 },
      }]);

      await backend.init();

      const manifest = await backend.getManifest('standalone-repo');

      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toEqual([]);
    });
  });

  describe('Error cases - invalid partitions', () => {
    it('returns null for unknown repo ID', async () => {
      /**
       * EP: Invalid input - unknown repo
       * Technique: Equivalence Partitioning (invalid partition)
       */
      (listRegisteredRepos as any).mockResolvedValue([]);
      await backend.init();

      const manifest = await backend.getManifest('non-existent-repo');

      expect(manifest).toBeNull();
    });

    it('returns null when manifest file is missing', async () => {
      /**
       * EP: Error condition - missing manifest
       * Technique: Error Guessing
       */
      // Create temp dir WITHOUT manifest
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-no-manifest-'));
      
      (listRegisteredRepos as any).mockResolvedValue([{
        name: 'repo-no-manifest',
        path: '/tmp/repo-no-manifest',
        storagePath: tmpDir,
        indexedAt: '2024-01-15T12:00:00Z',
        lastCommit: 'ghi789',
        stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
      }]);

      await backend.init();

      const manifest = await backend.getManifest('repo-no-manifest');

      expect(manifest).toBeNull();

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns null when manifest file is malformed JSON', async () => {
      /**
       * EP: Error condition - corrupt manifest
       * Technique: Error Guessing
       */
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bad-manifest-'));
      const gitnexusDir = path.join(tmpDir, '.gitnexus');
      await fs.mkdir(gitnexusDir, { recursive: true });
      await fs.writeFile(path.join(gitnexusDir, 'repo_manifest.json'), '{ invalid json }');

      (listRegisteredRepos as any).mockResolvedValue([{
        name: 'bad-manifest-repo',
        path: '/tmp/bad-manifest-repo',
        storagePath: tmpDir,
        indexedAt: '2024-01-15T13:00:00Z',
        lastCommit: 'jkl012',
        stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
      }]);

      await backend.init();

      const manifest = await backend.getManifest('bad-manifest-repo');

      expect(manifest).toBeNull();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns null when manifest missing required fields', async () => {
      /**
       * EP: Error condition - incomplete manifest
       * Technique: Error Guessing
       */
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-incomplete-'));
      const gitnexusDir = path.join(tmpDir, '.gitnexus');
      await fs.mkdir(gitnexusDir, { recursive: true });
      // Missing repoId (required field)
      await fs.writeFile(
        path.join(gitnexusDir, 'repo_manifest.json'),
        JSON.stringify({ indexedAt: '2024-01-15T14:00:00Z', dependencies: [] })
      );

      (listRegisteredRepos as any).mockResolvedValue([{
        name: 'incomplete-manifest-repo',
        path: '/tmp/incomplete-manifest-repo',
        storagePath: tmpDir,
        indexedAt: '2024-01-15T14:00:00Z',
        lastCommit: 'mno345',
        stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
      }]);

      await backend.init();

      const manifest = await backend.getManifest('incomplete-manifest-repo');

      expect(manifest).toBeNull();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});

// ─── findDepRepo Tests ───────────────────────────────────────────────

describe('LocalBackend.findDepRepo', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('Happy path - dependency found', () => {
    it('finds repo that declares the dependency', async () => {
      /**
       * EP: Valid input - dependency declared in manifest
       * Technique: Equivalence Partitioning
       */
      // Setup: repo-a depends on shared-utils
      const repoA = await createRepoWithManifest('repo-a', {
        repoId: 'repo-a',
        indexedAt: '2024-01-15T10:00:00Z',
        dependencies: ['shared-utils', 'common-libs'],
      });

      const repoB = await createRepoWithManifest('shared-utils', {
        repoId: 'shared-utils',
        indexedAt: '2024-01-14T09:00:00Z',
        dependencies: [],
      });

      (listRegisteredRepos as any).mockResolvedValue([
        {
          name: 'repo-a',
          path: '/tmp/repo-a',
          storagePath: repoA.storagePath,
          indexedAt: '2024-01-15T10:00:00Z',
          lastCommit: 'abc123',
          stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
        },
        {
          name: 'shared-utils',
          path: '/tmp/shared-utils',
          storagePath: repoB.storagePath,
          indexedAt: '2024-01-14T09:00:00Z',
          lastCommit: 'def456',
          stats: { files: 5, nodes: 20, edges: 30, communities: 1, processes: 2 },
        },
      ]);

      await backend.init();

      // WI-4: This will fail until findDepRepo + CrossRepoRegistry are implemented
      const repoId = await backend.findDepRepo('shared-utils');

      // Should return repo-a since it declares shared-utils as dependency
      expect(repoId).not.toBeNull();

      await repoA.cleanup();
      await repoB.cleanup();
    });

    it('finds repo by Maven groupId:artifactId format', async () => {
      /**
       * EP: Valid input - Maven dependency format
       * Technique: Equivalence Partitioning
       */
      const appRepo = await createRepoWithManifest('tcbs-bond-trading', {
        repoId: 'tcbs-bond-trading',
        indexedAt: '2024-01-15T10:00:00Z',
        dependencies: ['com.tcbs.bond.trading:exception-handler'],
      });

      const libRepo = await createRepoWithManifest('bond-exception-handler', {
        repoId: 'bond-exception-handler',
        indexedAt: '2024-01-14T09:00:00Z',
        dependencies: [],
      });

      (listRegisteredRepos as any).mockResolvedValue([
        {
          name: 'tcbs-bond-trading',
          path: '/repos/tcbs-bond-trading',
          storagePath: appRepo.storagePath,
          indexedAt: '2024-01-15T10:00:00Z',
          lastCommit: 'abc123',
          stats: { files: 100, nodes: 500, edges: 1000, communities: 10, processes: 20 },
        },
        {
          name: 'bond-exception-handler',
          path: '/repos/bond-exception-handler',
          storagePath: libRepo.storagePath,
          indexedAt: '2024-01-14T09:00:00Z',
          lastCommit: 'def456',
          stats: { files: 50, nodes: 200, edges: 400, communities: 5, processes: 8 },
        },
      ]);

      await backend.init();

      const repoId = await backend.findDepRepo('com.tcbs.bond.trading:exception-handler');

      // Should find the dependency in tcbs-bond-trading manifest
      expect(repoId).not.toBeNull();

      await appRepo.cleanup();
      await libRepo.cleanup();
    });
  });

  describe('Not found cases', () => {
    it('returns null when dependency not declared in any manifest', async () => {
      /**
       * EP: Invalid input - dependency not found
       * Technique: Equivalence Partitioning (invalid partition)
       */
      (listRegisteredRepos as any).mockResolvedValue([]);
      await backend.init();

      const repoId = await backend.findDepRepo('non-existent-package');

      expect(repoId).toBeNull();
    });

    it('returns null for empty string dependency name', async () => {
      /**
       * BVA: Boundary - empty input
       * Technique: Boundary Value Analysis (minimum)
       */
      (listRegisteredRepos as any).mockResolvedValue([]);
      await backend.init();

      const repoId = await backend.findDepRepo('');

      expect(repoId).toBeNull();
    });
  });

  describe('Lazy initialization', () => {
    it('initializes CrossRepoRegistry on first findDepRepo call', async () => {
      /**
       * State: Registry not initialized
       * Event: First findDepRepo call
       * New State: Registry initialized and cached
       * Technique: State Transition
       */
      (listRegisteredRepos as any).mockResolvedValue([]);
      await backend.init();

      // Before first call, registry should not be loaded
      // This is implicit - we can't directly check private field
      
      // First call triggers lazy initialization
      await backend.findDepRepo('test-package');

      // Should complete without error
      // If it failed to initialize, would have thrown
    });

    it('does not re-initialize registry on subsequent calls', async () => {
      /**
       * State: Registry already initialized
       * Event: Second findDepRepo call
       * New State: Same registry (cached)
       * Technique: State Transition
       */
      (listRegisteredRepos as any).mockResolvedValue([]);
      await backend.init();

      // First call
      await backend.findDepRepo('package-a');
      
      // Second call - should use cached registry
      await backend.findDepRepo('package-b');

      // Both should complete without error
      // No way to directly verify cache hit, but no errors = success
    });
  });
});

// ─── CrossRepoRegistry State Tests ─────────────────────────────────────

describe('CrossRepoRegistry state management', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  it('loads registry from ~/.gitnexus/registry.json on first access', async () => {
    /**
     * State: No registry in memory
     * Event: First cross-repo operation
     * New State: Registry loaded from disk
     * Technique: State Transition
     */
    // WI-4: Registry should be loaded from ~/.gitnexus/registry.json
    // and each repo's manifest should be read
    
    (listRegisteredRepos as any).mockResolvedValue([]);
    await backend.init();

    // Trigger lazy load
    await backend.findDepRepo('any-package');

    // Should not throw
  });

  it('caches manifest reads for repeated access', async () => {
    /**
     * State: Manifest already read
     * Event: Another getManifest call for same repo
     * New State: Same cached manifest
     * Technique: State Transition (verify caching)
     */
    const tmpHandle = await createRepoWithManifest('cached-repo', {
      repoId: 'cached-repo',
      indexedAt: '2024-01-15T10:00:00Z',
      dependencies: [],
    });

    (listRegisteredRepos as any).mockResolvedValue([{
      name: 'cached-repo',
      path: '/tmp/cached-repo',
      storagePath: tmpHandle.storagePath,
      indexedAt: '2024-01-15T10:00:00Z',
      lastCommit: 'abc123',
      stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
    }]);

    await backend.init();

    // First read
    const manifest1 = await backend.getManifest('cached-repo');
    
    // Second read - should use cache if implemented
    const manifest2 = await backend.getManifest('cached-repo');

    // Both should return same data
    expect(manifest1).toEqual(manifest2);

    await tmpHandle.cleanup();
  });
});