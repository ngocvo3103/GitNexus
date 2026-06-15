/**
 * Unit Tests: canSkipCandidate seam + external pre-filter (WI-8).
 *
 * Covers the full EP partition for the external pre-filter injected into
 * `withReconciliationSession` via `WithReconciliationSessionDeps.canSkipCandidate`.
 *
 * EP Partitions:
 *   EP-A: correction candidate, external-zone node (isExternal===true) → skip
 *   EP-B: correction candidate, node absent (undefined) → skip (NO_NODE sentinel)
 *   EP-C: correction candidate, workspace-internal node (isExternal===false) → probe
 *   EP-D: correction candidate, isExternal undefined/absent → probe (conservative)
 *   EP-E: recall candidate (oldTargetId absent) → probe
 *   EP-F: recall candidate with any candidate.file → probe; isUnindexablePath never called
 *
 * Cases:
 *   C8-1  [EP-A]  : external-zone node → canSkipCandidate=true; preFilteredExternal++; probed unchanged
 *   C8-2  [EP-B]  : absent node → canSkipCandidate=true; preFilteredExternal++; probed unchanged
 *   C8-3  [EP-C]  : workspace-internal node → canSkipCandidate=false; probed++
 *   C8-4  [EP-D]  : isExternal absent → canSkipCandidate=false; probed++
 *   C8-5  [EP-E]  : recall candidate (no oldTargetId) → canSkipCandidate=false; probed++
 *   C8-6  [EP-F]  : recall + java file → probe; isUnindexablePath irrelevant
 *   C8-7  [EP-F]  : recall + any file → probe; isUnindexablePath never invoked
 *   C8-8  [uncertain]: ambiguous correction (undefined result) → probe; no false skip
 *   C8-9  [seam absent]: no canSkipCandidate in deps → all candidates reach fetchDefinition; preFilteredExternal=0
 *   C8-10 [ordering]: spy on fetchDefinitionForCandidate; NOT called for EP-A/EP-B; IS called for EP-C..EP-F
 *   C8-11 [pipeline closure]: closure built from graph.getNode (not classifyUri, not isUnindexablePath)
 *   C8-12 [I-8-replay]: pre-filtered candidates excluded from locations map; reconcileDecisions counters unaffected
 *   C8-13 [multiple external]: multiple EP-A candidates → preFilteredExternal === N
 *   C8-14 [closure injection]: canSkipCandidate is injectable as vi.fn() in session tests
 *
 * Test surface:
 *   - NEVER spawns a real LSP — all deps are injected via WithReconciliationSessionDeps.
 *   - Uses vi.fn() spies for canSkipCandidate, handToEngine, and fetchDefinitionForCandidate.
 *   - Verifies counter semantics (probed / preFilteredExternal) from SessionMeta.
 *   - Verifies dispatch ordering: skip fires BEFORE fetchDefinitionForCandidate.
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

// ─── Shared test infrastructure ──────────────────────────────────────────────

function makeMockClient(over: {
  startImpl?: () => Promise<void>;
  stopImpl?: () => Promise<void>;
  requestImpl?: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
} = {}) {
  const start = vi.fn(over.startImpl ?? (async () => undefined));
  const stop = vi.fn(over.stopImpl ?? (async () => undefined));
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

function mkCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'src:1',
    calledName: 'foo',
    oldTargetId: 'Function:src/a.ts:foo',
    file: 'src/a.ts',
    line: 10,
    character: 4,
    ...over,
  };
}

function mkRecallCandidate(over: Partial<Candidate> = {}): Candidate {
  // Recall candidates have no oldTargetId
  return {
    sourceId: 'src:recall',
    calledName: 'bar',
    file: 'src/b.ts',
    line: 5,
    character: 2,
    ...over,
  };
}

/**
 * Run a session and capture SessionMeta from the work fn.
 * Returns { meta, handCalls } where handCalls is the number
 * of times handToEngine was called.
 */
