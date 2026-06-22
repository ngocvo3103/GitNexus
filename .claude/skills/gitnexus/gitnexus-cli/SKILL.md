---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

All commands work via `npx` — no global install required.

## Commands

### analyze — Build or refresh the index

```bash
npx gitnexus analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.gitnexus/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--lsp`        | Augment CALLS resolution via the language server (TS/Java/Go/Python/Rust) — confirm/correct (0.90) + recall (per-language: 0.90 default, TS 0.75 / Python 0.60). Off by default. See `gitnexus-lsp`. |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale. In Claude Code, a PostToolUse hook detects staleness after git commit/merge/rebase/pull and **prompts** you to re-run `analyze` (it suggests the command — including `--embeddings`/`--lsp` if the index used them — but does not run it for you).

#### `--lsp` and its levers (opt-in, higher-accuracy call graph)

`--lsp` re-checks the heuristic call graph against a real language server, raising
trust on ambiguous edges and recovering missed callers. **Requires the matching
server on `PATH`** (`jdtls`/`gopls`/`rust-analyzer`/`pylsp`/`typescript-language-server`);
it silently no-ops if absent. Tuning levers — all require `--lsp`:
`--lsp-budget <n>`, `--lsp-high-tier-sample <r>`, `--lsp-pipeline <n>`,
`--lsp-changed-since <ref>`, `--lsp-cache`, `--lsp-dry-run`. Full guidance,
provenance semantics, and per-language notes live in the **`gitnexus-lsp`** skill.

> **Footgun:** re-running `analyze` *without* `--lsp` rebuilds the call graph heuristic-only
> and drops confirm/correct/recall. (Unlike embeddings, which `analyze` auto-preserves, LSP
> provenance is only re-derived when the server runs — so it cannot be auto-preserved without
> `--lsp`.) If your index was built with `--lsp`, keep passing it; the freshness hook reads
> `meta.json` `stats.lsp` and includes `--lsp` in the re-analyze command it suggests.

### verify — Measure call-graph accuracy (Mode C)

```bash
npx gitnexus verify --lsp                    # heuristic vs LSP: precision + false-confident rate
npx gitnexus verify --lsp --max-fc-rate 0.05 # CI gate: fail if false-confident rate > 5%
npx gitnexus verify --lsp --strict           # boolean: fail only if the LSP server is unavailable
npx gitnexus verify --lsp --calibrate        # recommend an --lsp-high-tier-sample rate
```

Compares confident heuristic CALLS edges to LSP go-to-definition. Without `--lsp` it does
nothing; needs the language server installed. See `gitnexus-lsp` for interpreting the output.

### status — Check index freshness

```bash
npx gitnexus status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
npx gitnexus clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
npx gitnexus wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
npx gitnexus list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
