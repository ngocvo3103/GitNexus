/**
 * Regression guard: `processProcesses` is insertion-order-independent.
 *
 * Bug history (three separate regressions on perf/lsp-analyze-speedup):
 *   Bug 1 — findEntryPoints tied-score candidates were in Map insertion order
 *            → proc_<idx> numbering churned between sequential and parallel-parse paths.
 *            Fixed: sort uses total-order comparator with id tiebreak.
 *   Bug 2 — buildCallsGraph callees were in edge insertion order; slice(0, maxBranching)
 *            picked different callees between the two paths.
 *            Fixed: adjacency lists sorted by targetId after construction.
 *   Bug 3 — deduplicateTraces / deduplicateByEndpoints / limitedTraces sorts were
 *            not total-order → equal-length traces kept/numbered in insertion order.
 *            Fixed: all three sorts use length-desc + full-path-lexicographic comparator.
 *
 * This test builds the same graph twice with nodes and edges added in two
 * different insertion orders and asserts `processProcesses` produces IDENTICAL
 * results. "Same" means: same process IDs, same trace arrays, same step numbers.
 *
 * Graph topology (designed to exercise all three bug classes):
 *
 *   func:hub (name="handleUsers", exported, 5 callees > maxBranching=4)
 *     → func:hub_callee_alpha → func:hub_term_alpha   ← Bug 2: callee sort
 *     → func:hub_callee_beta  → func:hub_term_beta
 *     → func:hub_callee_gamma → func:hub_term_gamma
 *     → func:hub_callee_delta → func:hub_term_delta
 *     → func:hub_callee_zeta  → func:hub_term_zeta    ← dropped (last alphabetically)
 *
 *   func:ep_a (name="handleA", exported, tied-score 9.0 with ep_b)   ← Bug 1
 *     → func:mid_a1 → func:term_a1
 *     → func:mid_a2 → func:term_a2
 *     → func:mid_a3 → func:term_a3
 *
 *   func:ep_b (name="handleB", exported, tied-score 9.0 with ep_a)   ← Bug 1
 *     → func:mid_b1 → func:term_b1
 *     → func:mid_b2 → func:term_b2
 *     → func:mid_b3 → func:term_b3
 *
 * Score formula:
 *   hub:  (5 callees / (0 callers + 1)) × 2.0 × 1.5 × 1.0 = 15.0
 *   ep_a: (3 callees / (0 callers + 1)) × 2.0 × 1.5 × 1.0 =  9.0  (tied with ep_b)
 *   ep_b: (3 callees / (0 callers + 1)) × 2.0 × 1.5 × 1.0 =  9.0  (tied with ep_a)
 *
 * ORDER_A: hub → ep_a → ep_b (callees in ascending id order, edges forward)
 * ORDER_B: ep_b → ep_a → hub (callees in descending id order, edges reversed)
 */

import { describe, it, expect } from 'vitest';
import { processProcesses } from '../../src/core/ingestion/process-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { CommunityMembership } from '../../src/core/ingestion/community-processor.js';

// ── Graph construction helpers ────────────────────────────────────────────────

function addFn(
  graph: KnowledgeGraph,
  id: string,
  name: string,
  opts: { exported?: boolean } = {},
) {
  graph.addNode({
    id,
    label: 'Function',
    properties: {
      name,
      filePath: `src/${id.replace('func:', '')}.ts`,
      startLine: 1,
      endLine: 20,
      isExported: opts.exported ?? false,
      language: 'typescript' as any,
    },
  });
}

