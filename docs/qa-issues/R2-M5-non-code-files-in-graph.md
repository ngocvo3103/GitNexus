---
title: "Non-code files (CLAUDE.md, AGENTS.md, README.md, pom.xml) indexed as graph nodes, pollute query results"
labels: [triage, medium]
---

## Steps to reproduce

1. Index `sample-spring-minimal` or `sample-fastapi`
2. Run a `query` search:
   ```
   query(query="dependency injection", repo="sample-spring-minimal")
   ```
3. Run a Cypher query to find non-code nodes:
   ```
   MATCH (n) WHERE n.filePath CONTAINS 'CLAUDE.md' OR n.filePath CONTAINS 'AGENTS.md' RETURN n.name, n.filePath
   ```
4. Run `detect_changes`:
   ```
   detect_changes(repo="sample-spring-minimal")
   ```

## Actual behavior

Non-code files appear as graph nodes and pollute results:

**query "dependency injection"** returns only:
```
- File:pom.xml
- File:CLAUDE.md
- File:AGENTS.md
```

**Cypher** confirms these files exist as graph nodes:
```
| CLAUDE.md | CLAUDE.md |
| AGENTS.md | AGENTS.md |
```

**detect_changes** reports these as changed code symbols:
```json
{
  "id": "File:AGENTS.md",
  "name": "AGENTS.md",
  "change_type": "Modified"
},
{
  "id": "File:CLAUDE.md",
  "name": "CLAUDE.md",
  "change_type": "Modified"
}
```

**query "FastAPI route handler"** returns:
```
- File:CLAUDE.md
- File:AGENTS.md
- File:pyproject.toml
- File:README.md
```

## Expected behavior

Non-code files (Markdown, XML, TOML, YAML, etc.) should NOT be indexed as graph nodes. They should be excluded from:
- The knowledge graph
- `query` search results
- `detect_changes` changed symbols
- `impacted_endpoints` changed symbols

## User impact

**MEDIUM** -- Non-code files create noise in all graph-based operations. When searching for code, users get irrelevant markdown/config results. When analyzing git changes, they see documentation file changes treated as code changes. This degrades the signal-to-noise ratio across all tools and makes the knowledge graph less trustworthy.