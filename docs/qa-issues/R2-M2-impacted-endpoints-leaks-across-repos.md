---
title: "`impacted_endpoints` leaks changes across repos when called on a single repo"
labels: [triage, medium]
---

## Steps to reproduce

1. Have multiple repos indexed (e.g., `sample-spring-minimal` and `tcbs-bond-trading`)
2. Call `impacted_endpoints` specifying a single repo:
   ```
   impacted_endpoints(repo="sample-spring-minimal")
   ```

## Actual behavior

The response includes changed files and impacted endpoints from ALL indexed repos, not just the specified one:

```json
{
  "summary": {
    "changed_files": {
      "sample-spring-minimal": 2,
      "tcbs-bond-trading": 8
    },
    "impacted_endpoints": {
      "sample-spring-minimal": 0,
      "tcbs-bond-trading": 5
    }
  }
}
```

Even though `repo="sample-spring-minimal"` was specified, the tool also analyzed `tcbs-bond-trading` and included its 5 impacted endpoints.

## Expected behavior

When `repo` is specified, `impacted_endpoints` should only analyze the git diff for that repo and only return impacted endpoints within that repo. Cross-repo analysis should require explicit `repos` parameter.

## User impact

**MEDIUM** -- Users working on a specific repo will see noise from unrelated repos. In a workspace with many indexed repos, this could produce confusing and misleading results. A user checking their repo's endpoint impact would see false positives from completely unrelated projects.