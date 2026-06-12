/**
 * Canary Sampler — LSP read-only foundation, WI-#5 support.
 *
 * Produces a small set of `Sample` objects (URI + 0-indexed
 * line/character position) that the workspace-readiness probe
 * can use as canary `textDocument/definition` requests. A canary
 * is a position in a real TypeScript source file where a cross-
 * file identifier (an import binding, an exported function name,
 * etc.) is known to exist — giving the language server a genuine
 * question it CAN answer once the workspace is resolved.
 *
 * Why FS-based, not graph-based
 * ──────────────────────────────
 * There are two call sites that need canary samples:
 *
 *   1. `gitnexus lsp doctor` — runs BEFORE `analyze`, so the
 *      graph index does not yet exist. Querying the graph is
 *      not an option.
 *   2. `gitnexus analyze --lsp` (Mode A, pipeline.ts) — runs
 *      MID-index, interleaved with graph writes. The graph is
 *      partially built and querying it would introduce a
 *      time-of-check/time-of-use race on partial state.
 *
 * One FS-based policy for both call sites is simpler, cheaper,
 * and produces better canaries than an ad-hoc package.json trick:
 * a named-import position is a CROSS-FILE resolution request,
 * the strongest possible signal that the language server has
 * actually resolved the module graph.
 *
 * Trust model
 * ───────────
 * The sampler is intentionally minimal and read-only:
 *   - Pure FS + path operations only. No LspClient import, no
 *     graph access.
 *   - Never throws into the caller. Any unreadable file or
 *     directory is silently skipped (KD-3 analogue).
 *   - Deterministic: sort entries lexicographically at every
 *     directory level so two calls on the same tree return the
 *     same samples in the same order.
 *   - Hard cap: scanning stops after 500 files or `maxFiles`
 *     collected samples (whichever first) so the sampler is
 *     O(maxFiles) on large repos.
 *
 * Output: `Sample[]` in `workspace-readiness-probe.ts` shape —
 * `{ textDocument: { uri }, position: { line, character } }` with
 * 0-indexed line/character per LSP convention.
 *
 * When no eligible files exist (e.g., a TS-less repo), the
 * function returns `[]`. The probe then emits
 * `ready:false, reason:'no samples provided'` — which is the
 * correct verdict for a TS-less workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Sample } from './workspace-readiness-probe.js';

// ─── Public types ────────────────────────────────────────────────────

export interface CanaryOptions {
  /**
   * Maximum number of canary samples to return. The sampler stops
   * collecting as soon as it has this many. Default: 3.
   *
   * Setting to 0 is valid (returns []). Setting to a large value
   * causes the scan to run until the 500-file guard fires.
   */
  maxFiles?: number;
}

// ─── Private constants ───────────────────────────────────────────────

/** Stop the FS walk entirely once we've inspected this many files. */
const SCAN_CAP = 500;

/**
 * Directories whose contents are never useful canary sources.
 * Names are compared case-sensitively (Unix convention).
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.gitnexus',
  'build',
  'coverage',
]);

// ─── Regex patterns (priority order) ─────────────────────────────────

/**
 * Priority 1 — named import from a relative path:
 *   import { NAME, ... } from './x'
 *   import { NAME, ... } from '../y'
 *
 * Captures the import keyword line so we can find the column of
 * the first identifier. We match `{ NAME` and capture `NAME`.
 *
 * NOTE: all five regexes use `/m` and are applied only to the
 * "safe text" produced by `blankUnsafeLines()`, which blanks out
 * lines inside template literals and block comments so an
 * import-shaped string inside a backtick template or `/* … *\/`
 * comment cannot yield an unanswerable probe position. This is not
 * a full lexer; nested template literal edge cases are tolerated —
 * multiple samples from different files mitigate the rare miss.
 */