function addCall(
  graph: KnowledgeGraph,
  edgeId: string,
  sourceId: string,
  targetId: string,
) {
  graph.addRelationship({
    id: edgeId,
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: 0.9,
    reason: 'import-resolved',
  });
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

type ProcessResult = Awaited<ReturnType<typeof processProcesses>>;

function snapshotProcesses(result: ProcessResult) {
  return result.processes
    .map(p => ({
      id: p.id,
      entryPointId: p.entryPointId,
      terminalId: p.terminalId,
      trace: [...p.trace],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function snapshotSteps(result: ProcessResult) {
  return result.steps
    .map(s => ({ nodeId: s.nodeId, processId: s.processId, step: s.step }))
    .sort((a, b) => {
      if (a.processId !== b.processId) return a.processId < b.processId ? -1 : 1;
      return a.step - b.step;
    });
}

// ── Fixture definition ────────────────────────────────────────────────────────

const HUB_CALLEES = [
  { calleeId: 'func:hub_callee_alpha', termId: 'func:hub_term_alpha',
    callEdgeId: 'call:hub_to_alpha', termEdgeId: 'call:alpha_to_term' },
  { calleeId: 'func:hub_callee_beta',  termId: 'func:hub_term_beta',
    callEdgeId: 'call:hub_to_beta',  termEdgeId: 'call:beta_to_term' },
  { calleeId: 'func:hub_callee_gamma', termId: 'func:hub_term_gamma',
    callEdgeId: 'call:hub_to_gamma', termEdgeId: 'call:gamma_to_term' },
  { calleeId: 'func:hub_callee_delta', termId: 'func:hub_term_delta',
    callEdgeId: 'call:hub_to_delta', termEdgeId: 'call:delta_to_term' },
  // zeta sorts LAST alphabetically → gets dropped after sort+slice(0, maxBranching=4)
  { calleeId: 'func:hub_callee_zeta',  termId: 'func:hub_term_zeta',
    callEdgeId: 'call:hub_to_zeta',  termEdgeId: 'call:zeta_to_term' },
];

const EP_A_CHAINS = [
  { midId: 'func:mid_a1', termId: 'func:term_a1',
    callEdgeId: 'call:a_to_mid1', termEdgeId: 'call:mid1_to_term' },
  { midId: 'func:mid_a2', termId: 'func:term_a2',
    callEdgeId: 'call:a_to_mid2', termEdgeId: 'call:mid2_to_term' },
  { midId: 'func:mid_a3', termId: 'func:term_a3',
    callEdgeId: 'call:a_to_mid3', termEdgeId: 'call:mid3_to_term' },
];

const EP_B_CHAINS = [
  { midId: 'func:mid_b1', termId: 'func:term_b1',
    callEdgeId: 'call:b_to_mid1', termEdgeId: 'call:mid_b1_to_term' },
  { midId: 'func:mid_b2', termId: 'func:term_b2',
    callEdgeId: 'call:b_to_mid2', termEdgeId: 'call:mid_b2_to_term' },
  { midId: 'func:mid_b3', termId: 'func:term_b3',
    callEdgeId: 'call:b_to_mid3', termEdgeId: 'call:mid_b3_to_term' },
];

/**
 * Populate a KnowledgeGraph with the parity fixture.
 *
 * @param insertionOrder
 *   'ab' — hub first, then ep_a, then ep_b; callees/edges in ascending-id order
 *   'ba' — ep_b first, then ep_a, then hub; callees/edges in descending-id order
 *
 * Both graphs contain identical node and edge SETS; only the insertion (Map) order
 * differs. Without the three determinism fixes, `processProcesses` would produce
 * different proc_<idx> numbering and different trace selections between the two.
 */
function populateGraph(graph: KnowledgeGraph, insertionOrder: 'ab' | 'ba') {
  const isAB = insertionOrder === 'ab';

  // ── Entry-point nodes ────────────────────────────────────────────────────
  //
  // Score formula: calleeCount/(callerCount+1) × exportMultiplier × nameMultiplier
  //   hub:  (5/1) × 2.0 × 1.5 = 15.0   ← higher, sorts before ep_a/ep_b
  //   ep_a: (3/1) × 2.0 × 1.5 =  9.0   ← tied with ep_b; tiebreak by id
  //   ep_b: (3/1) × 2.0 × 1.5 =  9.0   ← "func:ep_a" < "func:ep_b" → ep_a first
  //
  const entryPointDefs = [
    { id: 'func:hub',  name: 'handleUsers' },
    { id: 'func:ep_a', name: 'handleA' },
    { id: 'func:ep_b', name: 'handleB' },
  ];
  const epOrder = isAB ? entryPointDefs : [...entryPointDefs].reverse();
  for (const ep of epOrder) {
    addFn(graph, ep.id, ep.name, { exported: true });
  }

  // ── Hub callees + terminals (5 pairs; zeta dropped by sort+slice) ────────
  const hubOrder = isAB ? HUB_CALLEES : [...HUB_CALLEES].reverse();
  for (const { calleeId, termId } of hubOrder) {
    // Use neutral names (no entry-point pattern match, not exported)
    // to keep their scores well below hub/ep_a/ep_b so they never
    // become dominant entry points themselves.
    addFn(graph, calleeId, calleeId.replace('func:hub_callee_', 'step_'));
    addFn(graph, termId, termId.replace('func:hub_term_', 'sink_'));
  }

  // ── ep_a mid + terminal nodes ────────────────────────────────────────────
  const aOrder = isAB ? EP_A_CHAINS : [...EP_A_CHAINS].reverse();
  for (const { midId, termId } of aOrder) {
    addFn(graph, midId, midId.replace('func:', ''));
    addFn(graph, termId, termId.replace('func:', ''));
  }

  // ── ep_b mid + terminal nodes ────────────────────────────────────────────
  const bOrder = isAB ? EP_B_CHAINS : [...EP_B_CHAINS].reverse();
  for (const { midId, termId } of bOrder) {
    addFn(graph, midId, midId.replace('func:', ''));
    addFn(graph, termId, termId.replace('func:', ''));
  }

  // ── CALLS edges ──────────────────────────────────────────────────────────
  // Edge insertion order is the core of Bug 2: buildCallsGraph iterates
  // iterRelationships() (insertion order) to build the adjacency list.
  // Without the callee sort, the 5th callee pushed into adj[hub] would be
  // whichever was added last, not whichever has the last alphabetical id.

  const hubEdges = hubOrder.flatMap(({ calleeId, termId, callEdgeId, termEdgeId }) => [
    { id: callEdgeId, src: 'func:hub', tgt: calleeId },
    { id: termEdgeId, src: calleeId, tgt: termId },
  ]);
  const aEdges = aOrder.flatMap(({ midId, termId, callEdgeId, termEdgeId }) => [
    { id: callEdgeId, src: 'func:ep_a', tgt: midId },
    { id: termEdgeId, src: midId, tgt: termId },
  ]);
  const bEdges = bOrder.flatMap(({ midId, termId, callEdgeId, termEdgeId }) => [
    { id: callEdgeId, src: 'func:ep_b', tgt: midId },
    { id: termEdgeId, src: midId, tgt: termId },
  ]);

  const allEdges = isAB
    ? [...hubEdges, ...aEdges, ...bEdges]
    : [...bEdges, ...aEdges, ...hubEdges];

  for (const e of allEdges) {
    addCall(graph, e.id, e.src, e.tgt);
  }
}

// No memberships — all nodes are community-less → processType 'intra_community'
const NO_MEMBERSHIPS: CommunityMembership[] = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('processProcesses — insertion-order independence', () => {
  // -----------------------------------------------------------------
  // Primary regression: run twice with different insertion orders and
  // assert the output is byte-identical.
  // -----------------------------------------------------------------

  it('(Bug 1+2+3) process IDs and traces are identical regardless of node/edge insertion order', async () => {
    const graphAB = createKnowledgeGraph();
    const graphBA = createKnowledgeGraph();

    populateGraph(graphAB, 'ab');
    populateGraph(graphBA, 'ba');

    const resultAB = await processProcesses(graphAB, NO_MEMBERSHIPS);
    const resultBA = await processProcesses(graphBA, NO_MEMBERSHIPS);

    expect(resultAB.processes.length).toBeGreaterThan(0);
    expect(resultAB.processes.length).toBe(resultBA.processes.length);

    // Snapshot comparison covers id (proc_<idx>), entryPointId, terminalId, trace
    expect(snapshotProcesses(resultAB)).toEqual(snapshotProcesses(resultBA));
  });

  it('(Bug 1+2+3) STEP_IN_PROCESS step numbers are identical regardless of insertion order', async () => {
    const graphAB = createKnowledgeGraph();
    const graphBA = createKnowledgeGraph();

    populateGraph(graphAB, 'ab');
    populateGraph(graphBA, 'ba');

    const resultAB = await processProcesses(graphAB, NO_MEMBERSHIPS);
    const resultBA = await processProcesses(graphBA, NO_MEMBERSHIPS);

    expect(snapshotSteps(resultAB)).toEqual(snapshotSteps(resultBA));
  });

  // -----------------------------------------------------------------
  // Bug 2 isolation: callee sort drops the CORRECT 5th callee (zeta)
  // regardless of which insertion order was used.
  // -----------------------------------------------------------------

  it('(Bug 2) drops the last-alphabetical callee when >maxBranching callees exist', async () => {
    const graph = createKnowledgeGraph();
    populateGraph(graph, 'ab'); // insertion order does not matter for this assertion
    const result = await processProcesses(graph, NO_MEMBERSHIPS);

    const allTraceNodes = result.processes.flatMap(p => p.trace);

    // func:hub_callee_zeta sorts last → must be dropped by slice(0, maxBranching=4)
    expect(allTraceNodes).not.toContain('func:hub_callee_zeta');
    expect(allTraceNodes).not.toContain('func:hub_term_zeta');

    // All four kept callees must appear in traces
    expect(allTraceNodes).toContain('func:hub_callee_alpha');
    expect(allTraceNodes).toContain('func:hub_callee_beta');
    expect(allTraceNodes).toContain('func:hub_callee_gamma');
    expect(allTraceNodes).toContain('func:hub_callee_delta');
  });

  it('(Bug 2) insertion order in reverse produces the SAME 4 hub callees', async () => {
    const graphBA = createKnowledgeGraph();
    populateGraph(graphBA, 'ba'); // callees added in reverse id order (zeta first)
    const result = await processProcesses(graphBA, NO_MEMBERSHIPS);

    const allTraceNodes = result.processes.flatMap(p => p.trace);

    // Even though zeta was inserted FIRST in ORDER_B, the callee sort must
    // still drop it because it sorts last by id — not by insertion position.
    expect(allTraceNodes).not.toContain('func:hub_callee_zeta');
    expect(allTraceNodes).not.toContain('func:hub_term_zeta');

    expect(allTraceNodes).toContain('func:hub_callee_alpha');
    expect(allTraceNodes).toContain('func:hub_callee_beta');
    expect(allTraceNodes).toContain('func:hub_callee_gamma');
    expect(allTraceNodes).toContain('func:hub_callee_delta');
  });

  // -----------------------------------------------------------------
  // Bug 1 isolation: tied-score entry points (ep_a and ep_b both score
  // 9.0) must always be ordered by node id, never by insertion order.
  // -----------------------------------------------------------------

  it('(Bug 1) tied-score entry points always ordered by node id, not insertion order', async () => {
    const graphAB = createKnowledgeGraph(); // hub, ep_a, ep_b  (ep_a inserted first)
    const graphBA = createKnowledgeGraph(); // ep_b, ep_a, hub  (ep_b inserted first)

    populateGraph(graphAB, 'ab');
    populateGraph(graphBA, 'ba');

    const resultAB = await processProcesses(graphAB, NO_MEMBERSHIPS);
    const resultBA = await processProcesses(graphBA, NO_MEMBERSHIPS);

    // Find the first process index where ep_a / ep_b is the entry point.
    const firstEpAIdxAB = resultAB.processes.findIndex(p => p.entryPointId === 'func:ep_a');
    const firstEpBIdxAB = resultAB.processes.findIndex(p => p.entryPointId === 'func:ep_b');
    const firstEpAIdxBA = resultBA.processes.findIndex(p => p.entryPointId === 'func:ep_a');
    const firstEpBIdxBA = resultBA.processes.findIndex(p => p.entryPointId === 'func:ep_b');

    // "func:ep_a" < "func:ep_b" → ep_a must always appear before ep_b in both runs
    expect(firstEpAIdxAB).not.toBe(-1);
    expect(firstEpBIdxAB).not.toBe(-1);
    expect(firstEpAIdxAB).toBeLessThan(firstEpBIdxAB);

    expect(firstEpAIdxBA).not.toBe(-1);
    expect(firstEpBIdxBA).not.toBe(-1);
    expect(firstEpAIdxBA).toBeLessThan(firstEpBIdxBA);

    // Positions must be IDENTICAL between the two insertion orders
    expect(firstEpAIdxAB).toBe(firstEpAIdxBA);
    expect(firstEpBIdxAB).toBe(firstEpBIdxBA);
  });

  // -----------------------------------------------------------------
  // Stats sanity: determinism extends to aggregate statistics too.
  // -----------------------------------------------------------------

  it('stats fields are identical regardless of insertion order', async () => {
    const graphAB = createKnowledgeGraph();
    const graphBA = createKnowledgeGraph();

    populateGraph(graphAB, 'ab');
    populateGraph(graphBA, 'ba');

    const resultAB = await processProcesses(graphAB, NO_MEMBERSHIPS);
    const resultBA = await processProcesses(graphBA, NO_MEMBERSHIPS);

    expect(resultAB.stats).toEqual(resultBA.stats);
  });
});
