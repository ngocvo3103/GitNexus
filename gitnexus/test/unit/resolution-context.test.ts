import { describe, it, expect, beforeEach } from 'vitest';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import type { KnowledgeGraph, GraphRelationship, GraphNode } from '../../src/core/graph/types.js';

const makeNode = (id: string, type = 'Class'): GraphNode => ({
  id,
  type,
  filePath: `src/${id}.ts`,
  name: id,
  properties: {},
});

const makeRel = (id: string, sourceId: string, targetId: string, relType: string): GraphRelationship => ({
  id,
  sourceId,
  targetId,
  type: relType as any,
  confidence: 1.0,
  reason: '',
});

const createGraph = (relationships: GraphRelationship[]): KnowledgeGraph => {
  const nodes = new Map<string, GraphNode>();
  const rels = relationships.slice();
  relationships.forEach(r => {
    if (!nodes.has(r.sourceId)) nodes.set(r.sourceId, makeNode(r.sourceId));
    if (!nodes.has(r.targetId)) nodes.set(r.targetId, makeNode(r.targetId));
  });

  return {
    nodes: Array.from(nodes.values()),
    relationships: rels,
    iterNodes: function* () { yield* nodes.values(); },
    iterRelationships: function* () { yield* rels; },
    forEachNode: fn => nodes.forEach(fn),
    forEachRelationship: fn => rels.forEach(fn),
    getNode: id => nodes.get(id),
    nodeCount: nodes.size,
    relationshipCount: rels.length,
    addNode: n => nodes.set(n.id, n),
    addRelationship: r => rels.push(r),
    removeNode: id => { const r = nodes.delete(id); return r; },
    removeRelationship: id => { const idx = rels.findIndex(r => r.id === id); if (idx >= 0) { rels.splice(idx, 1); return true; } return false; },
    removeNodesByFile: filePath => { const before = nodes.size; nodes.forEach((n, id) => { if (n.filePath === filePath) nodes.delete(id); }); return before - nodes.size; },
  };
};

describe('ResolutionContext', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  describe('findImplementations', () => {
    it('returns empty Set when graph is undefined', () => {
      expect(ctx.findImplementations(new Set(['iface:User']))).toEqual(new Set());
    });

    it('returns empty Set when graph has no IMPLEMENTS relationships', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'class:SomeOther', 'INHERITS'),
      ]);
      ctx.graph = graph;
      expect(ctx.findImplementations(new Set(['iface:User']))).toEqual(new Set());
    });

    it('returns empty Set when interfaceId is not targeted by any IMPLEMENTS edge', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'iface:User', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      expect(ctx.findImplementations(new Set(['iface:Other']))).toEqual(new Set());
    });

    it('returns single implementing class node ID', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'iface:User', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      expect(ctx.findImplementations(new Set(['iface:User']))).toEqual(new Set(['class:ImplA']));
    });

    it('returns multiple implementing class node IDs', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'iface:User', 'IMPLEMENTS'),
        makeRel('r2', 'class:ImplB', 'iface:User', 'IMPLEMENTS'),
        makeRel('r3', 'class:ImplC', 'iface:User', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      const result = ctx.findImplementations(new Set(['iface:User']));
      expect(result).toEqual(new Set(['class:ImplA', 'class:ImplB', 'class:ImplC']));
    });

    it('returns implementations for multiple interface IDs', () => {
      const graph = createGraph([
        makeRel('r1', 'class:UserImpl', 'iface:User', 'IMPLEMENTS'),
        makeRel('r2', 'class:AdminImpl', 'iface:Admin', 'IMPLEMENTS'),
        makeRel('r3', 'class:BothImpl', 'iface:User', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      const result = ctx.findImplementations(new Set(['iface:User', 'iface:Admin']));
      expect(result).toEqual(new Set(['class:UserImpl', 'class:BothImpl', 'class:AdminImpl']));
    });

    it('ignores IMPLEMENTS edges whose targetId is not in interfaceIds', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'iface:User', 'IMPLEMENTS'),
        makeRel('r2', 'class:ImplB', 'iface:Admin', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      // Only ask about iface:User
      const result = ctx.findImplementations(new Set(['iface:User']));
      expect(result).toEqual(new Set(['class:ImplA']));
      expect(result.has('class:ImplB')).toBe(false);
    });

    it('handles empty interfaceIds Set', () => {
      const graph = createGraph([
        makeRel('r1', 'class:ImplA', 'iface:User', 'IMPLEMENTS'),
      ]);
      ctx.graph = graph;
      expect(ctx.findImplementations(new Set())).toEqual(new Set());
    });

    it('graph property is mutable', () => {
      expect(ctx.graph).toBeUndefined();
      const graph = createGraph([]);
      ctx.graph = graph;
      expect(ctx.graph).toBe(graph);
    });
  });
});