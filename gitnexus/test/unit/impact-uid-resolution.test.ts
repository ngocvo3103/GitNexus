/**
 * Unit Tests: UID-format target resolution in _impactImpl
 *
 * Tests the uid detection, resolution, and fallback logic:
 *
 *   - isQualified: targets containing ':' or '/' trigger uid query
 *   - uid-match:  exact-id match returns correct target metadata
 *   - uid-miss:   fallback to priority-based name query
 *   - symType:    Class/Interface triggers seed expansion; Method does not
 *   - regression: plain names still resolve via priority query
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lbug-adapter module before importing LocalBackend
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

/** Create a LocalBackend with a registered repo handle and mocked init. */
function makeBackend(repoId = 'test-repo') {
  const backend = new LocalBackend();
  const repoHandle = {
    id: repoId,
    name: repoId,
    repoPath: `/tmp/${repoId}`,
    storagePath: `/tmp/${repoId}/.gitnexus`,
    lbugPath: `/tmp/${repoId}/.gitnexus/lbug`,
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  return { backend, repoHandle };
}

/** Return empty arrays for all executeQuery calls (no BFS traversal results). */
function noTraversalResults() {
  executeQueryMock.mockImplementation(async () => []);
}

/** Return empty arrays for all executeParameterized calls. */
function noParameterizedResults() {
  executeParameterizedMock.mockImplementation(async () => []);
}

/** Helper: find calls whose query string contains a substring. */
function callsWithQuery(substr: string) {
  return executeParameterizedMock.mock.calls.filter((call: any[]) => {
    const query = typeof call[1] === 'string' ? call[1] : '';
    return query.includes(substr);
  });
}

// ─── Test Group 1: isQualified detection ─────────────────────────────

describe('impact: uid-format target resolution — isQualified detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noTraversalResults();
    noParameterizedResults();
  });

  it('T1.1: colon-containing target triggers uid query', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:UserController', name: 'UserController', type: 'Class', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    const uidCalls = callsWithQuery('n.id = $targetName');
    expect(uidCalls.length).toBeGreaterThanOrEqual(1);
    // The uid query must pass the FULL qualified target as the parameter
    expect(uidCalls[0][2].targetName).toBe('Class:UserController');
  });

  it('T1.2: slash-containing target triggers uid query', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'pkg/mod:Func', name: 'Func', type: 'Function', filePath: 'pkg/mod.ts' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'pkg/mod:Func', direction: 'upstream', maxDepth: 1 });

    const uidCalls = callsWithQuery('n.id = $targetName');
    expect(uidCalls.length).toBeGreaterThanOrEqual(1);
    expect(uidCalls[0][2].targetName).toBe('pkg/mod:Func');
  });

  it('T1.3: plain name skips uid query', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      // Return a Class row for priority UNION query
      return [{ id: 'Class:UserController', name: 'UserController', filePath: 'ctrl/UserController.java', priority: 0 }];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'UserController', direction: 'upstream', maxDepth: 1 });

    const uidCalls = callsWithQuery('n.id = $targetName');
    expect(uidCalls).toHaveLength(0);
  });

  it('T1.5: empty-name qualified target returns not found', async () => {
    const { backend, repoHandle } = makeBackend();

    // All queries return empty (uid match, name match)
    executeParameterizedMock.mockImplementation(async () => []);

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Class:', direction: 'upstream', maxDepth: 1 });

    // Empty name extracted from "Class:" is "", which won't match any node
    expect(result.error).toContain('Class:');
  });

  it('T1.4: target with multiple colons triggers uid query', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Module::Submodule::Class', name: 'Class', type: 'Class', filePath: 'mod/sub/Class.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Module::Submodule::Class', direction: 'upstream', maxDepth: 1 });

    const uidCalls = callsWithQuery('n.id = $targetName');
    expect(uidCalls.length).toBeGreaterThanOrEqual(1);
    expect(uidCalls[0][2].targetName).toBe('Module::Submodule::Class');
  });
});

// ─── Test Group 2: uid-match path ────────────────────────────────────

