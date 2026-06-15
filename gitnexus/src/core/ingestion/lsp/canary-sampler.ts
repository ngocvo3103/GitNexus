/**
 * Canary Sampler — LSP read-only foundation, WI-#5 support.
 *
 * Produces a small set of `Sample` objects (URI + 0-indexed
 * line/character position) that the workspace-readiness probe
 * can use as canary `textDocument/definition` requests. A canary
 * is a position in a real source file where a cross-file identifier
 * (an import binding, an exported function name, etc.) is known to
 * exist — giving the language server a genuine question it CAN
 * answer once the workspace is resolved.
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
 * correct verdict for a language-less workspace.
 *
 * Language strategies (KD-5)
 * ──────────────────────────
 * `buildCanarySamples` is parameterized by a `LanguageCanaryStrategy`
 * (from `language-adapter.ts`). The default is `TS_CANARY_STRATEGY`,
 * which reproduces the original TypeScript-only behaviour exactly.
 * `JAVA_CANARY_STRATEGY` handles `.java` files using FQN-import
 * rightmost segments, class/interface/enum declarations, and method
 * signatures, while reusing the same comment-blanking pre-pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Sample } from './workspace-readiness-probe.js';
import type { LanguageCanaryStrategy } from './language-adapter.js';

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

  /**
   * Per-language sampling strategy (KD-5). Controls which files are
   * candidate files and how to extract an identifier position from
   * each file. Defaults to `TS_CANARY_STRATEGY` when omitted.
   *
   * Supply `adapter.canary` from a `LanguageAdapter` instance to
   * enable Java (or future language) sampling. When `adapter.canary`
   * is `null` (pre-WI-2 stub adapters), the default TS strategy is
   * used as a safe fallback.
   */
  strategy?: LanguageCanaryStrategy | null;
}

// ─── Private constants ───────────────────────────────────────────────

/** Stop the FS walk entirely once we've inspected this many files. */
const SCAN_CAP = 500;

/**
 * Directories whose contents are never useful canary sources.
 * Names are compared case-sensitively (Unix convention).
 *
 * Exported for direct membership assertions in unit tests (C3-17).
 */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.gitnexus',
  'build',
  'coverage',
  // Python-specific (I-7): canary walk + census SKIP_DIRS both carry this set
  '__pycache__',
  '.venv',
  'site-packages',
  'dist-packages',
  '.tox',
  'eggs',
  '.eggs',
  // Go-specific (WI-3): vendor directory contains third-party deps, not canary targets
  'vendor',
  // Rust/Maven-shared (WI-2/I-5): Cargo build output dir; also used by Maven as generated-sources
  // parent — excluding it prevents scanning compiled artifacts and keeps canary walks fast
  'target',
]);

// ─── TypeScript regex patterns (priority order) ───────────────────────

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

// ─── Java regex patterns (priority order) ─────────────────────────────

/**
 * Java Priority 1 — FQN import statement:
 *   import com.example.MyClass;
 *   import static com.example.Utils;
 *
 * Captures the rightmost segment (the simple name) after the last dot.
 * Applied to the safe text (comment-blanked) with `/m`.
 */
const RE_JAVA_IMPORT = /^import\s+(?:static\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)\s*;/m;

/**
 * Java Priority 2 — class, interface, or enum declaration:
 *   public class MyClass {
 *   public interface IFoo {
 *   enum Status {
 */
