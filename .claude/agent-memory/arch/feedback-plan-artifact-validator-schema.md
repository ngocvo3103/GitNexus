---
name: plan-artifact-validator-schema
description: GitNexus has a deterministic PostToolUse hook that validates docs/plans/*.md against a strict schema — author plan docs to this shape first-try to avoid iteration churn
metadata:
  type: feedback
---

GitNexus runs a deterministic plan-artifact validator (PostToolUse hook) on every write/edit to `docs/plans/*.md`. The Stop hook BLOCKS on its ✗ errors. Author the plan doc to this exact schema the first time:

**Required top-level sections (`##`):** `## Blast Radius`, `## Specs`, `## Test Strategy`, `## WI Dependency Map`, plus `## Acceptance Criteria` / `## Verification` / `## Work Items`.

**Each work item is a `#### WI-N — title` heading** (four hashes, not three) with these `**bold:**` fields:
- `**Status:**` (e.g. planned)
- `**What:**`
- `**Behavior:**` (concrete I/O)
- `**Depends on:**` (WI ids, or `—`)
- `**Files:**`, `**Reuse:**`, `**Spec:**` (Spec is advisory/⚠ only)
- `**Tests:**` block containing the labeled fields `Level:`, `Technique:`, `Cases:`, `File:`, `Verify-by:` (the colon matters)

**Mandatory Verification WI:** id `WI-V` (or under a `### Layer: Verification` heading). It must list **all prior WIs** in its `**Depends on:**`.

**Dependency map must be a ```mermaid graph** (TD), and the map edges and the WIs' `**Depends on:**` must be **bidirectionally consistent**: every map edge `WI-X --> WI-Y` must appear in WI-Y's `Depends on`, AND every `Depends on` entry must have a backing map edge. So if WI-V depends on WI-1..WI-5, the map needs `WI-1 --> WI-V` … `WI-5 --> WI-V` explicitly.

**Why:** This schema cost multiple fix-iterations in the #159 P0/P1 and P2 planning cycles (the errors only surface after writing). Knowing it up front turns a 4-round fix loop into a clean first write.

**How to apply:** When `/wf-planning` reaches Stage 5 (authoring `docs/plans/{name}.md`), template the WIs with all fields above and make the mermaid map a superset that exactly backs every `Depends on`. See [[incremental-cycle-planning]] for the per-slice cadence these plans follow. Note: design docs (`docs/designs/*.md`) are NOT validated by this hook — only `docs/plans/*.md`.
