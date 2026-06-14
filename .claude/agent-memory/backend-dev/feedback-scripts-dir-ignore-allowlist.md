---
name: scripts-dir-ignore-allowlist
description: When `gitnexus/scripts/` is in .gitignore but a slice commits new TS scripts to that dir, narrow the ignore to file patterns + add explicit `!gitnexus/scripts/<file>.ts` re-include lines (do NOT delete the rule outright).
metadata:
  type: feedback
---

On 2026-06-12, the Mode C campaign slice (`gitnexus/scripts/measure-mode-c.ts` + `gitnexus/scripts/flow-fate.ts`) was globally ignored by `.gitignore` line `gitnexus/scripts/`. A `git check-ignore` confirmed both files matched the rule; `git add -n` failed silently. The naive fix (delete the line entirely) is wrong because `check-scope-guard.sh` and other locally-generated `*.sh` / `*.mjs` / `*.js` artifacts in `gitnexus/scripts/` are deliberately untracked.

**Why:** The rule pre-dates the Mode C slice and was intended for "local dev scripts" (e.g. `check-scope-guard.sh`, `inspect_for_calls.mjs`). The campaign slice is the first time committed TS source has landed under `gitnexus/scripts/`. Removing the rule wholesale would silently un-ignore ad-hoc `*.mjs` and `*.sh` files; narrowing it via explicit `!` re-include lines keeps the local-only semantics while allowing the committed harness.

**How to apply:** For any future slice that adds a committed file under a `*.gitignore`d directory:
1. Confirm via `git check-ignore -v <path>` that the new file is ignored.
2. Replace the directory-level rule with file-pattern ignores (`*.mjs`, `*.sh`, `*.js`) + add explicit `!gitnexus/scripts/<file>.ts` re-include lines for each new committed file.
3. Declare the `.gitignore` change in the plan's d1 list (the rule change is part of the slice's scope, not pre-existing scope).
4. Re-run `git check-ignore -v <path>` to confirm the new file is now allowlisted; `git add -n <path>` should report the file.

The `tsconfig.scripts.json` at the `gitnexus/` top level is not under `gitnexus/scripts/`, so it was never affected by this rule — only the new TS files inside `gitnexus/scripts/` needed the re-include.