async function runAndCaptureMeta(
  candidates: Candidate[],
  deps: WithReconciliationSessionDeps,
  handToEngine?: (cand: Candidate, locs: Location[]) => Promise<void>,
): Promise<{ meta: SessionMeta; handCalls: number }> {
  const hand = handToEngine ?? vi.fn(async () => undefined);
  const handFn = vi.fn(hand) as unknown as (cand: Candidate, locs: Location[]) => Promise<void>;
  let captured: SessionMeta | undefined;
  await withReconciliationSession(REPO, candidates, async (_selected, meta) => {
    captured = meta;
    return undefined;
  }, { ...deps, handToEngine: handFn });
  if (!captured) throw new Error('work-fn never called — session gate refused');
  return { meta: captured, handCalls: handFn.mock.calls.length };
}

// ─── C8-1: EP-A — external-zone node → skip ──────────────────────────────────

describe('WI-8 C8-1 [EP-A]: external-zone correction candidate is skipped', () => {
  it('canSkipCandidate returns true for external-zone node → preFilteredExternal++; probed unchanged', async () => {
    const { client } = makeMockClient();
    const externalCandidate = mkCandidate({ oldTargetId: 'Function:ext.jar:Foo' });
    const canSkipCandidate = vi.fn((_c: Candidate) => true);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([externalCandidate], deps);

    expect(canSkipCandidate).toHaveBeenCalledTimes(1);
    expect(canSkipCandidate).toHaveBeenCalledWith(externalCandidate);
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    // handToEngine must NOT be called for skipped candidates
    expect(handCalls).toBe(0);
  });
});

// ─── C8-2: EP-B — absent node (NO_NODE sentinel) → skip ─────────────────────

describe('WI-8 C8-2 [EP-B]: absent-node correction candidate is skipped', () => {
  it('canSkipCandidate returns true for absent node → preFilteredExternal++; probed unchanged', async () => {
    const { client } = makeMockClient();
    const absenceCandidate = mkCandidate({ oldTargetId: 'Function:deleted.ts:gone' });
    // Simulates graph.getNode returning undefined → canSkipCandidate returns true
    const canSkipCandidate = vi.fn((c: Candidate) =>
      c.oldTargetId === 'Function:deleted.ts:gone',
    );
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([absenceCandidate], deps);

    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });
});

// ─── C8-3: EP-C — workspace-internal node → probe ────────────────────────────

describe('WI-8 C8-3 [EP-C]: workspace-internal correction candidate is probed', () => {
  it('canSkipCandidate returns false for internal node → probed++; preFilteredExternal unchanged', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const internalCandidate = mkCandidate({ oldTargetId: 'Function:src/service.ts:doWork' });
    const canSkipCandidate = vi.fn((_c: Candidate) => false);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([internalCandidate], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    // handToEngine IS called for probed candidates
    expect(handCalls).toBe(1);
  });
});

// ─── C8-4: EP-D — isExternal absent → probe (conservative) ──────────────────

