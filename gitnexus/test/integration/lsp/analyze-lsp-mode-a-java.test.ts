/**
 * Integration Tests: WI-6 — Reconciler + pipeline adapter threading.
 *
 * Verifies three acceptance criteria (hermetic — no real server):
 *
 *   J1  Java candidates flow through the session funnel with a Java
 *       adapter + fake client → engine sees Java workspace definitions
 *       → confirm/correct decision counters are non-zero.
 *
 *   J2  `selectAdapter` returns `null` for a directory with no
 *       supported-language files → `withReconciliationSession` called
 *       with `deps.adapter: null` → returns `null` cleanly (no spawn).
 *
 *   J3  TS funnel is byte-identical: explicitly supplying
 *       `TYPESCRIPT_ADAPTER` produces the same session result as
 *       omitting the adapter (backward-compat default).
 *
 * Design contract (from WI-6 spec):
 *   - The session short-circuits when `adapter` is null.
 *   - `defaultDiscoverServers` now picks `discovered[adapter.id]`
 *     (not `.typescript`), so a Java session requires a discovered
 *     `java` server entry in the fake `discoverServers` override.
 *   - The fake client returns workspace `file://` definitions so
 *     `mapLocationToNodeId` can resolve them to real node ids.
 *   - The #166 lesson: the FEED POPULATION (non-zero candidates
 *     passed to the session) is the tripwire, not an engine outcome
 *     assertion alone — the test asserts both.
 *
 * All tests are hermetic. No server binary is spawned; every
 * subprocess seam is replaced by a vi.fn() fake.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  withReconciliationSession,
  reconcileDecisions,
  applyDecisions,
  candidateLocationKey,
  type Candidate,
  type Location,
  type ReconciliationLspClient,
  type ReconciliationRepo,
  type ReconciliationProbeFn,
} from '../../../src/core/ingestion/mode-a-reconciler.js';

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { MapperResult } from '../../../src/core/ingestion/lsp/location-mapper.js';
import { JAVA_ADAPTER, TYPESCRIPT_ADAPTER } from '../../../src/core/ingestion/lsp/language-adapter.js';

// ─── Shared fake infrastructure ───────────────────────────────────────

/**
 * A minimal `ReconciliationLspClient` that records every
 * `textDocument/definition` call and returns a per-key
 * `Location[]` payload. The key is `${position.line}|${position.character}`.
 */
function makeFakeClient(
  locationByKey: Map<string, Location[]>,
): ReconciliationLspClient & { requestCalls: Array<{ method: string; params: unknown }> } {
  const requestCalls: Array<{ method: string; params: unknown }> = [];
  return {
    getState: () => 'ready' as const,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    request: vi.fn(async (method: string, params: unknown) => {
      requestCalls.push({ method, params });
      const position = (params as { position?: { line: number; character: number } })?.position ?? {};
      const key = `${position.line}|${position.character}`;
      return locationByKey.has(key) ? locationByKey.get(key)! : null;
    }),
    requestCalls,
  };
}

/** Fake probe that always reports ready. */
const PROBE_READY: ReconciliationProbeFn = vi.fn(async () => ({ ready: true as const }));

/** A repo handle with a repoPath that has no TS/Java files. */
const REPO_JAVA: ReconciliationRepo = { id: 'java-repo', repoPath: '/tmp/java-test-repo' };

// ─── J1: Java candidates flow → non-zero confirm/correct ──────────────

