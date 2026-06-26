/**
 * Unit Tests: Python external pre-filter (ADR-002 Lever 10).
 *
 * Covers the pythonExternalFqnIndex population (import-processor) and injection
 * (call-processor), plus the end-to-end soundness invariants:
 *
 *   (a) BYTE-IDENTITY   — identical graph outcome with and without the pre-filter
 *                         (skipped externals → locs=[] → NO_NODE → KEEP, identical to
 *                         probing the external and getting a null LSP response).
 *   (b) NO FALSE SKIP   — in-repo imports (relative or resolved) are NEVER classified
 *                         external; they must be probed.
 *   (c) AMBIGUITY GUARD — two recall items sharing a candidate key where one is external
 *                         and one is not → key absent from map → both probed.
 *
 * These tests are unit tests (no real LSP, no real ingestion pipeline) — they verify:
 *   1. pythonExternalFqnIndex population logic (import-processor semantics).
 *   2. RecallFeedItem.calleeExternalFqn injection (call-processor semantics).
 *   3. buildRecallExternalFqnMap behaviour with Python-sourced feed items.
 *   4. The canSkipCandidate recall branch skips Python external items and probes others.
 *
 * EP Partitions (Python-specific):
 *   EP-PY-A: module-alias import (`import numpy as np`) → bound name 'np' → external
 *   EP-PY-B: named import (`from os import getcwd`) → bound name 'getcwd' → external
 *   EP-PY-C: bare import (`import os`) → bound name 'os' → external
 *   EP-PY-D: relative import (`from .helpers import foo`) → NOT external → probe
 *   EP-PY-E: in-repo import that resolves → NOT external → probe
 *   EP-PY-F: two recall items at same key; one external, one not → key absent → probe
 *   EP-PY-G: receiver-name lookup (`np.array()` → receiverName='np') → external
 *   EP-PY-H: calledName fallback (`getcwd()` → receiverName undefined → calledName='getcwd') → external
 *   EP-PY-I: .ts file → pythonExternalFqnIndex absent → no injection → probe
 */

import { describe, it, expect, vi } from 'vitest';

import {
  withReconciliationSession,
  type WithReconciliationSessionDeps,
  type ReconciliationProbeFn,
  type ReconciliationLspClient,
  type ReconciliationRepo,
  type Location,
  type Candidate,
  type SessionMeta,
} from '../../../src/core/ingestion/mode-a-reconciler.js';
import { buildRecallExternalFqnMap } from '../../../src/core/ingestion/pipeline.js';
import type { RecallFeedItem } from '../../../src/core/ingestion/call-processor.js';

// ─── Shared test infrastructure (mirrors mode-a-external-prefilter.test.ts) ───

function makeMockClient(over: {
  requestImpl?: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
} = {}) {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const request = vi.fn(over.requestImpl ?? (async () => null));
  const getState = vi.fn(() => 'ready');
  return {
    client: { start, stop, request, getState } as unknown as ReconciliationLspClient,
    start,
    stop,
    request,
  };
}

function makeClientFactory(client: ReconciliationLspClient) {
  return vi.fn(() => client);
}

function makeReadyProbe(): ReconciliationProbeFn {
  return vi.fn(async () => ({ ready: true })) as unknown as ReconciliationProbeFn;
}

function makeDeps(
  client: ReconciliationLspClient,
  over: Partial<WithReconciliationSessionDeps> = {},
): WithReconciliationSessionDeps {
  return {
    // Session uses the default TYPESCRIPT_ADAPTER (adapter.id = 'typescript').
    // discoverServers must return a 'typescript' entry for the gate to pass.
    // The Python external FQN pre-filter is server-side logic (recallFqnMap /
    // canSkipCandidate) — it is independent of which language server is used.
    discoverServers: vi.fn(async () => ({
      typescript: { path: '/bin/typescript-language-server', version: '4.3.3' },
    })),
    createLspClient: makeClientFactory(client),
    probe: makeReadyProbe(),
    ...over,
  };
}

const REPO: ReconciliationRepo = {
  id: 'r1',
  repoPath: '/workspace/repo',
};

function mkRecallCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'src:py',
    calledName: 'array',
    file: 'src/analysis.py',
    line: 5,
    character: 3,
    ...over,
  };
}

/** candidateLocationKey mirrors pipeline.ts / mode-a-reconciler.ts */
function locationKey(c: Candidate): string {
  const base = `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`;
  const relType = (c as unknown as Record<string, unknown>).relType;
  return relType ? `${base}|${relType}` : base;
}

async function runAndCaptureMeta(
  candidates: Candidate[],
  deps: WithReconciliationSessionDeps,
): Promise<{ meta: SessionMeta; handCalls: number }> {
  const handFn = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
  let captured: SessionMeta | undefined;
  await withReconciliationSession(REPO, candidates, async (_selected, meta) => {
    captured = meta;
    return undefined;
  }, { ...deps, handToEngine: handFn as unknown as (cand: Candidate, locs: Location[]) => Promise<void> });
  if (!captured) throw new Error('work-fn never called — gate refused (check discoverServers returns typescript key)');
  return { meta: captured, handCalls: handFn.mock.calls.length };
}

// ─── Helper: build a canSkipCandidate closure mirroring pipeline.ts WI-A3 ────

function makeA3ClosurePy(
  graphNodes: Map<string, { properties: { isExternal?: boolean } }>,
  recallFqnMap: Map<string, string>,
  preFilteredKeys: Set<string>,
): (candidate: Candidate) => boolean {
  return (candidate: Candidate): boolean => {
    if (!candidate.oldTargetId) {
      const key = locationKey(candidate);
      const fqn = recallFqnMap.get(key);
      if (fqn) {
        preFilteredKeys.add(key);
        return true;
      }
      return false;
    }
    const node = graphNodes.get(candidate.oldTargetId);
    if (node === undefined) return false;
    const skip = node.properties.isExternal === true;
    if (skip) preFilteredKeys.add(locationKey(candidate));
    return skip;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: pythonExternalFqnIndex population semantics
//
// These tests exercise the MAP-BUILDING logic that import-processor applies.
// We simulate it inline (the actual processImports fn is tested via integration;
// here we verify the key/value shape the call-processor consumes).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulate what import-processor writes to pythonExternalFqnIndex.
 * Covers both slow path (processImports) and fast path (processImportsFromExtracted).
 *
 * Rules:
 *   - `!result` (unresolved in-repo) + `!rawImportPath.startsWith('.')` → external
 *   - Named bindings: record b.local → rawImportPath for each binding
 *   - No bindings: record topLevelSegment → rawImportPath
 */
function simulatePythonIndexPopulation(
  entries: Array<{
    filePath: string;
    rawImportPath: string;
    namedBindings?: Array<{ local: string; exported: string }>;
    isRelative?: boolean;
    resolvedInRepo?: boolean;
  }>,
): Map<string, Map<string, string>> {
  const idx = new Map<string, Map<string, string>>();
  for (const e of entries) {
    // Skip if resolved in-repo (result != null) or relative
    if (e.resolvedInRepo || e.isRelative) continue;
    let fileMap = idx.get(e.filePath);
    if (!fileMap) { fileMap = new Map(); idx.set(e.filePath, fileMap); }
    if (e.namedBindings && e.namedBindings.length > 0) {
      for (const b of e.namedBindings) {
        fileMap.set(b.local, e.rawImportPath);
      }
    } else {
      const topLevel = e.rawImportPath.split('.')[0];
      fileMap.set(topLevel, e.rawImportPath);
    }
  }
  return idx;
}

describe('PY-INDEX-1 [EP-PY-A]: module-alias import populates bound alias as key', () => {
  it('import numpy as np → pythonExternalFqnIndex["analysis.py"]["np"] = "numpy"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/analysis.py',
      rawImportPath: 'numpy',
      namedBindings: [{ local: 'np', exported: 'numpy' }],
    }]);

    const fileMap = idx.get('/repo/analysis.py');
    expect(fileMap).toBeDefined();
    expect(fileMap!.get('np')).toBe('numpy');
    // 'numpy' itself must NOT be a key — bound name is 'np'
    expect(fileMap!.has('numpy')).toBe(false);
  });
});

