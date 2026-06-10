---
name: incremental-cycle-planning
description: For large multi-phase RFCs/initiatives, plan ONE slice per cycle (not the whole thing) — user validated this scope-decomposition approach
metadata:
  type: feedback
---

For a large multi-phase RFC or initiative, decompose into shippable slices and plan **one slice per cycle**, sequentially — do NOT plan all phases as a single bloated work item.

**Why:** On issue #159 (LSP-Augmented Resolution, a P0→P5 phased RFC) the user explicitly confirmed "you're right about planning it in multiple cycles, let's start planning from P0 + P1, then the next ones, one cycle by the other." Validated the SDD scope-decomposition gate over a mega-plan.

**How to apply:** When an input is itself structured as a phased roadmap (P0/P1/…, MVP→GA, ordered milestones), pick the first coherent + safe slice (prefer the read-only / zero-irreversible-commitment one), plan it fully, and make all later phases explicit Non-Goals for this cycle with a documented build order. Re-plan each subsequent slice in its own cycle. See [[issue-triage-batch-plan-2026-06-04]] for the same one-batch-per-session pattern.
