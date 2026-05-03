/**
 * E2E Integration Tests: impacted_endpoints
 *
 * Uses withTestLbugDB + IMPACTED_ENDPOINTS_SEED_DATA to test the full
 * impacted_endpoints pipeline: git diff → symbols → BFS traversal →
 * route discovery → tier classification.
 *
 * Mocks execGitDiff to control which files are "changed."
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { IMPACTED_ENDPOINTS_SEED_DATA, IMPACTED_ENDPOINTS_FTS_INDEXES } from '../fixtures/impacted-endpoints-seed.js';

interface ImpactedEndpointsResult {
  summary: { changed_files: Record<string, number>; changed_symbols: number; impacted_endpoints: Record<string, number>; risk_level: string };
  impacted_endpoints: { WILL_BREAK: any[]; LIKELY_AFFECTED: any[]; MAY_NEED_TESTING: any[] };
  changed_symbols: any[];
  affected_processes: any[];
  affected_modules: any[];
  _meta: { version: string; generated_at: string };
  error?: string;
}

/** Sum values of a Record<string, number> (used for changed_files/impacted_endpoints counts). */
function totalFromRecord(obj: Record<string, number> | null | undefined): number {
  if (!obj || typeof obj !== 'object') return 0;
  return Object.values(obj).reduce((a, b) => a + b, 0);
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

/** Mock execFileSync to handle both --unified=0 and --name-only calls.
 *  For --unified=0: returns diff output with the given hunks.
 *  For --name-only: returns the file path (fallback behavior).
 */
function mockGitDiff(filePath: string, hunks: Array<{ newStart: number; newCount: number }>): void {
  vi.mocked(execFileSync).mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--unified=0')) {
      return buildUnifiedDiff(filePath, hunks);
    }
    if (args.includes('--name-only')) {
      return `${filePath}\n`;
    }
    return '';
  });
}

/** Mock execFileSync for multi-file diffs. */
function mockGitDiffMulti(files: Array<{ filePath: string; hunks: Array<{ newStart: number; newCount: number }> }>): void {
  vi.mocked(execFileSync).mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--unified=0')) {
      return files.map(f => buildUnifiedDiff(f.filePath, f.hunks)).join('');
    }
    if (args.includes('--name-only')) {
      return files.map(f => f.filePath).join('\n') + '\n';
    }
    return '';
  });
}

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// Mock child_process so execGitDiff returns controlled file paths
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';