describe('WI-6 J1: Java candidates flow — engine sees workspace definitions → confirm/correct non-zero', () => {
  /**
   * Scenario:
   *   - Graph has two nodes: a Java method (caller) and a Java method (callee).
   *   - correctionFeed has one candidate pointing from caller → heuristic-target;
   *     the fake client returns a workspace definition for the callee.
   *   - `mapLocationToNodeId` resolves the definition to the real callee node.
   *   - Expected: reconcileDecisions produces at least 1 confirm or correct.
   *
   * This is the #166 tripwire: if the feed is empty, all counters are 0
   * and the test proves nothing. We assert `fed.length > 0` before the
   * engine run, then assert that at least one decision is confirm|correct.
   */
  it('non-zero candidates fed, at least one confirm/correct from the engine', async () => {
    // ── Graph setup ──────────────────────────────────────────────────
    const graph = createKnowledgeGraph();

    // Caller node — a Java method in Service.java.
    graph.addNode({
      id: 'Method:src/Service.java:processOrder',
      label: 'Method',
      name: 'processOrder',
      properties: {
        name: 'processOrder',
        filePath: 'src/Service.java',
        startLine: 10,
        endLine: 15,
      },
    });

    // Callee node — the real target (what LSP resolves to).
    graph.addNode({
      id: 'Method:src/Repository.java:findById',
      label: 'Method',
      name: 'findById',
      properties: {
        name: 'findById',
        filePath: 'src/Repository.java',
        startLine: 5,
        endLine: 8,
      },
    });

    // Heuristic-target node — the WRONG target the heuristic emitted.
    graph.addNode({
      id: 'Method:src/Other.java:findById',
      label: 'Method',
      name: 'findById',
      properties: {
        name: 'findById',
        filePath: 'src/Other.java',
        startLine: 20,
        endLine: 23,
      },
    });

    // Add the heuristic CALLS edge (global-0.50) that the engine should correct.
    const heuristicRelId = 'heuristic-calls-1';
    graph.addRelationship({
      id: heuristicRelId,
      sourceId: 'Method:src/Service.java:processOrder',
      targetId: 'Method:src/Other.java:findById',
      type: 'CALLS',
      confidence: 0.5,
      reason: 'heuristic-global',
      source: 'heuristic',
      step: 'calls',
      properties: {},
    });

    // ── Candidate feed ───────────────────────────────────────────────
    // One correction candidate: from processOrder → wrong heuristic target,
    // with a call site at line 12, character 8 (findById identifier position).
    const candidate: Candidate = {
      sourceId: 'Method:src/Service.java:processOrder',
      calledName: 'findById',
      oldTargetId: 'Method:src/Other.java:findById',
      oldRelId: heuristicRelId,
      file: 'src/Service.java',
      line: 12,
      character: 8,
    };
    const candidates: Candidate[] = [candidate];

    // ── LSP response ─────────────────────────────────────────────────
    // The fake Java LSP returns a workspace definition for the real callee.
    const REAL_CALLEE_URI = 'file:///workspace/src/Repository.java';
    const locationByKey = new Map<string, Location[]>([
      [
        `${candidate.line}|${candidate.character}`,
        [{ uri: REAL_CALLEE_URI, range: { start: { line: 5, character: 0 } } }],
      ],
    ]);
    const fakeClient = makeFakeClient(locationByKey);

    // ── Session run ──────────────────────────────────────────────────
    const locations = new Map<string, Location[]>();

    const sessionResult = await withReconciliationSession(
      REPO_JAVA,
      candidates,
      async (selected, meta, skipped) => ({ count: selected.length, meta, skipped }),
      {
        // WI-6: explicitly pass JAVA_ADAPTER.
        adapter: JAVA_ADAPTER,
        // Fake discovery: java server present.
        discoverServers: async () => ({
          typescript: null,
          java: { path: '/usr/bin/jdtls', version: '1.0.0' },
        }),
        createLspClient: () => fakeClient,
        probe: PROBE_READY,
        handToEngine: async (cand, locs) => {
          locations.set(candidateLocationKey(cand), locs);
        },
      },
    );

    // #166 tripwire: session must have received and processed the candidate.
    expect(sessionResult).not.toBeNull();
    expect(sessionResult!.count).toBe(1);

    // ── Engine decision pass ─────────────────────────────────────────
    // Fake mapper: resolves the real callee URI at line 5 → the real node id.
    const fakeMapper = async (loc: Location, _repoId: string): Promise<MapperResult> => {
      if (loc.uri === REAL_CALLEE_URI) {
        // Line 5 → findById in Repository.java.
        return { kind: 'node', nodeId: 'Method:src/Repository.java:findById' };
      }
      return { kind: 'NO_NODE' };
    };

    const reconcileReport = await reconcileDecisions(
      graph,
      candidates,
      locations,
      {
        mapLocationToNodeId: fakeMapper,
        repoId: REPO_JAVA.id,
      },
    );

    // #166 tripwire: engine must have produced at least one confirm or correct.
    const actionableDecisions = reconcileReport.decisions.filter(
      (d) => d.action === 'confirm' || d.action === 'correct',
    );
    expect(actionableDecisions.length).toBeGreaterThan(0);

    // The specific decision should be 'correct' (LSP resolved to a different node
    // than the heuristic target).
    const correctDecision = reconcileReport.decisions.find((d) => d.action === 'correct');
    expect(correctDecision).toBeDefined();
    expect(correctDecision!.from).toBe('Method:src/Service.java:processOrder');
    expect(correctDecision!.to).toBe('Method:src/Repository.java:findById');

    // Summary counters: corrected ≥ 1.
    expect(reconcileReport.corrected).toBeGreaterThanOrEqual(1);

    // Apply is non-dryRun: the graph should be mutated.
    const applyResult = applyDecisions(graph, reconcileReport.decisions, { dryRun: false });
    expect(applyResult.decisions.filter((d) => d.action === 'correct').length).toBeGreaterThanOrEqual(1);

    // After apply: the edge to the wrong target should no longer exist;
    // the edge to the real target should be present.
    const remaining = [...graph.iterRelationships()];
    const wrongEdge = remaining.find(
      (r) => r.targetId === 'Method:src/Other.java:findById',
    );
    const correctEdge = remaining.find(
      (r) => r.targetId === 'Method:src/Repository.java:findById',
    );
    expect(wrongEdge).toBeUndefined();
    expect(correctEdge).toBeDefined();
  });
});

