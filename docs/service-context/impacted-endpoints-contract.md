# impacted_endpoints — MCP Tool Contract

**Version:** 1.0
**Type:** MCP Tool (local, stdio protocol)
**Date:** 2026-04-29

## Endpoint Catalog

| Tool Name | Type | Auth | Description |
|-----------|------|------|-------------|
| `impacted_endpoints` | MCP tool | None (local) | Given a git base_ref, discovers all API endpoints impacted by code changes |

## Input Schema

```typescript
interface ImpactedEndpointsInput {
  scope?: 'unstaged' | 'staged' | 'all' | 'compare';  // default: 'unstaged'
  base_ref?: string;              // required when scope='compare'
  max_depth?: number;             // default: 3, range: 1-10
  min_confidence?: number;        // default: 0.7, range: 0-1
  repo?: string;                  // optional single repo
  repos?: string[];               // optional multi-repo
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | enum | No | `'unstaged'` | Git diff scope |
| `base_ref` | string | When scope='compare' | — | Git ref to diff against |
| `max_depth` | number | No | `3` | BFS traversal depth (1-10) |
| `min_confidence` | number | No | `0.7` | Minimum edge confidence filter (0-1) |
| `repo` | string | No | — | Specific indexed repo |
| `repos` | string[] | No | — | Multi-repo dispatch |

## Output Schema

```typescript
interface ImpactedEndpointsOutput {
  summary: {
    changed_files: Record<string, number>;    // keyed by repo name, e.g. { "my-service": 3 }
    changed_symbols: number;
    impacted_endpoints: Record<string, number>; // keyed by repo name, e.g. { "my-service": 12 }
    risk_level: 'none' | 'low' | 'medium' | 'high' | 'critical';
  };
  impacted_endpoints: {
    WILL_BREAK: ImpactedEndpoint[];       // depth <= 1, confidence >= 0.85
    LIKELY_AFFECTED: ImpactedEndpoint[];  // depth <= 3, confidence >= 0.7
    MAY_NEED_TESTING: ImpactedEndpoint[]; // remaining
  };
  changed_symbols: ChangedSymbol[];
  _meta: {
    version: '1.0';
    generated_at: string;  // ISO 8601
  };
}

interface ImpactedEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  path: string;             // e.g., '/api/users/{id}'
  controller?: string;
  handler?: string;
  file_path: string;
  line?: number;
  impact_depth: number;     // shortest path length from change to Route
  confidence: number;       // min edge confidence along path (0-1)
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  affected_by: Array<{
    name: string;
    file_path: string;
    depth: number;
  }>;
  _repoId?: string;         // cross-repo attribution
}
```

### Tier Assignment Rules

| Tier | Depth | Confidence | Description |
|------|-------|------------|-------------|
| `WILL_BREAK` | <= 1 | >= 0.85 | Direct handler or file-based route in changed file |
| `LIKELY_AFFECTED` | <= 3 | >= 0.7 | Transitive dependency through service/utility calls |
| `MAY_NEED_TESTING` | remaining | — | Deep transitive or low-confidence paths |

- Each Route appears in exactly ONE tier (worst-tier wins)
- `viaSymbols` lists original changed symbols only (v1), full `relation_chain` deferred to v2

## Error Contract

| Condition | Response |
|-----------|----------|
| Repo not indexed | `{ error: "REPO_NOT_INDEXED", message: "Repo 'X' has not been analyzed. Run gitnexus analyze first." }` |
| Git diff fails (invalid ref, permission error) | `{ error: "GIT_DIFF_FAILED", message: "Git diff failed: <details>" }` |
| Git unavailable | `{ error: "GIT_UNAVAILABLE", message: "Not a git repository or git not found." }` |
| No changes detected | `{ summary: { changed_files: { "repoName": 0 }, changed_symbols: 0, impacted_endpoints: { "repoName": 0 }, risk_level: 'none' }, impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] }, changed_symbols: [] }` |
| No indexed symbols match changed files | `{ error: "NO_SYMBOLS_MATCHED", message: "Changed files contain no indexed symbols. Re-run gitnexus analyze." }` |
| Traversal overflow (>10k expanded) | `{ ..., _meta: { partial: true, overflow_at_depth: number } }` |
| Invalid scope/base_ref combo | `{ error: "INVALID_INPUT", message: "scope='compare' requires base_ref parameter." }` |
| Max depth out of range | `{ error: "INVALID_INPUT", message: "max_depth must be between 1 and 10." }` |

## Cross-Stack Behavioral Guarantees

| Backend guarantees | Caller expects |
|---|---|
| Each Route appears in exactly ONE tier (worst-tier wins) | No duplicate endpoints across tiers |
| `impact_depth` is the SHORTEST path length from any changed symbol | Depth can be used for prioritization |
| `confidence` is min edge weight along shortest path | Higher = more likely real impact |
| `affected_by` lists original changed symbols, not intermediate nodes (v1) | Can trace back which file changes caused this |
| `_meta.version` always `"1.0"` for this schema | Stable output shape |
| Git diff uses `--name-only` (file-level, not line-level) | Some false positives possible (unchanged code in changed files) |
| FETCHES path only from original `$changedIds` (not expanded set) | Consumer-impact list is conservative |
| Cross-repo results include `_repoId` per endpoint | Can group/attribute by service |
| Empty diff → empty result, NOT an error | Safe to call on clean working tree |
| `summary.changed_files` and `summary.impacted_endpoints` are always `Record<string, number>` keyed by repo name | Consistent shape whether called with `repo` or `repos` parameter |
| Iterative single-hop queries (not VAR_LENGTH) | Bounded performance, `max_expanded_nodes=10,000` safety valve |

## Alignment Checks

- [x] Input schema covers all detect_changes params plus new ones (max_depth, min_confidence)
- [x] Output `ImpactedEndpoint` contains all fields for test re-run (method+path), doc check (file_path), cross-service (_repoId)
- [x] Error codes cover all known failure modes from existing tools
- [x] Tier definitions (WILL_BREAK/LIKELY_AFFECTED/MAY_NEED_TESTING) have unambiguous numeric thresholds
- [x] No field name conflicts between this contract and existing `ImpactedSymbol`/`ChangedSymbol` types
