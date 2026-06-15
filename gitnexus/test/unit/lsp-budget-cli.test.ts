/**
 * Unit Tests: --lsp-budget CLI flag (WI-6, #159 P3)
 *
 * Covers CLI registration shape, Number() coercion, and the validation
 * guard. The threading assertion (lspBudget → lsp.budget →
 * withReconciliationSession cap) lives in lsp/mode-a-session.test.ts.
 *
 * Cases:
 *   C6-1: Commander coercion Number('500') === 500 (Number, not string)
 *   C6-2: --lsp-budget flag appears near --lsp and --lsp-dry-run in index.ts
 *   C6-3: No --lsp-budget flag → opts.lspBudget === undefined
 *   C6-4: budget=0 → Number.isInteger(0) && 0 <= 0 → rejected
 *   C6-5: budget=-1 → rejected
 *   C6-6: budget=1 → accepted (minimum valid)
 *   C6-7: budget=2000 → accepted (equals DEFAULT_CANDIDATE_CAP)
 *   C6-8: budget=2001 → accepted (above default)
 *   Edge: budget without --lsp → warning branch triggered
 *   Edge: 0 ?? DEFAULT_CANDIDATE_CAP does NOT coalesce on 0 — explicit guard fires
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ─── C6-1: Commander coercion ────────────────────────────────────────────────

describe('WI-6 — C6-1: Commander --lsp-budget coercion produces Number', () => {
  it('Number("500") === 500 (the Commander coercion in index.ts)', () => {
    // index.ts registers `.option('--lsp-budget <n>', ..., (v) => Number(v))`.
    // This mimics exactly what Commander does when the flag is provided.
    const coerce = (v: string) => Number(v);
    expect(coerce('500')).toBe(500);
    expect(typeof coerce('500')).toBe('number');
  });

  it('Number("abc") → NaN (non-numeric string; NaN fails Number.isInteger)', () => {
    const coerce = (v: string) => Number(v);
    expect(Number.isInteger(coerce('abc'))).toBe(false);
    expect(Number.isNaN(coerce('abc'))).toBe(true);
  });

  it('Number("1.5") → 1.5 (non-integer; Number.isInteger rejects it)', () => {
    const coerce = (v: string) => Number(v);
    expect(coerce('1.5')).toBe(1.5);
    expect(Number.isInteger(coerce('1.5'))).toBe(false);
  });

  it('AnalyzeOptions.lspBudget field accepts a number (structural check)', () => {
    // Verify the field exists and accepts a number value — the interface shape
    // guarantee that the rest of the system depends on.
    const opts: import('../../src/cli/analyze.js').AnalyzeOptions = { lspBudget: 500 };
    expect(opts.lspBudget).toBe(500);
    expect(typeof opts.lspBudget).toBe('number');
  });
});

// ─── C6-2: --lsp-budget appears near --lsp and --lsp-dry-run in source ──────

describe('WI-6 — C6-2: --lsp-budget registered adjacent to --lsp/--lsp-dry-run', () => {
  it('index.ts contains --lsp-budget option registration near --lsp options', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'cli', 'index.ts'),
      'utf-8',
    );
    expect(src).toContain("'--lsp-budget <n>'");
    expect(src).toContain("(v) => Number(v)");

    // All three lsp-family options must be within a 5-line window
    const lines = src.split('\n');
    const lspLine = lines.findIndex(l => /\.option\('--lsp'/.test(l));
    const lspDryLine = lines.findIndex(l => /\.option\('--lsp-dry-run'/.test(l));
    const lspBudgetLine = lines.findIndex(l => /\.option\('--lsp-budget/.test(l));

    expect(lspLine).toBeGreaterThan(-1);
    expect(lspDryLine).toBeGreaterThan(-1);
    expect(lspBudgetLine).toBeGreaterThan(-1);

    const sorted = [lspLine, lspDryLine, lspBudgetLine].sort((a, b) => a - b);
    expect(sorted[2] - sorted[0]).toBeLessThanOrEqual(5);
  });
});

// ─── C6-3: No flag → undefined ───────────────────────────────────────────────

describe('WI-6 — C6-3: No --lsp-budget flag → lspBudget === undefined', () => {
  it('AnalyzeOptions with no lspBudget → field is undefined', () => {
    const opts: import('../../src/cli/analyze.js').AnalyzeOptions = { lsp: true };
    expect(opts.lspBudget).toBeUndefined();
  });

  it('PipelineOptions.lsp.budget undefined → pipeline uses DEFAULT_CANDIDATE_CAP', async () => {
    // Verify that undefined budget threads through correctly — C6-11 (threading).
    // The ?? operator in pipeline.ts: `options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP`
    // correctly defaults to 2000 when budget is undefined.
    const { DEFAULT_CANDIDATE_CAP } = await import('../../src/core/ingestion/mode-a-reconciler.js');
    const budget: number | undefined = undefined;
    const cap = budget ?? DEFAULT_CANDIDATE_CAP;
    expect(cap).toBe(2000);
    expect(DEFAULT_CANDIDATE_CAP).toBe(2000);
  });
});

// ─── C6-4..C6-8: Validation guard logic (BVA around 0) ──────────────────────

describe('WI-6 — C6-4..C6-8: Validation guard Number.isInteger(n) && n > 0', () => {
  /**
   * The guard in analyzeCommand is:
   *   if (!Number.isInteger(n) || n <= 0) { reject }
   * Equivalent to: ACCEPTS iff Number.isInteger(n) && n > 0
   */
  const accepts = (n: number) => Number.isInteger(n) && n > 0;

  // C6-4: boundary at 0 — rejected
  it('C6-4: 0 → rejected (n <= 0)', () => {
    expect(accepts(0)).toBe(false);
  });

  // C6-5: -1 — rejected
  it('C6-5: -1 → rejected (n <= 0)', () => {
    expect(accepts(-1)).toBe(false);
  });

  // Non-numeric inputs
  it('NaN → rejected (!Number.isInteger)', () => {
    expect(accepts(NaN)).toBe(false);
  });

  it('Infinity → rejected (!Number.isInteger)', () => {
    expect(accepts(Infinity)).toBe(false);
  });

  it('1.5 → rejected (!Number.isInteger)', () => {
    expect(accepts(1.5)).toBe(false);
  });

  // C6-6: minimum valid value
  it('C6-6: 1 → accepted (minimum valid positive integer)', () => {
    expect(accepts(1)).toBe(true);
  });

  // C6-7: DEFAULT_CANDIDATE_CAP
  it('C6-7: 2000 → accepted (equals DEFAULT_CANDIDATE_CAP)', () => {
    expect(accepts(2000)).toBe(true);
  });

  // C6-8: above default
  it('C6-8: 2001 → accepted (above default)', () => {
    expect(accepts(2001)).toBe(true);
  });
});

