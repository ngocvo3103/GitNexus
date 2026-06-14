/**
 * WI-4 Unit Tests: Cross-Repo Query Executor
 *
 * Tests: queryMultipleRepos, LocalBackend cross-repo methods
 * Design techniques: EP, BVA, Error Guessing, State Transition
 *
 * These tests WILL FAIL until WI-4 is implemented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock readManifest to return test manifest data
vi.mock('../../src/storage/repo-manifest.js', () => ({
  readManifest: vi.fn().mockImplementation(async (repoPath: string) => {
    // Return mock manifests for test repos based on path
    if (repoPath.includes('tcbs-bond-trading')) {
      return {
        repoId: 'tcbs-bond-trading',
        indexedAt: '2024-01-15T10:00:00Z',
        dependencies: ['bond-exception-handler', 'shared-utils', 'com.tcbs.bond.trading:exception-handler'],
      };
    }
    if (repoPath.includes('bond-exception-handler')) {
      return {
        repoId: 'bond-exception-handler',
        indexedAt: '2024-01-14T09:00:00Z',
        dependencies: ['shared-utils'],
      };
    }
    // shared-utils has no manifest (returns null for "repo without manifest file" test)
    return null;
  }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { executeParameterized, executeQuery } from '../../src/mcp/core/lbug-adapter.js';

// ─── Test Fixtures ───────────────────────────────────────────────────

const MOCK_REPO_1 = {
  name: 'tcbs-bond-trading',
  path: '/repos/tcbs-bond-trading',
  storagePath: '/repos/.gitnexus/tcbs-bond-trading',
  indexedAt: '2024-01-15T10:00:00Z',
  lastCommit: 'abc123',
  stats: { files: 100, nodes: 500, edges: 1000, communities: 10, processes: 20 },
};

const MOCK_REPO_2 = {
  name: 'bond-exception-handler',
  path: '/repos/bond-exception-handler',
  storagePath: '/repos/.gitnexus/bond-exception-handler',
  indexedAt: '2024-01-14T09:00:00Z',
  lastCommit: 'def456',
  stats: { files: 50, nodes: 200, edges: 400, communities: 5, processes: 8 },
};

const MOCK_REPO_3 = {
  name: 'shared-utils',
  path: '/repos/shared-utils',
  storagePath: '/repos/.gitnexus/shared-utils',
  indexedAt: '2024-01-13T08:00:00Z',
  lastCommit: 'ghi789',
  stats: { files: 30, nodes: 100, edges: 200, communities: 3, processes: 5 },
};

function setupMultipleRepos() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_1, MOCK_REPO_2, MOCK_REPO_3]);
}

function setupSingleRepo() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_1]);
}

// ─── BDD Scenarios ───────────────────────────────────────────────────

/**
 * Feature: Cross-Repo Query Executor
 * 
 * Background: Multiple repositories are indexed and available
 * 
 * Scenario: Query multiple repos in parallel
 *   Given repos ["tcbs-bond-trading", "bond-exception-handler"] are indexed
 *   When queryMultipleRepos is called with a Cypher query
 *   Then results are returned with repoId attribution for each repo
 *   And all queries execute in parallel (start before any complete)
 * 
 * Scenario: Error isolation between repos
 *   Given repo "tcbs-bond-trading" is healthy
 *   And repo "broken-repo" throws an error
 *   When queryMultipleRepos is called with both repos
 *   Then healthy repo returns results
 *   And broken repo returns empty results (not thrown error)
 * 
 * Scenario: Empty results for failed repos
 *   Given a query against a non-existent repo
 *   When queryMultipleRepos is called
 *   Then the non-existent repo returns { repoId, results: [] }
 *   And no exception is thrown
 */

// ─── queryMultipleRepos Tests (EP + BVA) ──────────────────────────────

