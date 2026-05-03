/**
 * Unit Tests: execGitDiff
 *
 * Tests the git diff helper that produces changed-file lists for the
 * impacted_endpoints pipeline. Mocks child_process.execFileSync so no
 * real git invocation occurs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the mock so we can configure return values per-test
const execFileSyncMock = vi.fn();

// Mock child_process at module level — execGitDiff uses dynamic import
// so the mock must be in place before LocalBackend loads.
vi.mock('child_process', () => ({
  execFileSync: (...args: any[]) => execFileSyncMock(...args),
}));

// Mock lbug-adapter before importing LocalBackend
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

// Mock repo-manager to avoid filesystem access
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// Mock search/embedder to avoid onnxruntime loading
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('execGitDiff', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-diff', name: 'repo-diff', repoPath: '/tmp/repo-diff',
      storagePath: '/tmp/repo-diff/.gitnexus', lbugPath: '/tmp/repo-diff/.gitnexus/lbug',
      indexedAt: 'now', lastCommit: 'c', stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  });

  it('calls git diff --name-only for unstaged scope (default)', async () => {
    execFileSyncMock.mockReturnValue('file1.ts\nfile2.ts\n');

    const result = await (backend as any).execGitDiff('unstaged', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', '--name-only'], { cwd: '/tmp/repo', encoding: 'utf-8' });
    expect(result).toEqual(['file1.ts', 'file2.ts']);
  });

  it('calls git diff --staged --name-only for staged scope', async () => {
    execFileSyncMock.mockReturnValue('staged.ts\n');

    const result = await (backend as any).execGitDiff('staged', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', '--staged', '--name-only'], { cwd: '/tmp/repo', encoding: 'utf-8' });
    expect(result).toEqual(['staged.ts']);
  });

  it('calls git diff <base_ref> --name-only for compare scope', async () => {
    execFileSyncMock.mockReturnValue('compared.ts\n');

    const result = await (backend as any).execGitDiff('compare', 'main', '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', 'main', '--name-only'], { cwd: '/tmp/repo', encoding: 'utf-8' });
    expect(result).toEqual(['compared.ts']);
  });

  it('calls git diff HEAD --name-only for all scope', async () => {
    execFileSyncMock.mockReturnValue('all.ts\n');

    const result = await (backend as any).execGitDiff('all', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', 'HEAD', '--name-only'], { cwd: '/tmp/repo', encoding: 'utf-8' });
    expect(result).toEqual(['all.ts']);
  });

  it('returns error object when compare scope has no base_ref', async () => {
    const result = await (backend as any).execGitDiff('compare', undefined, '/tmp/repo');

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('base_ref is required');
  });

  it('returns error object when git command throws', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = await (backend as any).execGitDiff('unstaged', undefined, '/tmp/repo');

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Git diff failed');
    expect(result.error).toContain('not a git repository');
  });

  it('returns empty array when git returns empty stdout', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiff('unstaged', undefined, '/tmp/repo');

    expect(result).toEqual([]);
  });

  it('returns array of 3 paths when git returns 3 lines', async () => {
    execFileSyncMock.mockReturnValue('a.ts\nb.ts\nc.ts\n');

    const result = await (backend as any).execGitDiff('unstaged', undefined, '/tmp/repo');

    expect(result).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result).toHaveLength(3);
  });

  it('returns raw backslash paths from git — normalization is caller responsibility', async () => {
    execFileSyncMock.mockReturnValue('src\\main\\App.java\n');

    const result = await (backend as any).execGitDiff('unstaged', undefined, '/tmp/repo');

    expect(result).toHaveLength(1);
    // execGitDiff returns raw git output; normalization (replace(/\\\\/g, '/'))
    // is done in _impactedEndpointsImpl, not here
    expect(result[0]).toBe('src\\main\\App.java');
  });

  it('passes base_ref with special characters as a git argument', async () => {
    execFileSyncMock.mockReturnValue('feature.ts\n');

    const result = await (backend as any).execGitDiff('compare', 'feature/foo-bar', '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['diff', 'feature/foo-bar', '--name-only'],
      { cwd: '/tmp/repo', encoding: 'utf-8' },
    );
    expect(result).toEqual(['feature.ts']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regression: detect_changes uses execGitDiff consistently
// ──────────────────────────────────────────────────────────────────────

describe('execGitDiff regression — detect_changes consistency', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-reg', name: 'repo-reg', repoPath: '/tmp/repo-reg',
      storagePath: '/tmp/repo-reg/.gitnexus', lbugPath: '/tmp/repo-reg/.gitnexus/lbug',
      indexedAt: 'now', lastCommit: 'c', stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  });

  // R-09: detect_changes uses execGitDiff for unstaged scope
  it('detect_changes calls execGitDiff with same args as direct call (unstaged)', async () => {
    execFileSyncMock.mockReturnValue('Service.java\n');

    await (backend as any).detectChanges(
      (backend as any).repos.get('repo-reg'),
      { scope: 'unstaged' },
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', '--name-only'],
      { cwd: '/tmp/repo-reg', encoding: 'utf-8' },
    );
  });

  // R-10: detect_changes uses execGitDiff for compare scope
  it('detect_changes calls execGitDiff with same args as direct call (compare)', async () => {
    execFileSyncMock.mockReturnValue('Service.java\n');

    await (backend as any).detectChanges(
      (backend as any).repos.get('repo-reg'),
      { scope: 'compare', base_ref: 'main' },
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', 'main', '--name-only'],
      { cwd: '/tmp/repo-reg', encoding: 'utf-8' },
    );
  });

  // R-11: Error format consistency between detect_changes and impacted_endpoints
  it('returns same error format as impacted_endpoints when git diff fails', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const dcResult = await (backend as any).detectChanges(
      (backend as any).repos.get('repo-reg'),
      { scope: 'unstaged' },
    );

    const ieResult = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-reg'),
      { scope: 'unstaged' },
    );

    // Both should return { error: '...' } with same prefix
    expect(dcResult).toHaveProperty('error');
    expect(ieResult).toHaveProperty('error');
    expect(dcResult.error).toContain('Git diff failed');
    expect(ieResult.error).toContain('Git diff failed');
  });

  // R-04: detect_changes uses execGitDiff for staged scope
  it('detect_changes calls execGitDiff with correct args for staged scope', async () => {
    execFileSyncMock.mockReturnValue('Staged.java\n');

    await (backend as any).detectChanges(
      (backend as any).repos.get('repo-reg'),
      { scope: 'staged' },
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', '--staged', '--name-only'],
      { cwd: '/tmp/repo-reg', encoding: 'utf-8' },
    );
  });

  // R-05: detect_changes uses execGitDiff for all scope
  it('detect_changes calls execGitDiff with correct args for all scope', async () => {
    execFileSyncMock.mockReturnValue('All.java\n');

    await (backend as any).detectChanges(
      (backend as any).repos.get('repo-reg'),
      { scope: 'all' },
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', 'HEAD', '--name-only'],
      { cwd: '/tmp/repo-reg', encoding: 'utf-8' },
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// execGitDiffWithLines
// ──────────────────────────────────────────────────────────────────────

describe('execGitDiffWithLines', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-wl', name: 'repo-wl', repoPath: '/tmp/repo-wl',
      storagePath: '/tmp/repo-wl/.gitnexus', lbugPath: '/tmp/repo-wl/.gitnexus/lbug',
      indexedAt: 'now', lastCommit: 'c', stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  });

  it('calls git diff --unified=0 for unstaged scope (default)', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiffWithLines('unstaged', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', '--unified=0'],
      { cwd: '/tmp/repo', encoding: 'utf-8' },
    );
    // --unified=0, NOT --name-only
    const callArgs = execFileSyncMock.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--name-only');
    expect(result).toEqual([]);
  });

  it('calls git diff --staged --unified=0 for staged scope', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiffWithLines('staged', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', '--staged', '--unified=0'],
      { cwd: '/tmp/repo', encoding: 'utf-8' },
    );
    expect(result).toEqual([]);
  });

  it('calls git diff <base_ref> --unified=0 for compare scope', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiffWithLines('compare', 'main', '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', 'main', '--unified=0'],
      { cwd: '/tmp/repo', encoding: 'utf-8' },
    );
    expect(result).toEqual([]);
  });

  it('calls git diff HEAD --unified=0 for all scope', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiffWithLines('all', undefined, '/tmp/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git', ['diff', 'HEAD', '--unified=0'],
      { cwd: '/tmp/repo', encoding: 'utf-8' },
    );
    expect(result).toEqual([]);
  });

  it('returns error when compare scope has no base_ref', async () => {
    const result = await (backend as any).execGitDiffWithLines('compare', undefined, '/tmp/repo');

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('base_ref is required');
  });

  it('parses single-hunk diff into FileDiffWithLines with one LineRange', async () => {
    const diffOutput = [
      'diff --git a/src/App.ts b/src/App.ts',
      'index abc1234..def5678 100644',
      '--- a/src/App.ts',
      '+++ b/src/App.ts',
      '@@ -10,5 +42,8 @@ function main()',
      '+new line 1',
      '+new line 2',
    ].join('\n');
    execFileSyncMock.mockReturnValue(diffOutput);

    const result = await (backend as any).execGitDiffWithLines('unstaged', undefined, '/tmp/repo');

    expect(Array.isArray(result)).toBe(true);
    const files = result as any[];
    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe('src/App.ts');
    expect(files[0].changedLineRanges).toHaveLength(1);
    expect(files[0].changedLineRanges[0]).toEqual({ startLine: 42, endLine: 49 });
  });

  it('returns error object when git command throws', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = await (backend as any).execGitDiffWithLines('unstaged', undefined, '/tmp/repo');

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Git diff failed');
    expect((result as any).error).toContain('not a git repository');
  });

  it('returns empty array for empty git output', async () => {
    execFileSyncMock.mockReturnValue('');

    const result = await (backend as any).execGitDiffWithLines('unstaged', undefined, '/tmp/repo');

    expect(result).toEqual([]);
  });
});