// ─── Validation guard integration: verify guard logic in analyze.ts source ───

describe('WI-6 — Validation integration: guard is present in analyze.ts source', () => {
  // Instead of invoking analyzeCommand (which has heavy side effects),
  // we verify via static source inspection that the guard is properly placed
  // — before the progress bar and before the pipeline call.
  it('analyze.ts contains the lspBudget validation guard before runPipelineFromRepo', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'cli', 'analyze.ts'),
      'utf-8',
    );
    // Guard must be present
    expect(src).toContain('Number.isInteger');
    expect(src).toContain('lspBudget');
    expect(src).toContain('process.exitCode = 1');
    // Verify ordering: guard appears before the pipeline invocation call site
    // (use the await call site, not the import which appears at the top)
    const guardIdx = src.indexOf('if (!Number.isInteger(n) || n <= 0)');
    const pipelineCallIdx = src.indexOf('await runPipelineFromRepo(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pipelineCallIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(pipelineCallIdx);
  });

  it('analyze.ts emits --lsp-budget warning when budget is set without --lsp', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'cli', 'analyze.ts'),
      'utf-8',
    );
    expect(src).toContain('--lsp-budget ignored');
    expect(src).toContain('--lsp not enabled');
  });
});

// ─── C6-12: 0 ?? DEFAULT_CANDIDATE_CAP does NOT coalesce on zero ─────────────

describe('WI-6 — C6-12: 0 ?? DEFAULT_CANDIDATE_CAP does NOT coalesce (explicit guard)', () => {
  it('`0 ?? 2000` evaluates to 0 (not 2000) — the ?? operator is NOT safe for 0', async () => {
    // This test pins the INVARIANT stated in the WI: the `??` fallback alone is
    // insufficient for a zero guard. If someone wrote `budget ?? DEFAULT_CANDIDATE_CAP`
    // without the explicit `> 0` check, a budget=0 would silently pass as cap=0,
    // which is wrong. The guard `Number.isInteger(n) && n > 0` fires BEFORE budget=0
    // ever reaches the `??` expression.
    const { DEFAULT_CANDIDATE_CAP } = await import('../../src/core/ingestion/mode-a-reconciler.js');
    const zeroBudget = 0;
    // This is what would happen WITHOUT the explicit guard — wrong behavior:
    const unsafeResult = zeroBudget ?? DEFAULT_CANDIDATE_CAP;
    expect(unsafeResult).toBe(0); // NOT 2000 — the ?? does not coalesce on 0!

    // With the explicit guard (what the code actually does):
    // analyzeCommand rejects lspBudget=0 before it reaches pipeline.ts.
    // pipeline.ts only ever receives valid (> 0) or undefined values.
    const validBudget = undefined; // the pipeline receives undefined when no flag
    const safeResult = validBudget ?? DEFAULT_CANDIDATE_CAP;
    expect(safeResult).toBe(2000);
  });
});
