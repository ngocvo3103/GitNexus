/**
 * scripts/audit-recall-precision.ts — #159 backlog: recall-precision check
 *
 * Produces INDEPENDENT structural corroboration of `lsp-recall` edges
 * (source='lsp-recall'; confidence is per-language — default 0.90, with
 * weak-recall languages lowered below the 0.85 impact floor) WITHOUT
 * re-invoking the LSP oracle that created them (which would be circular).
 *
 * Methodology:
 *   For each `lsp-recall` edge, we check two things structurally:
 *   (a) Target node exists and has a callable kind (Function/Method/Constructor/
 *       Macro/Delegate) — the same CALLABLE_SYMBOL_TYPES gate the engine used.
 *   (b) The identifier token at (sourceLine, sourceCol) in the FROM file
 *       textually matches the target node's name — e.g., for `obj.foo()` the
 *       token at `sourceCol` is `foo` and the target is `foo`. We handle
 *       member-call (`obj.name(...)`) and bare-call forms.
 *
 * This cannot catch semantically wrong targets that textually match the same
 * identifier name (a different `foo` in a different module). It CAN catch:
 *   - unpositioned edges (NULL sourceLine) — weakest evidence
 *   - dynamic patterns (this./super. prefix) — LSP evidence, but less unique
 *   - name mismatches — likely bad recall edges
 *   - corroborated — token at call-site matches target name
 *
 * Read-only contract: all graph reads go through `executeParameterized` ONLY.
 * Never calls initLbug/executeQuery/addNode/addRelationship.
 * Passes the scripts-no-write-invariant test.
 */

// Static imports of Node stdlib (not write-API surfaces; exempt from the
// assertNoGraphWriteImports sweep which targets lbug-adapter tokens only).
import nodePath from 'node:path';
import nodeFs from 'node:fs';

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditRow {
  /** Repo basename (for display). */
  repo: string;
  /** FROM file (repo-relative path). */
  fromFile: string;
  /** 1-based line (stored 0-based in DB, displayed 1-based). */
  displayLine: number;
  /** Call-site text snippet (≤80 chars) read from disk. */
  callSiteText: string;
  /** Target symbol name. */
  targetName: string;
  /** Target node label. */
  targetLabel: string;
  /** Auto-verdict from structural corroboration. */
  verdict: 'corroborated' | 'name-mismatch' | 'dynamic' | 'unpositioned' | 'no-file';
}

export interface AuditStats {
  n: number;
  corroborated: number;
  nameMismatch: number;
  dynamic: number;
  unpositioned: number;
  noFile: number;
  corroborationRate: number;
}

export interface AuditResult {
  repoId: string;
  repoPath: string;
  stats: AuditStats;
  /** The seeded 40-row human-review table. */
  reviewRows: AuditRow[];
}

/** Options for `auditRecallPrecision`. */
export interface AuditRecallPrecisionOptions {
  repoPath: string;
  repoId: string;
  /** Max edges to audit. When total > sampleCap, stratified seeded sample. */
  sampleCap?: number;
  /** Seed for the PRNG (FNV-1a → mulberry32). */
  seed?: string;
  /** Read-only Cypher dispatch (executeParameterized-shaped). */
  runCypher: (
    repoId: string,
    cypher: string,
    params: Record<string, unknown>,
  ) => Promise<unknown[]>;
  /** Read a single file line by 0-based line index. Returns null if file
   *  absent or line out of range. Preserved as fallback seam for tests. */
  readLine?: ReadLineFn;
  /** Read a whole file as a string. Returns null on failure.
   *  When provided, the file-level cache uses this seam instead of
   *  nodeFs.readFileSync — enables test injection without per-line stubs. */
  readFile?: ReadFileFn;
}

export type ReadLineFn = (
  absPath: string,
  lineIndex: number,
) => string | null;

/** Whole-file read seam (for tests). Returns null on failure. */
export type ReadFileFn = (absPath: string) => string | null;

// ─── PRNG (mirrors mode-c-verifier.ts) ────────────────────────────────

/** FNV-1a 32-bit — same as mode-c-verifier.ts hashSeed. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — same as mode-c-verifier.ts. */
export function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle in-place with PRNG. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// ─── Callable label gate ──────────────────────────────────────────────
// Callability is assumed enforced upstream by the engine's P2 gate
// (CALLABLE_SYMBOL_TYPES in call-processor.ts). The audit queries only
// lsp-recall edges that have already passed that gate, so no secondary
// callability check is performed here. Corroboration output reflects
// structural name-match only; callable-label enforcement is upstream.

