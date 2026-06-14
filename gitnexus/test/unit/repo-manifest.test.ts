/**
 * WI-1 Unit Tests: Repository Manifest
 *
 * Tests: readManifest, writeManifest, RepoManifest interface
 * Covers cross-repo dependency tracking
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  readManifest,
  writeManifest,
  RepoManifest,
} from '../../src/storage/repo-manifest.js';
import { createTempDir } from '../helpers/test-db.js';

// ─── RepoManifest Interface Tests ─────────────────────────────────────────

describe('RepoManifest interface', () => {
  it('has required fields: repoId, indexedAt, dependencies', () => {
    // WI-1: RepoManifest must have repoId for cross-repo resolution
    const manifest: RepoManifest = {
      repoId: 'repo-abc123',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['shared-lib', 'core-utils'],
    };
    expect(manifest.repoId).toBe('repo-abc123');
    expect(manifest.indexedAt).toBe('2024-01-15T10:30:00Z');
    expect(manifest.dependencies).toEqual(['shared-lib', 'core-utils']);
  });

  it('dependencies is optional (empty array by default)', () => {
    // WI-1: Repos without dependencies should still be valid
    const manifest: RepoManifest = {
      repoId: 'standalone-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };
    expect(manifest.dependencies).toEqual([]);
  });

  it('supports additional metadata fields', () => {
    // WI-1: Manifest may include optional fields for future extensibility
    const manifest: RepoManifest = {
      repoId: 'repo-with-meta',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
      lastCommit: 'abc123def456',
      stats: {
        nodes: 1000,
        edges: 2500,
        communities: 15,
      },
    };
    expect(manifest.lastCommit).toBe('abc123def456');
    expect(manifest.stats?.nodes).toBe(1000);
  });
});

// ─── readManifest Tests ────────────────────────────────────────────────────

describe('readManifest', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let manifestPath: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-manifest-test-');
    manifestPath = path.join(tmpHandle.dbPath, '.gitnexus', 'repo_manifest.json');
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  it('returns null when manifest file does not exist', async () => {
    // WI-1: readManifest should gracefully handle missing files
    const result = await readManifest(tmpHandle.dbPath);
    expect(result).toBeNull();
  });

  it('returns valid manifest when file exists', async () => {
    // WI-1: readManifest should parse valid JSON manifest
    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    await fs.mkdir(gitnexusDir, { recursive: true });

    const manifest: RepoManifest = {
      repoId: 'test-repo-001',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['dep-a', 'dep-b'],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const result = await readManifest(tmpHandle.dbPath);
    expect(result).not.toBeNull();
    expect(result?.repoId).toBe('test-repo-001');
    expect(result?.dependencies).toEqual(['dep-a', 'dep-b']);
  });

  it('returns null for malformed JSON', async () => {
    // WI-1: readManifest should handle corrupt files gracefully
    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    await fs.mkdir(gitnexusDir, { recursive: true });
    await fs.writeFile(manifestPath, '{ invalid json }');

    const result = await readManifest(tmpHandle.dbPath);
    expect(result).toBeNull();
  });

  it('returns null when missing required fields', async () => {
    // WI-1: readManifest should validate manifest structure
    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    await fs.mkdir(gitnexusDir, { recursive: true });

    // Missing repoId (required field)
    const invalidManifest = {
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };
    await fs.writeFile(manifestPath, JSON.stringify(invalidManifest));

    const result = await readManifest(tmpHandle.dbPath);
    expect(result).toBeNull();
  });

  it('returns manifest with empty dependencies array if field missing', async () => {
    // WI-1: Backward compatibility for manifests without dependencies
    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    await fs.mkdir(gitnexusDir, { recursive: true });

    const legacyManifest = {
      repoId: 'legacy-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      // No dependencies field
    };
    await fs.writeFile(manifestPath, JSON.stringify(legacyManifest));

    const result = await readManifest(tmpHandle.dbPath);
    expect(result).not.toBeNull();
    expect(result?.repoId).toBe('legacy-repo');
    expect(result?.dependencies).toEqual([]);
  });
});

// ─── writeManifest Tests ───────────────────────────────────────────────────

describe('writeManifest', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let manifestPath: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-manifest-write-test-');
    manifestPath = path.join(tmpHandle.dbPath, '.gitnexus', 'repo_manifest.json');
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  it('creates .gitnexus directory if it does not exist', async () => {
    // WI-1: writeManifest should create directory structure
    const manifest: RepoManifest = {
      repoId: 'new-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };

    await writeManifest(tmpHandle.dbPath, manifest);

    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    const dirExists = await fs.stat(gitnexusDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
  });

  it('writes valid JSON to manifest file', async () => {
    // WI-1: writeManifest should produce valid JSON
    const manifest: RepoManifest = {
      repoId: 'test-repo-002',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['lib-x', 'lib-y', 'lib-z'],
    };

    await writeManifest(tmpHandle.dbPath, manifest);

    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.repoId).toBe('test-repo-002');
    expect(parsed.dependencies).toHaveLength(3);
  });

  it('overwrites existing manifest', async () => {
    // WI-1: writeManifest should update existing manifests
    const gitnexusDir = path.join(tmpHandle.dbPath, '.gitnexus');
    await fs.mkdir(gitnexusDir, { recursive: true });

    const manifest1: RepoManifest = {
      repoId: 'original-repo',
      indexedAt: '2024-01-01T00:00:00Z',
      dependencies: ['old-dep'],
    };
    await writeManifest(tmpHandle.dbPath, manifest1);

    const manifest2: RepoManifest = {
      repoId: 'updated-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['new-dep-1', 'new-dep-2'],
    };
    await writeManifest(tmpHandle.dbPath, manifest2);

    const result = await readManifest(tmpHandle.dbPath);
    expect(result?.repoId).toBe('updated-repo');
    expect(result?.dependencies).toEqual(['new-dep-1', 'new-dep-2']);
  });

  it('formats JSON with 2-space indentation for readability', async () => {
    // WI-1: Manifest should be human-readable
    const manifest: RepoManifest = {
      repoId: 'formatted-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };

    await writeManifest(tmpHandle.dbPath, manifest);

    const content = await fs.readFile(manifestPath, 'utf-8');
    // Check for 2-space indentation pattern
    expect(content).toContain('  "repoId"');
    expect(content).toContain('  "indexedAt"');
  });
});

// ─── Cross-Repo Dependency Tracking Tests ──────────────────────────────────

describe('cross-repo dependency tracking', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-deps-test-');
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  it('stores multiple dependencies in manifest', async () => {
    // WI-1: Manifest must support multiple dependencies
    const manifest: RepoManifest = {
      repoId: 'consumer-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['shared-types', 'common-utils', 'api-contracts'],
    };

    await writeManifest(tmpHandle.dbPath, manifest);
    const result = await readManifest(tmpHandle.dbPath);

    expect(result?.dependencies).toHaveLength(3);
    expect(result?.dependencies).toContain('shared-types');
    expect(result?.dependencies).toContain('common-utils');
    expect(result?.dependencies).toContain('api-contracts');
  });

  it('supports empty dependencies for standalone repos', async () => {
    // WI-1: Standalone repos without dependencies are valid
    const manifest: RepoManifest = {
      repoId: 'standalone-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: [],
    };

    await writeManifest(tmpHandle.dbPath, manifest);
    const result = await readManifest(tmpHandle.dbPath);

    expect(result?.dependencies).toEqual([]);
  });

  it('maintains dependency order', async () => {
    // WI-1: Dependencies should preserve insertion order
    const manifest: RepoManifest = {
      repoId: 'ordered-repo',
      indexedAt: '2024-01-15T10:30:00Z',
      dependencies: ['first', 'second', 'third'],
    };

    await writeManifest(tmpHandle.dbPath, manifest);
    const result = await readManifest(tmpHandle.dbPath);

    expect(result?.dependencies?.[0]).toBe('first');
    expect(result?.dependencies?.[1]).toBe('second');
    expect(result?.dependencies?.[2]).toBe('third');
  });
});