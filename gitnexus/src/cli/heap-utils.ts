/**
 * Heap Management Utilities
 *
 * Shared utilities for Node.js heap management in CLI commands.
 */

import { execFileSync } from 'child_process';
import v8 from 'v8';

const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;

/**
 * Re-exec the process with an 8GB heap if we're currently below that.
 * Required for memory-intensive operations like:
 * - `gitnexus analyze` (graph loading, embedding generation)
 * - `gitnexus document-endpoint --include-context` (deep call chains)
 * - `gitnexus impact` (blast radius analysis)
 *
 * @returns true if the process was re-exec'd (caller should return immediately)
 *          false if heap is already sufficient (caller should proceed)
 */
export function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  try {
    execFileSync(process.execPath, [HEAP_FLAG, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}