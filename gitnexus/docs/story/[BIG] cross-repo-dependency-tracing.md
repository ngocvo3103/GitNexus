# True Cross-Repo Dependency Tracing — Story Document

**Date:** 2026-05-01
**Status:** In review
**Priority:** P1
**Effort:** Medium-High
**Risk:** MEDIUM (cross-repo graph traversal, ID matching, performance)
**Related:** impacted-endpoints-gap-fixes.md, impacted-endpoints-gaps.md, non-java-route-extractors.md

---

## Problem

When a DTO changes in a shared library repo (e.g., `tcbs-bond-trading-core`), `impacted_endpoints` should discover which API endpoints break in consumer repos (e.g., `tcbs-bond-trading`). Currently, it **cannot trace dependencies across repo boundaries**.

### Current Behavior

`impacted_endpoints` with `repos: ["tcbs-bond-trading-core", "tcbs-bond-trading"]`:

1. Runs `git diff` independently in each repo to find changed symbols
2. BFSes from changed symbols within each repo's graph independently
3. Aggregates results with `_repoId` attribution

The cross-repo bridging code (step 3c, lines 1972-2023 in `local-backend.ts`) attempts to find symbols in the consumer repo that `IMPORT` or `CALL` the changed dependency symbols, but **it fails in practice** because the Kùzu graph stores `IMPORTS` edges using local symbol IDs, not the cross-repo qualified IDs that the bridging query searches for.

### Evidence

Real-repo test: Added a field to `TradingDto` in `tcbs-bond-trading-core` (92 upstream dependents within the core repo, CRITICAL risk).

**Expected:** `impacted_endpoints` discovers that `TradingDto` is imported by `BondServiceImpl` in `tcbs-bond-trading`, which is called by `BondExtController` handler methods, which handle 5 endpoints.

**Actual:** The 5 endpoints are found only because `tcbs-bond-trading` has **36 pre-existing unstaged changes** in its own files. The cross-repo BFS does NOT trace `TradingDto (core) → IMPORTS → BondServiceImpl (trading) → CALLS → BondExtController → Route`. The tool reports `0 endpoints` for `tcbs-bond-trading-core` (correct — it has no Routes) but discovers endpoints in `tcbs-bond-trading` through local changes only, not through cross-repo dependency tracing.

---

## Root Cause Analysis

### Why Cross-Repo BFS Bridging Fails

The bridging code (step 3c) performs:

```
1. Query dep repos: MATCH (n) WHERE n.id IN [changedIds] RETURN n.id
2. For matching dep symbols: Query current repo for IMPORTS/CALLS edges
   MATCH (importer)-[r:CodeRelation]->(dep)
   WHERE dep.id IN $depIds AND r.type IN ['IMPORTS', 'CALLS']
```

**Failure point:** `dep.id` in the current repo's graph is a **local** node ID like `Class:src/main/java/.../TradingDto.java:TradingDto`. The IMPORTS edge from `BondServiceImpl` to `TradingDto` in tcbs-bond-trading's graph may store the target as:
- A fully qualified import path (e.g., `com.tcbs.bond.trading.dto.TradingDto`) — stored in a separate Import node
- A local class reference (e.g., the same `Class:src/main/java/.../TradingDto.java:TradingDto`) — only if tcbs-bond-trading has its own copy of the class
- Or the edge may not exist at all because the ingestion pipeline doesn't resolve cross-repo imports

**Key insight:** The Kùzu graph is per-repo. When `tcbs-bond-trading` imports `TradingDto` from `tcbs-bond-trading-core`, the ingestion pipeline creates an IMPORTS edge to an Import node or File node, not to the concrete Class node in the dependency repo. The bridging query searches for `dep.id IN $depIds` where `$depIds` are the Class node IDs from the dep repo — these don't match.

---

## Solution Design

### Approach: Import-Path Matching with Class Name Fallback

Three-stage cross-repo dependency resolution that works with the per-repo graph structure:

#### Stage 1: Import Path Matching (High Confidence)

When BFS encounters a symbol in the dependency repo, find consumers by matching Java package paths:

```
Dep repo:    TradingDto → filePath contains "com/tcbs/bond/trading/dto/TradingDto"
Consumer repo: IMPORTS edge target contains "com.tcbs.bond.trading.dto.TradingDto"
```