describe('impact: uid-format target resolution — uid-match path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noTraversalResults();
    // Default: return empty for everything; individual tests override
    noParameterizedResults();
  });

  it('T2.1: uid match returns correct target id', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:UserController', name: 'UserController', type: 'Class', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    expect(result.target.id).toBe('Class:UserController');
  });

  it('T2.2: uid match with Class type', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:UserController', name: 'UserController', type: 'Class', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    expect(result.target.type).toBe('Class');
  });

  it('T2.3: uid match with Interface type', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Interface:AuthService', name: 'AuthService', type: 'Interface', filePath: 'svc/AuthService.java' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Interface:AuthService', direction: 'upstream', maxDepth: 1 });

    expect(result.target.type).toBe('Interface');
  });

  it('T2.4: uid match with Method type', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Method:handleRequest', name: 'handleRequest', type: 'Method', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Method:handleRequest', direction: 'upstream', maxDepth: 1 });

    expect(result.target.type).toBe('Method');
  });

  it('T2.5: uid match skips priority-based queries', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:UserController', name: 'UserController', type: 'Class', filePath: 'ctrl/UserController.java' }];
      }
      // Any other query returns empty — but must NOT include UNION ALL
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    // After a uid match, the priority-based UNION query must NOT be called
    const unionCalls = callsWithQuery('UNION ALL');
    expect(unionCalls).toHaveLength(0);
  });
});

// ─── Test Group 3: uid-miss fallback ────────────────────────────────

describe('impact: uid-format target resolution — uid-miss fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noTraversalResults();
    noParameterizedResults();
  });

  it('T3.1: uid not found, falls back to name', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query returns empty → trigger fallback
      if (query.includes('n.id = $targetName')) {
        return [];
      }
      // priority UNION query returns a match for "UserController"
      if (query.includes('UNION ALL')) {
        return [{ id: 'Class:UserController', name: 'UserController', filePath: 'ctrl/UserController.java', priority: 0 }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    expect(result.target.name).toBe('UserController');

    // Verify the UNION query used the extracted name, not the full target
    const unionCalls = callsWithQuery('UNION ALL');
    expect(unionCalls.length).toBeGreaterThanOrEqual(1);
    expect(unionCalls[0][2].targetName).toBe('UserController');
  });

  it('T3.2: uid not found, name also not found', async () => {
    const { backend, repoHandle } = makeBackend();

    // All queries return empty
    executeParameterizedMock.mockImplementation(async () => []);

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Class:NoSuchClass', direction: 'upstream', maxDepth: 1 });

    expect(result.error).toContain('Class:NoSuchClass');
  });

  it('T3.3: uid with slash falls back to name after slash', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query returns empty
      if (query.includes('n.id = $targetName')) {
        return [];
      }
      // priority UNION query returns a match for extracted name "Func"
      if (query.includes('UNION ALL')) {
        return [{ id: 'Function:Func', name: 'Func', filePath: 'pkg/mod.ts', priority: 2 }];
      }
      // unlabeled fallback also returns match
      if (query.includes('labels(n)') && !query.includes('UNION ALL')) {
        return [{ id: 'Function:Func', name: 'Func', type: 'Function', filePath: 'pkg/mod.ts' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'pkg/mod:Func', direction: 'upstream', maxDepth: 1 });

    // Target name should be the part after the last ':' or '/', i.e. "Func"
    expect(result.target.name).toBe('Func');

    // Verify the UNION query received the extracted name "Func"
    const unionCalls = callsWithQuery('UNION ALL');
    expect(unionCalls.length).toBeGreaterThanOrEqual(1);
    expect(unionCalls[0][2].targetName).toBe('Func');
  });

  it('T3.4: uid miss, UNION ALL miss, unlabeled fallback succeeds', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query returns empty
      if (query.includes('n.id = $targetName')) {
        return [];
      }
      // priority UNION ALL returns empty (Enum not in priority list)
      if (query.includes('UNION ALL')) {
        return [];
      }
      // unlabeled fallback: MATCH (n) WHERE n.name = $targetName (has labels(n)[0] AS type)
      if (query.includes('labels(n)') && query.includes('n.name') && !query.includes('UNION ALL')) {
        return [{ id: 'Enum:Color', name: 'Color', type: 'Enum', filePath: 'app/Color.java' }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'Enum:Color', direction: 'upstream', maxDepth: 1 });

    // Should resolve via unlabeled fallback to the Enum node
    expect(result.target.name).toBe('Color');
    expect(result.target.type).toBe('Enum');
  });
});