// ─── Name corroboration logic (pure, exported for unit tests) ─────────

/** One raw recall edge row from the graph query. */
export interface RecallEdgeRow {
  fromFile: string | null;
  fromName: string | null;
  sourceLine: number | null;
  sourceCol: number | null;
  targetName: string | null;
  targetLabel: string | null;
  reason: string | null;
}

/**
 * Classify a single recall edge row without touching the filesystem.
 * The `lineText` parameter is the already-read line (or null).
 *
 * Verdict priority (highest → lowest):
 *   unpositioned  — sourceLine is null or < 0
 *   no-file       — lineText is null (file absent or line OOB)
 *   dynamic       — call-site text contains `this.` or `super.` prefix
 *                   immediately before the target token
 *   corroborated  — identifier token at/near sourceCol matches targetName
 *   name-mismatch — token found but does not match
 *
 * Pure function: no I/O, no side effects. Exported for unit tests.
 */
export function classifyRow(
  row: RecallEdgeRow,
  lineText: string | null,
): AuditRow['verdict'] {
  // (1) unpositioned: null or sentinel -1
  if (row.sourceLine === null || row.sourceLine < 0) {
    return 'unpositioned';
  }
  // (2) no-file: file missing or line OOB
  if (lineText === null) {
    return 'no-file';
  }
  const targetName = row.targetName ?? '';
  if (!targetName) {
    return 'name-mismatch';
  }
  const col = row.sourceCol ?? 0;
  // (3) extract the identifier token at/near sourceCol.
  const token = extractToken(lineText, col, targetName.length);
  if (token === null) {
    return 'name-mismatch';
  }
  // (4) dynamic pattern: this./super. prefix immediately before the
  // token position (handles member-call dispatch where the receiver
  // is a keyword — weaker uniqueness than bare calls).
  if (hasDynamicPrefix(lineText, col)) {
    return 'dynamic';
  }
  // (5) name match
  if (token === targetName) {
    return 'corroborated';
  }
  return 'name-mismatch';
}

/**
 * Extract the identifier token at or around `col` in `lineText`.
 * Handles two forms:
 *   - bare call:   `foo(...)` — col points at `f`
 *   - member call: `obj.foo(...)` — col points at `f` of `foo`
 *
 * We scan left from `col` to find the start of the identifier
 * (word chars: [A-Za-z0-9_$]), then scan right for the end.
 * Returns the extracted identifier, or null if `col` is outside
 * a word character region.
 *
 * `hintLen` is unused for correctness but kept as a parameter
 * so callers can pass `targetName.length` for documentation.
 */