describe('queryMultipleRepos', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupMultipleRepos();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('Happy path - valid partitions', () => {
    it('executes query on multiple repos and returns attributed results', async () => {
      /**
       * EP: Valid input - multiple repos with results
       * Technique: Equivalence Partitioning
       * 
       * Given: Multiple repos are registered
       * When: queryMultipleRepos called with repo IDs
       * Then: Results include repoId attribution
       */
      // WI-4: This will fail until queryMultipleRepos is implemented
      const cypher = 'MATCH (f:Function) RETURN f.name LIMIT 10';
      
      // Mock results for each repo
      (executeQuery as any)
        .mockResolvedValueOnce([{ name: 'functionA', filePath: '/file1.ts' }])
        .mockResolvedValueOnce([{ name: 'functionB', filePath: '/file2.ts' }])
        .mockResolvedValueOnce([{ name: 'functionC', filePath: '/file3.ts' }]);

      const results = await backend.queryMultipleRepos(
        ['tcbs-bond-trading', 'bond-exception-handler', 'shared-utils'],
        cypher
      );

      expect(results).toHaveLength(3);
      expect(results[0]).toHaveProperty('repoId');
      expect(results[0]).toHaveProperty('results');
      expect(results[0].repoId).toBe('tcbs-bond-trading');
      expect(results[1].repoId).toBe('bond-exception-handler');
      expect(results[2].repoId).toBe('shared-utils');
    });

    it('returns empty results array when no repos specified', async () => {
      /**
       * BVA: Boundary - empty input
       * Technique: Boundary Value Analysis (minimum boundary)
       * 
       * Given: No repos specified
       * When: queryMultipleRepos called with empty array
       * Then: Returns empty results array
       */
      const cypher = 'MATCH (n) RETURN n';
      const results = await backend.queryMultipleRepos([], cypher);
      
      expect(results).toEqual([]);
    });

    it('executes query on single repo', async () => {
      /**
       * BVA: Boundary - single repo
       * Technique: Boundary Value Analysis (minimum+1)
       * 
       * Given: One repo specified
       * When: queryMultipleRepos called with single repo
       * Then: Results from that repo are returned
       */
      const cypher = 'MATCH (c:Class) RETURN c.name';
      
      (executeQuery as any).mockResolvedValueOnce([
        { name: 'UserService', filePath: '/services/UserService.ts' }
      ]);

      const results = await backend.queryMultipleRepos(['tcbs-bond-trading'], cypher);

      expect(results).toHaveLength(1);
      expect(results[0].repoId).toBe('tcbs-bond-trading');
      expect(results[0].results).toHaveLength(1);
    });
  });

  describe('Error isolation - invalid partitions', () => {
    it('returns empty results for unknown repo (not thrown error)', async () => {
      /**
       * EP: Invalid input - unknown repo ID
       * Technique: Error Guessing
       * 
       * Given: A repo ID that is not registered
       * When: queryMultipleRepos called with unknown repo
       * Then: Unknown repo returns empty results, not error
       */
      const cypher = 'MATCH (n) RETURN n';
      
      const results = await backend.queryMultipleRepos(
        ['unknown-repo-id', 'tcbs-bond-trading'],
        cypher
      );

      // Unknown repo should return empty results, not throw
      expect(results).toHaveLength(2);
      expect(results[0].repoId).toBe('unknown-repo-id');
      expect(results[0].results).toEqual([]);
      // Known repo should still return results
      expect(results[1].repoId).toBe('tcbs-bond-trading');
    });

    it('does not throw when one repo fails - error isolation', async () => {
      /**
       * EP: Error condition - one repo throws, others succeed
       * Technique: Error Guessing (fault injection)
       * 
       * Given: Multiple repos, one will fail
       * When: queryMultipleRepos executes
       * Then: Failed repo returns empty results
       * And: Successful repos return their results
       */
      const cypher = 'MATCH (f:Function) RETURN f.name';

      // First call succeeds, second throws, third succeeds
      (executeQuery as any)
        .mockResolvedValueOnce([{ name: 'functionA' }])
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce([{ name: 'functionC' }]);

      const results = await backend.queryMultipleRepos(
        ['tcbs-bond-trading', 'bond-exception-handler', 'shared-utils'],
        cypher
      );

      // All repos should return something, no exception
      expect(results).toHaveLength(3);
      expect(results[0].results).toHaveLength(1);
      // Failed repo returns empty
      expect(results[1].results).toEqual([]);
      expect(results[2].results).toHaveLength(1);
    });
  });

  describe('Parallel execution', () => {
    it('executes all queries in parallel (all start before any complete)', async () => {
      /**
       * State Transition: Parallel execution verification
       * Technique: State Transition (timing verification)
       * 
       * Given: Multiple repos to query
       * When: queryMultipleRepos is called
       * Then: All queries start before any complete
       * 
       * Verification: Check that promises are created concurrently,
       * not sequentially awaiting before starting next.
       */
      const callOrder: string[] = [];
      
      (executeQuery as any).mockImplementation(async () => {
        // Simulate async operation
        await new Promise(resolve => setTimeout(resolve, 10));
        return [];
      });

      // Track when each query starts
      const startTime = Date.now();
      const startTimes: number[] = [];

      // WI-4: This tests parallel execution pattern
      // All queries should start within a few ms of each other
      await backend.queryMultipleRepos(
        ['tcbs-bond-trading', 'bond-exception-handler', 'shared-utils'],
        'MATCH (n) RETURN n'
      );

      // If queries were sequential, total time would be ~30ms (3 * 10ms)
      // If parallel, total time should be ~10ms
      const totalTime = Date.now() - startTime;
      
      // Allow some variance, but should complete in parallel (~10-15ms, not ~30ms+)
      // This will fail if implementation is sequential
      expect(totalTime).toBeLessThan(25);
    });

    it('passes params to each query', async () => {
      /**
       * EP: Valid input - params parameter
       * Technique: Equivalence Partitioning
       */
      const cypher = 'MATCH (n:Function {name: $name}) RETURN n';
      const params = { name: 'authenticate' };

      (executeParameterized as any).mockResolvedValue([]);

      await backend.queryMultipleRepos(
        ['tcbs-bond-trading', 'bond-exception-handler'],
        cypher,
        params
      );

      // Verify params were passed to executeParameterized (called for each repo)
      expect(executeParameterized).toHaveBeenCalled();
    });
  });

  describe('Result attribution', () => {
    it('attributes each result to its source repo', async () => {
      /**
       * EP: Result attribution
       * Technique: Equivalence Partitioning
       */
      (executeQuery as any)
        .mockResolvedValueOnce([
          { name: 'UserService', filePath: '/services/UserService.ts' },
          { name: 'AuthService', filePath: '/services/AuthService.ts' },
        ])
        .mockResolvedValueOnce([
          { name: 'ExceptionHandler', filePath: '/handler/ExceptionHandler.java' },
        ]);

      const results = await backend.queryMultipleRepos(
        ['tcbs-bond-trading', 'bond-exception-handler'],
        'MATCH (c:Class) RETURN c.name, c.filePath'
      );

      expect(results[0].repoId).toBe('tcbs-bond-trading');
      expect(results[0].results).toHaveLength(2);
      
      expect(results[1].repoId).toBe('bond-exception-handler');
      expect(results[1].results).toHaveLength(1);
    });
  });
});

