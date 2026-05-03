---
name: R8 QA Findings 2026-05
description: 3 new issues (0 HIGH, 2 MEDIUM, 1 LOW) from ingestion pipeline, cluster resources, config property, and class-level impact testing
type: project
---

# Round 8 QA Findings

Date: 2026-05-01
New issues: #73, #74, #75

## Issue #73 (MEDIUM): Cluster resource type:undefined — labels() returns empty for large communities

- `gitnexus://repo/{name}/cluster/{name}` shows `type: undefined` for ALL members
- Root cause: Cypher `labels()` function returns empty arrays for nodes in large communities (e.g., "Impl" with 2027 symbols)
- `labels()` works correctly for small communities (e.g., "Security" with 66 symbols)
- Code path: `local-backend.ts` line 3488 uses `labels(n)[0] AS type`; `resources.ts` line 395 serializes `member.type`
- Fix needs fallback when `labels()` returns empty

## Issue #74 (MEDIUM): Config Property content field includes entire remaining file content

- Property nodes from `application.properties` have `content` field containing multi-line content from subsequent properties
- Example: `spring.datasource.url` content shows 4-5 subsequent properties instead of just the JDBC URL
- `logging.file` content starts with comment lines `#===...` instead of `bond-trading`
- Code path: `config-indexer.ts` `propertyToGraphNode()` line 337 sets `content: prop.value`
- Root cause likely in `parsePropertiesFile()` multi-line continuation handling

## Issue #75 (LOW): impact maxDepth has no effect when target is a Class node

- Both `maxDepth=1` and `maxDepth=10` produce identical results for Class-level impact
- Only IMPORTS edges at depth=1 are traversed; no method-level CALLS or downstream deps
- Related to known "no class-level callers" issue but extends to downstream direction
- Class-level impact analysis is shallow and misleading

## Other observations (not new issues, already known):

- impact `file_path` parameter ignored for disambiguation (#47)
- Cypher `type()` function doesn't exist (#72)
- Cypher Route/Property individual property access returns empty (#72 variant)
- `query` tool `task_context`/`goal` params don't affect results (dead code, previously reported)
- `detect_changes` includes non-code files (previously reported)
- document-endpoint returns skeleton + error for unmatched paths (previously reported)

## What worked well:

- `context` tool with `file_path` disambiguation works correctly
- `context` with `include_content=true` returns full source code
- `endpoints` search returns comprehensive results
- `document-endpoint` correctly extracts @RequestParam and @PathVariable parameters
- Config property indexing creates Property nodes accessible via Cypher backtick syntax
- Process resources work correctly
- `detect_changes` identifies changed symbols and affected processes
- CLI `status`, `analyze --help`, `clean --help` all work
- MCP resource `gitnexus://repo/{name}/schema` works correctly