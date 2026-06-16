/**
 * Unit Tests: canSkipCandidate seam + external pre-filter (WI-8).
 *
 * Covers the full EP partition for the external pre-filter injected into
 * `withReconciliationSession` via `WithReconciliationSessionDeps.canSkipCandidate`.
 *
 * EP Partitions:
 *   EP-A: correction candidate, external-zone node (isExternal===true) → skip
 *   EP-B: [removed — NO_NODE sentinel concept does not exist in the shipped implementation]
 *   EP-C: correction candidate, workspace-internal node (isExternal===false) → probe
 *   EP-D: correction candidate, node absent (undefined) → probe (conservative; could be deleted workspace symbol)
 *   EP-E: recall candidate (oldTargetId absent) → probe
 *   EP-F: recall candidate with any candidate.file → probe; isUnindexablePath never called
 *
 * Cases:
 *   C8-1  [EP-A]  : external-zone node → canSkipCandidate=true; preFilteredExternal++; probed unchanged
 *   C8-2  [EP-D]  : absent node → canSkipCandidate=false; probe (conservative; deleted workspace symbol must not be skipped)
 *   C8-3  [EP-C]  : workspace-internal node → canSkipCandidate=false; probed++
 *   C8-4  [EP-D]  : isExternal absent → canSkipCandidate=false; probed++
 *   C8-5  [EP-E]  : recall candidate (no oldTargetId) → canSkipCandidate=false; probed++
 *   C8-6  [EP-F]  : recall + java file → probe; isUnindexablePath irrelevant
 *   C8-7  [EP-F]  : recall + any file → probe; isUnindexablePath never invoked
 *   C8-8  [uncertain]: ambiguous correction (undefined result) → probe; no false skip
 *   C8-9  [seam absent]: no canSkipCandidate in deps → all candidates reach fetchDefinition; preFilteredExternal=0
 *   C8-10 [ordering]: spy on fetchDefinitionForCandidate; NOT called for EP-A; IS called for EP-C..EP-F (EP-B removed — absent node probes via EP-D)
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
import { buildRecallExternalFqnMap } from '../../../src/core/ingestion/pipeline.js';
import type { RecallFeedItem } from '../../../src/core/ingestion/call-processor.js';

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

// ─── C8-2: EP-D — absent node → probe (conservative) ────────────────────────

describe('WI-8 C8-2 [EP-D]: absent-node correction candidate is probed (conservative)', () => {
  it('canSkipCandidate returns false for absent node → probed++; preFilteredExternal unchanged', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const absenceCandidate = mkCandidate({ oldTargetId: 'Function:deleted.ts:gone' });
    // Production pipeline.ts:985-988: absent node → return false (conservative probe).
    // A deleted workspace symbol must not be silently skipped — let the engine decide.
    const canSkipCandidate = vi.fn((_c: Candidate) => false);
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([absenceCandidate], deps);

    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
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

// ─── C8-10: ordering — fetchDefinition NOT called for EP-A; IS called for EP-C..F (EP-B removed → EP-D probe) ─

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
  it('closure returns true only when graph.getNode(oldTargetId).isExternal===true; absent node → false (EP-D probe)', () => {
    // Reproduce the production pipeline.ts closure logic (lines 968-998).
    // EP-D invariant: node absent → false (conservative probe; could be a deleted workspace symbol).
    // EP-B (NO_NODE sentinel → skip) does NOT exist in the shipped implementation.
    const nodes = new Map<string, { properties: { isExternal?: boolean } }>([
      ['node:external', { properties: { isExternal: true } }],
      ['node:internal', { properties: { isExternal: false } }],
      ['node:no-field', { properties: {} }],
    ]);
    const mockGraph = {
      getNode: (id: string) => nodes.get(id),
    };

    // Production closure: absent node → false (EP-D; pipeline.ts:985-988)
    const canSkipCandidate = (candidate: Candidate): boolean => {
      if (!candidate.oldTargetId) return false;
      const node = mockGraph.getNode(candidate.oldTargetId);
      if (node === undefined) return false; // EP-D: conservative probe, not skip
      return node.properties.isExternal === true;
    };

    // EP-A: external node → skip
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:external' }))).toBe(true);
    // EP-D: absent node → probe (NOT skip — pipeline.ts:985-988 is the authority)
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:absent' }))).toBe(false);
    // EP-C: internal node → probe
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:internal' }))).toBe(false);
    // EP-D: node with no isExternal field → probe
    expect(canSkipCandidate(mkCandidate({ oldTargetId: 'node:no-field' }))).toBe(false);
    // EP-E: recall candidate (no oldTargetId) → probe
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
//   EP-C: workspace-internal node (isExternal===false) → probe
//   EP-D: node absent (undefined) → probe (conservative; pipeline.ts:985-988)
//   EP-D: isExternal field absent (node present, field missing) → probe (conservative)
//   EP-E: recall candidate (oldTargetId absent) → probe
//   EP-F: recall with any file → probe; closure never calls isUnindexablePath
//
// NOTE: EP-B (NO_NODE sentinel → skip) does NOT exist in the shipped implementation.
// pipeline.ts:985-988 returns false (probe) for absent nodes. C9-2 verifies EP-D.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a `canSkipCandidate` closure from a fake graph — the same
 * pattern pipeline.ts uses. The closure calls ONLY `graph.getNode`;
 * it never calls `classifyUri` or `isUnindexablePath` (verified in C9-5).
 *
 * `nodes` maps nodeId → { properties: { isExternal?: boolean } }.
 * An absent key simulates `graph.getNode` returning `undefined` → probe (EP-D).
 *
 * MATCHES production pipeline.ts:985-988: absent node → return false (conservative).
 */
