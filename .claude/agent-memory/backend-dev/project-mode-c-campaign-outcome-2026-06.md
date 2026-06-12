---
name: project-mode-c-campaign-outcome-2026-06
description: WI-3/4/5 outcomes for #159 Mode C campaign (2026-06-11) — all 6 legs excluded by env-level LSP unavailability, #170 flow delta is +1 not "266→167", memory snapshot was stale
metadata:
  type: project
---

WI-3/WI-4/WI-5 outcomes for the #159 Mode C measurement campaign (executed 2026-06-11):

- All 6 campaign legs (3 repos × 2 legs) are `underSampled:true` due to **environment-level LSP unavailability** — `typescript-language-server` v5.1.3 returns `[]` for the canary `package.json` (JSON file), and the verifier treats `[]` as a refusal. Probe returns 0/1 samples in every cwd. Not a harness bug; env-bound.
- Promotion recommendation: **NO at this data quality**, conditional path is "re-run in workspace-ready env (Node 22 LTS or non-sandbox)".
- #170 index-shape delta re-derived at 438600e (per I-7):
  - edges 22,103 → 22,563 (**+2.1%**, not "+90%")
  - flows 166 → 167 (**+1**, not "266→167")
  - Function nodes 2,054 → 2,083 (**+29 candidates**, 28 absorbed by `maxProcesses*2` trace cap)
  - The design doc / issue comments memory values "edges 11,709→22,269 +90%; flows 266→167" are **stale** (different vantage — likely pre-#168 / pre-#170 P2+P3 stack).
- WI-4 missing flow-fate JSON was found missing on resumption; fixed by writing a one-off driver at `gitnexus/scratch/wi4-driver.ts` (gitignored; bypasses flow-fate's defaultRunCypher by calling `initLbug`+`executeParameterized` directly). Pure `classifyFlowFates` is byte-identical across re-runs (sha256 `cf336171…332c60`).
- Halt contract honored: no zeros published as headline (KD-5 + I-5).
- Substitution log (per KD-2): zod install uses pnpm not npm (EUNSUPPORTEDPROTOCOL on `workspace:*`); fastify/excalidraw NOT cloned because analyze succeeded for both hono and zod.
- `isEntryPointCandidate` is computed, not stored on `Process` rows → use Function node count as the entry-point-shift signal instead.

**Why:** the data-quality gap (env-bound probe failure) and the memory-stale finding both block the 0.70→0.90 promotion. Future re-runs of this campaign need (a) workspace-ready env, (b) corrected memory values.
**How to apply:** when synthesizing a measurement comment, always re-derive from the artifacts (I-7), not from memory. If all legs are excluded, the promotion verdict is "NO at this data quality" — never publish zeros as headline.

Related: [[feedback-scripts-harness-no-write-pattern]]