// ─── J2: selectAdapter → null → session short-circuits ───────────────

describe('WI-6 J2: selectAdapter → null → session adapter:null → returns null (no spawn)', () => {
  /**
   * When `deps.adapter` is explicitly `null`, `withReconciliationSession`
   * must return `null` immediately:
   *   - `discoverServers` MUST NOT be called (no I/O at all).
   *   - `createLspClient` MUST NOT be called (no subprocess spawn).
   *   - The work fn MUST NOT be called.
   *
   * This mirrors the production path where `selectAdapter(repoPath)` returns
   * `null` (no TS or Java files detected) and pipeline passes
   * `adapter: null` to the session.
   */
  it('adapter:null in deps → session returns null, no server discovery, no spawn', async () => {
    const fakeDiscover = vi.fn(async () => ({
      typescript: { path: '/bin/ts', version: '4.0.0' },
    }));
    const fakeFactory = vi.fn(() => {
      throw new Error('createLspClient must not be called');
    });
    const workFn = vi.fn(async () => 'should-not-run');

    const result = await withReconciliationSession(
      { id: 'r1', repoPath: '/tmp/no-lang' },
      [],
      workFn,
      {
        adapter: null,          // explicit null → no-language short-circuit
        discoverServers: fakeDiscover,
        createLspClient: fakeFactory,
        probe: PROBE_READY,
      },
    );

    expect(result).toBeNull();
    expect(fakeDiscover).not.toHaveBeenCalled();
    expect(fakeFactory).not.toHaveBeenCalled();
    expect(workFn).not.toHaveBeenCalled();
  });
});

// ─── J3: TS backward-compat — adapter:undefined ≡ TYPESCRIPT_ADAPTER ─

