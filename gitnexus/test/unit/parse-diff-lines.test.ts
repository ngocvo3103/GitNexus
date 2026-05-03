/**
 * Unit Tests: parseDiffOutputWithLines
 *
 * Tests the pure function that parses `git diff --unified=0` output
 * into structured FileDiffWithLines with line-range data.
 */
import { describe, it, expect } from 'vitest';
import { parseDiffOutputWithLines } from '../../src/mcp/local/parse-diff-lines.js';

describe('parseDiffOutputWithLines', () => {
  // ── 1. Single file, single hunk ────────────────────────────────────
  it('parses a single file with one hunk', () => {
    const diff = [
      'diff --git a/src/Foo.java b/src/Foo.java',
      'index abc123..def456 100644',
      '--- a/src/Foo.java',
      '+++ b/src/Foo.java',
      '@@ -10,3 +10,3 @@',
      '  changed line here',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: 'src/Foo.java',
      changedLineRanges: [{ startLine: 10, endLine: 12 }],
    });
  });

  // ── 2. Single file, multiple hunks ────────────────────────────────
  it('parses a single file with multiple hunks', () => {
    const diff = [
      'diff --git a/Bar.java b/Bar.java',
      'index 111..222 100644',
      '--- a/Bar.java',
      '+++ b/Bar.java',
      '@@ -5,2 +5,2 @@',
      '  line a',
      '@@ -20,4 +20,4 @@',
      '  line b',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('Bar.java');
    expect(result[0].changedLineRanges).toEqual([
      { startLine: 5, endLine: 6 },
      { startLine: 20, endLine: 23 },
    ]);
  });

  // ── 3. Multi-file diff ────────────────────────────────────────────
  it('parses multiple files in one diff output', () => {
    const diff = [
      'diff --git a/A.java b/A.java',
      '--- a/A.java',
      '+++ b/A.java',
      '@@ -1,1 +1,1 @@',
      '  change',
      'diff --git a/B.java b/B.java',
      '--- a/B.java',
      '+++ b/B.java',
      '@@ -30,2 +30,2 @@',
      '  other change',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      filePath: 'A.java',
      changedLineRanges: [{ startLine: 1, endLine: 1 }],
    });
    expect(result[1]).toEqual({
      filePath: 'B.java',
      changedLineRanges: [{ startLine: 30, endLine: 31 }],
    });
  });

  // ── 4. Deletion-only hunk (newCount=0) ────────────────────────────
  it('skips deletion-only hunks where newCount is 0', () => {
    const diff = [
      'diff --git a/Deleted.java b/Deleted.java',
      '--- a/Deleted.java',
      '+++ b/Deleted.java',
      '@@ -10,3 +10,0 @@',
      '  removed line',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('Deleted.java');
    expect(result[0].changedLineRanges).toEqual([]);
  });

  // ── 5. Addition-only hunk (oldCount=0) ────────────────────────────
  it('parses addition-only hunks with oldCount=0', () => {
    const diff = [
      'diff --git a/New.java b/New.java',
      '--- a/New.java',
      '+++ b/New.java',
      '@@ -5,0 +6,4 @@',
      '+new line 1',
      '+new line 2',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0].changedLineRanges).toEqual([
      { startLine: 6, endLine: 9 },
    ]);
  });

  // ── 6. Empty diff output ──────────────────────────────────────────
  it('returns empty array for empty string input', () => {
    expect(parseDiffOutputWithLines('')).toEqual([]);
  });

  // ── 7. Binary file (no hunks) ──────────────────────────────────────
  it('returns empty changedLineRanges for binary files with no hunk headers', () => {
    const diff = [
      'diff --git a/image.png b/image.png',
      'Binary files /dev/null and b/image.png differ',
      '--- a/image.png',
      '+++ b/image.png',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('image.png');
    expect(result[0].changedLineRanges).toEqual([]);
  });

  // ── 8. Malformed hunk header ──────────────────────────────────────
  it('skips malformed hunk headers gracefully', () => {
    const diff = [
      'diff --git a/Bad.java b/Bad.java',
      '--- a/Bad.java',
      '+++ b/Bad.java',
      '@@ garbage @@',
      '@@ -10,3 +10,3 @@',
      '  valid line',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    // Only the well-formed hunk header is parsed
    expect(result[0].changedLineRanges).toEqual([
      { startLine: 10, endLine: 12 },
    ]);
  });

  // ── 9. Single-line change (count omitted) ─────────────────────────
  it('treats omitted count as 1 (single-line change)', () => {
    const diff = [
      'diff --git a/One.java b/One.java',
      '--- a/One.java',
      '+++ b/One.java',
      '@@ -5 +5 @@',
      '  single line changed',
    ].join('\n');

    const result = parseDiffOutputWithLines(diff);

    expect(result).toHaveLength(1);
    expect(result[0].changedLineRanges).toEqual([
      { startLine: 5, endLine: 5 },
    ]);
  });
});