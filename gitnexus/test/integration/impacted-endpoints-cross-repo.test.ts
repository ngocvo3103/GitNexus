/**
 * E2E Integration Tests: impacted_endpoints — Cross-Repo Scenarios
 *
 * Tests cross-repo impact detection using a combined seed that has both
 * consumer and library data in a single graph, with File→File IMPORTS
 * edges bridging them.
 *
 * The cross-repo flow works as follows:
 * 1. Git diff reports changed files in the current repo
 * 2. BFS finds changed symbols and traverses upstream edges
 * 3. CrossRepoResolver (step 3c) finds files that IMPORT the changed files
 * 4. Symbols from importing files are added to the BFS frontier
 * 5. BFS continues to discover routes via those symbols
 * 6. `_triggered_by` and confidence attribution are added for cross-repo discoveries
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  IMPACTED_ENDPOINTS_CROSS_REPO_CONSUMER_SEED,
  IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED,
  IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED,
  IMPACTED_ENDPOINTS_FTS_INDEXES,
  IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_FTS_INDEXES,
} from '../fixtures/impacted-endpoints-seed.js';
import type { CrossRepoContext } from '../../src/mcp/local/cross-repo-context.js';

interface ImpactedEndpointsResult {
  summary: { changed_files: Record<string, number>; changed_symbols: number; impacted_endpoints: Record<string, number>; risk_level: string };
  impacted_endpoints: { WILL_BREAK: any[]; LIKELY_AFFECTED: any[]; MAY_NEED_TESTING: any[] };
  changed_symbols: any[];
  affected_processes: any[];
  affected_modules: any[];
  _meta: { version: string; generated_at: string };
  error?: string;
}

/** Build a realistic `git diff --unified=0` output string for testing. */
function buildUnifiedDiff(filePath: string, hunks: Array<{ newStart: number; newCount: number }>): string {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const hunk of hunks) {
    const oldStart = hunk.newStart;
    const oldCount = hunk.newCount;
    lines.push(`@@ -${oldStart},${oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (let i = 0; i < hunk.newCount; i++) {
      lines.push(`+changed line ${hunk.newStart + i}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Mock execFileSync for single-file diffs. */
function mockGitDiff(filePath: string, hunks: Array<{ newStart: number; newCount: number }>): void {
  vi.mocked(execFileSync as any).mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--unified=0')) {
      return buildUnifiedDiff(filePath, hunks);
    }
    if (args.includes('--name-only')) {
      return `${filePath}\n`;
    }
    return '';
  });
}

/** Create a mock CrossRepoContext that lists shared-libs as a dependency. */
function createMockCrossRepoContext(
  queryFn?: (repoIds: string[], query: string, params: Record<string, unknown>) => Promise<Array<{ repoId: string; results: unknown[] }>>,
): CrossRepoContext {
  return {
    findDepRepo: async (prefix: string) => 'shared-libs',
    queryMultipleRepos: queryFn ?? (async () => []),
    listDepRepos: async () => ['shared-libs'],
  };
}

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';

// ═══════════════════════════════════════════════════════════════════════════
// Tests using IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED (consumer + library)
// ═══════════════════════════════════════════════════════════════════════════
describe('Cross-repo E2E: combined seed', () => {
  let backend: LocalBackend;

  withTestLbugDB('cr-combined', (handle) => {
    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) {
        throw new Error('LocalBackend not initialized');
      }
      backend = ext._backend;
    });

    // ── E2E-CR02: Change service method → consumer endpoint via CALLS chain ──
    it('E2E-CR02: discovers consumer endpoints when UserService.java changes via CALLS chain', async () => {
      mockGitDiff('UserService.java', [{ newStart: 35, newCount: 10 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(Object.values(result.summary.changed_files).reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      // UserService.java contains method-verifyToken, method-getUsers-svc
      // BFS: verifyToken ← getUsers-svc ← getUsers ← route-get-users
      const getUsersEndpoint = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(getUsersEndpoint).toBeDefined();
    });

    // ── E2E-CR07: Single-repo fallback (no CrossRepoContext) ──
    it('E2E-CR07a: works identically to before — FormatUtil transitive chain', async () => {
      mockGitDiff('FormatUtil.java', [{ newStart: 5, newCount: 5 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(Object.values(result.summary.changed_files).reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const getUsersEndpoint = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(getUsersEndpoint).toBeDefined();

      // No _triggered_by field in single-repo results
      for (const ep of allEndpoints) {
        expect(ep._triggered_by).toBeUndefined();
      }
    });

    it('E2E-CR07b: UserController change → POST /api/users (WILL_BREAK)', async () => {
      mockGitDiff('UserController.java', [{ newStart: 42, newCount: 5 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const postUsersEndpoint = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'POST',
      );
      expect(postUsersEndpoint).toBeDefined();
    });

    it('consumer standalone: finds POST /api/users when UserController changes', async () => {
      mockGitDiff('UserController.java', [{ newStart: 42, newCount: 5 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(Object.values(result.summary.changed_files).reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      const usersPost = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'POST',
      );
      expect(usersPost).toBeDefined();
    });
  }, {
    seed: IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED,
    ftsIndexes: IMPACTED_ENDPOINTS_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const ext = handle as any;
      vi.mocked(listRegisteredRepos as any).mockResolvedValue([
        {
          name: 'test-consumer',
          path: '/test/consumer',
          storagePath: ext.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 8, nodes: 30, communities: 3, processes: 2 },
        },
      ]);
      const b = new LocalBackend();
      await b.init();
      ext._backend = b;
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests using IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED (library only)
// ═══════════════════════════════════════════════════════════════════════════
describe('Cross-repo E2E: library standalone', () => {
  let backend: LocalBackend;

  withTestLbugDB('cr-library', (handle) => {
    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) {
        throw new Error('LocalBackend not initialized');
      }
      backend = ext._backend;
    });

    // ── E2E-CR03: Library-only change with no consumers ──
    it('E2E-CR03: returns 0 endpoints when library has no Route nodes', async () => {
      mockGitDiff('EmailValidator.java', [{ newStart: 10, newCount: 5 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      // Library has no Route nodes → 0 impacted endpoints
      // impacted_endpoints is now a Record<string, number>; value depends on repo.id at runtime
      expect(Object.values(result.summary.impacted_endpoints)[0]).toBe(0);
      expect(result.impacted_endpoints.WILL_BREAK).toEqual([]);
      expect(result.impacted_endpoints.LIKELY_AFFECTED).toEqual([]);
      expect(result.impacted_endpoints.MAY_NEED_TESTING).toEqual([]);
    });
  }, {
    seed: IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_SEED,
    ftsIndexes: IMPACTED_ENDPOINTS_CROSS_REPO_LIBRARY_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const ext = handle as any;
      vi.mocked(listRegisteredRepos as any).mockResolvedValue([
        {
          name: 'shared-libs',
          path: '/test/shared-libs',
          storagePath: ext.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'def456',
          stats: { files: 1, nodes: 4, communities: 1, processes: 0 },
        },
      ]);
      const b = new LocalBackend();
      await b.init();
      ext._backend = b;
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Consumer standalone test (uses combined seed to avoid DB lifecycle issues)
// ═══════════════════════════════════════════════════════════════════════════
// Note: This test is included in the "Cross-repo E2E: combined seed" describe block
// to avoid database lifecycle issues between separate withTestLbugDB calls.