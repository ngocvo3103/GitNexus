# impacted_endpoints — Test Strategy

**Date:** 2026-04-29
**Feature:** `impacted_endpoints` MCP tool

## Feature-Level Test Strategy

### Pipeline Under Test

```
base_ref → execGitDiff() → [changed files]
  → map files → graph symbols
  → BFS upstream (CALLS/IMPORTS/EXTENDS/IMPLEMENTS/HAS_METHOD, d=3)
  → 3 parallel Cypher queries → Route nodes
  → group into WILL_BREAK / LIKELY_AFFECTED / MAY_NEED_TESTING
```

### Risk Calibration

| Area | Risk | Rationale |
|------|------|-----------|
| Git diff execution | HIGH | Runs shell command in repo dir; must handle non-git, bad ref, empty diff |
| File-to-symbol mapping | MEDIUM | Uses `CONTAINS` on path (fuzzy); false positives possible |
| BFS traversal scale | HIGH | Can hit 500+ nodes; needs chunking/MAX_CHUNKS like `_impactImpl` |
| 3 parallel Cypher queries | MEDIUM | Schema-sensitive; if a query fails silently, whole tier is empty |
| Tier classification | HIGH | Business-critical output; wrong tier = wrong action |
| Multi-repo dispatch | MEDIUM | Must share `execGitDiff` result across repos; aggregation complexity |

### Coverage Map: Test Level Ownership

| Concern | Level | Technique |
|---------|-------|-----------|
| `execGitDiff` logic | **Unit** | EP, Decision Table |
| File-to-symbol mapping query | **Unit** | EP, BVA |
| BFS traversal (depth, batching, capping) | **Unit** | BVA, State Transition |
| Route discovery queries (3 Cyphers) | **Integration** | Decision Table |
| Tier classification logic | **Unit** | Decision Table, EP |
| Tool registration in tools.ts | **Unit** | EP |
| callTool dispatch routing | **Unit** | Decision Table |
| Multi-repo dispatch | **Unit** | Decision Table |
| Full E2E flow (git diff → seed → result) | **E2E** | Flow-Based |
| Schema compatibility (Route node shape) | **Integration** | Error Guessing |
| Error handling (bad ref, no diff, no graph hit) | **E2E** | Error Guessing, EP |

### Anti-Redundancy Rules

1. **E2E does NOT retest BFS batching/chunking** — unit covers that
2. **Integration does NOT retest tier classification** — unit covers that
3. **Unit does NOT test Cypher syntax correctness** — integration/E2E covers that
4. **One valid + one invalid** at API level for params — EP/BVA details at unit

### Anti-Patterns to Avoid

1. Do NOT mock `LocalBackend` as a whole — mock only the DB adapter layer
2. Do NOT seed 100+ nodes for unit tests — unit tests mock DB
3. Do NOT test `_impactImpl` BFS internals again — reuse pattern, don't duplicate
4. Do NOT hardcode repository paths — use temp directories
5. Do NOT skip the multi-repo path — dispatch pattern must be verified
6. Do NOT mock `execFileSync` at module level globally — `vi.mock` inside describe block

---

## Per-WI Test Assignments

### WI-1: Extract `execGitDiff` Helper (pure refactor)

**Level:** Unit | **Technique:** EP, Decision Table, Error Guessing | **File:** `test/unit/exec-git-diff.test.ts` (new)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Unstaged diff default | `{ scope: 'unstaged' }` | `['diff', '--name-only']` |
| 2 | Staged diff | `{ scope: 'staged' }` | `['diff', '--staged', '--name-only']` |
| 3 | Compare with base_ref | `{ scope: 'compare', base_ref: 'main' }` | `['diff', 'main', '--name-only']` |
| 4 | All changes | `{ scope: 'all' }` | `['diff', 'HEAD', '--name-only']` |
| 5 | Missing base_ref in compare | `{ scope: 'compare' }` (no base_ref) | error object |
| 6 | Git command fails | `execFileSync` throws | error with message |
| 7 | Git returns empty | stdout is `''` | `[]` |
| 8 | Git returns 3 files | stdout has 3 lines | array of 3 paths |
| 9 | File paths with backslashes | Windows paths | normalized to `/` |
| 10 | base_ref with special chars | `base_ref: 'feature/foo-bar'` | works (passed as arg, not shell) |

---

### WI-2: `_impactedEndpointsImpl` — Core Traversal Engine

**Level:** Unit + Integration | **Technique:** Decision Table, State Transition, BVA, EP

**Unit tests** (mock lbug-adapter) — **File:** `test/unit/impacted-endpoints-impl.test.ts` (new)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Happy path: 2 changed files, 5 impacted, 2 routes found | full pipeline output |
| 2 | Empty changed files list | early return with empty result |
| 3 | Changed file maps to 0 symbols | error: "no indexed symbols match changed files" |
| 4 | BFS traversal produces >100 nodes | chunks of 100 per parameterized call |
| 5 | MAX_CHUNKS exhausted | `partial: true` flag in result |
| 6 | Traversal query fails at depth 2 | returns d=1 results, `traversalComplete: false` |
| 7 | Route discovery query #1 fails (CALLS) | other 2 queries still run |
| 8 | Route discovery query #2 fails (transitive) | other 2 queries still run |
| 9 | Route discovery query #3 fails (HAS_METHOD) | other 2 queries still run |
| 10 | Direct CALLS → Route | WILL_BREAK tier |
| 11 | d=2 CALLS → Route | LIKELY_AFFECTED tier |
| 12 | HAS_METHOD → controller → Route | MAY_NEED_TESTING tier |
| 13 | Same Route hit via multiple paths | appears once in highest-priority tier only |
| 14 | Symbol in test dir | excluded if includeTests=false |

