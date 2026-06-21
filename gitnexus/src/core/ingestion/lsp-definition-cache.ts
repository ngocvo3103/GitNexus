/**
 * Lever 14 — persisted `textDocument/definition` result cache.
 *
 * Collapses the serial cap×latency cost of re-indexing an UNCHANGED repo: on a
 * clean checkout of the same commit, every definition result is reproducible,
 * so a prior run's answers can be replayed without touching the LSP server.
 *
 * Correctness — why the cache is namespaced by commit, not per-file-hash:
 * a definition result for a call site in file A can point at a target in file
 * B. Keying on A's content hash alone would return a stale Location when B
 * changed but A did not. The only safe key for a cross-file result is the WHOLE
 * repo state. We therefore:
 *   - namespace the entire cache by the HEAD commit, and
 *   - activate it ONLY when the working tree is clean (no uncommitted edits),
 * so "same commit + clean tree" guarantees identical file contents and the
 * cached answers are valid. A dirty tree or unknown commit yields a no-op cache
 * (every get misses, nothing is stored) — caching is silently disabled rather
 * than risk a stale hit. A different commit starts a fresh namespace (all miss).
 *
 * Opt-in via `--lsp-cache`; off by default, so the standard path is unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Location } from './lsp/location-mapper.js';

/** Per-candidate cache key: repo-relative file + callee position. */
export function definitionCacheKey(file: string, line: number, character: number): string {
  return `${file}:${line}:${character}`;
}

export interface DefinitionCache {
  /** Cached `Location[]` for this key, or `undefined` on a miss. */
  get(key: string): Location[] | undefined;
  /** Record the live result for this key (no-op when caching is disabled). */
  set(key: string, locations: Location[]): void;
  /** Persist new entries to disk (no-op when disabled / nothing new). */
  flush(): void;
  /** Observability: hits/misses/stores this session. */
  readonly stats: { hits: number; misses: number; stores: number };
}

/** A cache that never stores and always misses (caching disabled, but safe). */
const NOOP_CACHE: DefinitionCache = {
  get: () => undefined,
  set: () => {},
  flush: () => {},
  stats: { hits: 0, misses: 0, stores: 0 },
};

interface CacheFile {
  version: number;
  /** HEAD commit this namespace is valid for. */
  commit: string;
  entries: Record<string, Location[]>;
}

const CACHE_VERSION = 1;

function cacheFilePath(globalDir: string, repoId: string): string {
  // repoId can contain path separators; hash it to a flat, safe filename.
  const safe = createHash('sha1').update(repoId).digest('hex').slice(0, 16);
  return path.join(globalDir, 'lsp-def-cache', `${safe}.json`);
}

/**
 * Build a definition cache for a session.
 *
 * @param opts.enabled    `--lsp-cache` flag. When false → {@link NOOP_CACHE}.
 * @param opts.commit     current HEAD commit, or null when unknown.
 * @param opts.treeClean  true when the working tree has no uncommitted edits.
 * @param opts.globalDir  base dir for the cache file (e.g. `~/.gitnexus`).
 * @param opts.repoId     repo identifier (namespaces the cache file).
 *
 * Returns a no-op cache unless enabled AND commit known AND tree clean.
 */
export function buildDefinitionCache(opts: {
  enabled: boolean;
  commit: string | null;
  treeClean: boolean;
  globalDir: string;
  repoId: string;
}): DefinitionCache {
  if (!opts.enabled || !opts.commit || !opts.treeClean) return NOOP_CACHE;

  const file = cacheFilePath(opts.globalDir, opts.repoId);
  const entries = new Map<string, Location[]>();

  // Load the existing namespace iff it matches the current commit.
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheFile;
    if (parsed && parsed.version === CACHE_VERSION && parsed.commit === opts.commit && parsed.entries) {
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (Array.isArray(v)) entries.set(k, v as Location[]);
      }
    }
    // Mismatched commit / version → ignore (fresh namespace).
  } catch {
    // Missing / corrupt → fresh namespace.
  }

  const stats = { hits: 0, misses: 0, stores: 0 };
  let dirty = false;

  return {
    stats,
    get(key) {
      const v = entries.get(key);
      if (v === undefined) {
        stats.misses++;
        return undefined;
      }
      stats.hits++;
      return v;
    },
    set(key, locations) {
      if (entries.has(key)) return;
      entries.set(key, locations);
      stats.stores++;
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      const payload: CacheFile = {
        version: CACHE_VERSION,
        commit: opts.commit!,
        entries: Object.fromEntries(entries),
      };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Atomic-ish: write to a temp sibling then rename.
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
        fs.renameSync(tmp, file);
      } catch {
        // Best-effort: a cache write failure must never fail the analyze run.
      }
    },
  };
}