Query pattern:
```cypher
// In consumer repo: find symbols that import the changed class by package path
MATCH (importer)-[r:CodeRelation {type: 'IMPORTS'}]->(importNode)
WHERE importNode.name CONTAINS $shortClassName
  OR importNode.filePath CONTAINS $packagePath
RETURN importer.id, importer.name, importer.filePath, r.type, r.confidence
```

#### Stage 2: File-Level Import Matching (Medium Confidence)

If Stage 1 returns no results, match at the file level:

```
Dep repo:    TradingDto.java → filePath
Consumer repo: File nodes with IMPORTS edges to matching file paths
```

```cypher
MATCH (importer)-[r:CodeRelation {type: 'IMPORTS'}]->(depFile:File)
WHERE depFile.filePath CONTAINS $depFileName
RETURN importer.id, importer.name, importer.filePath, r.type, r.confidence
```

#### Stage 3: Class Name Fallback (Lower Confidence)

If no IMPORTS edges match, search by class name in the consumer repo:

```cypher
MATCH (c:Class)
WHERE c.name = $className
RETURN c.id, c.name, c.filePath
```

Then BFS from those matching classes to find routes.

### Implementation Plan

#### WI-1: Import Resolution Layer (Medium)

**File:** `src/mcp/local/cross-repo-resolver.ts` (NEW)

```typescript
interface CrossRepoResolver {
  // Given changed symbols from dep repo, find matching symbols in consumer repo
  resolveDepConsumers(
    consumerRepo: RepoHandle,
    depRepo: RepoHandle,
    changedSymbols: ChangedSymbol[]
  ): Promise<ResolvedConsumer[]>
}

interface ResolvedConsumer {
  id: string;           // Consumer repo symbol ID
  name: string;
  filePath: string;
  confidence: number;  // 1.0 = import path match, 0.9 = file match, 0.8 = name match
  matchMethod: 'import-path' | 'file-path' | 'class-name';
  matchedDepSymbol: string;  // ID of the dep symbol that matched
}
```

Three resolution strategies:
1. **Import-path matching** (confidence 1.0): Convert dep symbol's `filePath` to Java package path (`com/tcbs/bond/trading/dto/TradingDto.java` → `com.tcbs.bond.trading.dto.TradingDto`), then search IMPORTS edges
2. **File-path matching** (confidence 0.9): Match on file name suffix (`TradingDto.java`)
3. **Class-name matching** (confidence 0.8): Match on class name (`TradingDto`)

#### WI-2: Enhanced BFS Step 3c (Medium)

**File:** `src/mcp/local/local-backend.ts` (MODIFY)

Replace the current cross-repo bridging query (lines 1972-2023) with:

1. Collect all changed symbols from dep repos
2. For each consumer repo in the `repos` list:
   a. Call `CrossRepoResolver.resolveDepConsumers()` to find local symbols that depend on changed dep symbols
   b. Add resolved consumers to BFS frontier at depth 1 with confidence from match method
   c. Continue BFS from those consumers to discover Routes

#### WI-3: Multi-Repo BFS Orchestration (Medium)

**File:** `src/mcp/local/local-backend.ts` (MODIFY)

Current flow (broken):
```
For each repo in repos:
  Run _impactedEndpointsImpl independently
  Aggregate results with _repoId
```

New flow:
```
Phase 1: Collect changed symbols from ALL repos
Phase 2: For each repo (consumer), resolve cross-repo dependencies from ALL other repos (dep)
Phase 3: BFS from (local changed symbols + resolved cross-repo consumers) to Routes
Phase 4: Aggregate results with _repoId
```

This ensures a DTO change in `tcbs-bond-trading-core` propagates to `BondServiceImpl` in `tcbs-bond-trading` even when `tcbs-bond-trading` has no local changes.

#### WI-4: Cross-Repo Impact Attribution (Low)

**File:** `src/mcp/local/local-backend.ts` (MODIFY)

When an endpoint is discovered through cross-repo BFS, attribute it correctly:

```typescript
{
  method: "GET",
  path: "/e/v1/bonds/{id}",
  confidence: 0.9,       // Lower than local-only (1.0)
  discovery_paths: [
    "CROSS_REPO_IMPORT:TradingDto@tcbs-bond-trading-core → BondServiceImpl → BondExtController → GET /e/v1/bonds/{id}"
  ],
  _repoId: "tcbs-bond-trading",
  _triggered_by: "tcbs-bond-trading-core:TradingDto"
}
```

#### WI-5: E2E Cross-Repo Test (Low)

