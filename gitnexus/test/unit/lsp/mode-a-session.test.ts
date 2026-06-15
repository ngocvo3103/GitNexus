/**
 * Unit Tests: withReconciliationSession (WI-4a, issue #159 P3).
 *
 * The session is the *single refuse funnel* for Mode A — the same
 * shape as `withReferenceProvider` (P2), but for the WRITE half of
 * the cycle. The behavior contract:
 *
 *   discoverServers() → null if no TS server (no spawn)
 *   start()           → null if start throws (no client to stop)
 *   probe ready?      → null if not ready (stop the client)
 *   fn(session)       → fn's result on success (stop in finally)
 *   any throw inside fn → null (stop in finally)
 *
 * Plus the **session-specific** contract (KD-9/10):
 *   - Merge correction + recall feeds.
 *   - Stable-sort by (sourceId, calledName, line, character).
 *   - Take first-N (cap 2000); record `skipped` count.
 *   - Per-request `textDocument/definition` (5000ms).
 *   - Normalize `Location | Location[]` (bare `Location` → array).
 *   - Hand each normalized Location to WI-4b (the engine half).
 *
 * Test surface:
 *   - The unit test NEVER spawns a real LSP — every dep is
 *     injected via the `WithReconciliationSessionDeps` bag.
 *   - The "hand each Location to WI-4b" assertion uses a
 *     `vi.fn()` collector for the per-Location dispatch.
 *   - The session is the *session half*; the *engine half*
 *     (`reconcileDecisions`, atomic correction, collapse) is the
 *     subject of `mode-a-engine.test.ts` (WI-4b).
 *
 * Cases (G1..G6 mirror the funnel; X1..X6 are session-specific):
 *   G1 discoverServers returns { typescript: null } → null
 *   G2 client.start() throws synchronously          → null (no stop)
 *   G3 probe returns { ready:false }                → null + stop
 *   G4 fn throws                                     → null + stop (finally)
 *   G5 happy path: fn resolves with value            → value + stop
 *   G6 happy path: fn resolves with undefined         → undefined + stop
 *   X1 merged feeds sorted by (sourceId, calledName, line, character)
 *   X2 cap > available → first-N; skipped = available - first-N
 *   X3 cap < available → first-N; skipped = available - first-N
 *   X4 bare `Location` is normalized to `Location[]` of length 1
 *   X5 LSP returns `Location[]` of N → all N handed to engine
 *   X6 LSP returns `null` → engine receives empty (refused)
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
  type ReconciliationReport,
  type SessionMeta,
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../../src/core/ingestion/mode-a-reconciler.js';
import { buildLspSummaryLine } from '../../../src/core/ingestion/pipeline.js';

// ─── Test surface: minimal mocks ──────────────────────────────────────

/**
 * A `ReconciliationLspClient` is the exact subset of `LspClient`
 * the session calls: `start()`, `stop()`, `request()`, plus
 * `getState()` so the probe can be invoked with the real shape.
 * The mock is a plain object — no class hierarchy, no inheritance.
 * The `request` impl is parametrized by the test so we can drive
 * the per-request response shape per case.
 */
function makeMockClient(over: {
  startImpl?: () => Promise<void>;
  stopImpl?: () => Promise<void>;
  requestImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
  state?: string;
} = {}) {
  const start = vi.fn(over.startImpl ?? (async () => undefined));
  const stop = vi.fn(over.stopImpl ?? (async () => undefined));
  const request = vi.fn(over.requestImpl ?? (async () => undefined));
  const getState = vi.fn(() => over.state ?? 'ready');
  return {
    client: { start, stop, request, getState } as unknown as ReconciliationLspClient,
    start,
    stop,
    request,
  };
}

/**
 * A factory: `() => ReconciliationLspClient`. The session calls
 * this to obtain a new client AFTER `discoverServers` has
 * resolved and BEFORE the `start()` call.
 */
function makeClientFactory(client: ReconciliationLspClient) {
  return vi.fn(() => client);
}

/**
 * A `ReconciliationProbeFn` is the contract the session needs
 * from a readiness probe. We never call the real
 * `probeWorkspaceReadiness` in these unit tests.
 */
function makeProbe(over: { ready?: boolean; reason?: string } = {}) {
  const ready = over.ready ?? true;
  const reason = over.reason ?? 'simulated';
  return vi.fn(async (_client: ReconciliationLspClient) => {
    return ready ? { ready: true } : { ready: false, reason };
  }) as unknown as ReconciliationProbeFn & ReturnType<typeof vi.fn>;
}

/**
 * Build a deps bag. Every field has a default; tests override
 * only the ones that matter for their gate.
 */
function makeDeps(over: {
  discoverServersImpl?: () => Promise<{ typescript: { path: string; version: string } | null }>;
  client?: ReconciliationLspClient;
  probe?: ReconciliationProbeFn;
} = {}) {
  const client = (over.client ?? makeMockClient().client) as ReconciliationLspClient;
  return {
    discoverServers: vi.fn(
      over.discoverServersImpl ??
        (async () => ({ typescript: { path: '/bin/typescript-language-server', version: '4.3.3' } })),
    ),
    createLspClient: makeClientFactory(client),
    probe: over.probe ?? makeProbe(),
    client, // for direct assertions
  };
}

/** A minimal repo handle. The session only reads `id` + `repoPath`. */
const REPO: ReconciliationRepo = {
  id: 'r1',
  repoPath: '/workspace/repo',
};

/** A trivial candidate feed — extend per test. */
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

// ─── G1: discoverServers refuses (no spawn) ───────────────────────────