describe('WI-6 J3: TS backward compat — adapter:undefined produces same result as adapter:TYPESCRIPT_ADAPTER', () => {
  /**
   * Both calls use the same candidates + fake TS server.
   * The work fn returns the `selected.length`. We assert
   * both return the same non-null value — proving the
   * `undefined → TYPESCRIPT_ADAPTER` backward-compat path
   * is byte-identical to an explicit TS adapter.
   */
  it('adapter:undefined vs adapter:TYPESCRIPT_ADAPTER → identical session result', async () => {
    const candidates: Candidate[] = [
      {
        sourceId: 'Function:src/a.ts:foo',
        calledName: 'bar',
        oldTargetId: 'Function:src/b.ts:bar',
        file: 'src/a.ts',
        line: 5,
        character: 2,
      },
    ];

    function makeTsDeps(adapterOpt: typeof TYPESCRIPT_ADAPTER | undefined) {
      const locationByKey = new Map<string, Location[]>([
        [
          '5|2',
          [{ uri: 'file:///workspace/src/b.ts', range: { start: { line: 1, character: 0 } } }],
        ],
      ]);
      const fakeClient = makeFakeClient(locationByKey);
      const capturedLocs = new Map<string, Location[]>();

      return {
        deps: {
          ...(adapterOpt !== undefined ? { adapter: adapterOpt } : {}),
          discoverServers: async () => ({
            typescript: { path: '/bin/typescript-language-server', version: '4.3.3' },
          }),
          createLspClient: () => fakeClient,
          probe: PROBE_READY,
          handToEngine: async (cand: Candidate, locs: Location[]) => {
            capturedLocs.set(candidateLocationKey(cand), locs);
          },
        },
        capturedLocs,
      };
    }

    const { deps: depsUndefined, capturedLocs: locsUndefined } = makeTsDeps(undefined);
    const { deps: depsExplicit, capturedLocs: locsExplicit } = makeTsDeps(TYPESCRIPT_ADAPTER);

    const resultUndefined = await withReconciliationSession(
      { id: 'r-ts', repoPath: '/workspace' },
      candidates,
      async (selected) => selected.length,
      depsUndefined,
    );

    const resultExplicit = await withReconciliationSession(
      { id: 'r-ts', repoPath: '/workspace' },
      candidates,
      async (selected) => selected.length,
      depsExplicit,
    );

    // Both must succeed with the same candidate count.
    expect(resultUndefined).not.toBeNull();
    expect(resultExplicit).not.toBeNull();
    expect(resultUndefined).toBe(resultExplicit);

    // Both must have captured the definition for the candidate.
    const key = candidateLocationKey(candidates[0]);
    expect(locsUndefined.has(key)).toBe(true);
    expect(locsExplicit.has(key)).toBe(true);

    // The locations captured must be identical.
    expect(locsUndefined.get(key)).toEqual(locsExplicit.get(key));
  });

  /**
   * Explicit TS adapter: the discovery gate must pick `discovered.typescript`
   * (adapter.id === 'typescript'). This is symmetric to the Java gate in J1
   * that picks `discovered.java`.
   */
  it('explicit TYPESCRIPT_ADAPTER: discovery gate picks discovered.typescript, not .java', async () => {
    // Supply ONLY typescript in the discovered map — java is absent.
    // If the gate picks the wrong key the session returns null.
    const result = await withReconciliationSession(
      { id: 'r-ts-gate', repoPath: '/workspace' },
      [],
      async () => 'success',
      {
        adapter: TYPESCRIPT_ADAPTER,
        discoverServers: async () => ({
          typescript: { path: '/bin/tls', version: '4.0.0' },
          // java intentionally absent
        }),
        createLspClient: () => makeFakeClient(new Map()),
        probe: PROBE_READY,
      },
    );
    expect(result).toBe('success');
  });

  /**
   * Explicit JAVA_ADAPTER: the discovery gate must pick `discovered.java`.
   * If `discovered.java` is absent (only typescript present), the session
   * must return null — the gate correctly refuses.
   */
  it('explicit JAVA_ADAPTER: discovery gate picks discovered.java; absent java → null', async () => {
    // Only typescript present — no java server found.
    const result = await withReconciliationSession(
      { id: 'r-java-gate', repoPath: '/workspace' },
      [],
      async () => 'should-not-reach',
      {
        adapter: JAVA_ADAPTER,
        discoverServers: async () => ({
          typescript: { path: '/bin/tls', version: '4.0.0' },
          // java intentionally absent
        }),
        createLspClient: () => makeFakeClient(new Map()),
        probe: PROBE_READY,
      },
    );
    // Java adapter + no java server → gate refuses → null.
    expect(result).toBeNull();
  });
});