// ─── Test Group 4: symType propagation ─────────────────────────────

describe('impact: uid-format target resolution — symType propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noTraversalResults();
  });

  it('T4.1: uid match Class triggers seed expansion', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query → return Class
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:UserController', name: 'UserController', type: 'Class', filePath: 'ctrl/UserController.java' }];
      }
      // Constructor seed query (HAS_METHOD → Constructor)
      if (query.includes('HAS_METHOD') && query.includes('Constructor')) {
        return [{ id: 'Constructor:UserController', name: 'UserController', type: 'Constructor', filePath: 'ctrl/UserController.java' }];
      }
      // File seed query (DEFINES)
      if (query.includes('DEFINES')) {
        return [{ id: 'File:UserController.java', name: 'UserController.java', type: 'File', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Class:UserController', direction: 'upstream', maxDepth: 1 });

    // Verify Constructor seed query (HAS_METHOD → Constructor) was called
    const ctorCalls = callsWithQuery('HAS_METHOD');
    expect(ctorCalls.length).toBeGreaterThanOrEqual(1);
    expect(ctorCalls[0][1]).toContain('Constructor');

    // Verify File/DEFINES seed query was called
    const fileCalls = callsWithQuery('DEFINES');
    expect(fileCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('T4.2: uid match Method does not trigger seed expansion', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query → return Method
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Method:handleRequest', name: 'handleRequest', type: 'Method', filePath: 'ctrl/UserController.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Method:handleRequest', direction: 'upstream', maxDepth: 1 });

    // Verify NO Constructor seed query was called
    const ctorCalls = callsWithQuery('HAS_METHOD');
    expect(ctorCalls).toHaveLength(0);

    // Verify NO File/DEFINES seed query was called
    const fileCalls = callsWithQuery('DEFINES');
    expect(fileCalls).toHaveLength(0);
  });

  it('T4.3: uid match Interface triggers seed expansion', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';

      // uid query → return Interface
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Interface:AuthService', name: 'AuthService', type: 'Interface', filePath: 'svc/AuthService.java' }];
      }
      // Constructor seed query (HAS_METHOD → Constructor)
      if (query.includes('HAS_METHOD') && query.includes('Constructor')) {
        return [{ id: 'Constructor:AuthService', name: 'AuthService', type: 'Constructor', filePath: 'svc/AuthService.java' }];
      }
      // File seed query (DEFINES)
      if (query.includes('DEFINES')) {
        return [{ id: 'File:AuthService.java', name: 'AuthService.java', type: 'File', filePath: 'svc/AuthService.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, { target: 'Interface:AuthService', direction: 'upstream', maxDepth: 1 });

    // Interface should trigger same seed expansion as Class
    const ctorCalls = callsWithQuery('HAS_METHOD');
    expect(ctorCalls.length).toBeGreaterThanOrEqual(1);
    expect(ctorCalls[0][1]).toContain('Constructor');

    const fileCalls = callsWithQuery('DEFINES');
    expect(fileCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test Group 5: Regression ────────────────────────────────────────

describe('impact: uid-format target resolution — regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noTraversalResults();
    noParameterizedResults();
  });

  it('T5.1: plain name resolves via priority query', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      // priority UNION query → return Class match
      if (query.includes('UNION ALL')) {
        return [{ id: 'Class:UserController', name: 'UserController', filePath: 'ctrl/UserController.java', priority: 0 }];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'UserController', direction: 'upstream', maxDepth: 1 });

    expect(result.target.name).toBe('UserController');

    // Verify no uid query was made for plain names
    const uidCalls = callsWithQuery('n.id = $targetName');
    expect(uidCalls).toHaveLength(0);
  });

  it('T5.2: plain name not found returns error', async () => {
    const { backend, repoHandle } = makeBackend();

    // All queries return empty
    executeParameterizedMock.mockImplementation(async () => []);

    const result = await (backend as any)._impactImpl(repoHandle, { target: 'NoSuchThing', direction: 'upstream', maxDepth: 1 });

    expect(result.error).toContain('NoSuchThing');
  });
});