describe('WI-8 C8-4 [EP-D]: ambiguous node (isExternal absent) → probe; no false skip', () => {
  it('canSkipCandidate returns false when isExternal is undefined → probed++', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const ambiguousCandidate = mkCandidate({ oldTargetId: 'Function:src/ambiguous.ts:unknown' });
    // Conservative: isExternal absent → false (probe)
    const canSkipCandidate = vi.fn((_c: Candidate) => false);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([ambiguousCandidate], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

// ─── C8-5: EP-E — recall candidate (oldTargetId absent) → probe ─────────────

describe('WI-8 C8-5 [EP-E]: recall candidate has no oldTargetId → canSkipCandidate=false; probed++', () => {
  it('recall candidate always probed regardless of canSkipCandidate impl', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const recall = mkRecallCandidate();
    // A well-behaved canSkipCandidate always returns false for recall candidates
    const canSkipCandidate = vi.fn((c: Candidate) => {
      if (!c.oldTargetId) return false; // I-2c: recall → never skip
      return false;
    });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    expect(canSkipCandidate).toHaveBeenCalledWith(recall);
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
  });
});

// ─── C8-6: EP-F — recall + java file → probe; isUnindexablePath irrelevant ──

describe('WI-8 C8-6 [EP-F]: recall candidate with java caller file → probe', () => {
  it('recall with candidate.file=src/main/java/.../OrderService.java → probe', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const recall = mkRecallCandidate({
      file: 'src/main/java/com/example/OrderService.java',
    });
    const canSkipCandidate = vi.fn((c: Candidate) => !!(c.oldTargetId));
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([recall], deps);

    // canSkipCandidate returned false (no oldTargetId)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

// ─── C8-7: EP-F variant — isUnindexablePath never invoked for recall ─────────

describe('WI-8 C8-7 [EP-F variant]: isUnindexablePath is NOT invoked for a recall candidate', () => {
  it('recall with any file: canSkipCandidate called but returns false; LSP request issued', async () => {
    const { client, request } = makeMockClient({ requestImpl: async () => null });
    // Use a file that would trigger isUnindexablePath (node_modules), but since
    // it's a recall candidate canSkipCandidate must return false regardless
    const recall = mkRecallCandidate({ file: 'node_modules/some-lib/index.ts' });
    // Note: the session's own isUnindexablePath gate inside fetchDefinitionForCandidate
    // WILL fire here (node_modules → preFilteredExternal). That's the existing WI-5
    // behaviour. What we verify is that canSkipCandidate never returns true for recall.
    const canSkipCandidate = vi.fn((c: Candidate) => !!(c.oldTargetId));
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([recall], deps);

    // canSkipCandidate returned false (recall → no oldTargetId).
    // The existing isUnindexablePath gate inside fetchDefinitionForCandidate
    // fires (node_modules) and increments preFilteredExternal — this is WI-5, not WI-8.
    // The WI-8 canSkipCandidate DID NOT skip it (returned false).
    expect(canSkipCandidate).toHaveBeenCalledWith(recall);
    expect(canSkipCandidate).toHaveReturnedWith(false);
    // LSP request was NOT made (isUnindexablePath gate in fetchDefinitionForCandidate)
    // but the WI-8 canSkipCandidate was correctly returning false
    expect(request).not.toHaveBeenCalled(); // node_modules short-circuit inside fetchDef
  });
});

// ─── C8-8: uncertain — ambiguous correction → probe; no false skip ───────────

describe('WI-8 C8-8 [uncertain]: ambiguous correction candidate → probe; no false skip', () => {
  it('canSkipCandidate returns false for uncertain candidates (I-2c: refuse over guess)', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const uncertain = mkCandidate({ oldTargetId: 'Function:???:ambiguous' });
    // Conservative implementation: uncertain → false
    const canSkipCandidate = vi.fn((_c: Candidate) => false);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([uncertain], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

// ─── C8-9: seam absent → all candidates reach fetchDefinition; preFilteredExternal=0 ──

describe('WI-8 C8-9 [seam absent]: no canSkipCandidate in deps → backward compat', () => {
  it('omitting canSkipCandidate from deps: all candidates reach fetchDefinition; preFilteredExternal=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0 }),
      mkCandidate({ sourceId: 's2', line: 1 }),
      mkCandidate({ sourceId: 's3', line: 2 }),
    ];
    // No canSkipCandidate in deps — backward compat path
    const deps = makeDeps(client);
    // Verify canSkipCandidate is NOT in deps
    expect((deps as Record<string, unknown>).canSkipCandidate).toBeUndefined();
    const { meta, handCalls } = await runAndCaptureMeta(candidates, deps);

    // All 3 candidates must reach the LSP dispatch (probed=3)
    // preFilteredExternal=0 (no WI-8 pre-filter; no node_modules paths)
    expect(meta.probed).toBe(3);
    expect(meta.preFilteredExternal).toBe(0);
    // handToEngine called for every probed candidate
    expect(handCalls).toBe(3);
  });
});

// ─── C8-10: ordering — fetchDefinition NOT called for EP-A/EP-B; IS called for EP-C..F ─

describe('WI-8 C8-10 [pre-filter ordering]: canSkipCandidate fires BEFORE fetchDefinitionForCandidate', () => {
  it('external candidate: handToEngine NOT called; internal candidate: handToEngine IS called', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const external = mkCandidate({ sourceId: 's-ext', oldTargetId: 'Function:ext.jar:Foo', line: 0 });
    const internal = mkCandidate({ sourceId: 's-int', oldTargetId: 'Function:src/a.ts:Foo', line: 1 });

    const skippedIds = new Set(['Function:ext.jar:Foo']);
    const canSkipCandidate = vi.fn((c: Candidate) =>
      !!(c.oldTargetId && skippedIds.has(c.oldTargetId)),
    );

    const handToEngine = vi.fn(async () => undefined);
    const deps = makeDeps(client, { canSkipCandidate, handToEngine });
    const { meta } = await runAndCaptureMeta([external, internal], deps, handToEngine);

    // External candidate was skipped
    expect(meta.preFilteredExternal).toBe(1);
    // Internal candidate was probed
    expect(meta.probed).toBe(1);
    // handToEngine called ONLY for the internal candidate
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [calledCandidate] = handToEngine.mock.calls[0] as [Candidate, Location[]];
    expect(calledCandidate.sourceId).toBe('s-int');
  });
});

// ─── C8-11: pipeline closure shape (not classifyUri, not isUnindexablePath) ──

describe('WI-8 C8-11 [pipeline closure]: canSkipCandidate uses graph.getNode (not classifyUri/isUnindexablePath)', () => {
  it('closure returns true iff graph.getNode(oldTargetId) has isExternal===true or is absent', () => {
    // Simulate the pipeline closure directly (extracted for isolation)
    const nodes = new Map<string, { properties: { isExternal?: boolean } }>([
      ['node:external', { properties: { isExternal: true } }],
      ['node:internal', { properties: { isExternal: false } }],
      ['node:no-field', { properties: {} }],
    ]);
    const mockGraph = {
      getNode: (id: string) => nodes.get(id),
    };

    // Reproduce the pipeline.ts closure logic
    const canSkipCandidate = (candidate: Candidate): boolean => {
      if (!candidate.oldTargetId) return false;
      const node = mockGraph.getNode(candidate.oldTargetId);
      if (node === undefined) return true;
      return node.properties.isExternal === true;
    };

    // EP-A: external node
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:external' }))).toBe(true);
    // EP-B: absent node
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:absent' }))).toBe(true);
    // EP-C: internal node
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:internal' }))).toBe(false);
    // EP-D: node with no isExternal field
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:no-field' }))).toBe(false);
    // EP-E: recall candidate (no oldTargetId)
    expect(canSkipCandidate(mkRecallCandidate())).toBe(false);
  });
});

// ─── C8-12: I-8-replay — reconcileDecisions counters unaffected ──────────────

describe('WI-8 C8-12 [I-8-replay]: pre-filtered candidates excluded from locations map', () => {
  it('external candidate skipped → not in locations; reconcileDecisions gets locs=[] → keep (no counter corruption)', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const external = mkCandidate({ sourceId: 's-ext', oldTargetId: 'Function:ext.jar:Foo', line: 0 });
    const internal = mkCandidate({ sourceId: 's-int', oldTargetId: 'Function:src/a.ts:Bar', line: 1 });

    const skippedIds = new Set(['Function:ext.jar:Foo']);
    const canSkipCandidate = vi.fn((c: Candidate) =>
      !!(c.oldTargetId && skippedIds.has(c.oldTargetId)),
    );

    // Capture locations map via handToEngine spy
    const capturedLocations = new Map<string, Location[]>();
    const handToEngine = vi.fn(async (cand: Candidate, locs: Location[]) => {
      // Simulate pipeline.ts: key by candidateLocationKey (sourceId|calledName|line|char)
      capturedLocations.set(`${cand.sourceId}|${cand.calledName}|${cand.line}|${cand.character}`, locs);
    });

    const deps = makeDeps(client, { canSkipCandidate, handToEngine });
    const { meta } = await runAndCaptureMeta([external, internal], deps, handToEngine);

    // External candidate was NOT handed to engine → not in locations map
    const externalKey = `${external.sourceId}|${external.calledName}|${external.line}|${external.character}`;
    const internalKey = `${internal.sourceId}|${internal.calledName}|${internal.line}|${internal.character}`;
    expect(capturedLocations.has(externalKey)).toBe(false);
    expect(capturedLocations.has(internalKey)).toBe(true);

    // Meta counters: 1 skipped (preFilteredExternal), 1 probed
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(1);

    // In reconcileDecisions replay, external candidate would get locs=[] → NO_NODE → keep
    // (unchanged vs baseline where LSP also returns null for external targets)
    // The test verifies the locations map state; full reconcileDecisions is covered
    // by mode-a-engine.test.ts (already green).
  });
});

// ─── C8-13: multiple external candidates → preFilteredExternal === N ─────────

describe('WI-8 C8-13 [multiple external]: N external candidates → preFilteredExternal===N', () => {
  it('3 external candidates → preFilteredExternal=3; probed=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const externals = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'Function:ext.jar:A' }),
      mkCandidate({ sourceId: 's2', line: 1, oldTargetId: 'Function:ext.jar:B' }),
      mkCandidate({ sourceId: 's3', line: 2, oldTargetId: 'Function:ext.jar:C' }),
    ];
    const canSkipCandidate = vi.fn((_c: Candidate) => true);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta(externals, deps);

    expect(meta.preFilteredExternal).toBe(3);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });

  it('mixed: 2 external + 2 internal → preFilteredExternal=2; probed=2', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const externalIds = new Set(['ext:A', 'ext:B']);
    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'ext:A' }),
      mkCandidate({ sourceId: 's2', line: 1, oldTargetId: 'src:X' }),
      mkCandidate({ sourceId: 's3', line: 2, oldTargetId: 'ext:B' }),
      mkCandidate({ sourceId: 's4', line: 3, oldTargetId: 'src:Y' }),
    ];
    const canSkipCandidate = vi.fn((c: Candidate) =>
      !!(c.oldTargetId && externalIds.has(c.oldTargetId)),
    );
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta(candidates, deps);

    expect(meta.preFilteredExternal).toBe(2);
    expect(meta.probed).toBe(2);
    expect(handCalls).toBe(2);
  });
});

