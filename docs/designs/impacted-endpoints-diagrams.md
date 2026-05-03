# Impacted Endpoints — Solution Design Diagrams

**Date:** 2026-04-29
**Feature:** `impacted_endpoints` MCP tool

---

## Data/Control Flow: As-Is (current detect_changes)

```mermaid
sequenceDiagram
    participant MCP Client
    participant LocalBackend
    participant Git
    participant LadybugDB

    MCP Client->>LocalBackend: detect_changes(scope, base_ref)
    LocalBackend->>Git: git diff --name-only [base_ref]
    Git-->>LocalBackend: changed file paths
    loop For each changed file
        LocalBackend->>LadybugDB: MATCH (n) WHERE n.filePath CONTAINS $path
        LadybugDB-->>LocalBackend: symbols in file
        LocalBackend->>LadybugDB: MATCH (n)-[:STEP_IN_PROCESS]->(p:Process)
        LadybugDB-->>LocalBackend: affected processes
    end
    LocalBackend-->>MCP Client: { changed_symbols, affected_processes, risk_level }

    Note over MCP Client,LadybugDB: NO endpoint (Route node) discovery
```

---

## Data/Control Flow: To-Be (new impacted_endpoints)

```mermaid
sequenceDiagram
    participant MCP Client
    participant LocalBackend
    participant Git
    participant LadybugDB

    MCP Client->>LocalBackend: impacted_endpoints(base_ref, max_depth)
    LocalBackend->>Git: git diff --name-only [base_ref]
    Git-->>LocalBackend: changed file paths

    loop For each changed file
        LocalBackend->>LadybugDB: MATCH (n) WHERE n.filePath CONTAINS $path
        LadybugDB-->>LocalBackend: changed symbols
    end

    rect rgb(46, 125, 50, 0.15)
        Note over LocalBackend,LadybugDB: Phase 1: Upstream BFS (NEW)
        loop depth=1..max_depth
            LocalBackend->>LadybugDB: MATCH (caller)-[r:CodeRelation]->(n)<br/>WHERE n.id IN $frontier<br/>AND r.type IN [CALLS,IMPORTS,EXTENDS,IMPLEMENTS,HAS_METHOD]
            LadybugDB-->>LocalBackend: expanded symbols at depth N
        end
    end

    rect rgb(46, 125, 50, 0.15)
        Note over LocalBackend,LadybugDB: Phase 2: Route Discovery (NEW)
        par Path A: Handler Routes
            LocalBackend->>LadybugDB: MATCH (r:Route)-[CALLS]->(m)<br/>WHERE m.id IN $expandedIds
        and Path B: File Routes
            LocalBackend->>LadybugDB: MATCH (f:File)-[DEFINES|HANDLES_ROUTE]->(r:Route)<br/>WHERE f.id IN $expandedIds
        and Path C: Consumer Routes
            LocalBackend->>LadybugDB: MATCH (n)-[FETCHES]->(r:Route)<br/>WHERE n.id IN $changedIds
        end
        LadybugDB-->>LocalBackend: Route nodes (deduplicated)
    end

    rect rgb(245, 197, 24, 0.15)
        Note over LocalBackend: Tier Classification (MODIFIED from impact tiers)
        LocalBackend->>LocalBackend: Group by depth/confidence<br/>WILL_BREAK | LIKELY_AFFECTED | MAY_NEED_TESTING
    end

    LocalBackend-->>MCP Client: { impacted_endpoints, changed_symbols, summary }
```

**Color key:** Green = new, Yellow = modified/reused from existing, No color = unchanged

---

## Component/Service Structure: As-Is

```mermaid
graph TD
    subgraph "MCP Tools (tools.ts)"
        DETECT[detect_changes]
        IMPACT[impact]
        API[api_impact]
        ROUTEMAP[route_map]
        SHAPE[shape_check]
        ENDPOINTS[endpoints]
        DOC[document-endpoint]
    end

    subgraph "LocalBackend (local-backend.ts)"
        DC[detectChanges method]
        II[_impactImpl method]
        AI[apiImpact method]
        RM[routeMap method]
        SC[shapeCheck method]
        EQ[queryEndpoints]
        DE[documentEndpoint]
    end

    DETECT --> DC
    IMPACT --> II
    API --> AI
    ROUTEMAP --> RM
    SHAPE --> SC
    ENDPOINTS --> EQ
    DOC --> DE

    DC -->|git diff| GIT[(Git)]
    II -->|Cypher BFS| LDB[(LadybugDB)]
    AI -->|Route queries| LDB
    EQ -->|Route queries| LDB
```

**Note:** No connection from `detect_changes` to Route/endpoint discovery.

---

## Component/Service Structure: To-Be

