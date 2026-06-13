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
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.gitnexus',
  'build',
  'coverage',
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
