/**
 * Vitest globalSetup — runs once in the MAIN process before any forks.
 *
 * Two responsibilities:
 *
 * 1. Registry isolation (GITNEXUS_HOME):
 *    Sets GITNEXUS_HOME to a per-run tmpdir so that every test and every
 *    child process spawned by tests (spawnSync calls inherit process.env)
 *    reads/writes a throwaway registry — never the developer's real
 *    ~/.gitnexus.  The env var is picked up by getGlobalDir() in
 *    src/storage/repo-manager.ts, which is the single resolution point
 *    for all global state (registry.json, config.json).
 *
 * 2. Shared LadybugDB:
 *    Creates a single shared LadybugDB with full schema so that forked
 *    test files only need to clear + reseed data instead of recreating the
 *    entire schema each time (~29 DDL queries per file eliminated).
 *    The dbPath is shared with test files via vitest's provide/inject API.
 */
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import lbug from '@ladybugdb/core';
import type { GlobalSetupContext } from 'vitest/node';
import { createTempDir } from './helpers/test-db.js';
import {
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
} from '../src/core/lbug/schema.js';

export default async function setup({ provide }: GlobalSetupContext) {
  // ── 1. Registry isolation ─────────────────────────────────────────────
  // Create a per-run tmpdir for all global GitNexus state.  Set it BEFORE
  // any module that reads process.env.GITNEXUS_HOME is imported by a fork.
  const registryTmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gitnexus-registry-'),
  );
  process.env.GITNEXUS_HOME = registryTmpDir;

  // ── 2. Shared LadybugDB ───────────────────────────────────────────────
  const tmpHandle = await createTempDir('gitnexus-shared-');
  const dbPath = path.join(tmpHandle.dbPath, 'lbug');

  // Create DB with full schema
  const db = new lbug.Database(dbPath);
  const conn = new lbug.Connection(db);

  for (const q of NODE_SCHEMA_QUERIES) {
    await conn.query(q);
  }
  for (const q of REL_SCHEMA_QUERIES) {
    await conn.query(q);
  }
  await conn.query(EMBEDDING_SCHEMA);

  // Pre-install FTS extension so forks don't need to download it
  try {
    await conn.query('INSTALL fts');
    await conn.query('LOAD EXTENSION fts');
  } catch {
    // FTS may already be installed system-wide — not fatal
  }

  await conn.close();
  await db.close();

  // Share the dbPath with all test files via inject('lbugDbPath')
  provide('lbugDbPath', dbPath);

  // Fork-safe fallback. On vitest 4.x, `provide()` does not reliably reach
  // `inject()` in the `lbug-db` sub-project's forks during a full-suite run
  // (projects + globalSetup + inject interaction bug). globalSetup runs in
  // the MAIN process before any fork is spawned, so an env var set here is
  // inherited by every fork — a robust channel independent of provide/inject.
  // See test/helpers/test-indexed-db.ts for the consuming fallback.
  process.env.LBUG_DB_PATH = dbPath;

  // Teardown: remove temp directories after all tests complete
  return async () => {
    await tmpHandle.cleanup();
    try {
      await fs.rm(registryTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort: tmpdir may already be gone
    }
  };
}