```mermaid
graph TD
    subgraph "MCP Tools (tools.ts)"
        DETECT[detect_changes]
        IMPACT[impact]
        IE[impacted_endpoints]
        API[api_impact]
        ROUTEMAP[route_map]
        SHAPE[shape_check]
        ENDPOINTS[endpoints]
        DOC[document-endpoint]
    end

    subgraph "LocalBackend (local-backend.ts)"
        DC[detectChanges method]
        II[_impactImpl method]
        IEM[_impactedEndpointsImpl]
        EGD[execGitDiff helper]
        AI[apiImpact method]
        RM[routeMap method]
        SC[shapeCheck method]
        EQ[queryEndpoints]
        DE[documentEndpoint]
    end

    DETECT --> DC
    IMPACT --> II
    IE --> IEM
    API --> AI
    ROUTEMAP --> RM
    SHAPE --> SC
    ENDPOINTS --> EQ
    DOC --> DE

    DC --> EGD
    IEM --> EGD
    IEM -->|Phase 1 BFS| LDB[(LadybugDB)]
    IEM -->|Phase 2 Route queries| LDB
    EGD -->|git diff| GIT[(Git)]

    style IE fill:#2e7d32,color:#fff
    style IEM fill:#2e7d32,color:#fff
    style EGD fill:#f5c518
```

**Color key:** Green = new, Yellow = extracted from existing, No color = unchanged

---

## Traversal State Machine: To-Be

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> DIFF_DONE: execGitDiff()
    DIFF_DONE --> SYMBOLS_MAPPED: file→symbol Cypher
    DIFF_DONE --> EMPTY_RESULT: 0 changed files
    SYMBOLS_MAPPED --> NO_MATCH: 0 symbols found
    SYMBOLS_MAPPED --> TRAVERSING: BFS depth=1
    TRAVERSING --> TRAVERSING: depth++ (until max_depth)
    TRAVERSING --> OVERFLOW: >10k expanded nodes
    TRAVERSING --> ROUTES_DISCOVERED: Phase 2 queries
    ROUTES_DISCOVERED --> TIERS_GROUPED: classify by depth/confidence
    OVERFLOW --> TIERS_GROUPED: return partial
    EMPTY_RESULT --> [*]
    NO_MATCH --> [*]
    TIERS_GROUPED --> [*]

    note right of OVERFLOW: partial=true flag set
    note right of EMPTY_RESULT: risk_level=none
```

---

## Graph Traversal Paths: To-Be

```mermaid
graph LR
    subgraph "Changed Code"
        CF[changed File]
        CM[changed Method]
        CC[changed Class]
    end

    subgraph "Phase 1: Upstream BFS"
        CALLER1[caller d=1]
        CALLER2[caller d=2]
        CALLER3[caller d=3]
    end

    subgraph "Phase 2: Route Discovery"
        R1[Route: GET /api/users]
        R2[Route: POST /api/orders]
    end

    CM -->|CALLS| CALLER1
    CALLER1 -->|CALLS| CALLER2
    CALLER2 -->|CALLS| CALLER3

    R1 -.->|reverse CALLS| CALLER2
    R2 -.->|reverse CALLS| CALLER1
    CF -->|DEFINES| R1

    style R1 fill:#2e7d32,color:#fff
    style R2 fill:#2e7d32,color:#fff
    style CM fill:#f5c518
    style CC fill:#f5c518
    style CF fill:#f5c518
```

**Color key:** Green = Route nodes (target output), Yellow = changed code (input), Dashed edges = reverse traversal

---

## Use Case Flows

### Use Case 1: Integration Test Re-Run

```mermaid
sequenceDiagram
    participant CI as CI/CD Pipeline
    participant GN as GitNexus MCP
    participant Test as Test Runner

    CI->>GN: impacted_endpoints(base_ref='main')
    GN-->>CI: { WILL_BREAK: [GET /api/users, POST /api/orders], LIKELY_AFFECTED: [...], MAY_NEED_TESTING: [...] }
    CI->>Test: Run integration tests for WILL_BREAK + LIKELY_AFFECTED endpoints
    Test-->>CI: 15/15 passed (targeted, 2 min)
    CI->>CI: (Optional) Full suite later in SDLC
    Note over CI,Test: Saved ~10 min vs full 150-endpoint suite
```

### Use Case 2: Documentation Enforcement

```mermaid
sequenceDiagram
    participant PR as PR Reviewer (Bot)
    participant GN as GitNexus MCP
    participant PRFiles as PR Changed Files

    PR->>GN: impacted_endpoints(base_ref='main')
    GN-->>PR: impacted_endpoints[]
    PR->>GN: Check which impacted endpoints have docs (document-endpoint exists?)
    PR->>PRFiles: Cross-reference: are doc files in PR?
    PR-->>PR: Flag: "3 impacted endpoints missing doc updates"
```

### Use Case 3: Cross-Service Impact

```mermaid
sequenceDiagram
    participant PR as PR Reviewer
    participant GN as GitNexus MCP

    PR->>GN: impacted_endpoints(base_ref='main', repos=['svc-a', 'svc-b', 'svc-c'])
    GN-->>PR: { endpoints: [{ _repoId: 'svc-a', ... }, { _repoId: 'svc-b', ... }] }
    PR->>PR: Group by _repoId → alert downstream service owners
```