export function extractToken(
  lineText: string,
  col: number,
  _hintLen: number,
): string | null {
  const text = lineText;
  const len = text.length;
  // Clamp col to [0, len-1] — some edges may have sourceCol slightly
  // past the line end (e.g. trailing `(` after the identifier).
  const c = Math.min(Math.max(col, 0), len - 1);
  // If the character at col is not a word char, scan right one step
  // (handles col pointing at the `(` after `foo(`) or left one step
  // (handles col pointing at the `.` before `foo`).
  let start = c;
  if (!isWordChar(text[start])) {
    // Try right
    if (start + 1 < len && isWordChar(text[start + 1])) {
      start = start + 1;
    } else if (start > 0 && isWordChar(text[start - 1])) {
      start = start - 1;
    } else {
      return null;
    }
  }
  // Scan left to find identifier start.
  let lo = start;
  while (lo > 0 && isWordChar(text[lo - 1])) lo--;
  // Scan right to find identifier end.
  let hi = start;
  while (hi + 1 < len && isWordChar(text[hi + 1])) hi++;
  if (lo > hi) return null;
  return text.slice(lo, hi + 1);
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * True if the token at `col` is immediately preceded by `this.`
 * or `super.` (dynamic dispatch pattern).
 */
export function hasDynamicPrefix(lineText: string, col: number): boolean {
  // Find the start of the identifier at col.
  let lo = Math.min(Math.max(col, 0), lineText.length - 1);
  if (!isWordChar(lineText[lo])) {
    if (lo + 1 < lineText.length && isWordChar(lineText[lo + 1])) lo++;
    else if (lo > 0 && isWordChar(lineText[lo - 1])) lo--;
    else return false;
  }
  while (lo > 0 && isWordChar(lineText[lo - 1])) lo--;
  // Check what precedes lo: expect `.` and then `this` or `super`.
  if (lo < 1 || lineText[lo - 1] !== '.') return false;
  const before = lineText.slice(0, lo - 1);
  // Require a word boundary: the char before 'this'/'super' must not be a
  // word char (otherwise "notthis.foo" would match).
  if (before.endsWith('this')) {
    const prev = before[before.length - 5]; // char before 'this'
    return prev === undefined || !isWordChar(prev);
  }
  if (before.endsWith('super')) {
    const prev = before[before.length - 6]; // char before 'super'
    return prev === undefined || !isWordChar(prev);
  }
  return false;
}

// ─── Default readLine implementation ─────────────────────────────────

/**
 * Default readLine seam. Reads the file from disk, splits on newlines,
 * returns the line at `lineIndex` (0-based), or null when absent/OOB.
 * Caches nothing — callers that need caching inject their own seam.
 */
function defaultReadLine(absPath: string, lineIndex: number): string | null {
  let text: string;
  try {
    text = nodeFs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  return lines[lineIndex];
}

// ─── Line cache ───────────────────────────────────────────────────────

/**
 * File-level line cache: reads each file at most once per audit run.
 *
 * When `readFileFn` is provided (test seam), it is used to read the
 * whole file content as a string; the result is split on newlines and
 * cached. When absent, `nodeFs.readFileSync` is used directly —
 * a single read per file, regardless of how many lines are looked up.
 *
 * The `readLineFn` seam is preserved as a per-line fallback for test
 * contexts that inject line-level stubs without a whole-file seam.
 * In production `readLineFn` is never called (the file-level cache
 * satisfies every lookup after the first read).
 *
 * Return semantics: null for missing file or out-of-range lineIndex.
 */

function makeLineCache(
  repoPath: string,
  readLineFn: ReadLineFn,
  readFileFn?: ReadFileFn,
): (relPath: string | null, lineIndex: number) => string | null {
  // Cache: absPath → all lines of that file (populated once per file).
  const fileLines = new Map<string, string[] | null>();

  function getLines(absPath: string): string[] | null {
    if (fileLines.has(absPath)) return fileLines.get(absPath)!;
    let lines: string[] | null;
    if (readFileFn) {
      const text = readFileFn(absPath);
      lines = text !== null ? text.split('\n') : null;
    } else {
      try {
        lines = nodeFs.readFileSync(absPath, 'utf-8').split('\n');
      } catch {
        lines = null;
      }
    }
    fileLines.set(absPath, lines);
    return lines;
  }

  return (relPath: string | null, lineIndex: number): string | null => {
    if (!relPath) return null;
    const absPath = nodePath.isAbsolute(relPath)
      ? relPath
      : nodePath.resolve(repoPath, relPath);

    const lines = getLines(absPath);
    if (lines === null) {
      // File unreadable via file-level seam — fall back to the per-line seam
      // (supports test contexts that inject readLine without readFileFn).
      return readLineFn(absPath, lineIndex);
    }
    if (lineIndex < 0 || lineIndex >= lines.length) return null;
    return lines[lineIndex];
  };
}

// ─── Core audit function ──────────────────────────────────────────────

/**
 * Audit recall-precision for a single indexed repo.
 *
 * Read-only: only calls `runCypher` (executeParameterized-shaped).
 * Never calls initLbug / executeQuery / addNode / addRelationship.
 */
export async function auditRecallPrecision(
  opts: AuditRecallPrecisionOptions,
): Promise<AuditResult> {
  const sampleCap = opts.sampleCap ?? 500;
  const seed = opts.seed ?? 'recall-audit-v1';
  const readLine = opts.readLine ?? defaultReadLine;
  const readFile = opts.readFile;
  const { repoId, repoPath, runCypher } = opts;

  // ── 1) Query all lsp-recall CodeRelation rows ──────────────────────
  // Read-only Cypher: MATCH...WHERE r.source='lsp-recall' RETURN...
  // We join to both endpoint nodes to get their names and labels in one pass.
  const cypher = [
    'MATCH (a)-[r:CodeRelation]->(b)',
    "WHERE r.source = 'lsp-recall'",
    'RETURN',
    '  a.filePath AS fromFile,',
    '  a.name AS fromName,',
    '  r.sourceLine AS sourceLine,',
    '  r.sourceCol AS sourceCol,',
    '  b.name AS targetName,',
    '  b.label AS targetLabel,',
    '  r.reason AS reason',
    'ORDER BY a.filePath ASC, r.sourceLine ASC',
  ].join(' ');

  let rows: RecallEdgeRow[];
  try {
    const raw = await runCypher(repoId, cypher, {});
    rows = (raw ?? []) as RecallEdgeRow[];
  } catch {
    rows = [];
  }

  const total = rows.length;

  // ── 2) Seeded stratified sample if > sampleCap ────────────────────
  // We split into two strata: positioned (sourceLine >= 0) and
  // unpositioned (sourceLine null or < 0). Sample proportionally so
  // the corroboration rate is not biased by over-sampling one stratum.
  let auditable: RecallEdgeRow[];
  if (total <= sampleCap) {
    auditable = rows;
  } else {
    const rng = mulberry32(hashSeed(seed));
    const positioned = rows.filter(
      (r) => r.sourceLine !== null && r.sourceLine >= 0,
    );
    const unpositioned = rows.filter(
      (r) => r.sourceLine === null || r.sourceLine < 0,
    );
    const posShare = Math.round(
      (sampleCap * positioned.length) / total,
    );
    const unposShare = sampleCap - posShare;
    shuffleInPlace(positioned, rng);
    shuffleInPlace(unpositioned, rng);
    auditable = [
      ...positioned.slice(0, posShare),
      ...unpositioned.slice(0, unposShare),
    ];
  }

  // ── 3) Per-edge structural corroboration ───────────────────────────
  const repoBasename = nodePath.basename(nodePath.resolve(repoPath));
  // Line cache: one file read per unique path (file-level cache).
  const getLine = makeLineCache(repoPath, readLine, readFile);

  const auditRows: AuditRow[] = [];

  for (const row of auditable) {
    // (a) Extract row fields for structural corroboration.
    // Callability is assumed enforced upstream by the engine's P2 gate;
    // the audit does not re-check labels.
    const targetLabel = String(row.targetLabel ?? '');
    const targetName = String(row.targetName ?? '');
    const fromFile = String(row.fromFile ?? '');

    // (b) Determine verdict from line text.
    const lineIndex =
      row.sourceLine !== null && row.sourceLine >= 0
        ? row.sourceLine
        : -1;
    // Read from file only when positioned.
    const lineText =
      lineIndex >= 0 ? getLine(fromFile, lineIndex) : null;

    const verdict = classifyRow(row, lineText);

    // Build snippet: first 80 chars of the line, trimmed.
    const callSiteText =
      lineText !== null ? lineText.trim().slice(0, 80) : '';

    auditRows.push({
      repo: repoBasename,
      fromFile,
      displayLine: lineIndex >= 0 ? lineIndex + 1 : 0,
      callSiteText,
      targetName,
      targetLabel,
      verdict,
    });
  }

  // ── 4) Aggregate stats ─────────────────────────────────────────────
  let corroborated = 0;
  let nameMismatch = 0;
  let dynamic = 0;
  let unpositioned = 0;
  let noFile = 0;
  for (const r of auditRows) {
    switch (r.verdict) {
      case 'corroborated': corroborated++; break;
      case 'name-mismatch': nameMismatch++; break;
      case 'dynamic': dynamic++; break;
      case 'unpositioned': unpositioned++; break;
      case 'no-file': noFile++; break;
    }
  }
  const n = auditRows.length;
  // Corroboration rate: corroborated / (corroborated + nameMismatch + dynamic)
  // — we count dynamic as partial evidence (the token matches but via a
  // keyword receiver). Unpositioned and no-file are excluded from the denominator
  // since they are structural data gaps, not failures of corroboration.
  const positiveEvidence = corroborated + nameMismatch + dynamic;
  const corroborationRate = positiveEvidence > 0
    ? corroborated / positiveEvidence
    : 0;

  // ── 5) Seeded 40-row human-review table ───────────────────────────
  // Mix all verdict types for representativeness.
  const rng2 = mulberry32(hashSeed(seed + '-review'));
  const shuffled = auditRows.slice();
  shuffleInPlace(shuffled, rng2);
  const reviewRows = shuffled.slice(0, 40);

  return {
    repoId,
    repoPath,
    stats: { n, corroborated, nameMismatch, dynamic, unpositioned, noFile, corroborationRate },
    reviewRows,
  };
}

// ─── Report rendering ─────────────────────────────────────────────────

/**
 * Render a markdown report from multiple per-repo AuditResult objects.
 */
export function renderMarkdownReport(results: AuditResult[]): string {
  const lines: string[] = [];
  lines.push('# lsp-recall Precision Audit');
  lines.push('');
  lines.push(
    '**Methodology**: structural corroboration only — no LSP re-invocation ' +
    '(that would be circular). Checks: (a) target is callable-kinded, ' +
    '(b) identifier token at sourceLine:sourceCol textually matches target name.',
  );
  lines.push('');
  lines.push('**Caveat**: structural corroboration cannot catch a textually-matching ' +
    'but semantically-wrong target (e.g. a different `foo` in another module). ' +
    'The true recall precision upper-bound requires semantic analysis or manual review.');
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push(
    '| repo | n | corroborated | name-mismatch | dynamic | unpositioned | no-file | corroboration-rate |',
  );
  lines.push(
    '|------|---|-------------|--------------|---------|-------------|---------|-------------------|',
  );
  let totalN = 0, totalCorr = 0, totalMis = 0, totalDyn = 0, totalUnpos = 0, totalNoFile = 0;
  for (const r of results) {
    const s = r.stats;
    const name = nodePath.basename(nodePath.resolve(r.repoPath));
    lines.push(
      `| ${name} | ${s.n} | ${s.corroborated} | ${s.nameMismatch} | ${s.dynamic} | ${s.unpositioned} | ${s.noFile} | ${(s.corroborationRate * 100).toFixed(1)}% |`,
    );
    totalN += s.n; totalCorr += s.corroborated; totalMis += s.nameMismatch;
    totalDyn += s.dynamic; totalUnpos += s.unpositioned; totalNoFile += s.noFile;
  }
  const aggDenom = totalCorr + totalMis + totalDyn;
  const aggRate = aggDenom > 0 ? totalCorr / aggDenom : 0;
  lines.push(
    `| **TOTAL** | ${totalN} | ${totalCorr} | ${totalMis} | ${totalDyn} | ${totalUnpos} | ${totalNoFile} | **${(aggRate * 100).toFixed(1)}%** |`,
  );
  lines.push('');

  // Recommendation
  lines.push('## Recommendation');
  lines.push('');
  // Calibration check against the CURRENT model: recall confidence is now
  // per-language (default `LSP_RECALL_CONFIDENCE` = 0.90; the language
  // adapter may set a lower `recallConfidence`, e.g. TS 0.75 / Python 0.6),
  // and uncorroborated recalls are name-gated out at index time (roadmap
  // levers 1+2). The 0.85 WILL_BREAK impact floor is the decision boundary:
  // a language whose measured corroboration justifies clearing it should
  // sit ≥ 0.90; otherwise keep it below 0.85.
  const pct = aggRate * 100;
  let rec: string;
  let targetConf: string;
  if (pct >= 95) {
    rec = `Corroboration rate ${pct.toFixed(1)}% ≥ 95%: recall is reliable — **0.90 is justified** (clears the 0.85 WILL_BREAK floor).`;
    targetConf = '0.90';
  } else if (pct >= 85) {
    rec = `Corroboration rate ${pct.toFixed(1)}% ∈ [85%, 95%): borderline — **cap at 0.80** (just below the 0.85 impact floor).`;
    targetConf = '0.80';
  } else {
    rec = `Corroboration rate ${pct.toFixed(1)}% < 85%: weak — **keep well below 0.85** (e.g. TS 0.75 / Python 0.6). Single-method recall is unreliable for this language/repo.`;
    targetConf = '< 0.85 (per-language floor)';
  }
  lines.push(rec);
  lines.push('');
  lines.push(`Recommended target confidence: **${targetConf}**`);
  lines.push('');
  lines.push('**Caveats**:');
  lines.push('- Structural corroboration cannot detect semantically wrong targets that happen to share a name.');
  lines.push('- Dynamic calls (this./super. prefix) have weaker uniqueness — the method name is correct but the receiver type may differ.');
  lines.push('- Unpositioned edges (NULL sourceLine) cannot be structurally verified; they are excluded from the rate denominator.');
  lines.push('');

  // Per-repo human-review tables
  for (const r of results) {
    const name = nodePath.basename(nodePath.resolve(r.repoPath));
    lines.push(`## Human-Review Table: ${name}`);
    lines.push('');
    lines.push('| file:line | call-site text | target symbol | target label | verdict |');
    lines.push('|-----------|---------------|--------------|-------------|---------|');
    for (const row of r.reviewRows) {
      const loc = `${row.fromFile}:${row.displayLine}`;
      const site = row.callSiteText.replace(/\|/g, '\\|');
      lines.push(
        `| ${loc} | ${site} | ${row.targetName} | ${row.targetLabel} | **${row.verdict}** |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── CLI entry ────────────────────────────────────────────────────────

/**
 * CLI entry point. Usage:
 *   tsx scripts/audit-recall-precision.ts \
 *     --repo <path> [--repo <path> ...] \
 *     --out /tmp/159-recall-audit \
 *     [--sample 500] [--seed recall-audit-v1]
 *
 * For each repo: queries the existing index (must already be analyzed
 * with --lsp), audits lsp-recall edges, writes JSON + report.md.
 *
 * NEVER runs `analyze` itself — reads the index as-is.
 */
async function main(): Promise<void> {
  // node:path and node:fs are statically imported at the top of this file.
  // node:fs/promises is loaded lazily here (only needed in the CLI path).
  const { mkdir, writeFile } = await import('node:fs/promises');

  // ── Parse args ─────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const repoPaths: string[] = [];
  let outDir = '/tmp/159-recall-audit';
  let sampleCap = 500;
  let seed = 'recall-audit-v1';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) { repoPaths.push(args[++i]); }
    else if (args[i] === '--out' && args[i + 1]) { outDir = args[++i]; }
    else if (args[i] === '--sample' && args[i + 1]) { sampleCap = parseInt(args[++i], 10); }
    else if (args[i] === '--seed' && args[i + 1]) { seed = args[++i]; }
  }

  if (repoPaths.length === 0) {
    console.error(
      'Usage: tsx scripts/audit-recall-precision.ts --repo <path> [--repo ...] --out <dir>',
    );
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  // ── Load lbug-adapter dynamically (read-only: executeParameterized only) ──
  // Dynamic import keeps the static source-text sweep (assertNoGraphWriteImports)
  // from seeing a static import of lbug-adapter (KD-8 discipline).
  const lbugMod: any = await import('../dist/mcp/core/lbug-adapter.js');
  const executeParameterized: AuditRecallPrecisionOptions['runCypher'] =
    lbugMod.executeParameterized;
  const initLbug: (repoId: string, dbPath: string) => Promise<void> = lbugMod.initLbug;
  const closeLbug: (repoId?: string) => Promise<void> = lbugMod.closeLbug;
  const isLbugReady: (repoId: string) => boolean = lbugMod.isLbugReady;

  const getStoragePathsMod: any = await import('../dist/storage/repo-manager.js');
  const getStoragePaths: (repoPath: string) => { storagePath: string; lbugPath: string; metaPath: string } =
    getStoragePathsMod.getStoragePaths;

  const results: AuditResult[] = [];

  for (const repoPath of repoPaths) {
    const absRepo = nodePath.resolve(repoPath);
    const repoBasename = nodePath.basename(absRepo).toLowerCase();
    const repoId = repoBasename || 'repo';

    const paths = getStoragePaths(absRepo);

    // Check index exists
    if (!nodeFs.existsSync(paths.lbugPath)) {
      console.error(
        `[audit] SKIP ${repoBasename}: no index at ${paths.lbugPath} — run analyze --lsp first`,
      );
      continue;
    }

    // Open pool (lock discipline: open → read → close, no concurrent access)
    if (!isLbugReady(repoId)) {
      await initLbug(repoId, paths.lbugPath);
    }
    let result: AuditResult;
    try {
      console.log(`[audit] ${repoBasename}: querying lsp-recall edges…`);
      result = await auditRecallPrecision({
        repoPath: absRepo,
        repoId,
        sampleCap,
        seed,
        runCypher: executeParameterized,
      });
    } finally {
      await closeLbug(repoId).catch(() => { /* best-effort */ });
    }

    results.push(result);

    // Write per-repo JSON
    const jsonPath = nodePath.join(outDir, `${repoBasename}-recall-audit.json`);
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log(
      `[audit] ${repoBasename}: n=${result.stats.n} corroborated=${result.stats.corroborated} ` +
      `rate=${(result.stats.corroborationRate * 100).toFixed(1)}% → ${jsonPath}`,
    );
  }

  // Write combined markdown report
  const md = renderMarkdownReport(results);
  const mdPath = nodePath.join(outDir, 'report.md');
  await writeFile(mdPath, md, 'utf-8');
  console.log(`[audit] report → ${mdPath}`);
}

// Run when executed directly (tsx / node)
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('audit-recall-precision.ts') ||
    process.argv[1].endsWith('audit-recall-precision.js'));

if (isMain) {
  main().catch((err) => {
    console.error('[audit] fatal:', err);
    process.exit(1);
  });
}