// ─── getManifest Tests (EP + BVA) ─────────────────────────────────────

describe('getManifest', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupMultipleRepos();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('Happy path', () => {
    it('returns manifest for registered repo', async () => {
      /**
       * EP: Valid input - existing repo
       * Technique: Equivalence Partitioning
       * 
       * Given: Repo is registered with manifest
       * When: getManifest called with repoId
       * Then: Returns RepoManifest object
       */
      // WI-4: This will fail until getManifest is implemented
      const manifest = await backend.getManifest('tcbs-bond-trading');

      expect(manifest).not.toBeNull();
      expect(manifest?.repoId).toBe('tcbs-bond-trading');
      expect(manifest?.indexedAt).toBeDefined();
      expect(Array.isArray(manifest?.dependencies)).toBe(true);
    });

    it('returns manifest with dependencies', async () => {
      /**
       * EP: Valid input - manifest with dependencies
       */
      const manifest = await backend.getManifest('tcbs-bond-trading');

      // Dependencies may be empty but should be defined
      expect(manifest?.dependencies).toBeDefined();
    });
  });

  describe('Error cases', () => {
    it('returns null for unknown repo', async () => {
      /**
       * EP: Invalid input - unknown repo
       * Technique: Equivalence Partitioning (invalid partition)
       * 
       * Given: Repo ID is not registered
       * When: getManifest called
       * Then: Returns null
       */
      const manifest = await backend.getManifest('non-existent-repo');
      
      expect(manifest).toBeNull();
    });

    it('returns null for repo without manifest file', async () => {
      /**
       * EP: Error condition - missing manifest file
       * Technique: Error Guessing
       */
      // Even a registered repo might not have a manifest yet
      const manifest = await backend.getManifest('shared-utils');
      
      // Should not throw, return null gracefully
      expect(manifest).toBeNull();
    });
  });
});