**File:** `test/integration/impacted-endpoints-cross-repo.test.ts` (MODIFY)

Replace the placeholder test ("returns _repoId attribution in results") with real cross-repo BFS tests:

| Test ID | Scenario | Expected Result |
|---------|----------|-----------------|
| E2E-CR01 | Change DTO in library repo → discover endpoint in consumer repo | Consumer endpoints found via cross-repo import chain |
| E2E-CR02 | Change service method in library repo → discover endpoint in consumer | Consumer endpoints found via CALLS chain |
| E2E-CR03 | Change only affects library repo (no consumers) | 0 endpoints in consumer, correct count in library |
| E2E-CR04 | Library has no Routes → all endpoints in consumer | All consumer endpoints correctly attributed |

---

## Architecture

### Data Flow (Before)

```
impacted_endpoints(repos: [core, trading])
  ├── git diff in core → changed symbols in core graph → BFS in core → 0 Routes
  ├── git diff in trading → changed symbols in trading graph → BFS in trading → 5 Routes
  └── Aggregate: core: 0 endpoints, trading: 5 endpoints (local changes only)
```

### Data Flow (After)

```
impacted_endpoints(repos: [core, trading])
  ├── Phase 1: git diff in core + trading → changed symbols from both repos
  ├── Phase 2: Cross-repo resolution
  │   ├── TradingDto (core) → BondServiceImpl (trading) via IMPORTS match
  │   └── Add BondServiceImpl to trading's BFS frontier at depth 1
  ├── Phase 3: BFS from expanded frontier in trading
  │   └── BondServiceImpl → BondExtController → Routes (5 endpoints)
  └── Result: trading: 5 endpoints (attributed to TradingDto change in core)
```

### Key Difference

The current implementation treats each repo independently. The new implementation resolves cross-repo import chains and feeds them into the BFS frontier, enabling true dependency propagation from library → consumer.

---

## Performance Considerations

| Concern | Mitigation |
|---------|-----------|
| N² resolution queries (each repo × each other repo) | Limit to repos with changed symbols; batch queries |
| IMPORTS edge scan could be slow on large repos | Add compound index on `CodeRelation.type + target.name` |
| Class-name fallback may produce false positives | Use confidence scoring; lower confidence for name-only matches |
| Multi-repo BFS depth explosion | Cap cross-repo BFS depth at 1 (only direct importers); full BFS continues within consumer repo |

---

## Acceptance Criteria

1. **DTO change propagation**: Changing a DTO in `tcbs-bond-trading-core` must discover endpoints in `tcbs-bond-trading` that use that DTO, even when `tcbs-bond-trading` has no local changes
2. **No false positives**: Cross-repo tracing must NOT discover endpoints that don't actually depend on the changed symbol
3. **Attribution**: Results must show `_repoId` and `_triggered_by` (or equivalent) indicating which dep repo's change triggered the endpoint discovery
4. **Confidence scoring**: Cross-repo discovered endpoints must have lower confidence (0.8-0.9) than local-only discoveries (1.0)
5. **Performance**: Cross-repo resolution adds <500ms per repo pair for repos with <100 changed symbols
6. **Backward compatibility**: Single-repo calls (`impacted_endpoints` without `repos`) must work identically to before
7. **Fallback**: If cross-repo resolution fails (e.g., no IMPORTS edges), results must still be correct for locally-changed symbols

---

## Dependencies

- WI-4 from `impacted-endpoints-gap-fixes.md` (cross-repo BFS bridging via CrossRepoContext) — **DONE**, but the implementation only handles the query routing; the actual dependency resolution doesn't work because IMPORTS edge targets don't match dep repo symbol IDs
- WI-1 from `impacted-endpoints-gap-fixes.md` (FETCHES query) — **DONE**, improves transitive discovery
- `cross-repo-context.ts` — existing interface, may need extension for the resolver

## Open Questions

1. Should the import-path matching handle Python (`from tcbs.bond.trading.dto import TradingDto`) and Go (`import "github.com/tcbs/bond-trading-core/dto"`) in addition to Java?
2. Should we cache cross-repo resolution results for repeated queries within the same session?
3. How should we handle the case where the same class name exists in multiple packages (e.g., `com.tcbs.bond.trading.dto.TradingDto` vs `com.tcbs.bond.trading.v2.dto.TradingDto`)?
4. Should `_triggered_by` be a single string or an array (for endpoints reached through multiple changed symbols)?