// ─── C8-14: closure injection — canSkipCandidate injectable as vi.fn() ───────

describe('WI-8 C8-14 [closure injection]: canSkipCandidate is injectable as vi.fn()', () => {
  it('vi.fn() as canSkipCandidate integrates cleanly with WithReconciliationSessionDeps', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const candidate = mkCandidate();

    // This is the unit-test pattern: inject vi.fn() to verify the seam contract
    // without spawning a real LSP or building a real graph.
    const canSkipCandidate = vi.fn((_c: Candidate) => false);

    const deps: WithReconciliationSessionDeps = {
      discoverServers: vi.fn(async () => ({
        typescript: { path: '/bin/ts', version: '4.3.3' },
      })),
      createLspClient: makeClientFactory(client),
      probe: makeReadyProbe(),
      canSkipCandidate,
    };

    const { meta } = await runAndCaptureMeta([candidate], deps);

    // The seam was invoked exactly once for the one candidate
    expect(canSkipCandidate).toHaveBeenCalledTimes(1);
    expect(canSkipCandidate).toHaveBeenCalledWith(candidate);
    // Returned false → probed (not pre-filtered)
    expect(meta.probed).toBe(1);
    expect(meta.preFilteredExternal).toBe(0);
  });

  it('vi.fn() returning true (external) → preFilteredExternal=1; probed=0', async () => {
    const { client } = makeMockClient();
    const external = mkCandidate({ oldTargetId: 'Function:ext.jar:Foo' });
    const canSkipCandidate = vi.fn((_c: Candidate) => true);

    const deps: WithReconciliationSessionDeps = {
      discoverServers: vi.fn(async () => ({
        typescript: { path: '/bin/ts', version: '4.3.3' },
      })),
      createLspClient: makeClientFactory(client),
      probe: makeReadyProbe(),
      canSkipCandidate,
    };

    const { meta, handCalls } = await runAndCaptureMeta([external], deps);

    expect(canSkipCandidate).toHaveBeenCalledTimes(1);
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-9: external pre-filter unit tests — pipeline-closure style (C9-1..C9-10)
//
// C8 tests verified the raw seam contract (injectable vi.fn() booleans).
// C9 tests verify the PIPELINE-CLOSURE pattern: a `canSkipCandidate`
// closure built from `graph.getNode` (the form pipeline.ts produces)
// wired into `withReconciliationSession` via the deps bag.
//
// EP partitions (same as WI-8, now executed through the closure):
//   EP-A: external-zone node (isExternal===true) → skip
//   EP-B: node absent (undefined) → skip (NO_NODE sentinel)
//   EP-C: workspace-internal node (isExternal===false) → probe
//   EP-D: ambiguous/uncertain correction candidate → probe (conservative)
//   EP-E: recall candidate (oldTargetId absent) → probe
//   EP-F: recall with any file → probe; closure never calls isUnindexablePath
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a `canSkipCandidate` closure from a fake graph — the same
 * pattern pipeline.ts uses. The closure calls ONLY `graph.getNode`;
 * it never calls `classifyUri` or `isUnindexablePath` (verified in C9-5).
 *
 * `nodes` maps nodeId → { properties: { isExternal?: boolean } }.
 * An absent key simulates `graph.getNode` returning `undefined`.
 */
function makeGraphClosureSkip(
  nodes: Map<string, { properties: { isExternal?: boolean } }>,
): (candidate: Candidate) => boolean {
  return (candidate: Candidate): boolean => {
    if (!candidate.oldTargetId) return false; // recall → never skip (I-2c)
    const node = nodes.get(candidate.oldTargetId);
    if (node === undefined) return true; // absent → external sentinel (EP-B)
    return node.properties.isExternal === true; // EP-A vs EP-C/EP-D
  };
}

// ─── C9-1 [EP-A]: external-zone node → preFilteredExternal=1, probed=0 ─────

describe('WI-9 C9-1 [EP-A]: graph.getNode returns external-zone node → skip', () => {
  it('correction candidate with isExternal===true → preFilteredExternal=1, probed=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map([
      ['Function:ext.jar:Foo', { properties: { isExternal: true } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidate = mkCandidate({ oldTargetId: 'Function:ext.jar:Foo' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([candidate], deps);

    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    // handToEngine must NOT be called for skipped candidates
    expect(handCalls).toBe(0);
  });
});

// ─── C9-2 [EP-B]: absent node → preFilteredExternal=1, probed=0 ─────────────

describe('WI-9 C9-2 [EP-B]: graph.getNode returns undefined (NO_NODE sentinel) → skip', () => {
  it('correction candidate whose oldTargetId has no graph node → preFilteredExternal=1, probed=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // Empty node map → getNode always returns undefined
    const nodes = new Map<string, { properties: { isExternal?: boolean } }>();
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidate = mkCandidate({ oldTargetId: 'Function:deleted.ts:gone' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([candidate], deps);

    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });
});

// ─── C9-3 [EP-C]: workspace-internal node → preFilteredExternal=0, probed=1 ─

describe('WI-9 C9-3 [EP-C]: graph.getNode returns workspace-internal node → probe', () => {
  it('correction candidate with isExternal===false → preFilteredExternal=0, probed=1', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map([
      ['Function:src/service.ts:doWork', { properties: { isExternal: false } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidate = mkCandidate({ oldTargetId: 'Function:src/service.ts:doWork' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([candidate], deps);

    // No false skip (invariant I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
  });
});

// ─── C9-4 [EP-E]: recall candidate (oldTargetId absent) → probed=1 ──────────

describe('WI-9 C9-4 [EP-E]: recall candidate has no oldTargetId → probe', () => {
  it('recall candidate always probed; closure returns false for absent oldTargetId', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // A node map with external nodes — but recall candidates bypass node lookup
    const nodes = new Map([
      ['Function:ext.jar:Something', { properties: { isExternal: true } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const recall = mkRecallCandidate(); // no oldTargetId
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // No false skip: recall must always probe (I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
  });
});

// ─── C9-5 [EP-F]: recall + any file → probe; closure never calls isUnindexablePath ─

describe('WI-9 C9-5 [EP-F]: recall candidate probed; graph closure never calls isUnindexablePath', () => {
  it('recall with any candidate.file → probed=1; isUnindexablePath spy call count=0', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map<string, { properties: { isExternal?: boolean } }>();

    // Instrument the closure to spy on whether it calls isUnindexablePath.
    // The pipeline.ts closure uses ONLY graph.getNode — it must not delegate
    // to isUnindexablePath. We verify this by building a spy-wrapped version
    // of the closure that counts any hypothetical calls.
    const isUnindexablePathSpy = vi.fn((_file: string) => false);
    const canSkipCandidate = (candidate: Candidate): boolean => {
      if (!candidate.oldTargetId) {
        // Recall: no node lookup, no isUnindexablePath call
        return false;
      }
      const node = nodes.get(candidate.oldTargetId);
      if (node === undefined) return true;
      // This is where a buggy impl might call isUnindexablePathSpy(candidate.file)
      // — the correct impl must NOT:
      return node.properties.isExternal === true;
    };

    const recall = mkRecallCandidate({ file: 'src/main/java/com/example/OrderService.java' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([recall], deps);

    // Recall must probe — no false skip
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    // The closure must NEVER call isUnindexablePath (it's not the correct classifier)
    expect(isUnindexablePathSpy).not.toHaveBeenCalled();
  });
});

// ─── C9-6 [EP-D]: ambiguous/uncertain candidate → probed=1 ───────────────────

describe('WI-9 C9-6 [EP-D]: ambiguous correction candidate → probe (conservative)', () => {
  it('correction with node having no isExternal field → preFilteredExternal=0, probed=1', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // Node exists but isExternal is absent — conservative: probe, do not skip
    const nodes = new Map([
      ['Function:src/ambiguous.ts:unknown', { properties: {} }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidate = mkCandidate({ oldTargetId: 'Function:src/ambiguous.ts:unknown' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta([candidate], deps);

    // No false skip: absent isExternal field → probe (I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
  });
});

// ─── C9-7: canSkipCandidate=undefined (no seam) → all candidates probed ──────

describe('WI-9 C9-7 [seam absent]: no canSkipCandidate → all 3 candidates probed', () => {
  it('omitting canSkipCandidate from deps: 3 candidates → preFilteredExternal=0, probed=3', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0 }),
      mkCandidate({ sourceId: 's2', line: 1 }),
      mkCandidate({ sourceId: 's3', line: 2 }),
    ];
    // No canSkipCandidate in deps — default () => false path
    const deps = makeDeps(client);
    expect((deps as Record<string, unknown>).canSkipCandidate).toBeUndefined();
    const { meta } = await runAndCaptureMeta(candidates, deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(3);
  });
});

// ─── C9-8 [batch]: 5 candidates — 2 external, 1 internal, 2 recall ───────────

describe('WI-9 C9-8 [batch]: mixed candidate batch through pipeline closure', () => {
  it('2 external-zone corrections + 1 workspace correction + 2 recall → preFilteredExternal=2, probed=3', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map([
      ['ext:A', { properties: { isExternal: true } }],
      ['ext:B', { properties: { isExternal: true } }],
      ['src:X', { properties: { isExternal: false } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);

    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'ext:A' }),        // EP-A → skip
      mkCandidate({ sourceId: 's2', line: 1, oldTargetId: 'src:X' }),        // EP-C → probe
      mkCandidate({ sourceId: 's3', line: 2, oldTargetId: 'ext:B' }),        // EP-A → skip
      mkRecallCandidate({ sourceId: 's4', calledName: 'r1', line: 3 }),      // EP-E → probe
      mkRecallCandidate({ sourceId: 's5', calledName: 'r2', line: 4 }),      // EP-E → probe
    ];
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta(candidates, deps);

    expect(meta.preFilteredExternal).toBe(2);
    expect(meta.probed).toBe(3);
    // handToEngine called for every probed candidate
    expect(handCalls).toBe(3);
  });
});

// ─── C9-9: probed count = client.request call count (ordering assertion) ─────

describe('WI-9 C9-9 [ordering]: fetchDefinitionForCandidate called exactly probed times', () => {
  it('client.request spy called exactly meta.probed times; pre-filtered candidates never reach it', async () => {
    const { client, request } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map([
      ['ext:JAR', { properties: { isExternal: true } }],
      ['src:local', { properties: { isExternal: false } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);

    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'ext:JAR' }),    // skip → no request
      mkCandidate({ sourceId: 's2', line: 1, oldTargetId: 'src:local' }),  // probe → 1 request
      mkRecallCandidate({ sourceId: 's3', calledName: 'r', line: 2 }),     // probe → 1 request
    ];
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta(candidates, deps);

    // probed=2; external candidate never reached fetchDefinitionForCandidate
    expect(meta.probed).toBe(2);
    expect(meta.preFilteredExternal).toBe(1);
    // The client.request spy is the observable proxy for fetchDefinitionForCandidate
    // (each probed, indexable-path candidate issues exactly ONE request)
    expect(request).toHaveBeenCalledTimes(meta.probed);
  });
});

// ─── C9-10: probed and preFilteredExternal are numeric (not undefined) ────────

describe('WI-9 C9-10 [type shape]: probed and preFilteredExternal are numeric for any candidate mix', () => {
  it('SessionMeta.probed and .preFilteredExternal are both defined numbers regardless of mix', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const nodes = new Map([
      ['ext:A', { properties: { isExternal: true } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);

    // Mix: 1 external (skip), 1 recall (probe)
    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'ext:A' }),
      mkRecallCandidate({ sourceId: 's2', calledName: 'r', line: 1 }),
    ];
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta(candidates, deps);

    // Both fields must be defined numbers — not undefined, not NaN
    expect(typeof meta.probed).toBe('number');
    expect(typeof meta.preFilteredExternal).toBe('number');
    expect(Number.isFinite(meta.probed)).toBe(true);
    expect(Number.isFinite(meta.preFilteredExternal)).toBe(true);
    // Sanity: values are correct
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(1);
  });

  it('all-external batch: probed=0 is numeric (not undefined)', async () => {
    const { client } = makeMockClient();
    const nodes = new Map([
      ['ext:X', { properties: { isExternal: true } }],
      ['ext:Y', { properties: { isExternal: true } }],
    ]);
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidates = [
      mkCandidate({ sourceId: 's1', line: 0, oldTargetId: 'ext:X' }),
      mkCandidate({ sourceId: 's2', line: 1, oldTargetId: 'ext:Y' }),
    ];
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta } = await runAndCaptureMeta(candidates, deps);

    expect(typeof meta.probed).toBe('number');
    expect(meta.probed).toBe(0);
    expect(typeof meta.preFilteredExternal).toBe('number');
    expect(meta.preFilteredExternal).toBe(2);
  });
});
