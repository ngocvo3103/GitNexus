# Cross-Repo Dependency Tracing — Backend Spec

**Date:** 2026-05-01
**Type:** Feature
**Risk:** MEDIUM

---

## Behavioral Contract

### BC-1: Auto-Discovery of Dependent Repos

**Given** a user runs `impacted_endpoints` on repo `tcbs-bond-trading-core` (without `repos` parameter)
**And** `tcbs-bond-trading`'s manifest declares dependency on `com.tcbs.bond.trading:tcbs-bond-trading-core`
**When** the tool resolves dependent repos
**Then** it automatically includes `tcbs-bond-trading` in the analysis scope

**Edge case**: If no indexed repos depend on `tcbs-bond-trading-core`, the tool runs single-repo BFS as before (backward compatible).

**Edge case**: If `repos` parameter is explicitly provided, it takes precedence over auto-discovery.

### BC-2: File-Path IMPORTS Resolution (Stage 1)

**Given** `TradingDto.java` changed in `tcbs-bond-trading-core` (lines 10-222)
**And** `tcbs-bond-trading`'s graph has `File:BondServiceImpl.java -[IMPORTS]-> File:TradingDto.java`
**When** the resolver runs Stage 1
**Then** it finds `BondServiceImpl.java` as an importer, extracts all Method/Class symbols in that file, and adds them to the BFS frontier at depth 1 with confidence 0.9

**Edge case**: If the changed file path doesn't exist in the consumer's IMPORTS edges (e.g., newly added file), Stage 1 returns empty.

### BC-3: Class-Name Symbol Resolution (Stage 2)

**Given** Stage 1 returned no results for `TradingDto`
**And** `tcbs-bond-trading`'s graph has `Class:...:TradingDto` node
**When** the resolver runs Stage 2
**Then** it finds the Class node matching the name `TradingDto` and adds it to the BFS frontier at depth 1 with confidence 0.8

**Edge case**: Multiple classes with same name in different packages — all are returned, each with confidence 0.9. Consumer can disambiguate by `filePath`.

### BC-4: Package-Path Resolution (Stage 3)

**Given** Stages 1 and 2 returned no results
**And** the changed class has filePath `src/main/java/com/tcbs/bond/trading/dto/TradingDto.java`
**When** the resolver converts to package path `com.tcbs.bond.trading.dto.TradingDto`
**Then** it searches the consumer repo for any File nodes with IMPORTS edges whose target contains this package path, and adds importing file symbols to frontier at confidence 0.7

**Edge case**: Wildcard imports (`com.tcbs.bond.trading.dto.*`) — matched by directory prefix.

### BC-5: Cross-Repo Impact Attribution

**Given** an endpoint `GET /e/v1/bonds/{id}` in `tcbs-bond-trading` is discovered through cross-repo resolution
**When** the result is assembled
**Then** the endpoint includes `_repoId: "tcbs-bond-trading"`, `_triggered_by: ["tcbs-bond-trading-core:TradingDto"]`, and `confidence: 0.9`

### BC-6: Single-Repo Backward Compatibility

**Given** a user runs `impacted_endpoints` without `repos` parameter and no dependents are found
**When** the tool executes
**Then** it behaves identically to the current single-repo implementation (no cross-repo context created, no resolver called)

### BC-7: BFS Consumption of Resolved Consumers

**Given** `CrossRepoResolver.resolveDepConsumers()` returns `ResolvedConsumer { id: "Method:...:getBondbyId", filePath: "src/.../BondServiceImpl.java", confidence: 0.9 }`
**When** BFS processes the resolved consumers
**Then** it queries the consumer repo for all Method/Class symbols in `BondServiceImpl.java` and adds them to the visited set at depth 1 with confidence 0.9

**Edge case**: If the importing file has no Method/Class symbols (e.g., a config file), the File node itself is added at depth 1.

### BC-8: Multi-Repo Auto-Expand

**Given** a user runs `impacted_endpoints` on `tcbs-bond-trading-core` without `repos` parameter
**And** `findConsumers("tcbs-bond-trading-core")` returns `["tcbs-bond-trading"]`
**When** the tool processes repos
**Then** it automatically includes `tcbs-bond-trading` in the analysis scope and creates `CrossRepoContext` for cross-repo resolution

**Edge case**: If `repos` parameter is explicitly provided, it overrides auto-discovery.
**Edge case**: If `findConsumers()` returns empty, falls back to single-repo (BC-6).

---

## Invariants

1. Auto-discovery never excludes the source repo — it only adds consumer repos
2. Cross-repo resolution is non-fatal — if it fails, results are correct for locally-changed symbols
3. Confidence for cross-repo discoveries is always ≤ 0.9 (Stage 1: 0.9, Stage 2: 0.8, Stage 3: 0.7). Local-only discoveries remain at confidence 1.0.
4. The `repos` parameter, when explicitly provided, overrides auto-discovery
5. Reverse dependency map is built from manifests at init time, not queried per-call

---

## Data Model

### Reverse Dependency Map (in-memory, built during init)

```typescript
// Added to CrossRepoRegistry
private reverseDepMap: Map<string, Set<string>> = new Map();

findConsumers(repoId: string): string[]
```

### CrossRepoResolver Interface

```typescript
interface ResolvedConsumer {
  id: string;
  name: string;
  filePath: string;
  confidence: number;  // 0.9 (file-imports), 0.8 (class-name), 0.7 (package-path)
  matchMethod: 'file-imports' | 'class-name' | 'package-path';
  matchedDepSymbol: string;
}
```

---

## Error Handling

| Error | Behavior |
|-------|----------|
| CrossRepoRegistry not initialized | Skip auto-discovery, run single-repo |
| Manifest missing/malformed | Skip that repo in reverse map, log warning |
| Resolver query fails (DB error) | Non-fatal, continue with locally-discovered results |
| No dependents found | Run single-repo BFS (backward compatible) |

---

## Performance Constraints

- Auto-discovery adds <10ms (in-memory map lookup)
- Cross-repo resolution adds <500ms per repo pair for <100 changed symbols
- BFS depth from cross-repo consumers is capped at 1 hop into consumer repo, then normal BFS continues