const RE_JAVA_TYPE_DECL =
  /^(?:(?:public|protected|private|abstract|final|strictfp)\s+)*(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/m;

/**
 * Java Priority 3 — method signature (access modifier + return type + name + '('):
 *   public void doSomething(
 *   protected int calculate(
 *   String buildKey(
 *
 * Identifier pattern: [A-Za-z_][A-Za-z0-9_]* (no dollar-sign — not valid in Java).
 * Captures the method name (last identifier before the open paren).
 */
const RE_JAVA_METHOD =
  /^[ \t]*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*[A-Za-z_][A-Za-z0-9_<>\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;

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
 * using the supplied `strategy` (default: `TS_CANARY_STRATEGY`).
 *
 * The strategy controls which files are candidates and how to
 * extract an identifier position from each file — all other walk
 * mechanics (DFS, lexicographic sort, SCAN_CAP, EXCLUDED_DIRS,
 * never-throw) are language-neutral and live here.
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
  // Resolve strategy: opts.strategy takes precedence; null falls back
  // to TS_CANARY_STRATEGY (safe default for pre-WI-2 stub adapters
  // whose canary field is null).
  const strategy: LanguageCanaryStrategy = opts?.strategy ?? TS_CANARY_STRATEGY;
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

      // lstatSync (not statSync): do not follow symlinks when deciding whether
      // to recurse into a directory. A symlinked directory pointing outside the
      // repo root would cause the walk to escape the workspace boundary and read
      // files at arbitrary paths via readFileSync below. By treating symlinked
      // directories as non-directories we skip them (the isDirectory() check
      // below returns false for a symlink). Symlinked files are also skipped
      // (isFile() returns false for a symlink via lstat), which is acceptable
      // for canary sampling — we only need a few real source files.
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue; // dangling symlink or permission error — skip
      }

      if (stat.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue;
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) continue;
      if (!strategy.isCandidateFile(entry)) continue;

      filesScanned += 1;

      let text: string;
      try {
        text = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue; // unreadable file — skip
      }

      const sample = strategy.tryExtractSample(fullPath, text);
      if (sample !== null) {
        samples.push(sample);
      }
    }
  }

  walk(repoPath);
  return samples;
}

// ─── Shared position utilities ────────────────────────────────────────

/**
 * Find the 0-indexed (line, character) of the first occurrence of
 * `name` in `lines`, starting the search from character offset
 * `searchFrom` in the flat text. The `searchFrom` argument anchors
 * the search to the match region returned by the regex so we don't
 * skip to a different occurrence of the identifier elsewhere in the
 * file.
 *
 * Returns `null` if the identifier cannot be located (shouldn't
 * happen for a regex match, but is defensive).
 *
 * `charClass` is the word-boundary continuation class:
 *   - TS uses [A-Za-z0-9_$] (default, includes dollar-sign)
 *   - Java uses [A-Za-z0-9_] (no dollar-sign)
 */
