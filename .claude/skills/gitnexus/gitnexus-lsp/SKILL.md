---
name: gitnexus-lsp
description: "Use when the user wants higher-accuracy call resolution, asks about LSP support, or is doing high-stakes impact/rename/refactor work where a wrong or missing CALLS edge would be costly. Examples: \"Enable LSP\", \"How accurate is the call graph?\", \"Make impact analysis more precise\", \"Why is this caller missing?\""
---

# LSP-Augmented Resolution with GitNexus

GitNexus resolves CALLS edges with a fast tree-sitter **heuristic** by default. The
optional **LSP layer** re-checks that heuristic call graph against a real language
server (go-to-definition / references), so edges become **confirmed**, **corrected**,
or **recalled**. It is **opt-in and OFF by default** — nothing below runs unless you
pass `--lsp`.

## When to turn it ON

- High-stakes change where a wrong/missing caller is expensive (auth, payments, public API).
- Cross-file / cross-module / overloaded calls the heuristic resolves to `global` (0.50) confidence.
- Impact analysis where you need the d=1 "WILL BREAK" set to be trustworthy, not approximate.
- You suspect missing callers (`gitnexus_context` shows fewer incoming calls than reality).

## When it is NOT worth it

- Small single-file or single-module repos — the heuristic already resolves these at 0.95.
- No language server installed for the repo's language (see table) — LSP silently no-ops.
- You only need approximate navigation — same-file (0.95) and imported (0.90) calls are already high-confidence; LSP mainly helps the ambiguous `global` (0.50) tier.

## Enable it

```bash
npx gitnexus analyze --lsp
```

Requires the language server on `PATH`. One server per language:

| Language   | Server binary                | LSP-recall confidence* |
| ---------- | ---------------------------- | ---------------------- |
| Java       | `jdtls`                      | 0.90                   |
| Go         | `gopls`                      | 0.90                   |
| Rust       | `rust-analyzer`              | 0.90                   |
| Python     | `pylsp`                      | 0.60                   |
| TypeScript | `typescript-language-server` | 0.75                   |

\*Confidence GitNexus assigns to edges the server **recalls** (calls the heuristic missed).
Java/Go/Rust use the 0.90 default; TS (0.75) and Python (0.60) are lowered because their
servers' recall is less reliable (`language-adapter.ts` `recallConfidence`). `lsp-confirmed` /
`lsp-corrected` edges are 0.90 for every language. If the server is missing, `analyze --lsp`
runs the heuristic and skips augmentation (no error).

## Provenance — how to read the result

Every CALLS edge carries a `source` column (queryable, see below). The four values:

| `source`        | Meaning                                                       | Confidence |
| --------------- | ------------------------------------------------------------ | ---------- |
| `heuristic`     | tree-sitter only (default). Tiered: same-file 0.95 → import 0.90 → global 0.50 → external 0.35 | varies |
| `lsp-confirmed` | LSP agreed with the heuristic edge — trust ↑                 | 0.90       |
| `lsp-corrected` | LSP disagreed; edge re-pointed to the **correct** target (heuristic was wrong) | 0.90 |
| `lsp-recall`    | LSP found a real CALLS edge the heuristic **missed entirely** | 0.90 (TS 0.75, Py 0.60) |

So an `--lsp` index promotes ambiguous `global` (0.50) edges to verified 0.90, fixes wrong
targets, and adds missed callers — which is what makes impact/rename trustworthy.
`gitnexus_impact` returns callers regardless of confidence by default (`minConfidence`
defaults to 0), so a 0.50 heuristic edge is *shown but unproven*; the value of LSP is that a
0.90 edge is one you can trust is real rather than a heuristic guess. Pass `minConfidence`
(e.g. 0.85) to exclude the low-confidence guesses. (`d=1/2/3` is call *depth*, a separate
axis from confidence.)

**Query provenance via Cypher** (`gitnexus_cypher`):

```cypher
// All LSP-verified or LSP-recovered CALLS edges into a symbol
MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(f {name: "validateUser"})
WHERE r.source <> 'heuristic'
RETURN caller.name, caller.filePath, r.source, r.confidence
```

**Query-time LSP** (no `--lsp` reindex needed; needs a live server, silently falls back to heuristic if absent):

- `gitnexus_impact({target: "X", direction: "upstream", precision: "lsp"})` — augments the d=1 caller set via `textDocument/references`; tags each entry `source: lsp | heuristic | both`.
- `gitnexus_rename({symbol_name: "old", new_name: "new", precision: "lsp", dry_run: true})` — uses `textDocument/rename`; on any refusal the `changes[]` are byte-identical to the heuristic path plus an `lsp_status` notice.

## Measure & calibrate

```bash
npx gitnexus verify --lsp                    # Mode C: heuristic vs LSP — prints precision + false-confident rate
npx gitnexus verify --lsp --max-fc-rate 0.05 # CI gate: exit non-zero if false-confident rate > 5%
npx gitnexus verify --lsp --strict           # exit non-zero if the LSP server is unavailable (presence gate)
npx gitnexus verify --lsp --calibrate        # recommend an --lsp-high-tier-sample rate for the next analyze
```

- **precision** — % of confident heuristic CALLS edges that match LSP go-to-definition.
- **false-confident rate** — % that are confidently **wrong** (the number that matters for trust); `--max-fc-rate <r>` fails CI above `r`.
- `--strict` is a boolean (no value) — it only gates on the *server being available*, not on accuracy.
- `verify` without `--lsp` does nothing; if the server is absent it reports `LSP unavailable: <binary> not found`.

## Tuning levers (all require `--lsp`, all default OFF/serial)

| Flag                          | Use                                                                 |
| ----------------------------- | ------------------------------------------------------------------- |
| `--lsp-budget <n>`            | Cap LSP candidates (default 2000). Lower on huge repos to bound time. |
| `--lsp-high-tier-sample <r>`  | Spot-check fraction `[0,1]` of import-scoped (0.90) edges to catch confidently-wrong ones (default 0 = off). Use the rate from `--calibrate`. |
| `--lsp-pipeline <n>`          | `n` concurrent LSP requests in flight (default 1 = serial). Speeds up dispatch on servers that handle concurrency (jdtls, tsserver, gopls). |
| `--lsp-changed-since <ref>`   | Only augment call sites in files changed since a git ref — fast incremental re-index. |
| `--lsp-cache`                 | Cache `textDocument/definition` across runs (clean working tree only) — speeds repeat re-indexing. |
| `--lsp-dry-run`               | Preview every reconciliation decision, write nothing. Implies `--lsp`. |

## Footgun: re-analyze drops LSP provenance

**Re-running `analyze` without `--lsp` rebuilds the call graph heuristic-only and discards
every confirm/correct/recall edge** — the graph is rebuilt each run, and LSP provenance is
only re-derived when the server runs. So if your index was built with `--lsp`, keep passing
it. `analyze --lsp` records `stats.lsp: true` in `meta.json`; the Claude Code freshness hook
reads that and appends `--lsp` to the re-analyze command it suggests after `git commit` /
`merge`, so the provenance survives the auto-refresh prompt (see `gitnexus-cli`).