**Integration tests** (real LadybugDB + seed) — **File:** `test/integration/impacted-endpoints-e2e.test.ts` (new)

| # | Scenario | Expected |
|---|----------|----------|
| 15 | Seed: changed utility → service → controller → Route | Route in LIKELY_AFFECTED |
| 16 | Seed: changed controller directly | Route in WILL_BREAK |
| 17 | Seed: changed file with no Route upstream | 0 endpoints returned |

---

### WI-3: MCP Tool Registration in tools.ts

**Level:** Unit | **Technique:** EP | **File:** `test/unit/tools.test.ts` (extend existing)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Tool exists in GITNEXUS_TOOLS | `name === 'impacted_endpoints'` |
| 2 | Has valid inputSchema | `type: 'object'`, properties defined |
| 3 | `base_ref` is defined | in properties |
| 4 | `repo` is optional | `properties.repo.type === 'string'`, not in required |
| 5 | Description is non-empty | string with content |
| 6 | No `repos` parameter (v1) | `properties.repos` is undefined or optional |

---

### WI-4: callTool Dispatch Case

**Level:** Unit | **Technique:** Decision Table | **File:** `test/unit/calltool-dispatch.test.ts` (extend)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `callTool('impacted_endpoints', { base_ref: 'main' })` | calls `this.impactedEndpoints(repo, params)` |
| 2 | `callTool('impacted_endpoints', { base_ref: 'main', repo: 'test' })` | resolves specific repo |
| 3 | `callTool('impacted_endpoints', {})` (missing base_ref) | returns error |
| 4 | Unknown repo specified | throws "not found" |
| 5 | Multiple repos, no `repo` param | throws "Multiple repositories indexed" |
| 6 | No repos indexed | throws "No indexed repositories" |

---

### WI-5: Multi-Repo Dispatch in callToolMultiRepo

**Level:** Unit | **Technique:** Decision Table | **File:** `test/unit/calltool-dispatch.test.ts` (extend)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `callTool('impacted_endpoints', { base_ref: 'main', repos: ['r1','r2'] })` | routes to multi-repo handler |
| 2 | Two repos both return endpoints | merged with `_repoId` attribution |
| 3 | Same endpoint in both repos | both appear (not deduped, different repos) |
| 4 | One repo fails, one succeeds | partial result with errors array |
| 5 | Aggregate risk calculation | worst risk across repos wins |
| 6 | `repos: []` (empty array) | falls back to single-repo path |

---

## Seed Fixture Design

**File:** `test/fixtures/impacted-endpoints-seed.ts` (new)

### Entities

| Type | Count | Details |
|------|-------|---------|
| Route nodes | 5 | GET/POST /api/users, GET/DELETE /api/orders/{id}, GET /api/health |
| Method nodes | 8 | Handlers + service + utility methods |
| Class nodes | 7 | Controllers (UserController, OrderController, HealthController, BaseController), Services (UserService, OrderService), Utility (FormatUtil) |
| File nodes | 7 | 1 per class |
| DEFINES edges | 5 | File → Route (Spring controllers) |
| HAS_METHOD edges | 8 | Class → Method |
| CALLS edges (handler) | 5 | Route → Method (Spring mapping) |
| CALLS edges (service) | 1 | UserController.getUsers → UserService.getUsers |
| CALLS edges (utility) | 1 | UserService.getUsers → FormatUtil.formatUser |
| EXTENDS edge | 1 | HealthController → BaseController |
| IMPORTS edges | 2 | File → Class imports |

### Transitive Chain (LIKELY_AFFECTED tier)

```
[changed: formatUser (FormatUtil)]
  → d=1: UserService.getUsers (CALLS formatUser)
  → d=2: UserController.getUsers (CALLS UserService.getUsers)
  → d=3: Route GET /api/users (via class HAS_METHOD chain)
Result: GET /api/users → LIKELY_AFFECTED tier
```

### Direct Chain (WILL_BREAK tier)

```
[changed: UserController.java]
  → DEFINES → Route:POST:/api/users
Result: POST /api/users → WILL_BREAK tier (d=1, confidence=1.0)
```

---

## Coverage Summary

| Level | WI-1 | WI-2 | WI-3 | WI-4 | WI-5 | Total |
|-------|------|------|------|------|------|-------|
| Unit | 10 | 14 | 6 | 6 | 6 | **42** |
| Integration | 0 | 3 | 0 | 0 | 0 | **3** |
| E2E | 0 | 3 | 0 | 0 | 0 | **3** |
| **Total** | **10** | **20** | **6** | **6** | **6** | **48** |

### Techniques Applied

| Technique | Where |
|-----------|-------|
| Equivalence Partitioning | base_ref input, scope, diff output |
| Boundary Value Analysis | BFS depth limits, chunk size boundaries, 0/empty edge cases |
| Decision Table | Tier classification (6 rules), callTool dispatch (4 rules), git diff scope (4 rules) |
| State Transition | BFS traversal pipeline (5 states, 3 invalid transitions) |
| Error Guessing | Git failures, query failures, empty results, bad refs |
| Flow-Based | Full E2E journey (diff → symbols → BFS → routes → tiers) |
