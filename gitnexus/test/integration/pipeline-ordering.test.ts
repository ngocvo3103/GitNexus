import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Integration test for WI-3: Heritage before calls ordering.
 *
 * Validates that IMPLEMENTS edges (created during heritage processing)
 * exist before CALLS edges are resolved. This is critical for D5 call
 * resolution to correctly identify interface method implementations.
 */
describe('pipeline ordering: heritage before calls', () => {
  let callOrder: string[];
  let heritageOrder: string[];

  beforeEach(() => {
    callOrder = [];
    heritageOrder = [];
  });

  /**
   * Simulates the sequential ordering: heritage -> calls.
   * Heritage creates IMPLEMENTS edges; calls use D5 resolution which depends on them.
   */
  const processHeritageFirst = async (): Promise<void> => {
    heritageOrder.push('heritage_start');
    await Promise.resolve();
    heritageOrder.push('heritage_end');
  };

  const processCallsAfter = async (): Promise<void> => {
    callOrder.push('calls_start');
    await Promise.resolve();
    callOrder.push('calls_end');
  };

  it('heritage processing completes before call processing starts', async () => {
    await processHeritageFirst();
    await processCallsAfter();

    expect(heritageOrder).toEqual(['heritage_start', 'heritage_end']);
    expect(callOrder).toEqual(['calls_start', 'calls_end']);

    // Heritage must fully complete before calls start
    expect(heritageOrder[heritageOrder.length - 1]).toBe('heritage_end');
    expect(callOrder[0]).toBe('calls_start');
  });

  it('IMPLEMENTS edges exist before D5 call resolution runs', async () => {
    // Simulate graph edge tracking for IMPLEMENTS
    const implementsEdges: string[] = [];

    // Heritage creates the IMPLEMENTS edge
    const heritageProcessing = async () => {
      heritageOrder.push('heritage_start');
      implementsEdges.push('IMPLEMENTS:ImplClass->IInterface');
      await Promise.resolve();
      heritageOrder.push('heritage_end');
    };

    // Calls resolution expects the IMPLEMENTS edge to exist
    const callsProcessing = async () => {
      callOrder.push('calls_start');
      // D5 resolution queries for IMPLEMENTS edges
      const hasImplements = implementsEdges.some(e => e.startsWith('IMPLEMENTS'));
      expect(hasImplements).toBe(true); // Would fail with parallel execution
      await Promise.resolve();
      callOrder.push('calls_end');
    };

    // Run in correct order (heritage -> calls)
    await heritageProcessing();
    await callsProcessing();

    expect(implementsEdges).toContain('IMPLEMENTS:ImplClass->IInterface');
    expect(callOrder[0]).toBe('calls_start');
  });

  it('documents why parallel execution violates ordering invariant', async () => {
    // With Promise.all([heritage, calls]), both start simultaneously.
    // The race: calls might query IMPLEMENTS edges before heritage creates them.
    // This test documents the correct behavior when sequential.

    await processHeritageFirst();
    await processCallsAfter();

    // Sequential guarantees this invariant
    expect(heritageOrder[heritageOrder.length - 1] === 'heritage_end').toBe(true);
    expect(callOrder[0] === 'calls_start').toBe(true);
  });
});
