---
name: worktree-base-hazard
description: Agent isolation:"worktree" branches from default `main`, not the checked-out `main-afk` — pre-create worktrees explicitly for multi-lane work
metadata:
  type: feedback
---

When spawning parallel `Agent` lanes with `isolation: "worktree"` on this repo, the worktree is cut from the repository's **default branch (`main`)**, NOT the currently checked-out working branch. On GitNexus the working branch is `main-afk` and `main` is the stale public line (`f373a09`, v1.4.9/COBOL) that predates the entire #159 LSP stack — so the lanes silently built/tested against the wrong, older codebase (`call-processor.ts` diverged ~1361 lines; `LSP_RECALL_CONFIDENCE`/`TIER_CONFIDENCE` didn't even exist there).

**Why:** caught in the #159 recall/import-tier campaign — two backend-dev lanes ran a full pass (one ~80 min) producing code patches that didn't apply to `main-afk` and measurements against the wrong tree. Detected only by checking `git -C <worktree> log --oneline -1` (showed `f373a09`, an ancestor of `main-afk`). No `main-afk` corruption occurred because nothing was integrated before the check.

**How to apply:** for multi-lane parallel work, do NOT rely on the `isolation:"worktree"` flag. Pre-create worktrees yourself: `git worktree add -b <lane-branch> <path> main-afk`, then dispatch the agent pointing at that path (no isolation flag). Give every lane a **STEP 0 base-verification gate**: `git log --oneline -1` must show `06e7f56`/a main-afk descendant (never `f373a09`) AND a grep for a known-recent symbol (e.g. `LSP_RECALL_CONFIDENCE`) must be ≥1 — abort if either fails. Also forbid lanes from reading/writing the main checkout (`/Users/.../GitNexus`); a mis-based lane there also tends to leak scratch (e.g. `gitnexus/scratch/`, `probe-*.mts`) into the working tree. Relates to [[registry-test-isolation-hazard]]. See also the Branch Policy in CLAUDE.md ([[main-afk-is-working-branch]]).
