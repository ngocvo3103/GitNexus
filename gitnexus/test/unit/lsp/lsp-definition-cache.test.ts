import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildDefinitionCache,
  definitionCacheKey,
} from '../../../src/core/ingestion/lsp-definition-cache.js';
import type { Location } from '../../../src/core/ingestion/lsp/location-mapper.js';

const loc = (uri: string, line = 0): Location => ({ uri, range: { start: { line, character: 0 } } });

describe('lsp-definition-cache (lever 14)', () => {
  let dir: string;
  const repoId = '/some/repo';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gnx-defcache-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('definitionCacheKey is file+position', () => {
    expect(definitionCacheKey('src/a.ts', 3, 7)).toBe('src/a.ts:3:7');
  });

  it('disabled → no-op cache (always miss, never persists)', () => {
    const c = buildDefinitionCache({ enabled: false, commit: 'abc', treeClean: true, globalDir: dir, repoId });
    expect(c.get('k')).toBeUndefined();
    c.set('k', [loc('file:///x')]);
    c.flush();
    expect(c.get('k')).toBeUndefined();
    // Nothing written to disk.
    expect(() => readdirSync(path.join(dir, 'lsp-def-cache'))).toThrow();
  });

  it('dirty tree → no-op cache (cannot trust on-disk files match the commit)', () => {
    const c = buildDefinitionCache({ enabled: true, commit: 'abc', treeClean: false, globalDir: dir, repoId });
    c.set('k', [loc('file:///x')]);
    expect(c.get('k')).toBeUndefined();
  });

  it('unknown commit → no-op cache', () => {
    const c = buildDefinitionCache({ enabled: true, commit: null, treeClean: true, globalDir: dir, repoId });
    c.set('k', [loc('file:///x')]);
    expect(c.get('k')).toBeUndefined();
  });

  it('enabled+clean+commit: set then get hits; tracks stats', () => {
    const c = buildDefinitionCache({ enabled: true, commit: 'abc', treeClean: true, globalDir: dir, repoId });
    expect(c.get('k')).toBeUndefined(); // miss
    c.set('k', [loc('file:///def.ts', 5)]);
    expect(c.get('k')).toEqual([loc('file:///def.ts', 5)]); // hit
    expect(c.stats).toEqual({ hits: 1, misses: 1, stores: 1 });
  });

  it('flush persists; a new cache with the SAME commit replays the entry', () => {
    const c1 = buildDefinitionCache({ enabled: true, commit: 'abc', treeClean: true, globalDir: dir, repoId });
    c1.set('src/a.ts:1:2', [loc('file:///t.ts', 9)]);
    c1.flush();

    const c2 = buildDefinitionCache({ enabled: true, commit: 'abc', treeClean: true, globalDir: dir, repoId });
    expect(c2.get('src/a.ts:1:2')).toEqual([loc('file:///t.ts', 9)]);
    expect(c2.stats.hits).toBe(1);
  });

  it('a DIFFERENT commit starts a fresh namespace (no stale cross-commit hits)', () => {
    const c1 = buildDefinitionCache({ enabled: true, commit: 'commitA', treeClean: true, globalDir: dir, repoId });
    c1.set('k', [loc('file:///old.ts')]);
    c1.flush();

    const c2 = buildDefinitionCache({ enabled: true, commit: 'commitB', treeClean: true, globalDir: dir, repoId });
    expect(c2.get('k')).toBeUndefined();
  });

  it('corrupt cache file → fresh namespace, no throw', () => {
    const safe = createHash('sha1').update(repoId).digest('hex').slice(0, 16);
    mkdirSync(path.join(dir, 'lsp-def-cache'), { recursive: true });
    writeFileSync(path.join(dir, 'lsp-def-cache', `${safe}.json`), '{not valid json', 'utf-8');
    const c = buildDefinitionCache({ enabled: true, commit: 'abc', treeClean: true, globalDir: dir, repoId });
    expect(c.get('k')).toBeUndefined();
    // Still usable after a corrupt load.
    c.set('k', [loc('file:///x')]);
    expect(c.get('k')).toEqual([loc('file:///x')]);
  });
});
