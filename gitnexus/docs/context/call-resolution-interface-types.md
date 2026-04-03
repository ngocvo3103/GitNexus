# CALLS Resolution for Interface-Typed Receivers

**Status:** Draft

## Summary

Fix `resolveCallTarget()` to create CALLS relationships when the receiver type is an interface and the method name has multiple implementations across the codebase.

## Context

### Problem

When a Java controller calls a method on an interface-typed field:

```java
@Controller
public class BookingController {
    private final SuggestionService<Order> suggestionService;
    
    public void unhold(Request req) {
        suggestionService.process(req);  // NO CALLS edge created
    }
}
```

The resolution fails because:
1. D1 resolves `SuggestionService` → interface node
2. D2 widens to 14 `process` method candidates
3. D3 file-based filtering may return empty (interface file has no methods)
4. D4 ownerId filtering fails: `ownerId` points to implementing CLASS, not interface

### Current Behavior

- `matchingServiceV2.suggestOrder()` → CALLS created ✓ (unique method name)
- `suggestionService.process()` → NO CALLS ✗ (common method name + interface type)

## Technical Design

### Resolution Tiers (Current)

| Tier | Logic | Status |
|------|-------|--------|
| D1 | Resolve receiver type via `ctx.resolve()` | ✓ Works |
| D2 | Widen candidates to global method pool | ✓ Works |
| D3 | Filter by resolved type's file(s) | ✓ Works for classes |
| D4 | Filter by ownerId matching type's nodeId | ✗ Fails for interfaces |

### New D5 Tier

```typescript
// After D4 fails, check if receiver type is an interface
if (typeResolved.candidates[0].type === 'Interface') {
  // D5: Find classes that IMPLEMENT this interface
  const implementerIds = ctx.findImplementations(typeNodeIds, graph);
  if (implementerIds.size > 0) {
    const interfaceFiltered = pool.filter(c => 
      c.ownerId && implementerIds.has(c.ownerId)
    );
    if (interfaceFiltered.length === 1) {
      return toResolveResult(interfaceFiltered[0], tiered.tier);
    }
  }
}
```

### Ordering Constraint

**Current:** `Promise.all([processCalls, processHeritage])` - runs in parallel
**Required:** Sequential: `await processHeritage()` → `await processCalls()`

IMPLEMENTS edges must exist before call resolution attempts D5 lookup.

## Implementation

### WI-1: `findImplementations()` Method

```typescript
// In resolution-context.ts
findImplementations(interfaceIds: Set<string>): Set<string> {
  if (!this.graph) return new Set();
  
  const implementerIds = new Set<string>();
  for (const edge of this.graph.getRelationships()) {
    if (edge.type === 'IMPLEMENTS' && interfaceIds.has(edge.targetId)) {
      implementerIds.add(edge.sourceId);
    }
  }
  return implementerIds;
}
```

### WI-2: Graph Access in ResolutionContext

```typescript
// In resolution-context.ts
interface ResolutionContextOptions {
  graph?: KnowledgeGraph;  // Optional - existing callers work without it
}

export function createResolutionContext(options?: ResolutionContextOptions): ResolutionContext {
  return {
    // ... existing fields ...
    graph: options?.graph,
    findImplementations(interfaceIds) { /* ... */ }
  };
}
```

### WI-3: Pipeline Ordering

```typescript
// In pipeline.ts (lines 306-328)
// BEFORE:
await Promise.all([
  processCallsFromExtracted(...),
  processHeritageFromExtracted(...),
]);

// AFTER:
await processHeritageFromExtracted(graph, chunkWorkerData.heritage, ctx, ...);
await processCallsFromExtracted(graph, chunkWorkerData.calls, ctx, ...);
```

### WI-4: D5 Tier Implementation

```typescript
// In call-processor.ts (after line 943)
// D5. Interface implementation lookup - find classes that implement this interface
const primaryCandidate = typeResolved.candidates[0];
if (primaryCandidate.type === 'Interface' && ctx.findImplementations) {
  const implementerIds = ctx.findImplementations(typeNodeIds);
  if (implementerIds.size > 0) {
    const interfaceFiltered = pool.filter(c => 
      c.ownerId && implementerIds.has(c.ownerId)
    );
    if (interfaceFiltered.length === 1) {
      return toResolveResult(interfaceFiltered[0], tiered.tier);
    }
    // Multiple implementers - could log warning or use heuristics
    if (interfaceFiltered.length > 1 && overloadHints) {
      const disambiguated = tryOverloadDisambiguation(interfaceFiltered, overloadHints);
      if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
    }
  }
}
```

## Verification

### Test Cases

1. **Interface with single implementation**
   - Given: `SuggestionService` interface with one implementation
   - When: Call resolution runs
   - Then: CALLS edge created to implementation method

2. **Interface with multiple implementations**
   - Given: `SuggestionService` interface with `process()` in 14 classes
   - When: Call resolution runs
   - Then: CALLS edge created to interface method (trace-time resolution handles ambiguity)

3. **Class-typed receiver**
   - Given: `MatchingService` class (not interface)
   - When: Call resolution runs
   - Then: D1-D4 behavior unchanged (D5 skipped)

4. **No implementations found**
   - Given: Interface with no IMPLEMENTS edges
   - When: D5 runs
   - Then: Gracefully returns empty, falls through to overload disambiguation

### Commands

```bash
# Re-index test repository
node dist/cli/index.js index test/fixtures/java/interface-receiver -r test-interface

# Verify IMPLEMENTS edges exist
node dist/cli/index.js cypher "MATCH (c:Class)-[:IMPLEMENTS]->(i:Interface {name: 'SuggestionService'}) RETURN c.name" -r test-interface

# Verify CALLS edge created
node dist/cli/index.js cypher "MATCH (m:Method {name: 'unhold'})-[r:CALLS]->(c) RETURN c.name, type(r)" -r test-interface
```

## Files

| File | Change |
|------|--------|
| `src/core/ingestion/resolution-context.ts` | Add `graph` option, `findImplementations()` method |
| `src/core/ingestion/pipeline.ts` | Pass graph to context, fix ordering |
| `src/core/ingestion/call-processor.ts` | Add D5 tier after D4 |
| `test/unit/resolution-context.test.ts` | Unit tests for `findImplementations()` |
| `test/unit/call-processor.test.ts` | Unit tests for D5 tier |
| `test/integration/interface-call-resolution.test.ts` | E2E test |

## Risks

| Risk | Mitigation |
|------|------------|
| Performance impact from sequential heritage processing | Measure ingestion time before/after |
| Ambiguity when interface has 14 implementations | Create CALLS to interface method, let trace-time resolution handle |
| Circular inheritance in IMPLEMENTS edges | D5 only looks one level deep (interface → direct implementers) |