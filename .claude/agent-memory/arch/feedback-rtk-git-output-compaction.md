---
name: rtk-git-output-compaction
description: rtk wrapper compacts/reformats git output in this environment — never trust piped counts (wc/grep -c) on git diff/status; verify with direct flags or file-level greps
metadata:
  type: feedback
---

The user's shell environment routes `git` output through an **rtk** compaction wrapper. Piping wrapped output into `grep -c` / `wc -l` produces wrong numbers, and `git diff` hunks are reformatted (no `+`/`-` prefixes), so prefix-pattern greps silently return empty.

**Why:** during the PR #170 review this produced two near-false findings — "1 forbidden test file differs" (the 1 was an rtk noise line, re-run returned empty) and "0 matches for 'heritage'" against a suite log that turned out to be tail-only. Real hunks needed `rtk git diff --no-compact -- <path>`.

**How to apply:** for any count- or hunk-level git verification: (1) use `rtk git diff --no-compact`, or (2) grep the checked-out files directly instead of the diff, or (3) re-run the exact git command without pipes and read the literal output. Also: when capturing long-running command output to a file for later grep, never pipe through `tail` at capture time — grep the full log.