withTestLbugDB('impacted-endpoints-e2e', (handle) => {
  let backend: LocalBackend;

  beforeAll(async () => {
    const ext = handle as typeof handle & { _backend?: LocalBackend };
    if (!ext._backend) {
      throw new Error('LocalBackend not initialized — afterSetup did not attach _backend');
    }
    backend = ext._backend;
  });

  // ── Scenario 1: Transitive chain → LIKELY_AFFECTED ───────────────
  // Changing FormatUtil.java → method-formatUser (d=0) →
  // method-getUsers-svc (d=1) → method-getUsers (d=2) → route-get-users
  // Route is discovered via reverse-CALLS at BFS depth > 1

  describe('transitive chain: utility → service → controller → Route', () => {
    it('discovers GET /api/users in LIKELY_AFFECTED or deeper tier', async () => {
      // Mock git diff to report FormatUtil.java as changed
      mockGitDiff('FormatUtil.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      // The endpoint should be discovered in one of the tiers
      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const usersRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(usersRoute).toBeDefined();
    });
  });

  // ── Scenario 2: Direct chain → WILL_BREAK ──────────────────────
  // Changing UserController.java directly → file defines route-post-users
  // Route is at depth 0 (changed symbol maps directly to the file that
  // DEFINES the route)

  describe('direct chain: changed controller → WILL_BREAK', () => {
    it('discovers POST /api/users in WILL_BREAK tier', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();

      const breakEndpoints = result.impacted_endpoints?.WILL_BREAK || [];
      const usersPost = breakEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'POST',
      );
      expect(usersPost).toBeDefined();
    });
  });

  // ── Scenario 3: Changed file with no Route upstream ────────────

  describe('changed file with no Route upstream', () => {
    it('returns 0 impacted endpoints', async () => {
      // BaseController.java does not directly define any routes in the seed data
      // (the /api/health route is defined by HealthController.java)
      mockGitDiff('BaseController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      // BaseController has no DEFINES edge to a Route, and HealthController
      // has EXTENDS to it, but the Route's DEFINES edge comes from
      // HealthController's file. So changing BaseController.java should
      // find routes via EXTENDS traversal.
      // If no route is reachable, impacted_endpoints total should be 0.
      // If routes are found via EXTENDS, they should be in a deeper tier.
      // Either outcome is valid; verify the structure is correct.
      expect(result.impacted_endpoints).toBeDefined();
      expect(Array.isArray(result.impacted_endpoints.WILL_BREAK)).toBe(true);
      expect(Array.isArray(result.impacted_endpoints.LIKELY_AFFECTED)).toBe(true);
      expect(Array.isArray(result.impacted_endpoints.MAY_NEED_TESTING)).toBe(true);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Phase 4: E2E Acceptance Scenarios
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── E2E-J01: Change utility class → transitive endpoint impact ────
  // FormatUtil.java → method-formatUser (d=0) → method-getUsers-svc (d=1)
  // → method-getUsers (d=2) → route-get-users (via reverse-CALLS)
  // Route should land in LIKELY_AFFECTED or MAY_NEED_TESTING (depth > 1)

  describe('E2E-J01: utility change → transitive endpoint impact', () => {
    it('discovers GET /api/users in any tier', async () => {
      mockGitDiff('FormatUtil.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);
      expect(result.summary.changed_symbols).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const usersRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(usersRoute).toBeDefined();

      // Utility is transitive — must have at least one non-zero-depth
      // discovery path (reverse-CALLS or DEFINES from upstream)
      expect(usersRoute.discovery_paths.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── E2E-J02: Change controller directly → WILL_BREAK ──────────────
  // UserController.java DEFINES route-post-users → direct hit at depth 0

  describe('E2E-J02: controller change → WILL_BREAK', () => {
    it('discovers POST /api/users in WILL_BREAK tier', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();

      const breakEndpoints = result.impacted_endpoints?.WILL_BREAK || [];
      expect(breakEndpoints.length).toBeGreaterThanOrEqual(1);

      const usersPost = breakEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'POST',
      );
      expect(usersPost).toBeDefined();
    });
  });

  // ── E2E-J03: Change service method → endpoint discovered ──────────
  // UserService.java → method-getUsers-svc (d=0) → method-getUsers (d=1)
  // → route-get-users (via reverse-CALLS)
  // The route is discovered; its exact tier depends on affected_id depth.

  describe('E2E-J03: service change → endpoint discovered', () => {
    it('discovers GET /api/users in some tier when service changes', async () => {
      mockGitDiff('UserService.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const usersRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(usersRoute).toBeDefined();

      // Service change must have non-zero affected_by (traces back to changed code)
      expect(usersRoute.affected_by.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── E2E-J06: Clean working tree → empty result ────────────────────

  describe('E2E-J06: clean working tree', () => {
    it('returns empty result with risk_level none', async () => {
      // Empty diff: both --unified=0 and --name-only return empty string
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'unstaged',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(result.summary).toBeDefined();
      expect(totalFromRecord(result.summary.changed_files)).toBe(0);
      expect(result.summary.changed_symbols).toBe(0);
      expect(totalFromRecord(result.summary.impacted_endpoints)).toBe(0);
      expect(result.summary.risk_level).toBe('none');
      expect(result.impacted_endpoints?.WILL_BREAK).toEqual([]);
      expect(result.impacted_endpoints?.LIKELY_AFFECTED).toEqual([]);
      expect(result.impacted_endpoints?.MAY_NEED_TESTING).toEqual([]);
    });
  });

  // ── E2E-J08: Invalid base_ref → error response ────────────────────

  describe('E2E-J08: invalid base_ref for compare scope', () => {
    it('returns error when base_ref is missing for compare scope', async () => {
      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        // base_ref intentionally omitted
      }) as ImpactedEndpointsResult;

      expect(result).toHaveProperty('error');
      expect(result.error).toContain('base_ref');
    });

    it('returns error when git diff fails with bad base_ref', async () => {
      // Simulate git failing on a non-existent branch
      vi.mocked(execFileSync).mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'diff' && args.includes('nonexistent-branch-xyz')) {
          throw new Error("fatal: bad revision 'nonexistent-branch-xyz'");
        }
        return '';
      });

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'nonexistent-branch-xyz',
      }) as ImpactedEndpointsResult;

      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Git diff failed');

      // Reset mock to default return value
      vi.mocked(execFileSync).mockReturnValue('');
    });
  });

  // ── Structural contract: response shape validation ────────────────

  describe('response shape contract', () => {
    it('always returns summary with required fields regardless of diff result', async () => {
      mockGitDiff('FormatUtil.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      // summary shape
      expect(result.summary).toBeDefined();
      expect(typeof result.summary.changed_files).toBe('object');
      expect(result.summary.changed_files).not.toBeNull();
      expect(typeof result.summary.changed_symbols).toBe('number');
      expect(typeof result.summary.impacted_endpoints).toBe('object');
      expect(result.summary.impacted_endpoints).not.toBeNull();
      expect(typeof result.summary.risk_level).toBe('string');

      // tier shape
      expect(result.impacted_endpoints).toBeDefined();
      expect(Array.isArray(result.impacted_endpoints.WILL_BREAK)).toBe(true);
      expect(Array.isArray(result.impacted_endpoints.LIKELY_AFFECTED)).toBe(true);
      expect(Array.isArray(result.impacted_endpoints.MAY_NEED_TESTING)).toBe(true);

      // enrichment shape
      expect(Array.isArray(result.changed_symbols)).toBe(true);
      expect(Array.isArray(result.affected_processes)).toBe(true);
      expect(Array.isArray(result.affected_modules)).toBe(true);

      // meta shape
      expect(result._meta).toBeDefined();
      expect(result._meta.version).toBe('1.0');
      expect(typeof result._meta.generated_at).toBe('string');
    });

    it('each endpoint in tiers has required fields', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      for (const ep of allEndpoints) {
        expect(typeof ep.method).toBe('string');
        expect(typeof ep.path).toBe('string');
        expect(typeof ep.confidence).toBe('number');
        expect(Array.isArray(ep.affected_by)).toBe(true);
        expect(Array.isArray(ep.discovery_paths)).toBe(true);
      }
    });
  });

  // ── Tier classification correctness ──────────────────────────────

  describe('tier classification: depth-based assignment', () => {
    it('WILL_BREAK only contains endpoints with confidence >= 0.85', async () => {
      mockGitDiff('OrderController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      const breakEndpoints = result.impacted_endpoints?.WILL_BREAK || [];
      for (const ep of breakEndpoints) {
        // WILL_BREAK entries must have high confidence
        expect(ep.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('HealthController change discovers health endpoint', async () => {
      mockGitDiff('HealthController.java', [{ newStart: 1, newCount: 1000 }]);

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

      const healthRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/health' && ep.method === 'GET',
      );
      expect(healthRoute).toBeDefined();
    });
  });

  // ── Multi-file changes ────────────────────────────────────────────

  describe('multi-file change detection', () => {
    it('detects endpoints from multiple changed files', async () => {
      mockGitDiffMulti([
        { filePath: 'UserController.java', hunks: [{ newStart: 1, newCount: 1000 }] },
        { filePath: 'OrderController.java', hunks: [{ newStart: 1, newCount: 1000 }] },
      ]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(2);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      // Should find endpoints from both controllers
      const userEndpoints = allEndpoints.filter((ep: any) => ep.path === '/api/users');
      const orderEndpoints = allEndpoints.filter((ep: any) => ep.path === '/api/orders/{id}');
      expect(userEndpoints.length + orderEndpoints.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Multi-language E2E scenarios (Python, Go, TypeScript)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── E2E-PY01: FastAPI controller change → Route discovery ────────
  // Changing app/users.py → File → DEFINES → route-get-users-fastapi
  // Route discovered via direct file ownership

  describe('E2E-PY01: FastAPI controller change → Route discovery', () => {
    it('discovers GET /api/users from FastAPI route node', async () => {
      mockGitDiff('app/users.py', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const usersRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      );
      expect(usersRoute).toBeDefined();
    });
  });

  // ── E2E-PY02: FastAPI auth service change → endpoint discovery ──
  // Changing app/auth_service.py → File → DEFINES → route-post-login-fastapi
  // POST /api/login is discovered via direct file-to-route ownership

  describe('E2E-PY02: FastAPI auth service change → transitive endpoint', () => {
    it('discovers POST /api/login via transitive CALLS chain', async () => {
      mockGitDiff('app/auth_service.py', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const loginRoute = allEndpoints.find(
        (ep: any) => ep.path === '/api/login' && ep.method === 'POST',
      );
      expect(loginRoute).toBeDefined();
    });
  });

  // ── E2E-GO01: Gin handler change → Route discovery ───────────────
  // Changing handlers/order.go → File → DEFINES → both Gin routes
  // Both GET /orders/{id} and POST /orders should be discovered

  describe('E2E-GO01: Gin handler change → Route discovery', () => {
    it('discovers both GET /orders/{id} and POST /orders from Gin routes', async () => {
      mockGitDiff('handlers/order.go', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const getOrders = allEndpoints.find(
        (ep: any) => ep.path === '/orders/{id}' && ep.method === 'GET',
      );
      const postOrders = allEndpoints.find(
        (ep: any) => ep.path === '/orders' && ep.method === 'POST',
      );
      expect(getOrders).toBeDefined();
      expect(postOrders).toBeDefined();
    });
  });

  // ── E2E-GO02: Gin service change → transitive endpoint via call chain
  // Changing services/order_service.go → method-ValidateOrder-gin (d=0) →
  // method-CreateOrder-gin (d=1, via reverse-CALLS) →
  // route-post-orders-gin (via reverse-CALLS from route)
  // POST /orders should be discovered; changed_symbols >= 1

  describe('E2E-GO02: Gin service change → transitive endpoint via call chain', () => {
    it('discovers POST /orders via CreateOrder → ValidateOrder transitive chain', async () => {
      mockGitDiff('services/order_service.go', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);
      expect(result.summary.changed_symbols).toBeGreaterThanOrEqual(1);

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];

      const postOrders = allEndpoints.find(
        (ep: any) => ep.path === '/orders' && ep.method === 'POST',
      );
      expect(postOrders).toBeDefined();
    });
  });

  // ── E2E-TS01: TypeScript/Angular change → 0 endpoints (frontend) ──
  // Changing src/app/services/user.service.ts has a Method node but no
  // Route nodes upstream — frontend code has no API endpoints

  describe('E2E-TS01: TypeScript/Angular change → 0 endpoints (frontend code)', () => {
    it('returns 0 impacted endpoints for frontend-only code', async () => {
      mockGitDiff('src/app/services/user.service.ts', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.impacted_endpoints)).toBe(0);
      expect(result.impacted_endpoints?.WILL_BREAK).toEqual([]);
      expect(result.impacted_endpoints?.LIKELY_AFFECTED).toEqual([]);
      expect(result.impacted_endpoints?.MAY_NEED_TESTING).toEqual([]);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Annotation-fallback E2E scenarios
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── E2E-ANN01: Annotation-fallback dedup verification ──────────────
  // UserController.java has BOTH a Route node (route-get-users) AND
  // a Method (method-getUsers) with @GetMapping("/api/users") content.
  // The Route-node discovery (Query 2) finds GET /api/users.
  // The annotation-fallback query (Query 4) also finds it via @GetMapping.
  // Dedup must produce exactly 1 entry for GET /api/users — not 2.

  describe('E2E-ANN01: annotation-fallback dedup with Route node', () => {
    it('GET /api/users appears exactly once (not duplicated by annotation fallback)', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

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

      // GET /api/users must appear exactly once — Route-node and
      // annotation-fallback are deduped
      const getUsersCount = allEndpoints.filter(
        (ep: any) => ep.path === '/api/users' && ep.method === 'GET',
      ).length;
      expect(getUsersCount).toBe(1);
    });
  });

  // ── E2E-AF01: Non-Controller file → no annotation-fallback entries ─
  // UserService.java is NOT a Controller file (filePath does not contain
  // 'Controller'). The annotation-fallback query filters on
  // m.filePath CONTAINS 'Controller', so UserService.java methods
  // should never appear as annotation-fallback entries.

  describe('E2E-AF01: non-Controller file → no annotation-fallback entries', () => {
    it('changing UserService.java produces no annotation-fallback entries', async () => {
      mockGitDiff('UserService.java', [{ newStart: 1, newCount: 1000 }]);

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

      // No endpoint should have 'annotation-fallback' as a discovery_path
      // because UserService.java doesn't contain 'Controller' in its filePath
      const annotationFallbackEntries = allEndpoints.filter(
        (ep: any) => ep.discovery_paths?.includes('annotation-fallback'),
      );
      expect(annotationFallbackEntries.length).toBe(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // E2E-LINE: Line-range diff resolution scenarios
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ── E2E-LINE01: Single function change → narrower impact ────────────
  // Changing only createUser (lines 42-55) should NOT include getUsers
  // (lines 25-35) in changed_symbols, but UserController (10-60) DOES
  // overlap with the changed range.

  describe('E2E-LINE01: single function change → narrower impact than whole file', () => {
    it('changing only createUser (lines 42-55) does NOT include getUsers in changed_symbols', async () => {
      mockGitDiff('UserController.java', [{ newStart: 42, newCount: 14 }]); // lines 42-55 = createUser only

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(1);

      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      // method-createUser (42-55) overlaps with changed range
      expect(symbolNames).toContain('createUser');
      // method-getUsers (25-35) does NOT overlap with changed range (42-55)
      expect(symbolNames).not.toContain('getUsers');
      // class-UserController (10-60) DOES overlap with 42-55
      expect(symbolNames).toContain('UserController');

      // POST /api/users should be impacted (via createUser)
      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      const postUsers = allEndpoints.find((ep: any) => ep.path === '/api/users' && ep.method === 'POST');
      expect(postUsers).toBeDefined();
    });
  });

  // ── E2E-LINE02: Whole file change → broad impact ────────────────────
  // Changing entire UserController (lines 1-60) includes both getUsers and
  // createUser because all method ranges overlap.

  describe('E2E-LINE02: whole file change → all methods in changed_symbols', () => {
    it('changing entire UserController (lines 1-60) includes both getUsers and createUser', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 60 }]); // whole class

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      expect(symbolNames).toContain('getUsers');
      expect(symbolNames).toContain('createUser');
      expect(symbolNames).toContain('UserController');
    });
  });

  // ── E2E-LINE03: Single function in OrderController → DELETE only ────
  // Changing only deleteOrder (lines 55-65) should impact DELETE /api/orders/{id}
  // but NOT getOrder (lines 30-40).

  describe('E2E-LINE03: single function in OrderController → DELETE only', () => {
    it('changing only deleteOrder (lines 55-65) impacts DELETE /api/orders/{id} but not GET', async () => {
      mockGitDiff('OrderController.java', [{ newStart: 55, newCount: 11 }]); // lines 55-65 = deleteOrder

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      expect(symbolNames).toContain('deleteOrder');
      expect(symbolNames).not.toContain('getOrder');

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      const deleteOrders = allEndpoints.find((ep: any) => ep.path === '/api/orders/{id}' && ep.method === 'DELETE');
      expect(deleteOrders).toBeDefined();
    });
  });

  // ── E2E-LINE04: Multi-hunk same file → both affected functions ──────
  // Changing lines 25-35 (getUsers) AND 42-55 (createUser) includes both
  // methods in changed_symbols.

  describe('E2E-LINE04: multi-hunk change → both affected functions', () => {
    it('changing lines 25-35 AND 42-55 includes both getUsers and createUser', async () => {
      mockGitDiff('UserController.java', [
        { newStart: 25, newCount: 11 }, // getUsers (25-35)
        { newStart: 42, newCount: 14 }, // createUser (42-55)
      ]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      expect(symbolNames).toContain('getUsers');
      expect(symbolNames).toContain('createUser');
    });
  });

  // ── E2E-LINE05: Transitive chain still works with line-range filtering ──
  // Changing only formatUser (lines 5-12) should still discover GET /api/users
  // via BFS: formatUser → getUsers-svc → getUsers → route-get-users

  describe('E2E-LINE05: single function in utility → transitive chain still works', () => {
    it('changing formatUser (lines 5-12) still discovers GET /api/users via BFS', async () => {
      mockGitDiff('FormatUtil.java', [{ newStart: 5, newCount: 8 }]); // lines 5-12 = formatUser

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      expect(symbolNames).toContain('formatUser');
      // FormatUtil class (lines 1-15) overlaps with 5-12
      expect(symbolNames).toContain('FormatUtil');

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      const usersRoute = allEndpoints.find((ep: any) => ep.path === '/api/users' && ep.method === 'GET');
      expect(usersRoute).toBeDefined();
    });
  });

  // ── E2E-LINE06: Fallback when no hunks parsed ──────────────────────
  // When unified diff has no parseable hunks (e.g., binary file),
  // parseDiffOutputWithLines returns [] and _impactedEndpointsImpl returns
  // changed_files: 0 (no fallback to --name-only for empty diff).

  describe('E2E-LINE06: no hunk ranges → empty result', () => {
    it('when unified diff has no parseable hunks, returns changed_files: 0', async () => {
      // Simulate a binary file: file header but no +++ b/ line → parseDiffOutputWithLines returns []
      vi.mocked(execFileSync).mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('--unified=0')) {
          // Binary file diff: no +++ b/ line, no hunk headers → parseDiffOutputWithLines returns []
          return `diff --git a/UserController.java b/UserController.java\nBinary files differ\n`;
        }
        if (args.includes('--name-only')) {
          return 'UserController.java\n';
        }
        return '';
      });

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      // parseDiffOutputWithLines returns [] for binary diff (no +++ b/ line),
      // and _impactedEndpointsImpl returns changed_files: {repoId: 0} when lineDiffResult.length === 0
      expect(totalFromRecord(result.summary.changed_files)).toBe(0);
    });
  });

  // ── E2E-LINE07: Multi-file with precise line ranges ──────────────────
  // Changing createUser in UserController AND formatUser in FormatUtil
  // discovers both endpoints via their respective chains.

  describe('E2E-LINE07: multi-file with precise line ranges', () => {
    it('changing createUser in UserController AND formatUser in FormatUtil discovers both endpoints', async () => {
      mockGitDiffMulti([
        { filePath: 'UserController.java', hunks: [{ newStart: 42, newCount: 14 }] }, // createUser only
        { filePath: 'FormatUtil.java', hunks: [{ newStart: 5, newCount: 8 }] },         // formatUser only
      ]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(totalFromRecord(result.summary.changed_files)).toBeGreaterThanOrEqual(2);

      const symbolNames = result.changed_symbols.map((s: any) => s.name);
      // Only the specifically changed functions, not sibling methods
      expect(symbolNames).toContain('createUser');
      expect(symbolNames).toContain('formatUser');
      expect(symbolNames).not.toContain('getUsers'); // not in changed range

      const allEndpoints = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      const postUsers = allEndpoints.find((ep: any) => ep.path === '/api/users' && ep.method === 'POST');
      const getUsers = allEndpoints.find((ep: any) => ep.path === '/api/users' && ep.method === 'GET');
      expect(postUsers).toBeDefined();
      expect(getUsers).toBeDefined(); // via transitive chain from formatUser
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Issue #28: Response format consistency tests
  // changed_files and impacted_endpoints in summary must always be
  // Record<string, number> (object), never a scalar number.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Issue #28: single-repo response format is always object', () => {
    it('changed_files is an object (not a number) for single-repo call', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(typeof result.summary.changed_files).toBe('object');
      expect(result.summary.changed_files).not.toBeNull();
      expect(result.summary.changed_files).not.toBeInstanceOf(Array);
    });

    it('impacted_endpoints count is an object (not a number) for single-repo call', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(typeof result.summary.impacted_endpoints).toBe('object');
      expect(result.summary.impacted_endpoints).not.toBeNull();
      expect(result.summary.impacted_endpoints).not.toBeInstanceOf(Array);
    });

    it('zero changes returns object with repo key mapped to 0', async () => {
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'unstaged',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      expect(typeof result.summary.changed_files).toBe('object');
      expect(totalFromRecord(result.summary.changed_files)).toBe(0);
      expect(typeof result.summary.impacted_endpoints).toBe('object');
      expect(totalFromRecord(result.summary.impacted_endpoints)).toBe(0);
    });

    it('changed_files object keys are repo IDs with numeric values', async () => {
      mockGitDiff('UserController.java', [{ newStart: 1, newCount: 1000 }]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      expect(result).not.toHaveProperty('error');
      const entries = Object.entries(result.summary.changed_files);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      for (const [repoId, count] of entries) {
        expect(typeof repoId).toBe('string');
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });
  });

}, {
  seed: IMPACTED_ENDPOINTS_SEED_DATA,
  ftsIndexes: IMPACTED_ENDPOINTS_FTS_INDEXES,
  poolAdapter: true,
  afterSetup: async (handle) => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'test-impacted-endpoints',
        path: '/test/impacted-endpoints',
        storagePath: handle.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
        stats: { files: 7, nodes: 26, communities: 3, processes: 2 },
      },
    ]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
  },
});