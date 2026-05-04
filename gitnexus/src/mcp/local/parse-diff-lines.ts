/** A single contiguous range of changed lines within a file. */
export interface LineRange {
  startLine: number;
  endLine: number;   // inclusive
}

/** Result of a line-range-aware git diff. */
export interface FileDiffWithLines {
  filePath: string;
  /** Parsed hunk ranges from @@ -old_start,count +new_start,count @@.
   *  Uses the new-side start/count to match graph node startLine/endLine.
   *  Empty array means "whole file changed" (fallback behavior). */
  changedLineRanges: LineRange[];
}

const FILE_HEADER_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0` output into structured file + line-range data.
 *
 * Parses `+++ b/path` for file headers and
 * `@@ -old_start[,old_count] +new_start[,new_count] @@` for hunk ranges.
 * Uses NEW-side line numbers (matching graph node startLine/endLine).
 *
 * Edge cases:
 * - Deletion-only hunks (newCount=0): skipped (lines no longer exist)
 * - Binary files (no hunks): file appears with empty changedLineRanges (triggers fallback)
 * - Malformed hunk headers: gracefully skipped
 * - Count omitted (single line): treated as count=1
 */
export function parseDiffOutputWithLines(rawOutput: string): FileDiffWithLines[] {
  if (!rawOutput) {
    return [];
  }

  const results: FileDiffWithLines[] = [];
  let current: FileDiffWithLines | null = null;

  for (const line of rawOutput.split('\n')) {
    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch) {
      // Flush previous file
      if (current) {
        results.push(current);
      }
      current = { filePath: fileMatch[1], changedLineRanges: [] };
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch && current) {
      const newStart = Number(hunkMatch[1]);
      const newCount = hunkMatch[2] != null ? Number(hunkMatch[2]) : 1;

      // Deletion-only hunk — lines no longer exist on the new side
      if (newCount === 0) {
        continue;
      }

      current.changedLineRanges.push({
        startLine: newStart,
        endLine: newStart + newCount - 1,
      });
    }
  }

  // Flush last file
  if (current) {
    results.push(current);
  }

  return results;
}