function findIdentifierPosition(
  lines: string[],
  name: string,
  searchFrom: number,
  charClass: RegExp = /[A-Za-z0-9_$]/,
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
    if (after !== undefined && charClass.test(after)) continue;
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

// ─── TypeScript canary strategy ───────────────────────────────────────

/**
 * `TS_CANARY_STRATEGY` — the original TypeScript strategy extracted
 * verbatim from the pre-WI-2 `isCandidateFile` / `tryExtractSample`
 * helpers. Behaviour is byte-identical to the prior implementation;
 * only the calling convention changed (strategy object vs. module-
 * private functions).
 *
 * Priority order (first match wins):
 *   1. Named or default import from a relative path
 *   2. `export (async) function NAME`
 *   3. `export const NAME` / `export class NAME`
 *   4. `function NAME(`
 */
export const TS_CANARY_STRATEGY: LanguageCanaryStrategy = {
  isCandidateFile(name: string): boolean {
    // Excluded: `*.d.ts` — the language server cannot navigate FROM
    // a `.d.ts` position to a useful cross-file definition.
    if (name.endsWith('.d.ts')) return false;
    return (
      name.endsWith('.ts') ||
      name.endsWith('.tsx') ||
      name.endsWith('.mts') ||
      name.endsWith('.cts')
    );
  },

  tryExtractSample(
    absolutePath: string,
    text: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null {
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
  },
};

// ─── Python regex patterns (priority order) ───────────────────────────

/**
 * Python Priority 1a — `def` or `async def` declaration (indented or not):
 *   def function_name(
 *   async def function_name(
 *       def method(self):     ← indented methods inside classes
 *
 * Leading `[ \t]*` allows indented defs (methods inside class bodies).
 * Captures the function name. pylsp resolves `textDocument/definition`
 * at the function name to a non-empty `Location[]` (the declaration site).
 */
const RE_PY_DEF = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;

/**
 * Python Priority 1b — `class` declaration (indented or not):
 *   class MyClass:
 *   class MyClass(Base):
 *       class Inner:     ← nested class
 */
const RE_PY_CLASS = /^[ \t]*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/m;

/**
 * Python Priority 2 — call-site (fallback when no def/class):
 *   some_func(x, y)
 *   result = some_func(arg)
 *
 * Captures the function name before the open-paren. Applied to safe text.
 * pylsp resolves definition requests at call sites reliably; useful when
 * a file has no top-level or method declarations. Priority 1 beats this
 * whenever a def/class is present.
 *
 * The optional `SIMPLE_IDENT =` prefix allows `result = some_func(arg)`
 * to capture `some_func`. The key fix vs. the original: the LHS arm uses
 * `[A-Za-z_][A-Za-z0-9_]*` (no dot) instead of `[A-Za-z_][A-Za-z0-9_.]*`.
 * This prevents `obj.method(` from being consumed as "the optional LHS" —
 * `obj` does not satisfy the non-dotted pattern followed by `=`, so the
 * optional group backtracks; then `([A-Za-z_][A-Za-z0-9_]*)` matches `obj`
 * but the next character is `.`, not `(`, so the overall match fails.
 * Expressions like `obj.method(` and `result = obj.method(arg)` are now
 * correctly rejected — method calls on a dotted receiver are lower-quality
 * canary targets than standalone function calls.
 */
const RE_PY_CALL =
  /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;

/**
 * Python Priority 3 (LAST-RESORT FALLBACK) — `import` statement:
 *   import os
 *   from os import path
 *   from . import utils
 *
 * pylsp returns [] for definition requests on import tokens (same
 * behaviour as jdtls on Java import declarations). Retained only so an
 * import-only file still yields a sample rather than being dropped.
 */
const RE_PY_IMPORT =
  /^(?:from\s+[\w.]+\s+import\s+([A-Za-z_][A-Za-z0-9_]*)|import\s+([A-Za-z_][A-Za-z0-9_]*))/m;

/**
 * Python identifier continuation class (same as Java — no dollar-sign).
 */
const PY_IDENT_AFTER = new RegExp('[A-Za-z0-9_]');

/**
 * Return a copy of `text` where every line that is wholly or partly
 * inside a Python `#` line comment or a triple-quoted string
 * (`"""` or `'''`) is replaced with a blank line of the same length.
 * Preserves all line numbers so `findIdentifierPosition` offsets stay
 * valid.
 *
 * Limitation: this is NOT a full Python lexer. Single-quoted strings
 * (non-triple) are not tracked; the `def`/`class` regexes are unlikely
 * to appear verbatim inside ordinary single-line strings. The multiple-
 * sample strategy provides a second chance if one file's sample is wrong.
 */
function blankPythonUnsafeLines(text: string): string {
  const lines = text.split('\n');
  const blanked: string[] = [];
  let tripleQuoteChar: string | null = null; // '"' or "'" when inside """...""" / '''...'''

  for (const line of lines) {
    // Inside a triple-quoted string — blank the line and check for end delimiter.
    if (tripleQuoteChar !== null) {
      const endDelimiter = tripleQuoteChar.repeat(3);
      const endIdx = line.indexOf(endDelimiter);
      if (endIdx !== -1) {
        // Closing delimiter found — remainder of the line after it is
        // normal code, but since the line straddles the string boundary
        // we blank the whole line for simplicity (same rationale as
        // `blankUnsafeLines` for block comments).
        tripleQuoteChar = null;
      }
      blanked.push(' '.repeat(line.length));
      continue;
    }

    // Scan the line for triple-quote openers and # comments.
    let safe = true;
    let i = 0;
    let safeUpTo = 0; // index at which the line became unsafe

    while (i < line.length) {
      // # comment — rest of line is a comment.
      if (line[i] === '#') {
        safe = false;
        safeUpTo = i;
        break;
      }
      // Triple-quote opener — """ or '''.
      if (
        (line[i] === '"' && line[i + 1] === '"' && line[i + 2] === '"') ||
        (line[i] === "'" && line[i + 1] === "'" && line[i + 2] === "'")
      ) {
        const q = line[i];
        const endDelimiter = q.repeat(3);
        // Look for the closing delimiter on the same line (skip past the opener).
        const afterOpen = i + 3;
        const closeIdx = line.indexOf(endDelimiter, afterOpen);
        if (closeIdx !== -1) {
          // Inline triple-quoted string (opens and closes on the same line).
          // Mark this line unsafe and skip past the closing delimiter.
          safe = false;
          safeUpTo = i;
          i = closeIdx + 3;
          continue;
        } else {
          // Multi-line triple-quoted string starts here.
          safe = false;
          safeUpTo = i;
          tripleQuoteChar = q;
          break;
        }
      }
      i++;
    }

    if (safe) {
      blanked.push(line);
    } else {
      // Preserve the prefix of the line that is safe (before the comment / string),
      // then blank the rest to preserve character offsets.
      blanked.push(line.slice(0, safeUpTo) + ' '.repeat(line.length - safeUpTo));
    }
  }

  return blanked.join('\n');
}

// ─── Python canary strategy ───────────────────────────────────────────

/**
 * `PYTHON_CANARY_STRATEGY` — canary sampling for `.py` source files.
 *
 * Uses `blankPythonUnsafeLines` to strip `#` comments and triple-quoted
 * strings before applying regexes. This prevents a `def`-shaped string
 * inside a docstring from yielding an unanswerable probe position.
 *
 * Priority order (first match wins):
 *   1. `def` (or `async def`) function/method name — most reliable;
 *      pylsp returns the declaration `Location` for a definition request
 *      at the function name token.
 *   2. `class` declaration name — equally reliable.
 *   3. `import` / `from ... import` — last-resort fallback; some imports
 *      (e.g. stdlib) may resolve to an external file:// URI, which is fine
 *      because the probe only tests that pylsp returns a non-empty result.
 *
 * `isCandidateFile`: accepts `.py` only; excludes nothing else (unlike
 * the TS strategy, `.py` has no "declaration-only" equivalent of `.d.ts`
 * that would produce unreliable probe positions).
 */
export const PYTHON_CANARY_STRATEGY: LanguageCanaryStrategy = {
  isCandidateFile(name: string): boolean {
    return name.endsWith('.py');
  },

  tryExtractSample(
    absolutePath: string,
    text: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null {
    const safeText = blankPythonUnsafeLines(text);
    const lines = text.split('\n');

    // Priority 1a: def / async def declaration (indented or not).
    // Most reliable pylsp probe target — resolves to the declaration's own site.
    const defMatch = RE_PY_DEF.exec(safeText);
    if (defMatch) {
      const name = defMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(defMatch[0]), PY_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 1b: class declaration.
    const classMatch = RE_PY_CLASS.exec(safeText);
    if (classMatch) {
      const name = classMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(classMatch[0]), PY_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 2: call-site — useful when a file has no top-level decls.
    // pylsp resolves definition requests at call sites (unlike import tokens).
    const callMatch = RE_PY_CALL.exec(safeText);
    if (callMatch) {
      const name = callMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(callMatch[0]), PY_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 3 (LAST-RESORT FALLBACK): import statement.
    // pylsp returns [] for definition requests on import tokens — retained
    // only so an import-only file still yields a sample.
    const importMatch = RE_PY_IMPORT.exec(safeText);
    if (importMatch) {
      const name = importMatch[1] ?? importMatch[2];
      if (name) {
        const pos = findIdentifierPosition(
          lines, name, safeText.indexOf(importMatch[0]), PY_IDENT_AFTER,
        );
        if (pos !== null) {
          return makeSample(absolutePath, pos.line, pos.character);
        }
      }
    }

    return null;
  },
};

// ─── Go regex patterns (priority order) ───────────────────────────────

/**
 * Go Priority 1a — function declaration:
 *   func FunctionName(
 *   func FunctionName[T any](
 *
 * Must NOT match method declarations (those have a receiver in parens
 * between `func` and the name). We reject a `(` immediately after `func\s+`
 * to avoid matching `func (r Receiver) Name(`. The look-ahead `[^(]` in the
 * identifier character class handles this: `[A-Za-z_]` cannot be `(`.
 * Captures the function name. Applied to safe (comment-blanked) text.
 */
const RE_GO_FUNC = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*[([{]/m;

/**
 * Go Priority 1b — type declaration:
 *   type MyStruct struct {
 *   type MyInterface interface {
 *   type Alias = OtherType
 *
 * Captures the type name after the `type` keyword.
 */
const RE_GO_TYPE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/m;

/**
 * Go Priority 1c — method declaration:
 *   func (r Receiver) MethodName(
 *   func (r *Receiver) MethodName(
 *
 * After `func`, a receiver `(...)` appears before the method name.
 * Pattern: `func` + whitespace + `(` + anything + `)` + whitespace +
 * identifier (the method name) + `(`.
 * Captures the method name.
 */
const RE_GO_METHOD = /^func\s+\([^)]*\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[([{]/m;

/**
 * Go Priority 2 — call-site identifier (fallback when no decl present):
 *   someFunc(arg)
 *   result := someFunc(arg)
 *
 * Captures a plain identifier immediately followed by `(`. Leading
 * optional `IDENT :=` or `IDENT =` assignment pattern is accepted so
 * `result := someFunc(arg)` captures `someFunc`. Method calls on a
 * dotted receiver (`obj.Method(`) are excluded: the identifier regex
 * `[A-Za-z_][A-Za-z0-9_]*` is followed by `\s*(`, not `\.`, so a
 * dotted expression backtracks and `obj` would be followed by `.`, not
 * `(`, causing the overall match to fail.
 *
 * I-19 guard: Go reserved keywords that can precede `(` without being
 * call-sites are excluded via a negative lookahead on the captured group.
 * Without this, `import (` (grouped import block) would match because
 * `import` is an identifier followed by `(`, causing an import-only file
 * to yield a non-null sample from RE_GO_CALL — violating I-19, which
 * requires import-only files to return null. The negative lookahead blocks
 * the full set of Go statement-opening keywords that can syntactically
 * appear before `(` but are never user-defined call-site identifiers.
 *
 * Applied to safe (comment-blanked) text.
 */
const GO_RESERVED_WORDS_RE =
  /^(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/;
const RE_GO_CALL =
  /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*\s*:?=\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;

/**
 * Go Priority 3 (LAST-RESORT FALLBACK) — import declaration:
 *   import "fmt"
 *   import alias "pkg/path"
 *   import ( "fmt" ) — multi-import block, captures first package name
 *
 * gopls returns [] for definition requests on import path tokens (same
 * behaviour as jdtls / pylsp on import declarations). Retained only so
 * an import-only file still yields a sample rather than being dropped.
 *
 * Captures the last path segment (the basename of the import path, which
 * is the usable identifier token). Example: `"net/http"` → `http`.
 */
const RE_GO_IMPORT =
  /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"[^"]*\/([A-Za-z_][A-Za-z0-9_]*)"/m;

/**
 * Go identifier word-boundary continuation class.
 * Go identifiers do not include the dollar-sign (unlike JavaScript).
 */
const GO_IDENT_AFTER = new RegExp('[A-Za-z0-9_]');

// ─── Go canary strategy ───────────────────────────────────────────────

/**
 * `GO_CANARY_STRATEGY` — canary sampling for `.go` source files (WI-3).
 *
 * Reuses the same comment-blanking pre-pass (blankUnsafeLines) as
 * the TS and Java strategies. Go uses // line comments and slash-star
 * block comments — identical to C-style — and has NO template-literal
 * equivalents (Go raw string literals use backticks, but they cannot
 * contain a verbatim backtick, so they cannot produce false-positive
 * import/func matches inside them in practice). The backtick-tracking
 * inside blankUnsafeLines would blank raw string content, which is
 * acceptable.
 *
 * `isCandidateFile`: accepts `.go` files EXCEPT files ending in
 * `_test.go` — test files use testing-package identifiers that gopls
 * may not resolve in a non-test build context.
 *
 * Priority order (first match wins):
 *   1. `func Name(` (function decl) OR `type Name ` (type decl) OR
 *      `func (r Receiver) Name(` (method decl) — most reliable gopls
 *      probe targets; gopls returns the declaration `Location` for a
 *      definition request at the name token.
 *   2. Call-site identifier — useful when a file has no top-level
 *      declarations (rare in Go, but possible for generated/stub files).
 *   3. Import path segment (LAST-RESORT FALLBACK) — gopls returns []
 *      for definition requests at import tokens; retained only so a
 *      pathological import-only file still yields a sample rather than
 *      being dropped from the canary set entirely.
 *
 * Invariant: `GO_IDENT_AFTER` has no `$` (Go identifiers exclude it).
 */
export const GO_CANARY_STRATEGY: LanguageCanaryStrategy = {
  isCandidateFile(name: string): boolean {
    // Exclude _test.go files: gopls may not resolve testing-package
    // symbols in a non-test build context.
    if (name.endsWith('_test.go')) return false;
    return name.endsWith('.go');
  },

  tryExtractSample(
    absolutePath: string,
    text: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null {
    // Apply the comment-blanking pre-pass so regexes cannot match inside
    // // line comments or /* … */ block comments. The safe text has the
    // same line count and character offsets as `text`; only unsafe lines
    // are blanked. `blankUnsafeLines` is shared with TS and Java —
    // reuse is safe because Go uses identical C-style comment syntax.
    const safeText = blankUnsafeLines(text);
    const lines = text.split('\n');

    // Priority 1a: method declaration — checked BEFORE plain func so
    // `func (r Receiver) Name(` is captured as a method (not confused
    // with a func starting at the `N` after the receiver block).
    const methodMatch = RE_GO_METHOD.exec(safeText);
    if (methodMatch) {
      const name = methodMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(methodMatch[0]), GO_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 1b: function declaration.
    const funcMatch = RE_GO_FUNC.exec(safeText);
    if (funcMatch) {
      const name = funcMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(funcMatch[0]), GO_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 1c: type declaration.
    const typeMatch = RE_GO_TYPE.exec(safeText);
    if (typeMatch) {
      const name = typeMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(typeMatch[0]), GO_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 2: call-site identifier.
    // I-19 guard: skip the match if the captured identifier is a Go reserved
    // keyword (e.g. `import` in a grouped import block, `if`, `for`, etc.).
    // RE_GO_CALL would otherwise match `import (` as a call-site because
    // `import` satisfies `[A-Za-z_][A-Za-z0-9_]*` and is followed by `(`.
    const callMatch = RE_GO_CALL.exec(safeText);
    if (callMatch && !GO_RESERVED_WORDS_RE.test(callMatch[1])) {
      const name = callMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(callMatch[0]), GO_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // I-19: import-only / package-clause-only .go files MUST return null.
    // The former Priority 3 RE_GO_IMPORT fallback fired on slashed import paths
    // (e.g. `import "net/http"`) and returned a non-null sample, but gopls
    // returns [] for definition requests on import tokens — poisoning the canary
    // backstop. Removed to comply with I-19: files with no func/type/call-site
    // correctly yield no sample.

    return null;
  },
};

// ─── Java canary strategy ─────────────────────────────────────────────

/**
 * Java identifier word-boundary continuation class.
 * Java identifiers do not include the dollar-sign (unlike JavaScript).
 */
const JAVA_IDENT_AFTER = new RegExp('[A-Za-z0-9_]');

/**
 * `JAVA_CANARY_STRATEGY` — canary sampling for `.java` source files.
 *
 * Reuses the same comment-blanking pre-pass (`blankUnsafeLines`) as
 * the TS strategy. The backtick-tracking in that function is a
 * harmless no-op for Java source (backtick is not a string delimiter
 * in Java). Both line comments (//) and block comments (slash-star)
 * are handled correctly by the shared pre-pass.
 *
 * Identifier pattern: [A-Za-z_][A-Za-z0-9_]* (no dollar-sign — not valid
 * in standard Java identifiers used as canary targets).
 *
 * Priority order (first match wins):
 *   1. class / interface / enum NAME declaration
 *   2. Method signature name (first identifier before open-paren)
 *   3. FQN import rightmost segment (import com.example.MyClass → MyClass)
 *      — LAST-RESORT FALLBACK ONLY.
 *
 * Why the type declaration leads (and NOT the import) — #159 root cause #2:
 *   The canary probe issues `textDocument/definition` at the chosen
 *   position and treats a non-empty `Location[]` as "the workspace is
 *   resolvable". jdtls (unlike `typescript-language-server`) returns an
 *   EMPTY array for a definition request on the type token *inside an
 *   `import` declaration* — the import is a reference declaration, not a
 *   navigable usage site, so jdtls resolves nothing there. The pre-fix
 *   order put the import FIRST, so on any Java file with imports (i.e.
 *   essentially all of them) every canary sample landed on an
 *   unresolvable position → the probe reported 0/N → the whole Mode-A
 *   funnel refused every candidate (`server <unknown>`), even though
 *   jdtls was up and answering definitions at real usage sites.
 *
 *   Measured on tcbs-bond-trading: the type-declaration name resolves
 *   8/8 sampled files (jdtls returns the declaration's own Location — a
 *   non-empty array, which is exactly the "server is answering" signal
 *   the probe needs); the import position resolved 0/N whenever it
 *   actually matched an import line. The import priority is therefore
 *   demoted to a last-resort fallback for the pathological file that has
 *   imports but neither a type declaration nor a method signature.
 *
 * Invariant: identifiers inside line comments or block comments are
 * never yielded — the blanking pre-pass replaces those lines with
 * spaces before any regex is applied.
 */
export const JAVA_CANARY_STRATEGY: LanguageCanaryStrategy = {
  isCandidateFile(name: string): boolean {
    return name.endsWith('.java');
  },

  tryExtractSample(
    absolutePath: string,
    text: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null {
    // Java has no backtick template literals; reuse the comment-blanking
    // pre-pass (block comments + line comments). The backtick tracking
    // inside blankUnsafeLines is a harmless no-op for Java source.
    const safeText = blankUnsafeLines(text);
    const lines = text.split('\n');

    // Priority 1: class / interface / enum declaration.
    // jdtls resolves a definition request at the declaration name to a
    // non-empty Location[] (the declaration's own site) — the reliable
    // "workspace is resolvable" signal the probe gates on. See the
    // strategy docstring for the #159 root-cause-#2 rationale.
    const typeMatch = RE_JAVA_TYPE_DECL.exec(safeText);
    if (typeMatch) {
      const name = typeMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(typeMatch[0]), JAVA_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 2: method signature.
    const methodMatch = RE_JAVA_METHOD.exec(safeText);
    if (methodMatch) {
      const name = methodMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(methodMatch[0]), JAVA_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 3 (LAST-RESORT FALLBACK): FQN import rightmost segment.
    // jdtls returns [] for a definition request on the import token, so
    // this position is a POOR probe target — it is retained only so a
    // pathological file with imports but no type/method declaration still
    // yields *a* sample rather than dropping out of the canary set
    // entirely. A file reaching this branch is vanishingly rare in real
    // Java sources (every compilation unit declares a top-level type).
    const importMatch = RE_JAVA_IMPORT.exec(safeText);
    if (importMatch) {
      const name = importMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(importMatch[0]), JAVA_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    return null;
  },
};


// ─── Rust regex patterns (priority order) ─────────────────────────────

/**
 * Rust Priority 1 — `fn` declaration (free function or impl method):
 *   fn function_name(
 *   fn function_name<T>(
 *   pub fn function_name(
 *   async fn function_name(
 *
 * Captures the function name after `fn`. The leading `^[ \t]*` allows
 * indented functions inside `impl` blocks (impl methods are priority 1
 * because the spec treats them identically to free functions: the most
 * reliable rust-analyzer probe target is any named `fn` declaration).
 * Applied to safe (comment-blanked) text.
 */
const RE_RUST_FN =
  /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/m;

/**
 * Rust Priority 2 — struct, enum, or trait declaration:
 *   struct Config {
 *   enum Kind {
 *   trait Foo {
 *   pub struct Config<T> {
 *
 * Captures the type/trait name. Applied after all `fn` checks so that a
 * file with both `fn` and `struct` prioritises the `fn` (more reliable
 * rust-analyzer resolution target). Applied to safe text.
 */
const RE_RUST_TYPE_DECL =
  /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[{<(;]/m;

/**
 * Rust Priority 3 — call-site identifier (fallback when no fn/struct/enum/trait):
 *   foo.bar()           → captures 'bar'  (method call on dotted receiver)
 *   process(data)       → captures 'process'  (free function call)
 *   result = compute()  → captures 'compute'
 *
 * Matches any identifier immediately followed by `(`, searching left-to-right
 * so dotted method calls (`foo.bar()`) yield the method name (`bar`), not the
 * receiver (`foo`), because the first `(` after an identifier is at `bar(`.
 *
 * Unlike the Go strategy, Rust method calls (`receiver.method()`) ARE useful
 * rust-analyzer probe targets (the spec explicitly includes `foo.bar()` in
 * WI2-12). No dotted-receiver exclusion is applied here.
 *
 * `use` statements do NOT produce a match: `use std::io;` has no `(` after
 * an identifier. Macro invocations (`println!(…)`) are NOT matched because
 * `!` separates the macro name from `(`, breaking the `IDENT\s*(` pattern.
 *
 * Applied to safe (comment-blanked) text.
 */
const RE_RUST_CALL =
  /([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;

/**
 * Rust identifier word-boundary continuation class.
 * Rust identifiers do NOT include the dollar-sign (I-10, challenge #10).
 * This is its own named constant — NOT aliased from `GO_IDENT_AFTER` —
 * to avoid hidden cross-language coupling (WI-2 spec: "no alias to GO_IDENT_AFTER").
 */
export const RUST_IDENT_AFTER = new RegExp('[A-Za-z0-9_]');

/**
 * Rust reserved identifiers that RE_RUST_CALL would match but are NOT
 * user-defined call-site identifiers. These are Rust keywords that can
 * syntactically appear immediately before `(` without being user-defined
 * function calls (e.g. `if (cond)`, `while (cond)`, `for (...)`,
 * `fn (...)` anonymous closures).
 */
const RUST_RESERVED_WORDS_RE =
  /^(?:if|while|for|loop|match|fn|mod|use|let|const|static|type|trait|struct|enum|impl|pub|async|await|move|unsafe|extern|return|where)\b/;

// ─── Rust canary strategy ─────────────────────────────────────────────

/**
 * `RUST_CANARY_STRATEGY` — canary sampling for `.rs` source files (WI-2).
 *
 * Reuses blankUnsafeLines() (C-style // and slash-star block comments are
 * identical to Rust's comment syntax). Rust raw string literals (r"…" and
 * r#"…"#) are NOT handled by blankUnsafeLines — this is a known limitation
 * (same as GO_CANARY_STRATEGY documents backtick strings).
 * The multi-sample strategy (maxFiles > 1) mitigates the rare case where
 * a raw-string-literal-shaped false match poisons one sample; in practice
 * collision probability is near-zero (WI-2 spec R2-8(3) ledger option 3).
 *
 * NOTE on `use` declarations: `textDocument/definition` on a `use std`
 * token empirically DOES resolve (rust-analyzer returns count=1). However,
 * use-statement positions are unreliable canary anchors: they are module-
 * path tokens whose resolution depends on workspace indexing state. The
 * sampler intentionally excludes them (I-3 analogue) in favour of
 * declaration and call-site positions that are universally reliable.
 *
 * Priority order (first match wins):
 *   1. `fn` declaration (free function OR impl method) — most reliable;
 *      rust-analyzer returns the declaration `Location` for a definition
 *      request at the function name.
 *   2. `struct` / `enum` / `trait` declaration — equally reliable.
 *   3. Call-site identifier (fallback) — method calls (`foo.bar()`) and
 *      free-function calls (`process(data)`) are both acceptable targets.
 *      Macro calls (`println!(\u2026)`) are excluded (no `(` immediately after
 *      the macro name token).
 *   → null — use-only or empty files yield no sample (I-3 analogue).
 *
 * `isCandidateFile`: accepts `.rs` files only.
 */
export const RUST_CANARY_STRATEGY: LanguageCanaryStrategy = {
  isCandidateFile(name: string): boolean {
    return name.endsWith('.rs');
  },

  tryExtractSample(
    absolutePath: string,
    text: string,
  ): { textDocument: { uri: string }; position: { line: number; character: number } } | null {
    // Apply the comment-blanking pre-pass. Rust uses C-style comments
    // (// and /* */), identical to the TS/Java/Go pre-pass — reuse as-is.
    const safeText = blankUnsafeLines(text);
    const lines = text.split('\n');

    // Priority 1: fn declaration (free function or impl method).
    // rust-analyzer resolves a definition request at the fn name to a
    // non-empty Location[] — the most reliable "workspace is ready" signal.
    const fnMatch = RE_RUST_FN.exec(safeText);
    if (fnMatch) {
      const name = fnMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(fnMatch[0]), RUST_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 2: struct / enum / trait declaration.
    const typeMatch = RE_RUST_TYPE_DECL.exec(safeText);
    if (typeMatch) {
      const name = typeMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(typeMatch[0]), RUST_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // Priority 3: call-site identifier.
    // Keyword guard: skip if the captured identifier is a Rust reserved word
    // (e.g. `if`, `while`, `for`) that can syntactically appear before `(`
    // without being a user-defined call-site.
    const callMatch = RE_RUST_CALL.exec(safeText);
    if (callMatch && !RUST_RESERVED_WORDS_RE.test(callMatch[1])) {
      const name = callMatch[1];
      const pos = findIdentifierPosition(
        lines, name, safeText.indexOf(callMatch[0]), RUST_IDENT_AFTER,
      );
      if (pos !== null) {
        return makeSample(absolutePath, pos.line, pos.character);
      }
    }

    // use-only / empty files yield no sample (I-3 analogue — see strategy docstring).
    return null;
  },
};