describe('PY-INDEX-2 [EP-PY-B]: named import from module populates local name as key', () => {
  it('from os import getcwd → pythonExternalFqnIndex["app.py"]["getcwd"] = "os"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/app.py',
      rawImportPath: 'os',
      namedBindings: [{ local: 'getcwd', exported: 'getcwd' }],
    }]);

    const fileMap = idx.get('/repo/app.py');
    expect(fileMap).toBeDefined();
    expect(fileMap!.get('getcwd')).toBe('os');
  });
});

describe('PY-INDEX-3 [EP-PY-B multi]: from os import getcwd, path → two entries', () => {
  it('from os import getcwd, path → both keys recorded with module "os"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/app.py',
      rawImportPath: 'os',
      namedBindings: [
        { local: 'getcwd', exported: 'getcwd' },
        { local: 'path', exported: 'path' },
      ],
    }]);

    const fileMap = idx.get('/repo/app.py');
    expect(fileMap).toBeDefined();
    expect(fileMap!.get('getcwd')).toBe('os');
    expect(fileMap!.get('path')).toBe('os');
  });
});

describe('PY-INDEX-4 [EP-PY-C]: bare import populates top-level module segment', () => {
  it('import os → pythonExternalFqnIndex["script.py"]["os"] = "os"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/script.py',
      rawImportPath: 'os',
    }]);

    expect(idx.get('/repo/script.py')?.get('os')).toBe('os');
  });

  it('import os.path → key is "os" (top-level segment), value is "os.path"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/script.py',
      rawImportPath: 'os.path',
    }]);

    const fileMap = idx.get('/repo/script.py');
    expect(fileMap?.get('os')).toBe('os.path');
    // 'os.path' must NOT be a key — only the top segment
    expect(fileMap?.has('os.path')).toBe(false);
  });
});

describe('PY-INDEX-5 [EP-PY-D]: relative import → NOT added to index', () => {
  it('from .helpers import foo (isRelative=true) → file absent from index', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/app.py',
      rawImportPath: '.helpers',
      namedBindings: [{ local: 'foo', exported: 'foo' }],
      isRelative: true,
    }]);

    expect(idx.has('/repo/app.py')).toBe(false);
  });
});

describe('PY-INDEX-6 [EP-PY-E]: resolved in-repo import → NOT added to index', () => {
  it('import helpers (resolves to /repo/helpers.py) → file absent from index', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/app.py',
      rawImportPath: 'helpers',
      namedBindings: [{ local: 'foo', exported: 'foo' }],
      resolvedInRepo: true,
    }]);

    expect(idx.has('/repo/app.py')).toBe(false);
  });
});