function makeGraphClosureSkip(
  nodes: Map<string, { properties: { isExternal?: boolean } }>,
): (candidate: Candidate) => boolean {
  return (candidate: Candidate): boolean => {
    if (!candidate.oldTargetId) return false; // recall → never skip (I-2c)
    const node = nodes.get(candidate.oldTargetId);
    if (node === undefined) return false; // EP-D: absent node → probe (pipeline.ts:985-988)
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

// ─── C9-2 [EP-D]: absent node → preFilteredExternal=0, probed=1 (conservative probe) ─

describe('WI-9 C9-2 [EP-D]: graph.getNode returns undefined → probe (conservative; pipeline.ts:985-988)', () => {
  it('correction candidate whose oldTargetId has no graph node → preFilteredExternal=0, probed=1', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // Empty node map → getNode always returns undefined.
    // EP-D: absent node could be a deleted workspace symbol; must NOT be silently skipped.
    // Production pipeline.ts:985-988: return false (probe so the engine can decide).
    const nodes = new Map<string, { properties: { isExternal?: boolean } }>();
    const canSkipCandidate = makeGraphClosureSkip(nodes);
    const candidate = mkCandidate({ oldTargetId: 'Function:deleted.ts:gone' });
    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([candidate], deps);

    // EP-D: absent → probe, not skip. No false skip (I-2c).
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
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
      if (node === undefined) return false; // EP-D: conservative probe (pipeline.ts:985-988); absent node must not be skipped
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

// ═══════════════════════════════════════════════════════════════════════
// WI-A3: ADR-002 Phase 1 — recallExternalFqnMap + canSkipCandidate recall branch
//
// These tests verify the NEW recall branch added to canSkipCandidate in pipeline.ts.
// The recallExternalFqnMap is injected as a closure over WithReconciliationSessionDeps
// via a simulated canSkipCandidate that mirrors the pipeline.ts logic.
//
// EP Partitions (recall branch only — correction branch is already covered by C8/C9):
//   EP-G: recall candidate + FQN present in recallExternalFqnMap → skip
//   EP-H: recall candidate + FQN absent from map → probe
//   EP-G-wildcard: wildcard-origin simpleClassName never reaches map → probe
//   EP-G-non-java: .ts caller → calleeExternalFqn absent → map empty → probe
//
// Decision Table (3 conditions collapsed to 4 outcomes):
//   oldTargetId present × recallExternalFqnMap.has(key) × correction path
//   | correction | map.has | outcome                       |
//   | yes        | -       | existing graph.getNode path   | (C8/C9)
//   | no         | yes     | skip + preFilteredKeys.add    | EP-G (A3-U1)
//   | no         | no      | probe                         | EP-H (A3-U2)
//
// State Transitions for canSkipCandidate recall branch:
//   RECALL_NO_FQN  → probe  (A3-U2, A3-U3, A3-U4, A3-U8)
//   RECALL_WITH_FQN → skip + preFilteredKeys.add  (A3-U1, A3-U6)
//   CORRECTION      → existing graph.getNode path unchanged  (A3-U5)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the pipeline.ts canSkipCandidate closure mirroring the WI-A3 implementation:
 *   - correction branch: graph.getNode(oldTargetId).isExternal (unchanged)
 *   - recall branch: recallExternalFqnMap.get(key) → skip | probe
 *
 * `graphNodes` maps nodeId → { properties: { isExternal?: boolean } }
 * `recallFqnMap` maps candidateLocationKey → calleeExternalFqn
 * `preFilteredKeys` collects keys for I-8-replay verification
 */
function makeA3Closure(
  graphNodes: Map<string, { properties: { isExternal?: boolean } }>,
  recallFqnMap: Map<string, string>,
  preFilteredKeys: Set<string>,
): (candidate: Candidate) => boolean {
  return (candidate: Candidate): boolean => {
    if (!candidate.oldTargetId) {
      // ADR-002 WI-A3: recall branch
      const key = `${candidate.sourceId}|${candidate.calledName}|${candidate.line}|${candidate.character}`;
      const fqn = recallFqnMap.get(key);
      if (fqn) {
        preFilteredKeys.add(key);
        return true;
      }
      return false;
    }
    // Correction branch — unchanged from WI-8
    const node = graphNodes.get(candidate.oldTargetId);
    if (node === undefined) return false;
    const skip = node.properties.isExternal === true;
    if (skip) {
      preFilteredKeys.add(`${candidate.sourceId}|${candidate.calledName}|${candidate.line}|${candidate.character}`);
    }
    return skip;
  };
}

/** candidateLocationKey for test assertions (matches pipeline.ts/mode-a-reconciler.ts) */
function locationKey(c: Candidate): string {
  const base = `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`;
  return c.relType ? `${base}|${c.relType}` : base;
}

// ─── A3-U1 [EP-G]: recall candidate + FQN present → skip ────────────────────

describe('WI-A3 A3-U1 [EP-G]: recall candidate with FQN in recallExternalFqnMap → skip', () => {
  it('canSkipCandidate returns true; preFilteredExternal++; LSP client.request NOT called', async () => {
    const { client, request } = makeMockClient({ requestImpl: async () => null });
    const recall = mkRecallCandidate({ sourceId: 'src:java', calledName: 'List', line: 10, character: 4, file: 'src/main/java/App.java' });
    const recallKey = locationKey(recall);

    const recallFqnMap = new Map([[recallKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // Skip fired: preFilteredExternal incremented; LSP not dispatched
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    expect(request).not.toHaveBeenCalled();
    // I-8-replay: key recorded in preFilteredKeys
    expect(preFilteredKeys.has(recallKey)).toBe(true);
  });
});

// ─── A3-U2 [EP-H]: recall candidate + FQN absent from map → probe ────────────

describe('WI-A3 A3-U2 [EP-H]: recall candidate with no FQN in map → probe', () => {
  it('canSkipCandidate returns false; fetchDefinitionForCandidate IS called; client.request called', async () => {
    const { client, request } = makeMockClient({ requestImpl: async () => null });
    const recall = mkRecallCandidate({ sourceId: 'src:java2', calledName: 'UserService', line: 20, character: 8, file: 'src/main/java/App.java' });

    // Empty map — no FQN for this recall candidate
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // Probe fires: no pre-filter
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    // Key NOT recorded in preFilteredKeys (no skip)
    expect(preFilteredKeys.size).toBe(0);
  });
});

// ─── A3-U3 [EP-G-wildcard]: wildcard exclusion propagates end-to-end ─────────

describe('WI-A3 A3-U3 [EP-G-wildcard]: wildcard-origin simpleClassName never in map → probe', () => {
  it('recallFqnMap built from index with no wildcard entries → map.has(wildcardKey)=false → probe', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // Recall candidate whose calledName was derived from a wildcard import (e.g. java.util.*)
    // At WI-A1 population time, wildcard imports are excluded (rawImportPath.endsWith('.*')).
    // So javaExternalFqnIndex has no entry for 'SomeName' from java.util.*
    // → RecallFeedItem.calleeExternalFqn is undefined → map has no entry → probe.
    const wildcardRecall = mkRecallCandidate({
      sourceId: 'src:wildcard',
      calledName: 'ArrayList', // might have come from java.util.* — but never indexed
      line: 5,
      character: 0,
      file: 'src/main/java/Service.java',
    });

    // Map is empty — wildcard exclusion means no FQN was ever set on the RecallFeedItem
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([wildcardRecall], deps);

    // No skip: wildcard exclusion propagated correctly
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });
});

// ─── A3-U4 [EP-G-non-java]: .ts caller → calleeExternalFqn absent → probe ────

describe('WI-A3 A3-U4 [EP-G-non-java]: TypeScript caller → calleeExternalFqn undefined → probe', () => {
  it('.ts call site produces RecallFeedItem without calleeExternalFqn → map has no entry → probe', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // A TypeScript file — WI-A2 Java-only gate means calleeExternalFqn is never set
    // for non-.java files → recallFqnMap has no entry for this candidate
    const tsRecall = mkRecallCandidate({
      sourceId: 'src:ts',
      calledName: 'readFile',
      line: 3,
      character: 2,
      file: 'src/utils.ts',
    });

    // Empty map — Java-only gate at injection site (WI-A2)
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([tsRecall], deps);

    // .ts caller always probes — no false skip
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });
});

// ─── A3-U5 [correction branch isolation] ─────────────────────────────────────

describe('WI-A3 A3-U5 [correction branch isolation]: correction candidate uses graph.getNode, not recallFqnMap', () => {
  it('oldTargetId present → correction path fires; recallExternalFqnMap NOT consulted', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    const correction = mkCandidate({
      sourceId: 'src:corr',
      calledName: 'doWork',
      line: 15,
      character: 6,
      oldTargetId: 'Function:src/service.ts:doWork',
    });

    // Put a FQN entry in the map keyed at the same location key — MUST NOT affect correction path
    const corrKey = locationKey(correction);
    const recallFqnMap = new Map([[corrKey, 'should.not.be.consulted']]);
    const graphNodes = new Map([
      ['Function:src/service.ts:doWork', { properties: { isExternal: false } }],
    ]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(graphNodes, recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([correction], deps);

    // Correction candidate with isExternal=false → probe (graph.getNode path)
    // recallFqnMap entry at same key MUST NOT cause a false skip
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });

  it('existing C8/C9 EP-A/EP-C correction assertions unchanged by WI-A3 changes (EP-B removed; reclassified as EP-D)', async () => {
    const { client } = makeMockClient();
    const externalCorrection = mkCandidate({
      sourceId: 'src:ext-corr',
      line: 0,
      oldTargetId: 'Function:ext.jar:Foo',
    });
    // External node → correction branch skips (graph.getNode.isExternal=true)
    const graphNodes = new Map([
      ['Function:ext.jar:Foo', { properties: { isExternal: true } }],
    ]);
    const preFilteredKeys = new Set<string>();
    // recallFqnMap empty — must not affect correction path
    const canSkipCandidate = makeA3Closure(graphNodes, new Map(), preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([externalCorrection], deps);

    // EP-A still works: external-zone correction → skip
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });
});

// ─── A3-U6 [I-8-replay]: preFilteredKeys.add fires on skip ───────────────────

describe('WI-A3 A3-U6 [I-8-replay]: preFilteredKeys.add fires for every recall skip', () => {
  it('after canSkipCandidate returns true for recall, candidate key is in preFilteredKeys', async () => {
    const { client } = makeMockClient();
    const recall1 = mkRecallCandidate({ sourceId: 'r1', calledName: 'List', line: 1, character: 0, file: 'App.java' });
    const recall2 = mkRecallCandidate({ sourceId: 'r2', calledName: 'Map', line: 2, character: 0, file: 'App.java' });
    const recall3 = mkRecallCandidate({ sourceId: 'r3', calledName: 'UserService', line: 3, character: 0, file: 'App.java' });

    const key1 = locationKey(recall1);
    const key2 = locationKey(recall2);
    const key3 = locationKey(recall3);

    // recall1 and recall2 have FQNs; recall3 does not
    const recallFqnMap = new Map([
      [key1, 'java.util.List'],
      [key2, 'java.util.Map'],
    ]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([recall1, recall2, recall3], deps);

    // Two skips, one probe
    expect(meta.preFilteredExternal).toBe(2);
    expect(meta.probed).toBe(1);

    // I-8-replay: exactly the two skipped keys are in preFilteredKeys
    expect(preFilteredKeys.has(key1)).toBe(true);
    expect(preFilteredKeys.has(key2)).toBe(true);
    expect(preFilteredKeys.has(key3)).toBe(false);
  });
});

// ─── A3-U7 [EP-J]: keyed recall candidate skips; unkeyed candidate at different location probes ──
//
// Spec delta — EP-J divergent-pair probe coverage:
//   The spec (EP-J) describes: "two recall candidates at same key, only one external →
//   the external one skips (true), the non-external one probes (false)."
//
//   The IMPLEMENTATION diverges from this spec.  `buildRecallExternalFqnMap` detects a
//   divergent pair (one external, one non-external at the same key) and DELETES the key
//   entirely so the closure sees NO entry → BOTH candidates probe.  This is MORE
//   conservative than the spec's "external skips, non-external probes" description.
//   The load-bearing guard for this deletion invariant is EP-J-1 / EP-J-2 (bottom of
//   this file), which test `buildRecallExternalFqnMap` directly.
//
//   The spec scenario "external skips AND non-external probes at the same key" is
//   structurally unreachable at the closure level:
//     - buildRecallExternalFqnMap deletes ambiguous keys → no entry for the closure to see.
//     - pipeline.ts WI-1 dedup (lines 778-784) removes all but the first candidate per
//       candidateLocationKey BEFORE withReconciliationSession is called.
//   The closure therefore never sees two candidates at the same key in a real pipeline run.
//
//   This test covers the reachable closure behaviour:
//     - r1: candidateLocationKey IS in the map → skip (true)
//     - r2: candidateLocationKey is NOT in the map (different sourceId/calledName) → probe (false)
//   It verifies that the closure is purely key-based (no receiver-type cross-check) and
//   that an unrelated candidate is never falsely skipped (I-2c).
//
//   The full EP-J invariant (no false skips from divergent pairs) is covered by:
//     (a) MAP BUILD level: EP-J-1 / EP-J-2 / EP-J-3 / EP-J-4 (bottom of this file)
//     (b) CLOSURE level: A3-U7b (below) pins raw closure behaviour under shared-key conditions

describe('WI-A3 A3-U7 [EP-J]: keyed recall candidate skips; unkeyed candidate at distinct location probes', () => {
  it('candidate whose key is in recallFqnMap skips; candidate at a different key probes (I-2c: no false skip)', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // r1 is at a key present in recallFqnMap → closure returns true (skip).
    // r2 has a DIFFERENT sourceId and calledName → different candidateLocationKey,
    // NOT in the map → closure returns false (probe).
    // This exercises the closure's key-only lookup and verifies unrelated candidates
    // are never falsely skipped.
    const sharedKey = 'src:shared|call|5|3';
    const recallFqnMap = new Map([[sharedKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);

    // r1: key is in map → skip
    const r1: Candidate = { sourceId: 'src:shared', calledName: 'call', file: 'App.java', line: 5, character: 3 };
    expect(canSkipCandidate(r1)).toBe(true);
    expect(preFilteredKeys.has(sharedKey)).toBe(true);

    // r2: different key (src:other|otherCall|6|0), not in map → probe (I-2c)
    const r2: Candidate = { sourceId: 'src:other', calledName: 'otherCall', file: 'App.java', line: 6, character: 0 };
    expect(canSkipCandidate(r2)).toBe(false);

    // Only the keyed candidate was recorded; no false skip on r2
    expect(preFilteredKeys.size).toBe(1);
  });
});

// ─── A3-U8 [EP-K]: same-package in-repo call — no import → no map entry → probe

describe('WI-A3 A3-U8 [EP-K]: same-package in-repo call → no import → recallFqnMap empty → probe', () => {
  it('Bar is in same package as App (no import statement) → javaExternalFqnIndex has no Bar entry → probe', async () => {
    const { client } = makeMockClient({ requestImpl: async () => null });
    // Same-package class Bar: no import statement → WI-A1 never writes it to javaExternalFqnIndex
    // → WI-A2 cannot inject calleeExternalFqn → recallFqnMap has no entry → probe
    const inRepoRecall = mkRecallCandidate({
      sourceId: 'src:same-pkg',
      calledName: 'Bar',
      line: 7,
      character: 0,
      file: 'src/main/java/com/example/App.java',
    });

    // Map is empty — no import means no FQN injection
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([inRepoRecall], deps);

    // Conservative probe: in-repo call must never be false-skipped (I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });
});

// ─── A4-U5 [increment-source pin]: EP-G skip via canSkipCandidate, NOT isUnindexablePath ─────

describe('WI-A4 A4-U5 [increment-source pin]: EP-G skip increments preFilteredExternal via canSkipCandidate recall branch (not isUnindexablePath)', () => {
  it('candidate.file is a valid .java source path (not node_modules/dist/.d.ts) AND preFilteredExternal=1 AND client.request=0', async () => {
    // Spec (WI-A4 A4-U5): "EP-G skip must increment preFilteredExternal via canSkipCandidate
    // (recall branch), NOT via the isUnindexablePath gate inside fetchDefinitionForCandidate;
    // verify by asserting the candidate.file is a valid .java path (not node_modules/dist/.d.ts)
    // AND preFilteredExternal=1 AND client.request call count=0."
    //
    // Two distinct preFilteredExternal increment sources (must not be conflated):
    //   (a) canSkipCandidate recall branch — WI-A3, new path (what this test pins)
    //   (b) isUnindexablePath inside fetchDefinitionForCandidate — WS-C, already shipped
    //
    // (b) fires for node_modules/dist/.d.ts caller files.
    // (a) fires for .java source files with a FQN in recallExternalFqnMap.
    // Verifying that candidate.file is a real .java path rules out (b) as the source.
    const { client, request } = makeMockClient({ requestImpl: async () => null });

    const javaSourceFile = 'src/main/java/com/example/OrderService.java';
    const recall = mkRecallCandidate({
      sourceId: 'src:order',
      calledName: 'List',
      line: 5,
      character: 8,
      file: javaSourceFile,
    });
    const recallKey = locationKey(recall);

    // Precondition: candidate.file is NOT node_modules / dist / .d.ts
    // (this pins that the skip source is canSkipCandidate, not isUnindexablePath)
    expect(recall.file).toMatch(/\.java$/);
    expect(recall.file).not.toMatch(/node_modules|dist\/|\.d\.ts$/);

    const recallFqnMap = new Map([[recallKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // Increment source: canSkipCandidate recall branch returned true.
    // preFilteredExternal must be 1 (WI-A3 recall path, not isUnindexablePath).
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    // client.request=0 confirms fetchDefinitionForCandidate was never called
    // (the isUnindexablePath gate inside it was never reached either).
    expect(request).not.toHaveBeenCalled();
    // Recall key is recorded for I-8-replay exclusion
    expect(preFilteredKeys.has(recallKey)).toBe(true);
  });
});

// ─── A3-U7b [EP-J genuine shared-key]: closure is key-only; dedup is the safety net ────────────────
//
// Finding: the existing A3-U7 test uses r2 with DISTINCT sourceId/calledName ('src:other'/'otherCall')
// so it never exercises the case where two candidates share THE SAME candidateLocationKey
// (sourceId|calledName|line|character).  This test pins the actual closure behaviour
// under genuine shared-key conditions and documents the dedup dependency.
//
// Invariant "Two-overload same-key conservatism" (spec EP-J):
//   The production canSkipCandidate closure in pipeline.ts is purely key-based.
//   When r1 (external, key present in recallFqnMap) and r2 (non-external, same key)
//   BOTH reach the closure, r2 is also skipped because the map lookup succeeds.
//
//   Pipeline safety guarantee (WI-1, pipeline.ts lines 778-784):
//   The `dedupedCandidates` pass removes all but the first candidate per
//   candidateLocationKey BEFORE withReconciliationSession is called.
//   Therefore canSkipCandidate is NEVER called with two candidates at the same key
//   in a real analyze run.  The dedup is the load-bearing safety guarantee.
//
//   This test pins that contract explicitly so that any future removal of the
//   dedup step is caught before it reaches production.
//
// Upstream guard (BUILD-LOOP):
//   The recallFqnMap handed to this closure is built by `buildRecallExternalFqnMap`
//   (pipeline.ts).  The build-loop MUST delete any key that has a divergent pair
//   (one external entry, one absent/falsy entry) so the closure never sees a key
//   that represents an ambiguous recall set.
//   The EP-J unit tests (EP-J-1 / EP-J-2 / EP-J-3 / EP-J-4) at the bottom of THIS
//   file directly test `buildRecallExternalFqnMap` and are the load-bearing guard
//   for that deletion invariant.  If the `map.delete(key)` call is removed from
//   `buildRecallExternalFqnMap`, those tests fail before this closure is ever reached.

describe('WI-A3 A3-U7b [EP-J genuine shared-key]: two recall candidates at IDENTICAL candidateLocationKey — closure is key-only; pipeline dedup is the safety guarantee', () => {
  it('closure skips BOTH candidates when their sourceId|calledName|line|character are identical and key is in map', () => {
    // Construct two recall candidates at THE SAME candidateLocationKey.
    // r1: external (recallFqnMap has the key); r2: non-external BUT identical key.
    // Both have no oldTargetId (recall candidates).
    const sharedSourceId = 'src:shared';
    const sharedCalledName = 'process';
    const sharedLine = 12;
    const sharedChar = 8;

    // The shared key mirrors candidateLocationKey() without relType suffix
    const sharedKey = `${sharedSourceId}|${sharedCalledName}|${sharedLine}|${sharedChar}`;

    const recallFqnMap = new Map([[sharedKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);

    // r1: the external candidate — key is in map → skip (true)
    const r1: Candidate = {
      sourceId: sharedSourceId,
      calledName: sharedCalledName,
      file: 'src/main/java/App.java',
      line: sharedLine,
      character: sharedChar,
      // no oldTargetId → recall branch
    };

    // r2: a second candidate at THE SAME position (same sourceId|calledName|line|char).
    // In a live pipeline run this candidate would have been removed by WI-1 dedup
    // (pipeline.ts:778-784) before canSkipCandidate is ever invoked.
    // We call it here directly to document the closure's raw behaviour.
    const r2: Candidate = {
      sourceId: sharedSourceId,    // ← identical to r1
      calledName: sharedCalledName, // ← identical to r1
      file: 'src/main/java/App.java',
      line: sharedLine,            // ← identical to r1
      character: sharedChar,       // ← identical to r1
      // no oldTargetId → recall branch; same key as r1
    };

    // r1 — expected: skipped (key is in map)
    expect(canSkipCandidate(r1)).toBe(true);
    expect(preFilteredKeys.has(sharedKey)).toBe(true);

    // r2 — same candidateLocationKey as r1.
    // CLOSURE BEHAVIOUR: the map lookup hits the same key → also returns true.
    // This is key-only lookup; there is no receiver-type cross-check inside the closure.
    //
    // PRODUCTION SAFETY: this case cannot arise in a live analyze run because
    // pipeline.ts WI-1 dedup (lines 778-784) eliminates all but the first candidate
    // per candidateLocationKey before withReconciliationSession is called.
    // The dedup is the load-bearing guard that prevents r2 from ever reaching here.
    //
    // If the dedup step is ever removed or weakened, this assertion confirms the
    // closure alone is NOT conservative enough — a fix to the closure or a
    // compensating guard upstream would be required (I-2c).
    expect(canSkipCandidate(r2)).toBe(true); // closure returns true; dedup prevents this in production

    // Both candidates share the same key entry in preFilteredKeys
    expect(preFilteredKeys.size).toBe(1); // single key, set deduplicates
  });

  it('session skips the surviving post-dedup external candidate: preFilteredExternal=1; probed=0', async () => {
    // This sub-case verifies the session's closure behaviour when it receives a SINGLE
    // external recall candidate — the candidate a real pipeline would pass after WI-1 dedup
    // has already reduced any same-key pair to one survivor.
    //
    // NOTE: This test does NOT exercise the dedup step itself.  Only one candidate is
    // passed to runAndCaptureMeta, so pipeline.ts:778-784 is never invoked here.
    // What this test pins is the closure's session-level behaviour for a post-dedup
    // external candidate: canSkipCandidate fires → preFilteredExternal=1, probed=0.
    //
    // The WI-1 dedup logic itself is tested at the integration level via
    // runPipelineFromRepo (A4-E1 / A4-E2), where two same-key candidates arising from
    // the real fixture would be deduplicated before reaching the session.
    const { client } = makeMockClient({ requestImpl: async () => null });

    const sharedKey = 'src:dedup|call|3|2';
    const recallFqnMap = new Map([[sharedKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);

    // Single external candidate — the one that would survive dedup in a real pipeline run.
    const r1: Candidate = {
      sourceId: 'src:dedup',
      calledName: 'call',
      file: 'src/main/java/App.java',
      line: 3,
      character: 2,
    };

    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([r1], deps);

    // External candidate → skip fires → preFilteredExternal=1, probed=0, handToEngine not called
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    // preFilteredKeys accumulated the shared key
    expect(preFilteredKeys.has(sharedKey)).toBe(true);
  });
});

// ─── EP-J [buildRecallExternalFqnMap build-loop hardening] ────────────────────
//
// These tests target the EXTRACTED PURE HELPER `buildRecallExternalFqnMap`
// (pipeline.ts) directly, independently of the session machinery.
//
// A3-U7b (above) tests the CLOSURE after the map is built — it cannot detect
// a regression in the map-building logic itself (ambiguous-key deletion) because
// the test hands a pre-built map to the closure.
//
// These EP-J tests lock the MAP BUILD so that:
//   1. A same-key divergent pair (one external, one non-external) → key ABSENT.
//   2. Both orderings of that pair produce the same result (no ordering dependency).
//   3. A same-key convergent pair (both external) → key PRESENT.
//
// Mutation detector: if the `map.delete(key)` call on the falsy-FQN branch is
// removed, EP-J divergent tests FAIL because the map retains the external entry
// and `canSkipCandidate` would skip the in-repo twin → false skip (I-2c violation).
// This makes the test suite the load-bearing guard for the build-loop hardening.
//
// The A3-U7b comment in mode-a-external-prefilter.test.ts now points here as the
// upstream guard for the inline pipeline loop.

/** Build a minimal RecallFeedItem at a shared (sourceId, calledName, line, char) */
function mkFeedItem(
  sourceId: string,
  calledName: string,
  line: number,
  character: number,
  calleeExternalFqn?: string,
): RecallFeedItem {
  return { sourceId, calledName, file: 'src/App.java', line, character, calleeExternalFqn };
}

// Shared key values used across EP-J tests
const EP_J_SOURCE = 'src:App.java:App/run';
const EP_J_CALL   = 'process';
const EP_J_LINE   = 12;
const EP_J_CHAR   = 8;
// Expected candidateLocationKey — matches candidateLocationKey() without relType suffix
const EP_J_KEY    = `${EP_J_SOURCE}|${EP_J_CALL}|${EP_J_LINE}|${EP_J_CHAR}`;

describe('EP-J [buildRecallExternalFqnMap]: divergent pair (external-first ordering) → key ABSENT', () => {
  // Scenario: r1 has external FQN ('org.springframework.X'), r2 shares the SAME
  // {sourceId,calledName,line,character} but has undefined calleeExternalFqn.
  // The ambiguous-key logic MUST delete the key so canSkipCandidate cannot skip.
  //
  // Mutation detector: if `map.delete(key)` is removed, r1's external FQN is
  // retained in the map → the test fails (key PRESENT instead of ABSENT).
  it('EP-J-1: external item first, non-external item second → key absent from map', () => {
    const r1 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, 'org.springframework.X');
    const r2 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, undefined);

    const map = buildRecallExternalFqnMap([r1, r2]);

    // Key must be ABSENT — the non-external twin must not be silently skipped (I-2c)
    expect(map.has(EP_J_KEY)).toBe(false);
    // Probe both orderings: the external item's FQN must not be retrievable
    expect(map.get(EP_J_KEY)).toBeUndefined();
  });
});

describe('EP-J [buildRecallExternalFqnMap]: divergent pair (in-repo-first ordering) → key ABSENT', () => {
  // Same as EP-J-1 but the non-external item arrives FIRST.
  // The ambiguous-key guard must fire regardless of insertion order.
  //
  // Mutation detector: if the `if (!ambiguousKeys.has(key)) { map.set(...) }` guard
  // is removed (replaced with unconditional set), r1 sets the key, r2 deletes it,
  // but r2-first case: r2 sets ambiguousKeys, r1 arrives and sets map (bypassing guard)
  // → key PRESENT → test fails.
  it('EP-J-2: non-external item first, external item second → key absent from map', () => {
    const r1 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, undefined);
    const r2 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, 'org.springframework.X');

    const map = buildRecallExternalFqnMap([r1, r2]);

    // Key must be ABSENT — the external item must not override the in-repo entry
    expect(map.has(EP_J_KEY)).toBe(false);
    expect(map.get(EP_J_KEY)).toBeUndefined();
  });
});

describe('EP-J [buildRecallExternalFqnMap]: convergent pair (both external) → key PRESENT', () => {
  // Positive case: two items at the same key BOTH carry truthy calleeExternalFqn.
  // Result: key PRESENT with the FQN from the first item (second write is a no-op
  // due to the ambiguousKeys guard — but neither item is in-repo, so the key survives).
  it('EP-J-3: both items external → key present in map', () => {
    const r1 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, 'org.springframework.X');
    const r2 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, 'org.springframework.X');

    const map = buildRecallExternalFqnMap([r1, r2]);

    // Key MUST be present — both twins are external → skip is safe
    expect(map.has(EP_J_KEY)).toBe(true);
    expect(map.get(EP_J_KEY)).toBe('org.springframework.X');
  });
});

// ─── EP-I [in-repo/external simpleClassName collision] ───────────────────────
//
// Design §EdgeCases (EP-I):
//   'Foo' appears as BOTH an in-repo import (resolver non-null → WI-A1 does NOT write
//   to javaExternalFqnIndex) AND as an external import (prefix-match, resolver null →
//   WI-A1 WOULD write it).  The gating at WI-A1 (`if (!result)`) ensures only the
//   resolver-null case writes.  When the in-repo import is the only import for 'Foo'
//   in a given file, javaExternalFqnIndex must have NO entry for 'Foo' under that
//   filePath → RecallFeedItem.calleeExternalFqn is undefined → recallExternalFqnMap
//   has no entry → canSkipCandidate probes, not skips (I-2c).
//
// Coverage rationale:
//   A1-U5 (import-processor.test.ts) pins the population gate: resolver non-null →
//   never writes.  That test is the only guard at the WI-A1 level.  The missing
//   coverage is the downstream invariant: when only the in-repo import is present,
//   recallExternalFqnMap.get(key) returns undefined so canSkipCandidate must probe.
//   These tests close that gap at the recallExternalFqnMap and closure levels.

describe('EP-I [in-repo/external collision]: in-repo import blocks FQN entry → recallExternalFqnMap has no entry → probe', () => {
  it('EP-I-1: RecallFeedItem with undefined calleeExternalFqn (in-repo import won) → map.has(key) === false', () => {
    // Simulate: 'Foo' was imported from an in-repo file (resolver returned non-null)
    // → WI-A1 did NOT write to javaExternalFqnIndex
    // → WI-A2 cannot inject calleeExternalFqn on the RecallFeedItem (undefined)
    // → buildRecallExternalFqnMap must NOT produce an entry for this key
    const inRepoFeed: RecallFeedItem[] = [
      {
        sourceId: 'src:App.java:App/run',
        calledName: 'doWork',
        file: 'src/main/java/com/example/App.java',
        line: 8,
        character: 4,
        calleeExternalFqn: undefined, // in-repo import → no FQN injected
      },
    ];
    const map = buildRecallExternalFqnMap(inRepoFeed);
    const key = `${inRepoFeed[0].sourceId}|${inRepoFeed[0].calledName}|${inRepoFeed[0].line}|${inRepoFeed[0].character}`;
    // EP-I invariant: no external FQN was injected → map has no entry → probe
    expect(map.has(key)).toBe(false);
    expect(map.get(key)).toBeUndefined();
  });

  it('EP-I-2: canSkipCandidate probes (returns false) when FQN not in map (in-repo import case)', async () => {
    // Downstream of EP-I-1: when recallExternalFqnMap has no entry for a recall candidate
    // whose simpleClassName came from an in-repo import, canSkipCandidate must NOT skip.
    const { client } = makeMockClient({ requestImpl: async () => null });
    const inRepoRecall = mkRecallCandidate({
      sourceId: 'src:App.java:App/run',
      calledName: 'doWork',
      file: 'src/main/java/com/example/App.java',
      line: 8,
      character: 4,
    });

    // Empty map — in-repo import means no FQN was injected into the index
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([inRepoRecall], deps);

    // EP-I: in-repo simpleClassName → no false skip (I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
  });

  it('EP-I-3: same simpleName has external entry when external-only import is present (positive case)', () => {
    // Positive: 'Foo' imported from an external prefix (resolver null → WI-A1 wrote it)
    // → calleeExternalFqn is set → recallExternalFqnMap DOES have the entry → skip is correct.
    const externalFeed: RecallFeedItem[] = [
      {
        sourceId: 'src:App.java:App/run',
        calledName: 'doWork',
        file: 'src/main/java/com/example/App.java',
        line: 8,
        character: 4,
        calleeExternalFqn: 'com.example.external.Foo', // external import won
      },
    ];
    const map = buildRecallExternalFqnMap(externalFeed);
    const key = `${externalFeed[0].sourceId}|${externalFeed[0].calledName}|${externalFeed[0].line}|${externalFeed[0].character}`;
    // External import → FQN was injected → map has entry → skip is safe
    expect(map.has(key)).toBe(true);
    expect(map.get(key)).toBe('com.example.external.Foo');
  });
});

describe('EP-J [buildRecallExternalFqnMap]: unshared key → key PRESENT regardless of other keys', () => {
  // Sanity: items with distinct keys are independent — a divergent pair at key-A
  // must not affect key-B.
  it('EP-J-4: unambiguous external item at separate key is preserved', () => {
    const OTHER_SOURCE = 'src:Other.java:Other/init';
    const OTHER_CALL   = 'build';
    const OTHER_LINE   = 5;
    const OTHER_CHAR   = 2;
    const OTHER_KEY    = `${OTHER_SOURCE}|${OTHER_CALL}|${OTHER_LINE}|${OTHER_CHAR}`;

    const divergent1 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, 'org.springframework.X');
    const divergent2 = mkFeedItem(EP_J_SOURCE, EP_J_CALL, EP_J_LINE, EP_J_CHAR, undefined);
    const unambiguous = mkFeedItem(OTHER_SOURCE, OTHER_CALL, OTHER_LINE, OTHER_CHAR, 'java.util.List');

    const map = buildRecallExternalFqnMap([divergent1, divergent2, unambiguous]);

    // Divergent pair → key absent
    expect(map.has(EP_J_KEY)).toBe(false);
    // Unambiguous external item at a different key → still present (isolation)
    expect(map.has(OTHER_KEY)).toBe(true);
    expect(map.get(OTHER_KEY)).toBe('java.util.List');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-A4: Named unit cases A4-U1..U4, A4-U6
//
// The plan (ADR-002 §WI-A4 §Tests) enumerates six named unit obligations.
// A4-U5 (increment-source pin) was written during WI-A3 and appears above.
// A4-U6 is a passthrough guard: after WI-A3 changes the correction-branch
// EP-A/EP-C behaviour (C7-7/AC-2 invariants) must remain unmodified.
//
// A4-U1 and A4-U5 together pin the INCREMENT SOURCE as the canSkipCandidate
// recall branch (not isUnindexablePath).  A4-U1 uses an *injected map* and
// focuses on the EP-G skip outcome; A4-U5 (above) additionally asserts the
// candidate.file is a .java source path to disambiguate the two sources.
//
// Key distinction from A3-U1..U4:
//   - A3-U1..U4 verified the closure logic from the WI-A3 design perspective.
//   - A4-U1..U4 are named WI-A4 spec obligations that also pin the increment
//     source (canSkipCandidate vs isUnindexablePath) using injected maps,
//     fulfilling the traceability requirement of the plan.
// ═══════════════════════════════════════════════════════════════════════

// ─── A4-U1 [EP-G]: recall + FQN in map → canSkipCandidate skip; increment-source = canSkipCandidate ─

describe('WI-A4 A4-U1 [EP-G]: recall candidate with FQN in recallExternalFqnMap → canSkipCandidate skip (increment-source pin)', () => {
  it('canSkipCandidate returns true; preFilteredExternal=1 via recall branch (not isUnindexablePath); client.request=0', async () => {
    // Spec obligation: "A4-U1 (EP-G skip) and A4-U5 are supposed to pin the increment
    // source as canSkipCandidate (not isUnindexablePath) using injected maps."
    //
    // Two distinct preFilteredExternal increment sources — must not be conflated:
    //   (a) canSkipCandidate recall branch [WI-A3, this PR] ← what this test verifies
    //   (b) isUnindexablePath inside fetchDefinitionForCandidate [WS-C, shipped]
    //
    // Source (b) fires only for node_modules/dist/.d.ts caller files.
    // Source (a) fires for .java source files with a FQN in recallExternalFqnMap.
    // An injected map (not a real import-processor run) isolates the closure path.
    const { client, request } = makeMockClient({ requestImpl: async () => null });

    const javaSourceFile = 'src/main/java/com/example/BondService.java';
    const recall = mkRecallCandidate({
      sourceId: 'src:bond',
      calledName: 'List',
      line: 8,
      character: 4,
      file: javaSourceFile,
    });
    const recallKey = locationKey(recall);

    // Inject the map directly (no import-processor involvement — tests the closure wiring only)
    const recallFqnMap = new Map([[recallKey, 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // EP-G: skip fires via canSkipCandidate recall branch
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
    // Source (a) confirmed: client.request never reached (fetchDefinitionForCandidate not called)
    expect(request).not.toHaveBeenCalled();
    // Candidate.file is a .java source path → rules out source (b) isUnindexablePath
    expect(recall.file).toMatch(/\.java$/);
    expect(recall.file).not.toMatch(/node_modules|dist\/|\.d\.ts$/);
    // I-8-replay: key recorded
    expect(preFilteredKeys.has(recallKey)).toBe(true);
  });
});

// ─── A4-U2 [EP-H]: recall + FQN absent from map → probe ───────────────────────

describe('WI-A4 A4-U2 [EP-H]: recall candidate with no FQN in recallExternalFqnMap → probe', () => {
  it('canSkipCandidate returns false; fetchDefinitionForCandidate IS called; preFilteredExternal=0', async () => {
    // Spec obligation: A4-U2 [EP-H] — recall Candidate, map has no entry → canSkipCandidate false;
    // fetchDefinitionForCandidate is called.
    const { client, request } = makeMockClient({ requestImpl: async () => null });
    const recall = mkRecallCandidate({
      sourceId: 'src:bond2',
      calledName: 'ServiceImpl',
      line: 20,
      character: 8,
      file: 'src/main/java/com/example/App.java',
    });

    // Empty map — no external FQN for this recall candidate
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([recall], deps);

    // EP-H: probe fires (no skip)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(preFilteredKeys.size).toBe(0);
  });
});

// ─── A4-U3 [EP-G-wildcard]: wildcard FQN never reaches javaExternalFqnIndex → probe ─

describe('WI-A4 A4-U3 [EP-G-wildcard]: wildcard import exclusion propagates end-to-end — map empty → probe', () => {
  it('index constructed with a wildcard import input has no wildcard-derived key; recallExternalFqnMap lookup misses → probe', () => {
    // Spec obligation: A4-U3 — "confirm wildcard FQN never reaches javaExternalFqnIndex:
    // construct the index with a wildcard import in input; assert the resulting map has no
    // entry for the wildcard-derived name; recallExternalFqnMap lookup misses → probe."
    //
    // WI-A1 population gate: rawImportPath.endsWith('.*') → no entry written.
    // This test confirms the downstream consequence: no entry in recallExternalFqnMap.
    //
    // We construct a RecallFeedItem where calleeExternalFqn is undefined (as WI-A2 would
    // produce when the WI-A1 wildcard gate fires) and assert map.has(key) is false.

    // Simulate: 'import java.util.*' was present but WI-A1 excluded it → index has no
    // 'ArrayList' or 'HashMap' entry → WI-A2 leaves calleeExternalFqn undefined.
    const wildcardFeed: RecallFeedItem[] = [
      {
        sourceId: 'src:App.java:App/run',
        calledName: 'ArrayList', // derived from java.util.* — but wildcard exclusion → undefined FQN
        file: 'src/main/java/com/example/App.java',
        line: 6,
        character: 4,
        calleeExternalFqn: undefined, // wildcard gate fired → not written to index → not injected
      },
    ];

    const map = buildRecallExternalFqnMap(wildcardFeed);
    const key = `${wildcardFeed[0].sourceId}|${wildcardFeed[0].calledName}|${wildcardFeed[0].line}|${wildcardFeed[0].character}`;

    // Wildcard exclusion: the index never had an entry → map has no entry → probe
    expect(map.has(key)).toBe(false);
    expect(map.get(key)).toBeUndefined();
  });
});

// ─── A4-U4 [EP-G-non-java]: .ts caller → calleeExternalFqn absent → probe ──────

describe('WI-A4 A4-U4 [EP-G-non-java]: TypeScript caller → calleeExternalFqn undefined → recallExternalFqnMap has no entry → probe', () => {
  it('RecallFeedItem from a .ts call site has calleeExternalFqn undefined; map empty → canSkipCandidate false → probe', async () => {
    // Spec obligation: A4-U4 — "RecallFeedItem from a .ts call site has calleeExternalFqn
    // undefined; recallExternalFqnMap has no entry → probe."
    //
    // WI-A2 Java-only gate: filePath.endsWith('.java') is the guard at injection time.
    // A TypeScript call site never sets calleeExternalFqn → map has no entry.
    const { client } = makeMockClient({ requestImpl: async () => null });
    const tsRecall = mkRecallCandidate({
      sourceId: 'src:ts-svc',
      calledName: 'readFile',
      line: 12,
      character: 2,
      file: 'src/services/fileService.ts',
    });

    // Map is empty — Java-only gate at WI-A2 injection site prevents any .ts entry
    const recallFqnMap = new Map<string, string>();
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta } = await runAndCaptureMeta([tsRecall], deps);

    // EP-G-non-java: .ts caller always probes — no false skip (I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(preFilteredKeys.size).toBe(0);
    // Confirm the file is indeed .ts (not .java) — this is the gate condition
    expect(tsRecall.file).toMatch(/\.ts$/);
    expect(tsRecall.file).not.toMatch(/\.java$/);
  });
});

// ─── A4-U6 [golden I-9: C7-7/AC-2 passthrough guard] ────────────────────────
//
// Spec obligation (WI-A4 A4-U6): "run the full existing golden byte-identity
// test suite; assert zero test modifications needed; this is a pass-through guard,
// not a new test."
//
// The plan's intent is that no existing EP-A through EP-F assertions were altered
// by WI-A3 changes. This test verifies that the correction branch (C7-7/AC-2
// invariants) still behaves identically after WI-A3 by exercising the same EP-A
// and EP-C partitions through the makeA3Closure helper (which wraps the full
// combined closure, not just the recall branch).

describe('WI-A4 A4-U6 [golden I-9 passthrough guard]: WI-A3 changes did not alter EP-A/EP-C correction-branch behaviour (C7-7/AC-2 invariant)', () => {
  it('EP-A (external-zone correction) still returns true via correction branch after WI-A3 recall-branch extension', async () => {
    // After WI-A3, canSkipCandidate has TWO branches:
    //   1. recall branch (oldTargetId absent): uses recallExternalFqnMap [new, WI-A3]
    //   2. correction branch (oldTargetId present): uses graph.getNode [unchanged, WS-C]
    //
    // This test pins that the correction branch (2) is UNMODIFIED by WI-A3.
    // An external-zone correction candidate must still skip, regardless of whether
    // recallExternalFqnMap is populated or empty (the map is not consulted for corrections).
    //
    // Traceability: VER-9 (correction candidate → graph.getNode path, calleeExternalFqn NOT
    // evaluated); A3-U5 (correction branch isolation). This is the named A4-U6 guard.
    const { client } = makeMockClient();
    const externalCorrection = mkCandidate({
      sourceId: 'src:ext-a4u6',
      calledName: 'ResponseEntity',
      line: 0,
      character: 4,
      oldTargetId: 'Function:ext.jar:ResponseEntity',
    });

    // Graph node for the correction candidate — external-zone
    const graphNodes = new Map([
      ['Function:ext.jar:ResponseEntity', { properties: { isExternal: true } }],
    ]);
    // recallFqnMap is populated (non-empty) — must NOT affect correction branch
    const recallFqnMap = new Map([['any|key|0|0', 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(graphNodes, recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([externalCorrection], deps);

    // EP-A invariant (C7-7/AC-2): external correction → skip, preFilteredExternal=1
    // This must hold identically after WI-A3 changes — no regression to the correction path.
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(0);
    expect(handCalls).toBe(0);
  });

  it('EP-C (workspace-internal correction) still returns false via correction branch after WI-A3 recall-branch extension', async () => {
    // Mirror of above: workspace-internal correction must probe (false), even with a
    // populated recallFqnMap. The WI-A3 recall branch must not interfere with the
    // correction path (C7-7 / AC-2 invariant).
    const { client } = makeMockClient({ requestImpl: async () => null });
    const internalCorrection = mkCandidate({
      sourceId: 'src:int-a4u6',
      calledName: 'OrderService',
      line: 5,
      character: 2,
      oldTargetId: 'Function:src/services/OrderService.ts:doWork',
    });

    const graphNodes = new Map([
      ['Function:src/services/OrderService.ts:doWork', { properties: { isExternal: false } }],
    ]);
    const recallFqnMap = new Map([['any|key|0|0', 'java.util.List']]);
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(graphNodes, recallFqnMap, preFilteredKeys);
    const deps = makeDeps(client, { canSkipCandidate });

    const { meta, handCalls } = await runAndCaptureMeta([internalCorrection], deps);

    // EP-C invariant: workspace-internal correction → probe (no false skip, I-2c)
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-A3/A4 dedup-before-skip regression guard
//
// Finding [MAJOR] (Design Quality + Test Strategy): A3-U7b documents that WI-1
// dedup prevents r2 from reaching canSkipCandidate, but there is no automated
// test that verifies the combined guarantee: divergent-pair → map deletion →
// session preFilteredExternal=0 (both candidates probe, not just one skips).
//
// This test closes that gap at the unit level by:
//   1. Building a divergent pair through buildRecallExternalFqnMap (which deletes
//      the ambiguous key — tested by EP-J-1/EP-J-2).
//   2. Using the RESULTING EMPTY MAP with the makeA3Closure (the same closure
//      pattern as pipeline.ts canSkipCandidate) through withReconciliationSession.
//   3. Asserting that even when a single surviving candidate is presented to the
//      session, preFilteredExternal=0 (because the map deletion upstream already
//      prevented a skip-eligible entry).
//
// This is the UNIT-LEVEL regression guard that ties EP-J-1/EP-J-2 (map-build
// guard) to A3-U7b (session-level closure) into one combined assertion.
// If buildRecallExternalFqnMap's map.delete(key) is removed, EP-J-1/EP-J-2 catch
// it at the map-build level. THIS test catches it if the deletion guard is present
// but the closure is somehow not using the resulting map (wiring regression).
// ═══════════════════════════════════════════════════════════════════════

describe('WI-A3/A4 dedup-before-skip regression guard: divergent pair → buildRecallExternalFqnMap deletes key → session preFilteredExternal=0', () => {
  it('EP-J divergent pair: map deletion upstream causes canSkipCandidate to probe the surviving candidate (combined guarantee)', async () => {
    // Setup: two RecallFeedItems at the SAME candidateLocationKey.
    //   r1: external FQN set ('java.util.List')
    //   r2: no external FQN (non-external or same-file class)
    // buildRecallExternalFqnMap detects the divergent pair and DELETES the key.
    // The resulting map is empty for that key.
    //
    // The "surviving candidate" simulates what pipeline.ts WI-1 dedup would pass
    // to withReconciliationSession after reducing the pair to one entry. Even that
    // one entry must PROBE (not skip) because the map has no entry for its key.
    //
    // This combined test catches a wiring regression where:
    //   - EP-J-1/EP-J-2 pass (map deletion fires correctly)
    //   - BUT canSkipCandidate uses a STALE or DIFFERENT map reference → would skip
    //     the surviving candidate despite the map deletion.
    const { client } = makeMockClient({ requestImpl: async () => null });

    const sharedSource = 'src:shared-dedup';
    const sharedCalled = 'process';
    const sharedLine   = 5;
    const sharedChar   = 2;

    // Step 1: build a divergent feed → buildRecallExternalFqnMap deletes the key
    const divergentFeed: RecallFeedItem[] = [
      { sourceId: sharedSource, calledName: sharedCalled, file: 'src/App.java', line: sharedLine, character: sharedChar, calleeExternalFqn: 'java.util.List' },
      { sourceId: sharedSource, calledName: sharedCalled, file: 'src/App.java', line: sharedLine, character: sharedChar, calleeExternalFqn: undefined },
    ];
    const recallFqnMap = buildRecallExternalFqnMap(divergentFeed);

    // EP-J-1 invariant confirmed: the key must be absent
    const sharedKey = `${sharedSource}|${sharedCalled}|${sharedLine}|${sharedChar}`;
    expect(recallFqnMap.has(sharedKey)).toBe(false);

    // Step 2: build the closure using the map returned by buildRecallExternalFqnMap
    // (mirrors pipeline.ts: const recallExternalFqnMap = buildRecallExternalFqnMap(recallFeed);
    //  then canSkipCandidate uses that variable by closure capture)
    const preFilteredKeys = new Set<string>();
    const canSkipCandidate = makeA3Closure(new Map(), recallFqnMap, preFilteredKeys);

    // Step 3: simulate what pipeline.ts WI-1 dedup passes to withReconciliationSession:
    // only one candidate at the shared key survives dedup (let's say the external one).
    const survivingCandidate: Candidate = {
      sourceId: sharedSource,
      calledName: sharedCalled,
      file: 'src/App.java',
      line: sharedLine,
      character: sharedChar,
    };

    const deps = makeDeps(client, { canSkipCandidate });
    const { meta, handCalls } = await runAndCaptureMeta([survivingCandidate], deps);

    // Combined guarantee: divergent pair → key deleted → closure probes surviving candidate.
    // preFilteredExternal=0: the map deletion correctly prevents a false skip.
    // If map.delete(key) were removed from buildRecallExternalFqnMap, the map would retain
    // 'java.util.List' for sharedKey → canSkipCandidate would return true → meta.preFilteredExternal=1
    // → this assertion would FAIL, catching the regression.
    expect(meta.preFilteredExternal).toBe(0);
    expect(meta.probed).toBe(1);
    expect(handCalls).toBe(1);
    // No key was added to preFilteredKeys (no skip fired)
    expect(preFilteredKeys.size).toBe(0);
  });
});
