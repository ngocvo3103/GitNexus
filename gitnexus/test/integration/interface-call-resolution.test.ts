import { describe, it, expect, beforeAll } from 'vitest';
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './resolvers/helpers.js';

/**
 * Integration test for WI-5: Interface-typed receiver CALLS edge creation.
 *
 * Validates that CALLS relationships are created when a Java controller calls
 * a method on an interface-typed field with a common method name.
 *
 * Pattern: Spring DI with interface type and implementation class.
 * - Controller has field: `private final Service service;`
 * - Service is an interface with `process()` method
 * - ServiceImpl is a concrete implementation
 * - CALLS edge should be created from controller method to `process`
 *
 * The fixture tests D5 resolution: when D4 ownerId fallback fails for
 * interface-typed receivers, D5 uses IMPLEMENTS edges to find implementing
 * classes and filters method candidates by their ownerIds.
 */
describe('interface-typed receiver: CALLS edge creation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-interface-receiver'),
      () => {},
      { skipGraphPhases: false }
    );
  }, 60000);

  it('creates IMPLEMENTS edge from implementation to interface', () => {
    const implEdges = getRelationships(result, 'IMPLEMENTS');
    expect(implEdges.length).toBeGreaterThanOrEqual(1);
    
    // ServiceImpl implements Service
    const serviceImpl = implEdges.find(e => e.source === 'ServiceImpl');
    expect(serviceImpl).toBeDefined();
    expect(serviceImpl!.target).toBe('Service');
  });

  it('creates CALLS edge from controller method to interface method', () => {
    const callsEdges = getRelationships(result, 'CALLS');
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);

    // Find CALLS edge from execute() -> process()
    // This is the core bug fix: D5 resolution finds the method via IMPLEMENTS edge
    const executeToProcess = callsEdges.find(r =>
      r.source === 'execute' && r.target === 'process'
    );
    
    // With D5 implementation, the CALLS edge should be created
    expect(executeToProcess).toBeDefined();
    expect(executeToProcess!.rel.reason).toBe('import-resolved');
  });

  it('resolves interface-typed receiver using D5 tier', () => {
    // Verify the Method node for 'process' exists
    const methodNodes = getNodesByLabel(result, 'Method');
    expect(methodNodes).toContain('process');

    // Verify the Interface node exists
    const interfaceNodes = getNodesByLabel(result, 'Interface');
    expect(interfaceNodes).toContain('Service');

    // Verify the Class node exists (implementation)
    const classNodes = getNodesByLabel(result, 'Class');
    expect(classNodes).toContain('ServiceImpl');
  });
});