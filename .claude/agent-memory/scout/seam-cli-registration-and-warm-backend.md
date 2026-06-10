---
name: seam-cli-registration-warm-backend
description: CLI command registration pattern (createLazyAction) and warm-backend lifecycle (LocalBackend init/disconnect) for gitnexus verify/lsp commands
metadata:
  type: reference
---

## CLI Registration Seam (src/cli/index.ts)

All commands register via the createLazyAction pattern:

```ts
program
  .command('name')
  .description('...')
  .option('-f, --flag', 'description')
  .action(createLazyAction(() => import('./name.js'), 'nameCommand'));
```

**Pattern:**
1. `.action()` receives createLazyAction(loader, exportName)
2. loader is `() => import('./file.js')` (compiled .js file with .js extension)
3. exportName is the export name in that file (e.g., 'verifyCommand' for verify.ts)
4. createLazyAction is generic: `<TModule, TKey extends keyof TModule>` enforces type safety at compile time

**New command registration slot:** Before `program.parse()` at line 153 in index.ts. Insert between eval-server block (line 146-151) and parse.

```ts
program
  .command('verify')
  .description('Verify index health and LSP integration')
  .option('--lsp', 'Check LSP server availability')
  .action(createLazyAction(() => import('./verify.js'), 'verifyCommand'));

program
  .command('lsp')
  .description('LSP server diagnostics')
  .option('--doctor', 'Run diagnostic checks')
  .action(createLazyAction(() => import('./lsp.js'), 'lspCommand'));
```

**Key constraint:** Import statements MUST use `.js` extension (ESM). Files compile from .ts → .js.

## Command File Structure (verify.ts, lsp.ts template)

Example from status.ts (simplest):

```ts
export const statusCommand = async () => {
  // ... logic ...
  console.log('Output here');
};
```

Example from index-repo.ts (with parameters and options):

```ts
export interface VerifyOptions {
  lsp?: boolean;
}

export const verifyCommand = async (options?: VerifyOptions) => {
  // Parse options
  if (options?.lsp) { /* specific logic */ }
  
  // Output via console.log
  console.log('Result here');
  
  // Optionally process.exit(1) on error; process continues normally otherwise
};
```

Example from analyze.ts (with resource cleanup and exit):

```ts
export const analyzeCommand = async (inputPath?: string, options?: AnalyzeOptions) => {
  // ... work ...
  await closeLbug();
  console.log('Summary');
  process.exit(0);  // Force exit (needed when native modules hold handles)
};
```

## Warm-Backend Lifecycle (eval-server prior art)

**Pattern from evalServerCommand (eval-server.ts:307-430):**

```ts
export async function evalServerCommand(options?: EvalServerOptions): Promise<void> {
  // 1. INIT: Warm backend (discover repos, DON'T open DB yet)
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    console.error('No indexed repositories. Run: gitnexus analyze');
    process.exit(1);
  }

  // 2. KEEP WARM: Create HTTP server that holds backend in memory
  const server = http.createServer(async (req, res) => {
    // 3. LAZY DB INIT: backend.callTool() opens per-repo LadybugDB on first query
    const result = await backend.callTool(toolName, args);
    // ... format + respond ...
  });

  // 4. LIFECYCLE: Idle timer, SIGINT handler
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function resetIdleTimer() {
    if (idleTimeoutSec <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      await backend.disconnect();
      process.exit(0);
    }, idleTimeoutSec * 1000);
  }

  server.listen(port, '127.0.0.1', () => { resetIdleTimer(); });

  const shutdown = async () => {
    await backend.disconnect();  // Close all connections, clear caches
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

**Key lifecycle phases:**
1. `new LocalBackend()` — create instance
2. `await backend.init()` — discover repos from registry (warm init, no DB connections)
3. `backend.callTool(name, args)` — lazy-opens per-repo LadybugDB on first query
4. `await backend.disconnect()` — closes all LadybugDB connections, clears in-memory caches
5. `process.exit(0)` — exit (native module handles cleaned up by OS)

**LocalBackend internals:**
- `init()` calls `refreshRepos()` → populates `this.repos` map and `this.contextCache`
- `ensureInitialized(repoId)` — lazily calls `initLbug(repoId, path)` on first query
- `initializedRepos` Set tracks which repos have been opened
- `isLbugReady(repoId)` checks if connection still exists (idle timeout may have evicted it)
- `disconnect()` calls `closeLbug()` + clears all maps; does NOT call `disposeEmbedder()` (crashes)

## Text-Report + Next-Step Formatter Pattern (eval-server prior art)

**Pattern: formatToolResult dispatcher + per-tool formatter:**

```ts
export function formatQueryResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;
  
  const lines: string[] = [];
  // ... build output ...
  lines.push(`Found ${count} items:`);
  for (const item of results) {
    lines.push(`  • ${item.name}`);
  }
  
  return lines.join('\n').trim();
}

export function formatContextResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;
  // ... similar pattern ...
}

function formatToolResult(toolName: string, result: any): string {
  switch (toolName) {
    case 'query': return formatQueryResult(result);
    case 'context': return formatContextResult(result);
    default: return JSON.stringify(result, null, 2);
  }
}

function getNextStepHint(toolName: string): string {
  switch (toolName) {
    case 'query':
      return '\n---\nNext: Pick a symbol and run gitnexus-context to explore it.';
    case 'context':
      return '\n---\nNext: Run gitnexus-impact to see what breaks if you change this.';
    default: return '';
  }
}

// In HTTP handler:
const formatted = formatToolResult(toolName, result);
const hint = getNextStepHint(toolName);
res.end(formatted + hint);
```

**For Mode C (verify --lsp text report), follow the same pattern:**
- Create `formatLspVerifyResult(result)` → returns text
- Append next-step hint from `getNextStepHint('lsp')`
- Return text + hint

## Safe stdout() function for CLI output (tool.ts prior art)

```ts
function output(data: any): void {
  const text = typeof data === 'string' ? data : JSON.stringify(stripUndefined(data), mapReplacer, 2);
  try {
    writeSync(1, text + '\n');  // Low-level fd write (bypasses LadybugDB's stdout capture)
  } catch (err: any) {
    if (err?.code === 'EPIPE') {
      process.exit(0);  // Pipe closed (e.g., piped to head)
    }
    process.stderr.write(text + '\n');  // Fallback
  }
}
```

Use this when commands might be piped to other tools (`gitnexus verify --lsp | grep error`).

## Key Imports for New Commands

```ts
import { LocalBackend } from '../mcp/local/local-backend.js';
import { initLbug, closeLbug } from '../core/lbug/lbug-adapter.js';
import { listRegisteredRepos, getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import http from 'http';  // If daemon-like (HTTP server)
import { writeSync } from 'node:fs';  // If safe output() needed
```

All imports must end with `.js` extension.

## Integration Checklist

- [ ] Add command block to index.ts (before program.parse())
- [ ] Create src/cli/verify.ts with `export const verifyCommand`
- [ ] Create src/cli/lsp.ts with `export const lspCommand`
- [ ] If Mode A/B (simple status check): use statusCommand pattern (no daemon)
- [ ] If Mode C (daemon): use evalServerCommand pattern (warm backend + HTTP)
- [ ] If text output needed: create formatter functions (eval-server pattern)
- [ ] All imports use .js extension (ESM)
- [ ] Run `npm run build` to compile .ts → .js
- [ ] Test: `npx gitnexus verify --lsp`, `npx gitnexus lsp --doctor`