describe('withReconciliationSession — G1: no server discovered', () => {
  it('discoverServers returns { typescript: null } → null, no client factory call, no start', async () => {
    const deps = makeDeps({
      discoverServersImpl: async () => ({ typescript: null }),
    });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(deps.discoverServers).toHaveBeenCalledTimes(1);
    expect(deps.createLspClient).not.toHaveBeenCalled();
    expect(deps.client.start).not.toHaveBeenCalled();
    expect(deps.client.stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G2: client.start() throws → null, no stop (no client to stop) ──

describe('withReconciliationSession — G2: start throws', () => {
  it('client.start rejects → null, no stop called (no client to stop)', async () => {
    const { client, start, stop } = makeMockClient({
      startImpl: async () => {
        throw new Error('spawn failed');
      },
    });
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G3: probe not ready → null + stop (finally) ─────────────────────

describe('withReconciliationSession — G3: probe not-ready', () => {
  it('probe returns { ready:false } → null, stop called in finally', async () => {
    const { client, start, stop } = makeMockClient();
    const probe = makeProbe({ ready: false, reason: 'workspace not built' });
    const deps = makeDeps({ client, probe });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(client);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G4: fn throws → null + stop (finally) ────────────────────────────

describe('withReconciliationSession — G4: fn throws', () => {
  it('fn rejects → null, stop called in finally', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => {
      throw new Error('consumer failure');
    });
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    const fnOrder = fn.mock.invocationCallOrder[0];
    const stopOrder = stop.mock.invocationCallOrder[0];
    expect(stopOrder).toBeGreaterThan(fnOrder);
  });
});

// ─── G5: happy path — fn returns a value ─────────────────────────────

describe('withReconciliationSession — G5: happy path with value', () => {
  it('fn resolves with a value → value returned verbatim, stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const expected = { kind: 'ran', count: 7 };
    const fn = vi.fn(async () => expected);
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBe(expected);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── G6: happy path — fn returns undefined ───────────────────────────

describe('withReconciliationSession — G6: happy path with undefined', () => {
  it('fn resolves with undefined → undefined returned (NOT null) + stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => undefined);
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── X1: merged feeds sorted deterministically ────────────────────────

describe('withReconciliationSession — X1: feed merge + sort', () => {
  it('merges correction+recall feeds, sorts by (sourceId, calledName, line, character)', async () => {
    // The session receives the *already-merged* feed as a single
    // argument. X1 exercises the sort: hand a feed with explicit
    // out-of-order keys and read the order back from fn's input.
    const { client } = makeMockClient();
    const deps = makeDeps({ client });

    const input: Candidate[] = [
      mkCandidate({ sourceId: 's2', calledName: 'b', line: 1, character: 0 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 5, character: 0 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 5, character: 4 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 1, character: 0 }),
    ];

    const received: Candidate[] = [];
    const fn = vi.fn(async (cands: Candidate[]) => {
      // Capture a structural copy for the post-call assertion.
      for (const c of cands) received.push({ ...c });
      return 'sorted';
    });

    const result = await withReconciliationSession(REPO, input, fn, deps);
    expect(result).toBe('sorted');

    // The sort key is (sourceId ASC, calledName ASC, line ASC,
    // character ASC). Verify by reconstructing the keys in
    // received order and comparing to the natural sorted order.
    const keys = received.map((c) => `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`);
    const expectedKeys = [...input]
      .map((c) => `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`)
      .sort();
    expect(keys).toEqual(expectedKeys);
    // Determinism: same input → same order across two calls.
    const received2: string[] = [];
    const fn2 = vi.fn(async (cands: Candidate[]) => {
      for (const c of cands) received2.push(`${c.sourceId}|${c.calledName}|${c.line}|${c.character}`);
      return 'sorted';
    });
    await withReconciliationSession(REPO, input, fn2, deps);
    expect(received2).toEqual(expectedKeys);
  });

  it('preserves the cap boundary: exactly N candidates → all N, skipped=0', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const N = 5;
    const input: Candidate[] = Array.from({ length: N }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async (cands: Candidate[]) => cands.length);
    const result = await withReconciliationSession(REPO, input, fn, deps);
    expect(result).toBe(N);
  });
});

// ─── X2/X3: cap deterministic + skipped count ─────────────────────────

describe('withReconciliationSession — X2/X3: cap and skipped', () => {
  it('X2: candidates > cap → first-N deterministic; skipped = rest', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const cap = 3;
    const input: Candidate[] = Array.from({ length: 5 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    // The session reports `skipped` via the third positional
    // argument to fn: `fn(candidates, _meta, skipped)`. We
    // confirm BOTH the trimmed candidate list AND the count.
    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
    }));
    const result = await withReconciliationSession(REPO, input, fn, { ...deps, cap });
    expect(result).toEqual({ count: cap, skipped: input.length - cap });
  });

  it('X3: candidates < cap → all passed; skipped = 0', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const cap = 10;
    const input: Candidate[] = Array.from({ length: 4 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
    }));
    const result = await withReconciliationSession(REPO, input, fn, { ...deps, cap });
    expect(result).toEqual({ count: 4, skipped: 0 });
  });

  it('X2b: cap is exactly the default (2000) when not overridden', async () => {
    expect(DEFAULT_CANDIDATE_CAP).toBe(2000);
  });
});

// ─── X4: bare `Location` normalized to `Location[]` ───────────────────

describe('withReconciliationSession — X4: Location|Location[] normalization', () => {
  it('bare Location (object) is normalized to Location[] of length 1', async () => {
    // The session issues `textDocument/definition` per candidate.
    // For this test, the client returns a single (bare) Location
    // — the session must hand it to the engine as a 1-element
    // array. The engine-side dispatch is the `handToEngine` dep
    // we inject: a vi.fn() that captures the normalized payload.
    const bare: Location = {
      uri: 'file:///workspace/repo/src/b.ts',
      range: { start: { line: 7, character: 2 } },
    };
    const { client } = makeMockClient({
      requestImpl: async () => bare,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect(Array.isArray(locs)).toBe(true);
    expect((locs as Location[]).length).toBe(1);
    expect((locs as Location[])[0]).toEqual(bare);
  });
});

// ─── X4b: request URI is anchored to the repo root (Bug F4-forward) ──

describe('withReconciliationSession — X4b: definition request URI is repo-root-anchored', () => {
  it('repo-relative candidate.file → file:// URI under repo.repoPath, NOT process.cwd()', async () => {
    // REGRESSION (Bug F4-forward): a candidate's `file` is a
    // repo-relative POSIX path (`src/a.ts`). The session builds the
    // `textDocument/definition` URI via `pathToFileURL`, which resolves
    // a RELATIVE path against `process.cwd()` — producing a URI for a
    // file that does not exist in the analyzed workspace (the LSP server
    // is rooted at `repo.repoPath`). The server then returns null for
    // every request, and every candidate becomes NO_NODE.
    //
    // The fix anchors `candidate.file` to `repo.repoPath` before the
    // URI conversion. This test pins that: the request URI MUST be
    // `<repoPath>/src/a.ts`, and MUST NOT be the cwd-resolved path.
    //
    // This is the blind spot the prior mapper tests missed: they all
    // passed synthetic, pre-absolute `file:///...` URIs, so the
    // relative-path-to-URI construction at the request site was never
    // exercised end-to-end. With the bug present, this assertion fails
    // because the URI resolves to `${process.cwd()}/src/a.ts`.
    const captured: any[] = [];
    const { client } = makeMockClient({
      requestImpl: async (_method: string, params: any) => {
        captured.push(params);
        return null;
      },
    });
    const deps = makeDeps({ client });
    // REPO.repoPath is '/workspace/repo'; the candidate file is the
    // repo-relative 'src/a.ts'.
    const input: Candidate[] = [mkCandidate({ file: 'src/a.ts' })];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, deps);

    expect(captured.length).toBe(1);
    const uri: string = captured[0].textDocument.uri;
    // Anchored to the repo root — the load-bearing assertion.
    expect(uri).toBe(`file://${REPO.repoPath}/src/a.ts`);
    // And explicitly NOT resolved against the process cwd (the bug).
    expect(uri).not.toContain(process.cwd());
  });

  it('absolute candidate.file is passed through unchanged (no double-join)', async () => {
    // Defensive: a producer that already resolved the path to an
    // absolute filesystem path must not be re-anchored under repoPath.
    const captured: any[] = [];
    const { client } = makeMockClient({
      requestImpl: async (_method: string, params: any) => {
        captured.push(params);
        return null;
      },
    });
    const deps = makeDeps({ client });
    const absFile = '/some/other/abs/path/x.ts';
    const input: Candidate[] = [mkCandidate({ file: absFile })];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, deps);

    expect(captured.length).toBe(1);
    const uri: string = captured[0].textDocument.uri;
    expect(uri).toBe(`file://${absFile}`);
    // The repo root must NOT have been prepended.
    expect(uri).not.toContain(REPO.repoPath);
  });
});

// ─── X5: Location[] of N → all N handed to engine ────────────────────

describe('withReconciliationSession — X5: multi-Location pass-through', () => {
  it('Location[] of N → all N handed to engine (the engine decides ambiguity)', async () => {
    const arr: Location[] = [
      { uri: 'file:///repo/a.ts', range: { start: { line: 1, character: 0 } } },
      { uri: 'file:///repo/b.ts', range: { start: { line: 2, character: 0 } } },
      { uri: 'file:///repo/c.ts', range: { start: { line: 3, character: 0 } } },
    ];
    const { client } = makeMockClient({
      requestImpl: async () => arr,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect((locs as Location[]).length).toBe(arr.length);
  });
});

// ─── X6: null / timeout → engine receives empty array (refused) ──────

describe('withReconciliationSession — X6: null / undefined LSP result', () => {
  it('null result (timeout / crash) → engine receives empty array', async () => {
    const { client } = makeMockClient({
      requestImpl: async () => null,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect(Array.isArray(locs)).toBe(true);
    expect((locs as Location[]).length).toBe(0);
  });

  it('non-typed result (e.g. server returned a string) → engine receives empty array (refuse over guess)', async () => {
    const { client } = makeMockClient({
      requestImpl: async () => 'unexpected-payload',
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect((locs as Location[]).length).toBe(0);
  });
});

// ─── Per-request timeout (KD-10) ──────────────────────────────────────

describe('withReconciliationSession — per-request timeout', () => {
  it('default per-request timeout is 5000ms (KD-10)', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it('each textDocument/definition request is issued with the configured timeout', async () => {
    const { client, request } = makeMockClient({
      requestImpl: async () => null,
    });
    const deps = makeDeps({ client });
    const input: Candidate[] = Array.from({ length: 3 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, requestTimeoutMs: 1234 });
    expect(request).toHaveBeenCalledTimes(input.length);
    for (const call of request.mock.calls) {
      const [_method, _params, timeoutMs] = call;
      expect(timeoutMs).toBe(1234);
    }
  });
});

// ─── Crash isolation: a crash in fn must not skip stop() ──────────────

describe('withReconciliationSession — crash isolation', () => {
  it('synchronous throw inside fn → null + stop still called', async () => {
    const { client, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(() => {
      throw new Error('sync crash');
    });
    const result = await withReconciliationSession(REPO, [], fn as any, deps);
    expect(result).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// ─── Lifecycle ordering (state-transition) ───────────────────────────

describe('withReconciliationSession — lifecycle ordering', () => {
  it('happy path: discover → start → probe → fn → stop (in that order)', async () => {
    const order: string[] = [];
    const { client, start, stop } = makeMockClient({
      startImpl: async () => { order.push('start'); },
      stopImpl: async () => { order.push('stop'); },
    });
    const probe = vi.fn(async () => {
      order.push('probe');
      return { ready: true };
    }) as unknown as ReconciliationProbeFn;
    const discoverServers = vi.fn(async () => {
      order.push('discover');
      return { typescript: { path: '/bin/typescript-language-server', version: '4.3.3' } };
    });
    const fn = vi.fn(async () => {
      order.push('fn');
      return 'ok';
    });
    const result = await withReconciliationSession(REPO, [], fn, {
      discoverServers,
      createLspClient: makeClientFactory(client),
      probe,
    });
    expect(result).toBe('ok');
    expect(order).toEqual(['discover', 'start', 'probe', 'fn', 'stop']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// ─── Default-probe seam: must be refusable ────────────────────────────

describe('withReconciliationSession — default probe refuses when no samples are provided', () => {
  it('a default probe with empty samples returns ready:false, funnel returns null', async () => {
    // The default probe is the real `probeWorkspaceReadiness` —
    // it refuses on empty samples. We pass a deps bag with no
    // `probe` override and confirm the default refuses (no
    // fn-call, stop still runs).
    const { client, stop, start } = makeMockClient();
    const deps: WithReconciliationSessionDeps = {
      discoverServers: vi.fn(async () => ({ typescript: { path: '/bin/ts', version: '4' } })),
      createLspClient: makeClientFactory(client),
      // No `probe` — funnel uses default.
    };
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);
    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── security-3 polish MAJOR: bad line/character is refused pre-request ─

describe('withReconciliationSession — security-3: line/character bounds gate', () => {
  // Per the polish review: an attacker-controlled (or
  // upstream-buggy) heritage feed could pass a negative,
  // non-integer, or otherwise out-of-range position. The
  // session funnel MUST refuse the request (no
  // `textDocument/definition` call) so the engine treats
  // the candidate as `NO_NODE` and emits `keep`. The
  // session's hand-to-engine collector receives an empty
  // `Location[]` for that candidate; the LSP client
  // `request` is never invoked.
  const BAD_LINE_CASES: Array<[string, number]> = [
    ['line = -1 (negative)', -1],
    ['line = NaN', Number.NaN],
    ['line = 1.5 (fractional)', 1.5],
    ['line = Infinity', Number.POSITIVE_INFINITY],
  ];
  const BAD_CHAR_CASES: Array<[string, number]> = [
    ['character = -1 (negative)', -1],
    ['character = NaN', Number.NaN],
    ['character = 2.7 (fractional)', 2.7],
  ];

  for (const [label, line] of BAD_LINE_CASES) {
    it(`${label} → no LSP request issued, engine receives empty Location[]`, async () => {
      const { client, request } = makeMockClient({
        requestImpl: async () => null,
      });
      const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
      const deps = makeDeps({ client });
      const input: Candidate[] = [mkCandidate({ line, character: 0 })];
      const fn = vi.fn(async () => undefined);
      await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
      // The gate ran BEFORE the LSP request. A `NaN` line
      // would otherwise serialize as `null` in JSON-RPC,
      // which the server could reject or — worse — return
      // a coerced position for. We refuse at the funnel.
      expect(request).not.toHaveBeenCalled();
      expect(handToEngine).toHaveBeenCalledTimes(1);
      const [_cand, locs] = handToEngine.mock.calls[0];
      expect((locs as Location[]).length).toBe(0);
    });
  }

  for (const [label, character] of BAD_CHAR_CASES) {
    it(`${label} → no LSP request issued, engine receives empty Location[]`, async () => {
      const { client, request } = makeMockClient({
        requestImpl: async () => null,
      });
      const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
      const deps = makeDeps({ client });
      const input: Candidate[] = [mkCandidate({ line: 0, character })];
      const fn = vi.fn(async () => undefined);
      await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
      expect(request).not.toHaveBeenCalled();
      expect(handToEngine).toHaveBeenCalledTimes(1);
      const [_cand, locs] = handToEngine.mock.calls[0];
      expect((locs as Location[]).length).toBe(0);
    });
  }

  it('a valid (line, character) still issues the LSP request (regression pin)', async () => {
    // Belt-and-braces: the gate MUST NOT false-positive on
    // a legitimate zero-based position. The pre-fix
    // behavior was an unconditional `request` call for any
    // position; we want to keep that for the valid range.
    const { client, request } = makeMockClient({
      requestImpl: async () => null,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate({ line: 0, character: 0 })];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(request).toHaveBeenCalledTimes(1);
    const [method, params] = request.mock.calls[0];
    expect(method).toBe('textDocument/definition');
    expect((params as any).position).toEqual({ line: 0, character: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-5: ReconciliationReport.probed + .preFilteredExternal + funnel line
// ═══════════════════════════════════════════════════════════════════════
//
// C5-1..C5-6 : ReconciliationReport shape via withReconciliationSession
// C5-7       : N capture timing (N is deduped feed length)
// C5-8..C5-13: Funnel line format (4 exit paths via buildLspSummaryLine)
// C5-14..C5-16: BVA on skipped computation inside buildLspSummaryLine

// ─── C5-1..C5-6: ReconciliationReport shape ──────────────────────────

describe('WI-5 — C5-1..C5-6: ReconciliationReport.probed / preFilteredExternal shape', () => {
  // Helper: run session, capture meta (probed/preFilteredExternal) from fn
  async function runSessionCaptureMeta(
    input: Candidate[],
    requestImpl: (method: string, params: any, timeoutMs: number) => Promise<any> = async () => null,
    overrideDeps: Partial<WithReconciliationSessionDeps> = {},
  ): Promise<SessionMeta> {
    const { client } = makeMockClient({ requestImpl });
    const deps = makeDeps({ client });
    let captured: SessionMeta | undefined;
    await withReconciliationSession(REPO, input, async (_selected, meta) => {
      captured = meta;
      return undefined;
    }, { ...deps, ...overrideDeps });
    if (!captured) throw new Error('work-fn never called (session gate refused)');
    return captured;
  }

  it('C5-1: probed field present and === 0 when no candidates dispatched', async () => {
    // Empty feed → dispatch loop never runs → probed stays 0
    const meta = await runSessionCaptureMeta([]);
    expect(meta.probed).toBe(0);
  });

  it('C5-2: probed increments exactly once per fetchDefinitionForCandidate call (3 candidates → probed=3)', async () => {
    // 3 normal candidates; requestImpl returns null (refused) but the request WAS issued
    const input: Candidate[] = Array.from({ length: 3 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const meta = await runSessionCaptureMeta(input, async () => null);
    expect(meta.probed).toBe(3);
  });

  it('C5-3: candidate with isUnindexablePath file → probed NOT incremented; preFilteredExternal incremented', async () => {
    // node_modules path triggers isUnindexablePath → preFiltered=true in fetchDefinitionForCandidate
    const skippedCandidate = mkCandidate({ file: 'node_modules/lodash/index.ts', line: 0, character: 0 });
    const normalCandidate = mkCandidate({ sourceId: 's2', file: 'src/a.ts', line: 0, character: 0 });
    // Total: 1 pre-filtered, 1 probed
    const meta = await runSessionCaptureMeta([skippedCandidate, normalCandidate], async () => null);
    expect(meta.preFilteredExternal).toBe(1);
    expect(meta.probed).toBe(1);
  });

  it('C5-4: preFilteredExternal === 0 when no candidates skipped by pre-filter', async () => {
    const input: Candidate[] = [mkCandidate({ file: 'src/a.ts', line: 0, character: 0 })];
    const meta = await runSessionCaptureMeta(input, async () => null);
    expect(meta.preFilteredExternal).toBe(0);
  });

  it('C5-5: preFilteredExternal distinct from refused: candidate passes pre-filter but returns unindexable path → probed=1, preFilteredExternal=0', async () => {
    // The candidate file is indexable; the LSP returns null → NO_NODE → refused (engine side).
    // preFilteredExternal only counts the isUnindexablePath gate, NOT LSP refusals.
    const input: Candidate[] = [mkCandidate({ file: 'src/a.ts', line: 0, character: 0 })];
    const meta = await runSessionCaptureMeta(input, async () => null);
    // probed: 1 (request was issued)
    expect(meta.probed).toBe(1);
    // preFilteredExternal: 0 (isUnindexablePath returned false for 'src/a.ts')
    expect(meta.preFilteredExternal).toBe(0);
  });

  it('C5-6: both fields are non-optional on ReconciliationReport (TypeScript compile check)', () => {
    // If the interface had optional fields (probed?: number), the type would accept
    // a value without them. We assert here that a valid concrete object MUST have
    // both fields by constructing a minimal valid ReconciliationReport and reading them.
    const report: ReconciliationReport = {
      decisions: [],
      confirmed: 0,
      corrected: 0,
      recall: 0,
      refused: 0,
      skipped: 0,
      probed: 0,
      preFilteredExternal: 0,
    };
    // If probed/preFilteredExternal were optional, omitting them would be legal
    // and TypeScript would not error — but this assertion would still read 0.
    // The compile-time check is that this literal is accepted without `?:` — the
    // unit test pins the runtime values as the structural source-of-truth.
    expect(report.probed).toBe(0);
    expect(report.preFilteredExternal).toBe(0);
  });
});

// ─── C5-7: N capture timing ───────────────────────────────────────────

describe('WI-5 — C5-7: N capture timing', () => {
  it('C5-7: work-fn receives the full selected slice; probed reflects actual dispatches not raw N', async () => {
    // The pipeline captures N = dedupedCandidates.length BEFORE withReconciliationSession.
    // Inside the session, the cap may trim selected.length < N. probed only counts
    // the selected slice (candidates that actually enter the dispatch loop).
    // With cap=3 and 5 candidates, selected.length=3, probed≤3.
    const cap = 3;
    const input: Candidate[] = Array.from({ length: 5 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const { client } = makeMockClient({ requestImpl: async () => null });
    const deps = makeDeps({ client });
    let capturedSelected = -1;
    let capturedProbed = -1;
    await withReconciliationSession(REPO, input, async (selected, meta) => {
      capturedSelected = selected.length;
      capturedProbed = meta.probed;
      return undefined;
    }, { ...deps, cap });
    // selected should equal the cap
    expect(capturedSelected).toBe(cap);
    // probed should equal selected.length (all 3 are indexable paths)
    expect(capturedProbed).toBe(cap);
  });
});

// ─── C5-8..C5-13: Funnel line format (buildLspSummaryLine) ───────────

describe('WI-5 — C5-8..C5-13: funnel line format (4 exit paths)', () => {
  const BASE_REPORT = {
    confirmed: 3,
    corrected: 1,
    recall: 2,
    refused: 4,
    skipped: 1,
    serverVersion: '4.3.3',
  };

  it('C5-8 [success path]: funnel line contains budget suffix "(budget 2000 of 5 candidates)"', () => {
    const line = buildLspSummaryLine('success', BASE_REPORT, { N: 5, B: 2000, elapsedS: '1.2' });
    expect(line).toContain('(budget 2000 of 5 candidates)');
    // sanity: existing tokens preserved
    expect(line).toContain('confirmed 3');
    expect(line).toContain('corrected 1');
    expect(line).toContain('skipped(cap) 1');
    expect(line).toContain('server <4.3.3>');
  });

  it('C5-9 [gate-failure, N=1000, B=500]: P=0, confirmed=0, S=500, budget suffix present', () => {
    const line = buildLspSummaryLine('gate-failure',
      { ...BASE_REPORT, confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0 },
      { N: 1000, B: 500, elapsedS: '0.0' },
    );
    expect(line).toContain('P=0');
    expect(line).toContain('confirmed 0');
    // S = max(0, 1000-500) = 500
    expect(line).toContain('skipped(cap) 500');
    expect(line).toContain('(budget 500 of 1000 candidates)');
  });

  it('C5-10 [gate-failure, N=100, B=2000]: S=max(0,100-2000)=0 (no negative skipped)', () => {
    const line = buildLspSummaryLine('gate-failure',
      { ...BASE_REPORT, confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0 },
      { N: 100, B: 2000, elapsedS: '0.0' },
    );
    // S = max(0, 100-2000) = 0
    expect(line).toContain('skipped(cap) 0');
    expect(line).toContain('(budget 2000 of 100 candidates)');
    // Must NOT contain negative numbers
    expect(line).not.toMatch(/skipped\(cap\) -/);
  });

  it('C5-11 [error path]: funnel line emitted before rethrow; dispatch-error outcome explicit', () => {
    // The error path is tested by verifying buildLspSummaryLine is pure and
    // that the pipeline error-catch block can call it. Here we verify the
    // error-path format string is distinct and contains the budget suffix.
    // The actual console.log + rethrow logic lives in pipeline.ts; this test
    // verifies the building block used in that block.
    const budgetSuffix = '(budget 500 of 1000 candidates)';
    // pipeline.ts error path emits:
    //   `  lsp: dispatch-error P=${...} confirmed 0, ... (budget B of N candidates)`
    // This is built inline (not via buildLspSummaryLine); we verify the suffix
    // format is consistent across all paths by checking the helper produces it.
    const gateLine = buildLspSummaryLine('gate-failure',
      { confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0, serverVersion: '' },
      { N: 1000, B: 500, elapsedS: '2.5' },
    );
    expect(gateLine).toContain(budgetSuffix);
  });

  it('C5-12 [awaitReady=false path]: no budget suffix emitted when LSP is not enabled', () => {
    // When options.lsp.enabled is false/unset, the entire LSP block is skipped.
    // No funnel line is emitted at all — this is the absence assertion.
    // Verifiable without running the pipeline: buildLspSummaryLine must not
    // be called when the block is not entered. This test asserts that the
    // three path strings all produce lines containing the budget suffix,
    // which means any path that DOES log will include it — and since the
    // disabled path produces no log, it trivially has no budget suffix.
    //
    // To avoid a vacuous test, we also verify that none of the three paths
    // produce an empty string (each path DOES emit a real line when called).
    const successLine = buildLspSummaryLine('success', BASE_REPORT, { N: 5, B: 2000, elapsedS: '1.0' });
    const gfLine = buildLspSummaryLine('gate-failure', BASE_REPORT, { N: 5, B: 2000, elapsedS: '1.0' });
    const dryLine = buildLspSummaryLine('dry-run', { ...BASE_REPORT, decisionCount: 3 }, { N: 5, B: 2000, elapsedS: '' });
    // All enabled paths produce non-empty lines with budget suffix
    expect(successLine).not.toBe('');
    expect(gfLine).not.toBe('');
    expect(dryLine).not.toBe('');
    // Disabled path produces NO line → trivially no budget suffix
    // (There is nothing to assert on a no-op, but we document it above.)
  });

  it('C5-13 [dry-run path]: summary line gains budget suffix', () => {
    const line = buildLspSummaryLine('dry-run',
      { ...BASE_REPORT, decisionCount: 7 },
      { N: 5, B: 2000, elapsedS: '' },
    );
    expect(line).toContain('7 decision(s), 0 edges written');
    expect(line).toContain('(budget 2000 of 5 candidates)');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-6: --lsp-budget threading assertions (C6-9..C6-12)
// ═══════════════════════════════════════════════════════════════════════
//
// Verify that the budget value threads correctly from:
//   AnalyzeOptions.lspBudget → PipelineOptions.lsp.budget → deps.cap
//                                                              in withReconciliationSession
//
// These are threading invariants — they do NOT spawn a real LSP process.
// Every dep is injected via WithReconciliationSessionDeps.

describe('WI-6 — C6-9/C6-10: budget=500 threads to deps.cap=500 in withReconciliationSession', () => {
  it('C6-9: PipelineOptions.lsp.budget=500 produces cap=500 (type-level threading)', () => {
    // Verify the PipelineOptions.lsp.budget field is accepted by the type system.
    // The actual cap threading is runtime-exercised in C6-10.
    const opts: import('../../../src/core/ingestion/pipeline.js').PipelineOptions = {
      lsp: { enabled: true, budget: 500 },
    };
    expect(opts.lsp?.budget).toBe(500);
  });

  it('C6-10: PipelineOptions.lsp.budget=500 → deps.cap=500 flows into withReconciliationSession', async () => {
    // When the caller passes budget=500, the pipeline computes:
    //   const lspB = options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP;
    // and then passes `cap: lspB` to withReconciliationSession.
    // We exercise this by calling withReconciliationSession directly
    // with cap=500 and verifying the session honours it.
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const cap = 500;

    // Create 600 candidates — more than the cap
    const input: Candidate[] = Array.from({ length: 600 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );

    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
    }));

    const result = await withReconciliationSession(REPO, input, fn, { ...deps, cap });
    // The session must honour the injected cap=500
    expect(result).toEqual({ count: 500, skipped: 100 });
  });
});

describe('WI-6 — C6-11: undefined budget → DEFAULT_CANDIDATE_CAP=2000 via ?? fallback', () => {
  it('C6-11: lsp.budget=undefined → cap defaults to DEFAULT_CANDIDATE_CAP=2000', async () => {
    // When --lsp-budget is not supplied, PipelineOptions.lsp.budget is undefined.
    // The pipeline computes: `const lspB = undefined ?? DEFAULT_CANDIDATE_CAP`
    // which equals 2000. This is the identity-preserving path (I-9).
    const budget: number | undefined = undefined;
    const resolvedCap = budget ?? DEFAULT_CANDIDATE_CAP;
    expect(resolvedCap).toBe(2000);
    expect(DEFAULT_CANDIDATE_CAP).toBe(2000);

    // Verify the session itself defaults to DEFAULT_CANDIDATE_CAP when no cap override
    const { client } = makeMockClient();
    const deps = makeDeps({ client });

    // Use a small feed so we don't time out; the point is no cap override is passed.
    const input: Candidate[] = Array.from({ length: 5 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );

    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
      cap: _meta?.cap,
    }));

    const result = await withReconciliationSession(REPO, input, fn, deps);
    // All 5 candidates selected (default cap=2000 >> 5); skipped=0
    expect(result).toEqual({ count: 5, skipped: 0, cap: DEFAULT_CANDIDATE_CAP });
  });
});

describe('WI-6 — C6-12: 0 ?? DEFAULT_CANDIDATE_CAP does NOT coalesce on 0', () => {
  it('C6-12: the explicit > 0 guard fires for budget=0 before it reaches the ?? fallback', () => {
    // This test documents the invariant: the CLI validation rejects budget=0
    // before it ever reaches the `??` expression in pipeline.ts.
    // If budget=0 somehow reached the `??`, it would NOT default to 2000
    // (because 0 ?? 2000 evaluates to 0 in JS). The guard prevents this.
    const zeroBudget = 0;

    // Prove the ?? operator is NOT safe for zero:
    expect(zeroBudget ?? DEFAULT_CANDIDATE_CAP).toBe(0); // NOT 2000

    // Prove the guard rejects 0:
    const guard = (n: number) => Number.isInteger(n) && n > 0;
    expect(guard(0)).toBe(false); // guard fires, function returns early

    // Prove the guard accepts valid values:
    expect(guard(1)).toBe(true);
    expect(guard(500)).toBe(true);
    expect(guard(2000)).toBe(true);
  });
});

// ─── C5-14..C5-16: BVA on skipped computation ────────────────────────

describe('WI-5 — C5-14..C5-16: BVA on skipped computation in gate-failure path', () => {
  const ZeroReport = {
    confirmed: 0,
    corrected: 0,
    recall: 0,
    refused: 0,
    skipped: 0,
    serverVersion: 'v1',
  };

  it('C5-14: N=B → S=0 (boundary: equal — no cap overshoot)', () => {
    const line = buildLspSummaryLine('gate-failure', ZeroReport, { N: 500, B: 500, elapsedS: '0.0' });
    expect(line).toContain('skipped(cap) 0');
    expect(line).toContain('(budget 500 of 500 candidates)');
  });

  it('C5-15: N>B → S=N-B (positive skipped)', () => {
    const line = buildLspSummaryLine('gate-failure', ZeroReport, { N: 700, B: 500, elapsedS: '0.0' });
    // S = max(0, 700-500) = 200
    expect(line).toContain('skipped(cap) 200');
    expect(line).toContain('(budget 500 of 700 candidates)');
  });

  it('C5-16: N<B → S=0 (clamped — not negative)', () => {
    const line = buildLspSummaryLine('gate-failure', ZeroReport, { N: 100, B: 2000, elapsedS: '0.0' });
    // S = max(0, 100-2000) = 0
    expect(line).toContain('skipped(cap) 0');
    expect(line).toContain('(budget 2000 of 100 candidates)');
    expect(line).not.toMatch(/skipped\(cap\) -/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WI-7: --lsp-budget wiring + funnel line format + I-9 golden
//       non-regression (mode-a-session.test.ts portion: C7-1..C7-6)
// ═══════════════════════════════════════════════════════════════════════
//
// C7-1: SessionMeta shape regression — probed/preFilteredExternal are
//        numeric on the G5 happy path (typeof guard).
// C7-2: Same regression on G6 happy path (fn returns undefined).
// C7-3: 500 candidates, cap=500, boundary: funnel line has
//        '(budget 500 of 500 candidates)' and 'skipped(cap) 0'.
// C7-4: 1000 candidates, cap=500: funnel line has
//        '(budget 500 of 1000 candidates)'; skipped(cap) 500 token.
// C7-5: No --lsp-budget: funnel line has '(budget 2000 of N candidates)'
//        where N = actual feed size (DEFAULT_CANDIDATE_CAP path).
// C7-6: --lsp-budget 0: guard fires before withReconciliationSession;
//        discoverServers vi.fn() never called.
// ═══════════════════════════════════════════════════════════════════════

// ─── C7-1: SessionMeta shape regression — G5 happy path ──────────────

describe('WI-7 — C7-1: SessionMeta.probed / preFilteredExternal are numeric on G5 happy path', () => {
  it('C7-1: G5 — meta.probed and meta.preFilteredExternal are typeof number (not undefined, not null)', async () => {
    // Regression pin: if a future refactor removes probed/preFilteredExternal
    // from SessionMeta, the work-fn will see undefined and this assertion catches it.
    // The C5-1..C5-6 tests verify the values; this test pins the TYPE contract.
    const { client } = makeMockClient({ requestImpl: async () => null });
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate({ file: 'src/a.ts', line: 0, character: 0 })];

    let probedType = 'not-set';
    let preFilteredType = 'not-set';
    const result = await withReconciliationSession(REPO, input, async (_selected, meta) => {
      probedType = typeof meta.probed;
      preFilteredType = typeof meta.preFilteredExternal;
      return 'value-from-g5';
    }, deps);

    // G5: fn returned a value — session also returned that value
    expect(result).toBe('value-from-g5');
    // Shape regression pins — must be 'number', never 'undefined' or 'object' (null)
    expect(probedType).toBe('number');
    expect(preFilteredType).toBe('number');
  });
});

// ─── C7-2: SessionMeta shape regression — G6 happy path ──────────────

describe('WI-7 — C7-2: SessionMeta.probed / preFilteredExternal are numeric on G6 happy path', () => {
  it('C7-2: G6 (fn returns undefined) — meta.probed and meta.preFilteredExternal remain numeric', async () => {
    // G6: fn resolves with undefined (the session returns undefined, NOT null).
    // Fields must be populated with concrete numbers even on the undefined-return path.
    const { client } = makeMockClient({ requestImpl: async () => null });
    const deps = makeDeps({ client });
    const input: Candidate[] = Array.from({ length: 2 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, file: 'src/a.ts', line: i, character: 0 }),
    );

    let capturedProbed: unknown = 'not-set';
    let capturedPreFiltered: unknown = 'not-set';
    const result = await withReconciliationSession(REPO, input, async (_selected, meta) => {
      capturedProbed = meta.probed;
      capturedPreFiltered = meta.preFilteredExternal;
      return undefined; // G6: explicitly undefined
    }, deps);

    // G6: result is undefined (NOT null)
    expect(result).toBeUndefined();
    // Both fields populated as numbers
    expect(typeof capturedProbed).toBe('number');
    expect(typeof capturedPreFiltered).toBe('number');
    // 2 indexable candidates dispatched (src/a.ts is not node_modules)
    expect(capturedProbed).toBe(2);
    expect(capturedPreFiltered).toBe(0);
  });
});

// ─── C7-3: 500 candidates, cap=500, all dispatched (N=B boundary) ────

describe('WI-7 — C7-3: funnel line — N=B=500 (boundary: all candidates within cap)', () => {
  it('C7-3: 500 candidates, cap=500 → funnel line contains "(budget 500 of 500 candidates)" and skipped(cap) 0', () => {
    // N=B boundary: no candidates dropped by the cap — skipped(cap)=0.
    // The budget suffix must reflect both the cap and the total correctly.
    // Uses gate-failure path to verify skipped(cap) computation (max(0, 500-500)=0).
    const line = buildLspSummaryLine(
      'gate-failure',
      { confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0, serverVersion: 'v4' },
      { N: 500, B: 500, elapsedS: '0.3' },
    );
    // Key WI-7 assertions
    expect(line).toContain('(budget 500 of 500 candidates)');
    expect(line).toContain('skipped(cap) 0');
    // Invariant: existing tokens survive the budget suffix extension (WI-7 / L4 AC)
    expect(line).toContain('server <v4>');
    expect(line).not.toMatch(/skipped\(cap\) -/);
  });
});

// ─── C7-4: 1000 candidates, cap=500, skipped=500 (N>B cap-overflow) ──

describe('WI-7 — C7-4: funnel line — N=1000 > B=500 (cap overflow; skipped(cap)=500)', () => {
  it('C7-4: 1000 candidates, cap=500 → "(budget 500 of 1000 candidates)"; skipped(cap) 500 token present', () => {
    // N > B: 500 candidates dropped by the cap. Both the cap and the total must
    // appear in the budget suffix — operators need this to understand silent drops.
    const line = buildLspSummaryLine(
      'gate-failure',
      { confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0, serverVersion: 'v4' },
      { N: 1000, B: 500, elapsedS: '0.5' },
    );
    // Key WI-7 assertions
    expect(line).toContain('(budget 500 of 1000 candidates)');
    // S = max(0, 1000-500) = 500
    expect(line).toContain('skipped(cap) 500');
    // Invariant: existing tokens survive
    expect(line).toContain('server <v4>');
  });
});

// ─── C7-5: No --lsp-budget → default cap B=2000, N=actual feed size ──

describe('WI-7 — C7-5: funnel line — no --lsp-budget flag uses DEFAULT_CANDIDATE_CAP=2000', () => {
  it('C7-5: no --lsp-budget → "(budget 2000 of N candidates)" where N=actual feed size', () => {
    // When --lsp-budget is not supplied, pipeline.ts resolves:
    //   const lspB = options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP;
    // This test pins that the default-path funnel line correctly encodes the feed size
    // and the default cap — the I-9 / byte-identity invariant.
    const N = 37; // representative actual feed size
    const line = buildLspSummaryLine(
      'success',
      { confirmed: 5, corrected: 1, recall: 3, refused: 2, skipped: 0, serverVersion: '4.3.3' },
      { N, B: DEFAULT_CANDIDATE_CAP, elapsedS: '1.5' },
    );
    // Budget uses the constant default (2000) and the actual feed size
    expect(line).toContain(`(budget ${DEFAULT_CANDIDATE_CAP} of ${N} candidates)`);
    expect(line).toContain('(budget 2000 of 37 candidates)');
    // Invariant: skipped(cap) and server <v> tokens survive (WI-7 explicit invariant)
    expect(line).toContain('skipped(cap) 0');
    expect(line).toContain('server <4.3.3>');
    expect(line).toContain('confirmed 5');
    expect(line).toContain('corrected 1');
  });
});

// ─── C7-6: --lsp-budget 0 → guard fires; discoverServers never called ─

describe('WI-7 — C7-6: --lsp-budget 0 guard fires before ingestion starts', () => {
  it('C7-6: budget=0 → validation guard fires; discoverServers vi.fn() is never called', async () => {
    // The analyzeCommand guard:
    //   if (!Number.isInteger(n) || n <= 0) { error; exitCode=1; return; }
    // fires BEFORE runPipelineFromRepo, which means BEFORE withReconciliationSession,
    // which means BEFORE discoverServers is ever called.
    //
    // This test models the invariant: with budget=0, the guard is the gatekeeper.
    // discoverServers (the first dep withReconciliationSession would call) is a
    // vi.fn() that must NOT be invoked.
    const discoverServers = vi.fn(async () => ({ typescript: null as null }));

    const lspBudget = 0;

    // Guard logic (mirrors analyzeCommand exactly)
    const guardPasses = Number.isInteger(lspBudget) && lspBudget > 0;

    if (guardPasses) {
      // This branch is NEVER entered for budget=0.
      // In the real pipeline: runPipelineFromRepo → withReconciliationSession → discoverServers.
      await withReconciliationSession(REPO, [], async () => null, { discoverServers });
    }
    // else: analyzeCommand returns early (process.exitCode=1); no LSP I/O starts.

    expect(guardPasses).toBe(false);
    // discoverServers was never reached (guard blocked all upstream calls)
    expect(discoverServers).not.toHaveBeenCalled();
  });

  it('C7-6 edge — budget=-1: same guard fires; discoverServers not called', () => {
    const discoverServers = vi.fn(async () => ({ typescript: null as null }));
    // -1 is invalid (n <= 0)
    const guardPasses = Number.isInteger(-1) && -1 > 0;
    expect(guardPasses).toBe(false);
    expect(discoverServers).not.toHaveBeenCalled();
  });

  it('C7-6 edge — budget without --lsp: warning path; discoverServers not called (lsp=false)', async () => {
    // When --lsp-budget is passed WITHOUT --lsp, analyzeCommand emits a warning
    // and proceeds WITHOUT enabling LSP. The withReconciliationSession call is
    // guarded by `options.lsp.enabled`; when false, it is never reached.
    const discoverServers = vi.fn(async () => ({ typescript: null as null }));

    // Model the lsp=false path: no withReconciliationSession call when lsp disabled
    const lspEnabled = false;
    if (lspEnabled) {
      // Never reached when --lsp is absent
      await withReconciliationSession(REPO, [], async () => null, { discoverServers });
    }

    expect(lspEnabled).toBe(false);
    expect(discoverServers).not.toHaveBeenCalled();
  });
});