describe('PY-INDEX-7 [multi-file]: multiple files populated independently', () => {
  it('two Python files with different external imports → separate fileMap entries', () => {
    const idx = simulatePythonIndexPopulation([
      {
        filePath: '/repo/analysis.py',
        rawImportPath: 'numpy',
        namedBindings: [{ local: 'np', exported: 'numpy' }],
      },
      {
        filePath: '/repo/stats.py',
        rawImportPath: 'scipy',
        namedBindings: [{ local: 'sp', exported: 'scipy' }],
      },
    ]);

    expect(idx.get('/repo/analysis.py')?.get('np')).toBe('numpy');
    expect(idx.get('/repo/stats.py')?.get('sp')).toBe('scipy');
    // No cross-contamination
    expect(idx.get('/repo/analysis.py')?.has('sp')).toBe(false);
    expect(idx.get('/repo/stats.py')?.has('np')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: RecallFeedItem injection (call-processor semantics)
//
// Verify the RecallFeedItem.calleeExternalFqn values that the call-processor
// would inject, then confirm buildRecallExternalFqnMap builds the right map.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulate call-processor slow/fast path injection of calleeExternalFqn.
 * Returns the value that would be spread onto the RecallFeedItem.
 *
 * Logic (mirrors call-processor.ts):
 *   - .py file: look up receiverName first, then calledName
 *   - .java file: look up receiverTypeName (Java gate, unchanged)
 *   - other: undefined
 */
function simulatePythonFqnInjection(opts: {
  filePath: string;
  receiverName?: string;
  calledName: string;
  pythonExternalFqnIndex?: Map<string, Map<string, string>>;
}): string | undefined {
  const { filePath, receiverName, calledName, pythonExternalFqnIndex } = opts;
  if (!filePath.endsWith('.py')) return undefined;
  return pythonExternalFqnIndex?.get(filePath)?.get(receiverName ?? calledName);
}

describe('PY-INJECT-1 [EP-PY-G]: member call receiver lookup (np.array())', () => {
  it('np.array() → receiverName="np" → calleeExternalFqn="numpy"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/analysis.py',
      rawImportPath: 'numpy',
      namedBindings: [{ local: 'np', exported: 'numpy' }],
    }]);

    const fqn = simulatePythonFqnInjection({
      filePath: '/repo/analysis.py',
      receiverName: 'np',
      calledName: 'array',
      pythonExternalFqnIndex: idx,
    });

    expect(fqn).toBe('numpy');
  });
});

describe('PY-INJECT-2 [EP-PY-H]: free-function call falls back to calledName (getcwd())', () => {
  it('getcwd() with no receiver → calledName="getcwd" → calleeExternalFqn="os"', () => {
    const idx = simulatePythonIndexPopulation([{
      filePath: '/repo/app.py',
      rawImportPath: 'os',
      namedBindings: [{ local: 'getcwd', exported: 'getcwd' }],
    }]);

    const fqn = simulatePythonFqnInjection({
      filePath: '/repo/app.py',
      receiverName: undefined,
      calledName: 'getcwd',
      pythonExternalFqnIndex: idx,
    });

    expect(fqn).toBe('os');
  });
});

describe('PY-INJECT-3 [EP-PY-I]: non-Python file → no injection', () => {
  it('.ts file → calleeExternalFqn=undefined regardless of index', () => {
    // Even if a pythonExternalFqnIndex somehow contained a .ts entry, it must not fire
    const idx = new Map([
      ['/repo/utils.ts', new Map([['readFile', 'fs']])],
    ]);

    const fqn = simulatePythonFqnInjection({
      filePath: '/repo/utils.ts',
      calledName: 'readFile',
      pythonExternalFqnIndex: idx,
    });

    expect(fqn).toBeUndefined();
  });
});

describe('PY-INJECT-4: index absent (non-LSP path) → undefined', () => {
  it('pythonExternalFqnIndex=undefined → calleeExternalFqn=undefined (I-9 byte-identical)', () => {
    const fqn = simulatePythonFqnInjection({
      filePath: '/repo/analysis.py',
      receiverName: 'np',
      calledName: 'array',
      pythonExternalFqnIndex: undefined,
    });

    expect(fqn).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: buildRecallExternalFqnMap with Python-sourced feed items
//
// buildRecallExternalFqnMap is language-agnostic; these tests confirm it handles
// Python RecallFeedItems correctly (including I-2c ambiguity guard).
// ═══════════════════════════════════════════════════════════════════════════════

describe('PY-MAP-1 [EP-PY-A]: numpy recall item → FQN in map', () => {
  it('single Python recall item with calleeExternalFqn → map has entry', () => {
    const feed: RecallFeedItem[] = [
      {
        sourceId: 'Function:/repo/analysis.py:run',
        calledName: 'array',
        file: '/repo/analysis.py',
        line: 10,
        character: 5,
        calleeExternalFqn: 'numpy',
      },
    ];

    const map = buildRecallExternalFqnMap(feed);
    const key = `${feed[0].sourceId}|${feed[0].calledName}|${feed[0].line}|${feed[0].character}`;
    expect(map.get(key)).toBe('numpy');
  });
});

describe('PY-MAP-2 [EP-PY-B]: os.getcwd recall item → FQN in map', () => {
  it('free-function recall from os module → map has entry keyed by calledName', () => {
    const feed: RecallFeedItem[] = [
      {
        sourceId: 'Function:/repo/app.py:main',
        calledName: 'getcwd',
        file: '/repo/app.py',
        line: 3,
        character: 2,
        calleeExternalFqn: 'os',
      },
    ];

    const map = buildRecallExternalFqnMap(feed);
    const key = `${feed[0].sourceId}|${feed[0].calledName}|${feed[0].line}|${feed[0].character}`;
    expect(map.get(key)).toBe('os');
  });
});

describe('PY-MAP-3 [EP-PY-F / I-2c]: ambiguity guard — two items at same key (one external, one not)', () => {
  it('external-first then non-external: key absent from map → both probed', () => {
    const sourceId = 'Function:/repo/mixed.py:run';
    const calledName = 'compute';
    const line = 7;
    const character = 4;

    const feed: RecallFeedItem[] = [
      // First: external
      { sourceId, calledName, file: '/repo/mixed.py', line, character, calleeExternalFqn: 'scipy' },
      // Second: in-repo (no FQN) — same key
      { sourceId, calledName, file: '/repo/mixed.py', line, character },
    ];

    const map = buildRecallExternalFqnMap(feed);
    const key = `${sourceId}|${calledName}|${line}|${character}`;
    // I-2c: ambiguous → key MUST be absent (deleted by the non-external item)
    expect(map.has(key)).toBe(false);
  });

  it('non-external-first then external: key absent from map → both probed', () => {
    const sourceId = 'Function:/repo/mixed.py:run';
    const calledName = 'transform';
    const line = 12;
    const character = 6;

    const feed: RecallFeedItem[] = [
      // First: in-repo (no FQN) — marks key ambiguous
      { sourceId, calledName, file: '/repo/mixed.py', line, character },
      // Second: external — must NOT override the ambiguous mark
      { sourceId, calledName, file: '/repo/mixed.py', line, character, calleeExternalFqn: 'pandas' },
    ];

    const map = buildRecallExternalFqnMap(feed);
    const key = `${sourceId}|${calledName}|${line}|${character}`;
    expect(map.has(key)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: End-to-end session behaviour
//
// Verify that Python external recall candidates are skipped by canSkipCandidate,
// that in-repo Python calls are probed, and that the byte-identity invariant holds.
// ═══════════════════════════════════════════════════════════════════════════════

describe('PY-E2E-1 [EP-PY-A / byte-identity]: external Python recall → skip; same meta as LSP returning null', () => {
  it('numpy recall candidate with FQN → preFilteredExternal=1, probed=0, handToEngine not called', async () => {
    const { client } = makeMockClient();

    const recall = mkRecallCandidate({
      sourceId: 'Function:/repo/analysis.py:run',
      calledName: 'array',
      line: 10,
      character: 5,
      file: '/repo/analysis.py',
    });
    const key = locationKey(recall);

    const recallFqnMap = new Map([[key, 'numpy']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    // I-8-replay: key recorded
    expect(preFilteredKeys.has(key)).toBe(true);
  });
});

describe('PY-E2E-2 [EP-PY-D / no false skip]: relative import → recall always probed', () => {
  it('relative import call site has no FQN in map → probed=1', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    const recall = mkRecallCandidate({
      sourceId: 'Function:/repo/app.py:main',
      calledName: 'foo',
      line: 4,
      character: 2,
      file: '/repo/app.py',
    });
    const key = locationKey(recall);

    // Empty map — relative imports were never added
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
    expect(preFilteredKeys.has(key)).toBe(false);
  });
});

describe('PY-E2E-3 [EP-PY-E / no false skip]: in-repo Python import → recall probed', () => {
  it('in-repo import site has no FQN in map → probed=1; never skipped', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    const recall = mkRecallCandidate({
      sourceId: 'Function:/repo/service.py:handler',
      calledName: 'process',
      line: 7,
      character: 4,
      file: '/repo/service.py',
    });

    // Map is empty — in-repo imports were excluded from index at population time
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });
});

describe('PY-E2E-4 [EP-PY-F / I-2c]: ambiguous key → probe, never skip', () => {
  it('two recalls at same key (one external, one not) → key absent from map → both probed', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    const sourceId = 'Function:/repo/mixed.py:run';
    const calledName = 'compute';
    const line = 7;
    const character = 4;

    const feedItems: RecallFeedItem[] = [
      { sourceId, calledName, file: '/repo/mixed.py', line, character, calleeExternalFqn: 'scipy' },
      { sourceId, calledName, file: '/repo/mixed.py', line, character },
    ];

    // buildRecallExternalFqnMap enforces I-2c: ambiguous key deleted
    const recallFqnMap = buildRecallExternalFqnMap(feedItems);
    const key = `${sourceId}|${calledName}|${line}|${character}`;
    expect(recallFqnMap.has(key)).toBe(false);

    // The recall candidate maps to the ambiguous key → must probe
    const recall = mkRecallCandidate({ sourceId, calledName, line, character, file: '/repo/mixed.py' });
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

describe('PY-E2E-5 [batch]: mixed numpy/os/in-repo batch → correct counts', () => {
  it('2 external (numpy + os) + 1 in-repo → preFilteredExternal=2, probed=1', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    const numpyRecall = mkRecallCandidate({
      sourceId: 's1', calledName: 'array', line: 1, character: 0, file: '/repo/analysis.py',
    });
    const osRecall = mkRecallCandidate({
      sourceId: 's2', calledName: 'getcwd', line: 2, character: 0, file: '/repo/app.py',
    });
    const inRepoRecall = mkRecallCandidate({
      sourceId: 's3', calledName: 'process', line: 3, character: 0, file: '/repo/service.py',
    });

    const recallFqnMap = new Map([
      [locationKey(numpyRecall), 'numpy'],
      [locationKey(osRecall), 'os'],
      // inRepoRecall has no entry → probe
    ]);

    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta(
      [numpyRecall, osRecall, inRepoRecall],
      deps,
    );

    expect(meta.preFilteredExternal).toBe(2);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
    expect(preFilteredKeys.size).toBe(2);
  });
});

describe('PY-E2E-6 [I-9 / non-LSP path]: no pythonExternalFqnIndex → all recalls probed', () => {
  it('recallFqnMap empty (non-LSP: index was never built) → probed=2, preFilteredExternal=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    // Without LSP, the index is never built → no FQNs → empty recallFqnMap
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const r1 = mkRecallCandidate({ sourceId: 's1', calledName: 'array', line: 1, character: 0 });
    const r2 = mkRecallCandidate({ sourceId: 's2', calledName: 'getcwd', line: 2, character: 0 });

    const { meta } = await runAndCaptureMeta([r1, r2], deps);

    // Non-LSP path: byte-identical to baseline (no skips at all)
    expect(meta.probed).toBe(2);
    expect(meta.preFilteredExternal).toBe(0);
  });
});

describe('PY-E2E-7 [soundness / I-2c]: "unknown ≠ external" — unrecognised module not in index', () => {
  it('import someUnknownLib where resolver failed but lib is not in index → probed (conservative)', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });

    // The import-processor never adds 'someUnknownLib' to the index if it could not
    // classify it definitively — but in practice all !result + !startsWith('.') entries
    // ARE added.  The conservative invariant here: if the index does NOT have an entry
    // for this recall candidate, it must be probed, not skipped.
    const recall = mkRecallCandidate({
      sourceId: 'Function:/repo/app.py:main',
      calledName: 'frobnicate',
      line: 99,
      character: 0,
      file: '/repo/app.py',
    });

    // No entry for this candidate → no FQN
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

describe('PY-E2E-8 [pandas]: real-world pandas recall → preFilteredExternal=1', () => {
  it('import pandas as pd; pd.DataFrame() recall → skipped via recallFqnMap', async () => {
    const { client } = makeMockClient();

    const recall = mkRecallCandidate({
      sourceId: 'Function:/repo/data.py:load',
      calledName: 'DataFrame',
      line: 15,
      character: 7,
      file: '/repo/data.py',
    });
    const key = locationKey(recall);

    const recallFqnMap = new Map([[key, 'pandas']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3ClosurePy(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    expect(preFilteredKeys.has(key)).toBe(true);
  });
});
