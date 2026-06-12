/**
 * Vitest setupFiles entry — runs ONCE PER FORK before each test file.
 *
 * Responsibility: per-fork GITNEXUS_HOME isolation (gh #175).
 *
 * global-setup.ts creates a single parent tmpdir for the run and exports it
 * as GITNEXUS_TEST_HOME_PARENT.  This file runs inside each worker fork and
 * mkdtemps a UNIQUE child directory under that parent, then sets
 * process.env.GITNEXUS_HOME to it.
 *
 * Result: every test file (fork) gets its own private registry dir.
 * Subprocesses spawned by tests inherit GITNEXUS_HOME from the fork's
 * process.env via the usual { ...process.env } spread, so they too are
 * isolated without any additional wiring.
 *
 * Teardown of the per-fork dirs is handled transitively: global-setup.ts
 * removes the parent recursively after all forks have exited, which sweeps
 * up all children created here.
 */
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const parent = process.env.GITNEXUS_TEST_HOME_PARENT;

if (!parent) {
  // global-setup.ts did not run (e.g. the file is executed outside the
  // normal vitest harness).  Fall back to a standalone tmpdir so the
  // fork still gets isolation rather than touching the real ~/.gitnexus.
  const fallback = mkdtempSync(join(tmpdir(), 'gitnexus-registry-fork-'));
  process.env.GITNEXUS_HOME = fallback;
} else {
  // Normal path: create a unique child under the run-level parent.
  const forkDir = mkdtempSync(join(parent, 'fork-'));
  process.env.GITNEXUS_HOME = forkDir;
}