const RE_NAMED_IMPORT = /^import\s*\{([^}]+)\}\s*from\s*['"]\.\.?[/\\]/m;

/**
 * Priority 1 (alt) — default import from a relative path:
 *   import NAME from './x'
 */
const RE_DEFAULT_IMPORT = /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*['"]\.\.?[/\\]/m;

/**
 * Priority 2 — exported async/non-async function:
 *   export function NAME(
 *   export async function NAME(
 */
const RE_EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/m;

/**
 * Priority 3 — export const / export class:
 *   export const NAME
 *   export class NAME
 */
const RE_EXPORT_CONST_CLASS =
  /^export\s+(?:const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/m;

/**
 * Priority 4 — plain function declaration:
 *   function NAME(
 */
const RE_FUNCTION = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/m;

// ─── Line-state pre-pass ─────────────────────────────────────────────

/**
 * Return a copy of `text` where every line that is wholly or partly
 * inside a template literal (backtick) or a block comment (`/* … *​/`)
 * is replaced with a blank line of the same length. The blank-out
 * preserves all line numbers so `findIdentifierPosition` offsets stay
 * valid.
 *
 * Limitation: this is NOT a full lexer. Nested template literals
 * (ES2015+) and backtick characters inside string literals / regexes
 * are not handled perfectly. In practice the regexes need to avoid
 * only the obvious `import { … } from '…'` shapes that appear verbatim
 * inside template literals or multi-line block comments; the multiple-
 * sample strategy in `buildCanarySamples` provides a second chance if
 * one file's sample is wrong.
 */
function blankUnsafeLines(text: string): string {
  const lines = text.split('\n');
  const blanked: string[] = [];
  let inBlockComment = false;
  let inTemplateLiteral = false;

  for (const line of lines) {
    let safe = !inBlockComment && !inTemplateLiteral;

    // Track block comment boundaries within the line.
    // We scan character by character to toggle state.
    let i = 0;
    while (i < line.length) {
      if (inBlockComment) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          i += 2;
          // Rest of the line after `*/` may be normal code, but since
          // the line is already marked unsafe we still blank it — the
          // identifier position would be hard to use reliably.
          continue;
        }
        i++;
      } else if (inTemplateLiteral) {
        if (line[i] === '`') {
          inTemplateLiteral = false;
        } else if (line[i] === '\\') {
          i++; // skip escaped char
        }
        i++;
      } else {
        // Normal code.
        if (line[i] === '/' && line[i + 1] === '*') {
          inBlockComment = true;
          safe = false; // the rest of this line is unsafe
          i += 2;
          continue;
        }
        if (line[i] === '/' && line[i + 1] === '/') {
          // Line comment — rest of line is a comment; stop scanning.
          break;
        }
        if (line[i] === '`') {
          inTemplateLiteral = true;
          safe = false; // the rest of this line is unsafe
        }
        i++;
      }
    }

    if (safe) {
      blanked.push(line);
    } else {
      // Replace the entire line content with spaces to preserve length
      // and therefore all character offsets in `findIdentifierPosition`.
      blanked.push(' '.repeat(line.length));
    }
  }

  return blanked.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a list of canary `Sample` objects by walking `repoPath`
 * for `.ts`, `.tsx`, `.mts`, and `.cts` files (excluding `.d.ts`).
 *
 * For each candidate file, the text is scanned once for the FIRST
 * identifier whose position makes a strong canary definition
 * request, in priority order:
 *
 *   1. Named or default import from a relative path (cross-file
 *      resolution — the strongest signal the module graph works).
 *   2. `export (async) function NAME`
 *   3. `export const NAME` / `export class NAME`
 *   4. `function NAME(`
 *
 * The position emitted is the 0-indexed (line, character) of the
 * identifier's first character, following the LSP convention used
 * throughout this codebase.
 *
 * The walk is depth-first, entries sorted lexicographically at
 * every directory level for determinism. Scanning stops after
 * `SCAN_CAP` (500) files inspected or `maxFiles` (default 3)
 * samples collected, whichever comes first.
 *
 * Never throws: any unreadable file or directory is silently
 * skipped.
 */
export async function buildCanarySamples(
  repoPath: string,
  opts?: CanaryOptions,
): Promise<Sample[]> {
  const maxFiles = opts?.maxFiles ?? 3;
  if (maxFiles <= 0) return [];

  const samples: Sample[] = [];
  let filesScanned = 0;

  /**
   * Recursive DFS walker. Returns early once both caps are met.
   * Kept as a nested function so it closes over `samples` and
   * `filesScanned` without needing to thread them as parameters.
   */
  function walk(dir: string): void {
    if (samples.length >= maxFiles) return;
    if (filesScanned >= SCAN_CAP) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // unreadable directory — skip
    }

    // Lexicographic sort at every level for determinism.
    entries.sort();

    for (const entry of entries) {
      if (samples.length >= maxFiles) return;
      if (filesScanned >= SCAN_CAP) return;

      const fullPath = path.join(dir, entry);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // dangling symlink or permission error — skip
      }

      if (stat.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue;
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) continue;
      if (!isCandidateFile(entry)) continue;

      filesScanned += 1;

      const sample = tryExtractSample(fullPath);
      if (sample !== null) {
        samples.push(sample);
      }
    }
  }

  walk(repoPath);
  return samples;
}

// ─── Private helpers ─────────────────────────────────────────────────

/**
 * Return true when the filename qualifies as a TypeScript source
 * file. Excluded: `*.d.ts` (declaration files — the language
 * server cannot navigate FROM a `.d.ts` position to a useful
 * cross-file definition).
 */
function isCandidateFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  return (
    name.endsWith('.ts') ||
    name.endsWith('.tsx') ||
    name.endsWith('.mts') ||
    name.endsWith('.cts')
  );
}

/**
 * Attempt to extract a `Sample` from the given file. Returns
 * `null` if the file is unreadable or contains no eligible
 * identifier.
 *
 * Priority order (first match wins):
 *   1. Named import identifier from a relative path
 *   2. Default import identifier from a relative path
 *   3. Exported function name
 *   4. Exported const/class name
 *   5. Plain function name
 *
 * Position is 0-indexed (line, character) per LSP convention.
 */
function tryExtractSample(absolutePath: string): Sample | null {
  let text: string;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');

  // Apply the line-state pre-pass so regexes cannot match inside
  // template literals or block comments (F7 fix). The safe text has
  // the same line count and character offsets as `text`; only unsafe
  // lines are blanked, so `findIdentifierPosition` still maps to the
  // correct (line, character) in the original file.
  const safeText = blankUnsafeLines(text);

  // Priority 1a: named import from relative path
  const namedMatch = RE_NAMED_IMPORT.exec(safeText);
  if (namedMatch) {
    const firstName = namedMatch[1].split(',')[0].trim();
    if (firstName) {
      const pos = findIdentifierPosition(lines, firstName, safeText.indexOf(namedMatch[0]));
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }
  }

  // Priority 1b: default import from relative path
  const defaultMatch = RE_DEFAULT_IMPORT.exec(safeText);
  if (defaultMatch) {
    const name = defaultMatch[1];
    const lineOffset = safeText.indexOf(defaultMatch[0]);
    const pos = findIdentifierPosition(lines, name, lineOffset);
    if (pos !== null) {
      return makeSample(absolutePath, pos.line, pos.character);
    }
  }

  // Priority 2: export (async) function
  const exportFnMatch = RE_EXPORT_FUNCTION.exec(safeText);
  if (exportFnMatch) {
    const name = exportFnMatch[1];
    const lineOffset = safeText.indexOf(exportFnMatch[0]);
    const pos = findIdentifierPosition(lines, name, lineOffset);
    if (pos !== null) {
      return makeSample(absolutePath, pos.line, pos.character);
    }
  }

  // Priority 3: export const / export class
  const exportCCMatch = RE_EXPORT_CONST_CLASS.exec(safeText);
  if (exportCCMatch) {
    const name = exportCCMatch[1];
    const lineOffset = safeText.indexOf(exportCCMatch[0]);
    const pos = findIdentifierPosition(lines, name, lineOffset);
    if (pos !== null) {
      return makeSample(absolutePath, pos.line, pos.character);
    }
  }

  // Priority 4: plain function
  const fnMatch = RE_FUNCTION.exec(safeText);
  if (fnMatch) {
    const name = fnMatch[1];
    const lineOffset = safeText.indexOf(fnMatch[0]);
    const pos = findIdentifierPosition(lines, name, lineOffset);
    if (pos !== null) {
      return makeSample(absolutePath, pos.line, pos.character);
    }
  }

  return null;
}

/**
 * Find the 0-indexed (line, character) of the first occurrence of
 * `name` in the text, starting the search from character offset
 * `searchFrom`. The `searchFrom` argument anchors the search to
 * the match region returned by the regex so we don't skip to a
 * different occurrence of the identifier elsewhere in the file.
 *
 * Returns `null` if the identifier cannot be located (shouldn't
 * happen for a regex match, but is defensive).
 */
function findIdentifierPosition(
  lines: string[],
  name: string,
  searchFrom: number,
): { line: number; character: number } | null {
  // Convert the flat character offset to (line, charWithinLine)
  // then search forward from that point for `name`.
  let charCount = 0;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1; // +1 for '\n'
    if (charCount + lineLen > searchFrom) {
      startLine = i;
      break;
    }
    charCount += lineLen;
  }

  // Scan from startLine forward looking for the first line that
  // contains `name` as a word-boundary token.
  for (let i = startLine; i < lines.length; i++) {
    const idx = lines[i].indexOf(name);
    if (idx === -1) continue;
    // Verify it's actually the identifier (not a prefix of a longer word).
    const after = lines[i][idx + name.length];
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) continue;
    return { line: i, character: idx };
  }

  return null;
}

/**
 * Construct a `Sample` from an absolute path and 0-indexed
 * line/character position.
 */
function makeSample(absolutePath: string, line: number, character: number): Sample {
  return {
    textDocument: { uri: 'file://' + absolutePath },
    position: { line, character },
  };
}