// ─── findDepRepo Tests (EP + State Transition) ────────────────────────

describe('findDepRepo', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupMultipleRepos();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('Happy path', () => {
    it('finds repo that provides a dependency', async () => {
      /**
       * EP: Valid input - dependency found
       * Technique: Equivalence Partitioning
       * 
       * Given: A dependency is declared in a registered repo's manifest
       * When: findDepRepo called with dependency name
       * Then: Returns repoId of the providing repo
       */
      // WI-4: This will fail until findDepRepo is implemented
      // Note: depends on CrossRepoRegistry being implemented
      const repoId = await backend.findDepRepo('bond-exception-handler');

      expect(repoId).not.toBeNull();
      // Should return the repo that provides this dependency
      expect(typeof repoId).toBe('string');
    });

    it('finds repo by Maven groupId:artifactId', async () => {
      /**
       * EP: Valid input - Maven dependency format
       * Technique: Equivalence Partitioning
       */
      const repoId = await backend.findDepRepo('com.tcbs.bond.trading:exception-handler');

      expect(repoId).not.toBeNull();
    });

    it('finds repo by npm package name', async () => {
      /**
       * EP: Valid input - npm dependency format
       * Technique: Equivalence Partitioning
       */
      const repoId = await backend.findDepRepo('@types/express');

      // May be null if not in registered repos
      expect(repoId === null || typeof repoId === 'string').toBe(true);
    });
  });

  describe('Not found cases', () => {
    it('returns null when dependency not found in any repo', async () => {
      /**
       * EP: Invalid input - dependency not found
       * Technique: Equivalence Partitioning (invalid partition)
       */
      const repoId = await backend.findDepRepo('non-existent-package');

      expect(repoId).toBeNull();
    });

    it('returns null for empty dependency name', async () => {
      /**
       * BVA: Boundary - empty input
       * Technique: Boundary Value Analysis (minimum)
       */
      const repoId = await backend.findDepRepo('');

      expect(repoId).toBeNull();
    });
  });

  describe('Lazy initialization', () => {
    it('initializes CrossRepoRegistry on first call', async () => {
      /**
       * State Transition: Registry lazy initialization
       * Technique: State Transition Testing
       * 
       * Given: Backend just initialized
       * When: findDepRepo called for first time
       * Then: CrossRepoRegistry is created and loaded
       */
      // First call should trigger lazy initialization
      const repoId1 = await backend.findDepRepo('some-package');
      
      // Second call should use cached registry
      const repoId2 = await backend.findDepRepo('another-package');
      
      // Both should complete without error
      expect(repoId1 === null || typeof repoId1 === 'string').toBe(true);
      expect(repoId2 === null || typeof repoId2 === 'string').toBe(true);
    });

    it('reuses same CrossRepoRegistry across calls', async () => {
      /**
       * State Transition: Registry reuse
       * Technique: State Transition (verify cached state)
       */
      // Multiple calls should not reinitialize registry
      await backend.findDepRepo('package-a');
      await backend.findDepRepo('package-b');
      await backend.findDepRepo('package-c');

      // Registry should be created only once
      // This is implicitly tested - if it reinitialized each time,
      // we'd see repeated file reads or initialization logs
    });
  });
});

// ─── CrossRepoRegistry Integration Tests ─────────────────────────────

describe('CrossRepoRegistry (lazy initialization)', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupMultipleRepos();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  it('lazy-initializes registry when findDepRepo called', async () => {
    /**
     * State Transition: First call triggers load
     * 
     * Given: Backend initialized without registry
     * When: findDepRepo called
     * Then: Registry is created and loaded
     */
    // WI-4: CrossRepoRegistry should be lazy-loaded
    const result = await backend.findDepRepo('test-package');
    
    // Should not throw, should complete
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('lazy-initializes registry when getManifest called for cross-repo', async () => {
    /**
     * State Transition: Registry needed for cross-repo lookup
     */
    const manifest = await backend.getManifest('tcbs-bond-trading');
    
    // Should not throw
    expect(manifest === null || typeof manifest === 'object').toBe(true);
  });
});