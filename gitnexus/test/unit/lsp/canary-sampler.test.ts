/**
 * Unit Tests: canary-sampler (LSP read-only foundation, WI-#5 support)
 *
 * The canary sampler is the FS-based counterpart to the
 * workspace-readiness probe. Its job: walk a repo tree and produce
 * a small set of `Sample` objects at real TypeScript identifier
 * positions so the probe has genuine cross-file resolution
 * requests to fire at the language server.
 *
 * Decision table:
 *
 *   | has .ts with import | has export fn | TS-less dir | result                     |
 *   |---------------------|---------------|-------------|----------------------------|
 *   | yes                 | *             | no          | sample at import identifier |
 *   | no                  | yes           | no          | sample at export fn name   |
 *   | no                  | no            | no          | [] (no eligible position)  |
 *   | *                   | *             | yes         | []                         |
 *
 * AC-3 (gh #172): determinism across two calls on the same tree.
 * AC-4: node_modules / dist / .d.ts excluded.
 * AC-5: priority order — import position beats export fn.
 * AC-6: 0-indexed line/character correctness.
 * AC-7: unreadable entries skipped without throw.
 * AC-8: maxFiles cap respected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCanarySamples } from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-canary-sampler-'));
});

afterAll(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/** Create a sub-directory under tmpRoot with its own fresh name. */
function mkFixture(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('buildCanarySamples — determinism', () => {
  it('two calls on the same tree return identical results', async () => {
    const dir = mkFixture('determinism');
    fs.writeFileSync(
      path.join(dir, 'a.ts'),
      [
        "import { foo } from './b';",
        'export function caller() { foo(); }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      ['export function foo() {}', ''].join('\n'),
    );

    const first = await buildCanarySamples(dir);
    const second = await buildCanarySamples(dir);

    expect(first).toEqual(second);
  });
});

describe('buildCanarySamples — exclusions', () => {
  it('ignores node_modules directory', async () => {
    const dir = mkFixture('excl-node_modules');
    // Only TS file is inside node_modules — should yield []
    const nm = path.join(dir, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(
      path.join(nm, 'index.ts'),
      ["import { x } from './y';", ''].join('\n'),
    );

    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });

  it('ignores dist directory', async () => {
    const dir = mkFixture('excl-dist');
    const distDir = path.join(dir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.ts'),
      ["import { x } from './y';", ''].join('\n'),
    );

    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });

  it('ignores .d.ts declaration files', async () => {
    const dir = mkFixture('excl-dts');
    // Only file is a .d.ts — should yield [] (no eligible file)
    fs.writeFileSync(
      path.join(dir, 'types.d.ts'),
      ["export declare function foo(): void;", ''].join('\n'),
    );

    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });

  it('ignores coverage directory', async () => {
    const dir = mkFixture('excl-coverage');
    const covDir = path.join(dir, 'coverage');
    fs.mkdirSync(covDir, { recursive: true });
    fs.writeFileSync(
      path.join(covDir, 'index.ts'),
      ["import { x } from './y';", ''].join('\n'),
    );

    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });
});

describe('buildCanarySamples — priority order', () => {
  it('import identifier wins over export function when both are present', async () => {
    const dir = mkFixture('priority');
    // This file has both a relative import AND an exported function.
    // The sampler must pick the import position (priority 1).
    const content = [
      "import { Foo } from './other';",   // line 0 — import wins
      'export function bar(): void {}',    // line 1 — export fn, lower priority
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'main.ts'), content);
    // Create 'other.ts' so the import is plausible
    fs.writeFileSync(path.join(dir, 'other.ts'), 'export class Foo {}\n');

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // The sampler should have picked `Foo` from the import line.
    // Line 0, character = index of 'Foo' in "import { Foo } from './other';"
    const importLine = "import { Foo } from './other';";
    const expectedChar = importLine.indexOf('Foo');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('falls through to export function when no relative import exists', async () => {
    const dir = mkFixture('priority-export-fn');
    const content = [
      '// no import here',
      'export function myFunc(): void {}',  // line 1
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'lib.ts'), content);

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Should point at 'myFunc'
    const line1 = 'export function myFunc(): void {}';
    const expectedChar = line1.indexOf('myFunc');
    expect(samples[0].position.line).toBe(1);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('falls through to export const when no import or export fn exists', async () => {
    const dir = mkFixture('priority-export-const');
    const content = [
      '// no import, no export function',
      'export const MY_CONST = 42;',  // line 1
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'consts.ts'), content);

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const line1 = 'export const MY_CONST = 42;';
    const expectedChar = line1.indexOf('MY_CONST');
    expect(samples[0].position.line).toBe(1);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('falls through to plain function when only function decl exists', async () => {
    const dir = mkFixture('priority-plain-fn');
    const content = [
      '// no import, no export',
      'function internalHelper() {}',  // line 1
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'util.ts'), content);

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const line1 = 'function internalHelper() {}';
    const expectedChar = line1.indexOf('internalHelper');
    expect(samples[0].position.line).toBe(1);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

describe('buildCanarySamples — 0-indexed line/character correctness', () => {
  it('emits correct 0-based line and character for a known literal file content', async () => {
    const dir = mkFixture('position-correctness');
    // Deliberately use a multi-line file so line>0 is exercised.
    const content = [
      '// copyright header',                            // line 0
      '// second comment line',                         // line 1
      "import { TargetIdent } from '../sibling';",      // line 2 — this wins
      'export function helper(): void {}',              // line 3
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'consumer.ts'), content);

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const importLine = "import { TargetIdent } from '../sibling';";
    const expectedChar = importLine.indexOf('TargetIdent');

    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toBe('file://' + path.join(dir, 'consumer.ts'));
  });
});

describe('buildCanarySamples — TS-less directory', () => {
  it('returns [] for a directory with no .ts files', async () => {
    const dir = mkFixture('ts-less');
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');

    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });

  it('returns [] for an empty directory', async () => {
    const dir = mkFixture('empty');
    const samples = await buildCanarySamples(dir);
    expect(samples).toHaveLength(0);
  });
});

describe('buildCanarySamples — robustness', () => {
  it('does not throw when an unreadable file is encountered', async () => {
    const dir = mkFixture('unreadable');
    // Create a readable file to ensure the walk does something
    fs.writeFileSync(
      path.join(dir, 'readable.ts'),
      "import { X } from './y';\n",
    );
    // Create a file then chmod it unreadable (skip on Windows where chmod behaves differently)
    const unreadable = path.join(dir, 'secret.ts');
    fs.writeFileSync(unreadable, 'export const X = 1;\n');
    try {
      fs.chmodSync(unreadable, 0o000);
    } catch {
      // chmod not supported (Windows) — the test still passes
    }

    let result: import('../../../src/core/ingestion/lsp/workspace-readiness-probe.js').Sample[];
    await expect(
      buildCanarySamples(dir).then((s) => { result = s; return s; }),
    ).resolves.toBeDefined();

    // Restore permissions for cleanup
    try { fs.chmodSync(unreadable, 0o644); } catch { /* noop */ }
  });

  it('does not throw for a non-existent directory', async () => {
    const nonExistent = path.join(tmpRoot, 'does-not-exist-xyz');
    await expect(buildCanarySamples(nonExistent)).resolves.toEqual([]);
  });
});

describe('buildCanarySamples — maxFiles cap', () => {
  it('returns at most maxFiles samples', async () => {
    const dir = mkFixture('maxfiles-cap');
    // Create 6 .ts files each with an import — should be capped to 2
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(dir, `file${i}.ts`),
        [`import { dep${i} } from './dep';`, ''].join('\n'),
      );
    }
    fs.writeFileSync(path.join(dir, 'dep.ts'), `export const dep0 = 1;\n`);

    const samples = await buildCanarySamples(dir, { maxFiles: 2 });
    expect(samples.length).toBeLessThanOrEqual(2);
  });

  it('returns [] when maxFiles is 0', async () => {
    const dir = mkFixture('maxfiles-zero');
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      "import { x } from './y';\n",
    );

    const samples = await buildCanarySamples(dir, { maxFiles: 0 });
    expect(samples).toHaveLength(0);
  });
});

describe('buildCanarySamples — URI format', () => {
  it('emits file:// URIs with absolute paths', async () => {
    const dir = mkFixture('uri-format');
    fs.writeFileSync(
      path.join(dir, 'a.ts'),
      "import { B } from './b';\n",
    );

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].textDocument.uri).toMatch(/^file:\/\//);
    expect(path.isAbsolute(samples[0].textDocument.uri.replace('file://', ''))).toBe(true);
  });

  it('accepts .tsx, .mts, .cts extensions', async () => {
    const dir = mkFixture('extensions');
    fs.writeFileSync(
      path.join(dir, 'comp.tsx'),
      "import { React } from './react-shim';\nexport function Comp() { return null; }\n",
    );

    const samples = await buildCanarySamples(dir, { maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].textDocument.uri).toContain('comp.tsx');
  });
});

// ─── F7: template-literal / block-comment pre-pass ───────────────────

describe('buildCanarySamples — template-literal / block-comment pre-pass (F7)', () => {
  it('file whose only import-like line is inside a template literal falls through to export-function sample', async () => {
    // Only import-shaped text in this file is inside a backtick template
    // literal. The sampler must skip it and fall through to the
    // `export function helper` declaration. If it does NOT skip, the
    // regex would match the in-template line and the resulting sample
    // position would point inside the template (unanswerable by TSLS).
    const dir = mkFixture('f7-template-literal');

    // This file has exactly two TypeScript source files:
    //   - template-only.ts: the import is only inside a template literal
    //   - helper.ts:        has an export function that IS a real sample
    fs.writeFileSync(
      path.join(dir, 'helper.ts'),
      [
        '// Real export — the sampler should land here after skipping template-only.ts',
        'export function helper(): void {}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'template-only.ts'),
      [
        '// Only import-shaped text is inside a template literal.',
        'const sql = `',
        "  import { something } from './other';",
        '`;',
        '',
      ].join('\n'),
    );

    const samples = await buildCanarySamples(dir, { maxFiles: 2 });
    // At least one sample must NOT point at a line inside a backtick template.
    // The safe sample is in helper.ts at the `export function helper` line.
    const helperSample = samples.find((s) => s.textDocument.uri.includes('helper.ts'));
    expect(helperSample, 'expected a sample from helper.ts (not from template-only.ts template body)').toBeDefined();
  });

  it('file whose only import-like line is inside a block comment falls through to export-function sample', async () => {
    const dir = mkFixture('f7-block-comment');

    fs.writeFileSync(
      path.join(dir, 'real.ts'),
      [
        'export function realFn(): void {}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'commented.ts'),
      [
        '/**',
        " * import { commented } from './other';",
        ' */',
        'export const x = 1;',
        '',
      ].join('\n'),
    );

    const samples = await buildCanarySamples(dir, { maxFiles: 2 });
    // No sample should point to the JSDoc line (line 1 of commented.ts).
    for (const s of samples) {
      if (s.textDocument.uri.includes('commented.ts')) {
        // If a sample lands in commented.ts, it must be the `export const x`
        // line (line 3, 0-indexed), NOT the commented import line (line 1).
        expect(s.position.line, 'sample must not point into a block comment').not.toBe(1);
      }
    }
    expect(samples.length, 'should produce at least one sample').toBeGreaterThan(0);
  });
});
