---
name: impacted-endpoints-reverse-calls-broaden
description: impacted_endpoints reverse-CALLS discovery Query 1 must match both Method AND Function labels; top-level TS functions are labeled `Function`, not `Method`
metadata:
  type: feedback
---

`local-backend.ts:2559` Query 1 (`reverse-CALLS` route discovery) was hard-coded to `MATCH (m:Method)`. Top-level `export function` in TS gets the `Function` label, not `Method` (only class methods get `Method` — see [[parse-worker-getlabel-captures]]). A fixture that uses top-level functions (e.g. AC-7's `ac7Handler` in `ac7-controller.ts`) creates `Function` nodes that the BFS adds to `expandedMeta`, but the route-handler edge was seeded with `m:Function` — so the discovery query never matched, and `GET /ac7-route` never surfaced in `LIKELY_AFFECTED`.

**Why:** Real-world TS controllers can be either class-based (Method) OR top-level function (Function) — the graph must support both. The unit test in `impacted-endpoints-impl.test.ts` only exercised the Method path because its fixture seeded Method nodes directly via Cypher.

**How to apply:** When adding a BFS / route discovery / annotation query, do NOT assume `Method` is the only callable label — use `(m:Method OR m:Function)` or the equivalent parameterized disjunction. The fix at `local-backend.ts:2559` broadened to `(m:Method OR m:Function)` and all 98 unit tests in `impacted-endpoints-impl.test.ts` still pass (the (j) test seeds Method nodes which still match). The AC-7 test in `mode-a-golden.test.ts` now passes because the route-handler edge to a `Function` node is discoverable.
