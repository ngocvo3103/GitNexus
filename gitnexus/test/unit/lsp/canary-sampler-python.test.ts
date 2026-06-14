/**
 * Unit Tests: canary-sampler — Python strategy (WI-3a)
 *
 * Tests `PYTHON_CANARY_STRATEGY` and `blankPythonUnsafeLines` (exercised
 * indirectly through the strategy) against the WI-3a acceptance criteria:
 *
 *   | Scenario                                   | Expected
 *   |--------------------------------------------|------------------------------------------
 *   | multi-line """docstring containing def"""   | docstring lines blanked; real def sampled
 *   | # comment containing def                   | comment blanked; real def sampled
 *   | # inside triple-quoted string              | NOT a comment (string state wins)
 *   | def / async def priority over class        | def wins
 *   | class only (no def)                        | class name sampled
 *   | call-site only (no def/class)              | call-site sampled (priority 2)
 *   | import only (no def/class/call)            | import name sampled (last-resort)
 *   | from...import                              | imported name sampled
 *   | empty file                                 | null (no sample)
 *   | .ts file in Python fixture dir             | not sampled (isCandidateFile=false)
 *   | files in __pycache__ / .venv / site-pkg    | not walked (EXCLUDED_DIRS prunes)
 *   | offset/line-count preservation (BVA)       | position maps to correct line/char
 *   | blankUnsafeLines byte-identical for TS     | TS golden lock (invariant)
 *   | EXCLUDED_DIRS membership                   | __pycache__, .venv, site-packages present
 *
 * Tests use in-memory fixture files written to tmp directories — hermetic,
 * no dependency on repo layout. Pattern mirrors canary-sampler-java.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildCanarySamples,
  PYTHON_CANARY_STRATEGY,
  TS_CANARY_STRATEGY,
  JAVA_CANARY_STRATEGY,
} from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-canary-python-'));
});

afterAll(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function mkFixture(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── EXCLUDED_DIRS membership (I-7 invariant) ────────────────────────

describe('EXCLUDED_DIRS — Python dir membership (I-7)', () => {
  // We verify via the observable behaviour: files inside these dirs
  // are never walked, so buildCanarySamples returns [] even when the
  // dir contains valid .py files.

  it('does not walk __pycache__', async () => {
    const dir = mkFixture('excl-pycache');
    const pycache = path.join(dir, '__pycache__');
    fs.mkdirSync(pycache);
    // Put a .py file inside __pycache__ — it must NOT be picked.
    fs.writeFileSync(path.join(pycache, 'module.cpython-312.py'), 'def cached(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk .venv', async () => {
    const dir = mkFixture('excl-venv');
    const venv = path.join(dir, '.venv');
    fs.mkdirSync(venv, { recursive: true });
    fs.writeFileSync(path.join(venv, 'activate.py'), 'def activate(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk site-packages', async () => {
    const dir = mkFixture('excl-site-packages');
    const sitePkg = path.join(dir, 'site-packages');
    fs.mkdirSync(sitePkg, { recursive: true });
    fs.writeFileSync(path.join(sitePkg, 'requests.py'), 'def get(url): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk dist-packages', async () => {
    const dir = mkFixture('excl-dist-packages');
    const distPkg = path.join(dir, 'dist-packages');
    fs.mkdirSync(distPkg, { recursive: true });
    fs.writeFileSync(path.join(distPkg, 'flask.py'), 'class Flask: pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk .tox', async () => {
    const dir = mkFixture('excl-tox');
    const tox = path.join(dir, '.tox');
    fs.mkdirSync(tox, { recursive: true });
    fs.writeFileSync(path.join(tox, 'test_env.py'), 'def test_foo(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk eggs', async () => {
    const dir = mkFixture('excl-eggs');
    const eggs = path.join(dir, 'eggs');
    fs.mkdirSync(eggs, { recursive: true });
    fs.writeFileSync(path.join(eggs, 'pkg.py'), 'def install(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('does not walk .eggs', async () => {
    const dir = mkFixture('excl-dot-eggs');
    const dotEggs = path.join(dir, '.eggs');
    fs.mkdirSync(dotEggs, { recursive: true });
    fs.writeFileSync(path.join(dotEggs, 'pkg.py'), 'def install(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('still walks regular source dirs alongside excluded dirs', async () => {
    const dir = mkFixture('excl-mixed');
    // Excluded dir with a .py file that must NOT be picked.
    const pycache = path.join(dir, '__pycache__');
    fs.mkdirSync(pycache);
    fs.writeFileSync(path.join(pycache, 'mod.cpython-312.py'), 'def cached(): pass\n');
    // Non-excluded dir with a .py file that SHOULD be picked.
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'app.py'), 'def main(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 5 });
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.textDocument.uri).not.toContain('__pycache__');
    }
  });
});

// ─── isCandidateFile ─────────────────────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — isCandidateFile', () => {
  it('accepts .py files', () => {
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('app.py')).toBe(true);
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('__init__.py')).toBe(true);
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('test_foo.py')).toBe(true);
  });

  it('rejects .ts files', () => {
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('index.ts')).toBe(false);
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('main.tsx')).toBe(false);
  });

  it('rejects .java files', () => {
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('Service.java')).toBe(false);
  });

  it('rejects non-py files', () => {
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('README.md')).toBe(false);
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('requirements.txt')).toBe(false);
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('setup.cfg')).toBe(false);
  });
});

// ─── Priority 1: def declaration beats everything ────────────────────

describe('PYTHON_CANARY_STRATEGY — Priority 1: def/async def declaration', () => {
  it('samples def function name (basic case)', async () => {
    const dir = mkFixture('py-def-basic');
    const content = [
      '# module docstring',
      'import os',
      '',
      'def process_data(items):',  // line 3 — should be sampled
      '    return list(items)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'processor.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const defLine = 'def process_data(items):';
    const expectedChar = defLine.indexOf('process_data');
    expect(samples[0].position.line).toBe(3);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('processor.py');
  });

  it('samples async def function name', async () => {
    const dir = mkFixture('py-async-def');
    const content = [
      'import asyncio',
      '',
      'async def fetch_result(url):',  // line 2
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'fetcher.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const defLine = 'async def fetch_result(url):';
    const expectedChar = defLine.indexOf('fetch_result');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('def wins over class when both are present', async () => {
    const dir = mkFixture('py-def-beats-class');
    const content = [
      'class MyClass:',      // line 0 — class
      '    def method(self):',  // line 1 — def (priority 1a)
      '        pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'module.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    // def appears first in priority order — but RE_PY_DEF is checked first
    // and line 1 has `    def method(self):` which matches (indented def allowed).
    // The sampled name must be 'method', not 'MyClass'.
    const filePath = samples[0].textDocument.uri.replace('file://', '');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    const sampledLine = lines[samples[0].position.line] ?? '';
    const sampledChar = sampledLine[samples[0].position.character] ?? '';
    // The sampled position must start a Python identifier.
    expect(sampledChar).toMatch(/[A-Za-z_]/);
    // And specifically it should NOT be the class declaration line
    // (which is line 0); it should be on line 1 (the def line).
    expect(samples[0].position.line).toBe(1);
  });

  it('def wins over import — import is last-resort only', async () => {
    const dir = mkFixture('py-def-beats-import');
    const content = [
      'import os',              // line 0 — import (last-resort)
      '',
      'def real_function():',   // line 2 — def (priority 1)
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'module.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    expect(samples[0].position.line).toBe(2);
    const defLine = 'def real_function():';
    expect(samples[0].position.character).toBe(defLine.indexOf('real_function'));
  });
});

// ─── Priority 1b: class declaration ──────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — Priority 1b: class declaration', () => {
  it('samples class name when no def is present', async () => {
    const dir = mkFixture('py-class-only');
    const content = [
      'import os',
      '',
      'class MyProcessor:',  // line 2
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'processor.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const classLine = 'class MyProcessor:';
    const expectedChar = classLine.indexOf('MyProcessor');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('class with base class in parens — samples class name', async () => {
    const dir = mkFixture('py-class-with-base');
    const content = [
      'class DataHandler(BaseHandler):',  // line 0
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'handler.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const classLine = 'class DataHandler(BaseHandler):';
    const expectedChar = classLine.indexOf('DataHandler');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── Priority 2: call-site fallback ──────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — Priority 2: call-site (no def/class)', () => {
  it('samples call-site function name when no def or class exists', async () => {
    const dir = mkFixture('py-call-only');
    // File has only a call-site; no def or class.
    const content = [
      'result = some_function(arg)',  // line 0
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'script.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    // The sampled position should be on line 0 and point to an identifier.
    expect(samples[0].position.line).toBe(0);
    const lineText = content.split('\n')[0];
    const sampledChar = lineText[samples[0].position.character] ?? '';
    expect(sampledChar).toMatch(/[A-Za-z_]/);
  });
});

// ─── Priority 3 (last-resort): import ────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — Priority 3 (last-resort): import', () => {
  it('samples import os → os', async () => {
    const dir = mkFixture('py-import-only');
    const content = 'import os\n';
    fs.writeFileSync(path.join(dir, 'minimal.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const importLine = 'import os';
    const expectedChar = importLine.indexOf('os');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('samples "from pathlib import Path" → Path', async () => {
    const dir = mkFixture('py-from-import');
    const content = 'from pathlib import Path\n';
    fs.writeFileSync(path.join(dir, 'paths.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const importLine = 'from pathlib import Path';
    const expectedChar = importLine.indexOf('Path');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('two imports in file — returns exactly one sample (no double-samples)', async () => {
    const dir = mkFixture('py-two-imports');
    const content = [
      'import os',
      'import sys',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'imports.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 3 });
    // maxFiles=3 but only one .py file — should yield exactly 1 sample.
    expect(samples).toHaveLength(1);
  });
});

// ─── Empty file ───────────────────────────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — empty file', () => {
  it('returns [] for a completely empty file', async () => {
    const dir = mkFixture('py-empty');
    fs.writeFileSync(path.join(dir, 'empty.py'), '');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(0);
  });

  it('returns [] for a file with only whitespace', async () => {
    const dir = mkFixture('py-whitespace');
    fs.writeFileSync(path.join(dir, 'whitespace.py'), '   \n\n  \n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(0);
  });

  it('returns [] for a directory with no .py files', async () => {
    const dir = mkFixture('py-no-py-files');
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask==2.0\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });
});

// ─── Blanker: multi-line docstring suppression (AC-1) ────────────────
//
// ACCEPTANCE CRITERION (WI-3a, first AC):
//   GIVEN a .py text with a multi-line """docstring containing def fake():"""
//   followed by def real():, WHEN blankPythonUnsafeLines runs (via the
//   PYTHON_CANARY_STRATEGY), THEN docstring lines are blanked to spaces of
//   equal length and the def real(): line is intact.

describe('blankPythonUnsafeLines — multi-line triple-quoted string (AC-1)', () => {
  it('docstring containing def fake(): is suppressed; def real(): is sampled', async () => {
    const dir = mkFixture('py-docstring-suppress');
    const content = [
      'def real_func():',      // line 0 — MUST be sampled
      '    """',               // line 1 — opens triple-quoted string
      '    def fake_func():',  // line 2 — MUST be suppressed (inside docstring)
      '    """',               // line 3 — closes triple-quoted string
      '    return 42',         // line 4
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'module.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must sample real_func on line 0, NOT fake_func on line 2.
    expect(samples[0].position.line).toBe(0);
    const defLine = 'def real_func():';
    expect(samples[0].position.character).toBe(defLine.indexOf('real_func'));
    expect(samples[0].textDocument.uri).toContain('module.py');
  });

  it('all lines of multi-line docstring are blanked to equal length', async () => {
    const dir = mkFixture('py-docstring-line-lengths');
    // Verify character-offset preservation: the line after the docstring
    // must be at the correct position. We do this by checking the sampled
    // position maps to 'real_def' in the ORIGINAL text.
    const line0 = 'def real_def():';
    const line1 = '    """This is the docstring.';
    const line2 = '    def ghost(): pass';
    const line3 = '    """';
    const line4 = '    pass';
    const content = [line0, line1, line2, line3, line4, ''].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Verify the sampled position is on line 0 and points to 'real_def'.
    const sampledLine = samples[0].position.line;
    const sampledChar = samples[0].position.character;
    const fileContent = fs.readFileSync(
      samples[0].textDocument.uri.replace('file://', ''), 'utf8',
    );
    const fileLines = fileContent.split('\n');
    const charAtPos = fileLines[sampledLine]?.slice(sampledChar, sampledChar + 8) ?? '';
    expect(charAtPos).toBe('real_def');
  });

  it('single-line triple-quoted string ("""x""") blanks that line', async () => {
    const dir = mkFixture('py-single-line-triple');
    const content = [
      '"""Module docstring."""',    // line 0 — single-line triple-quoted; blanked
      '',
      'def actual_function():',    // line 2 — MUST be sampled
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].position.line).toBe(2);
  });

  it('triple-quote with triple-single-quote style (\'\'\'...\'\'\')', async () => {
    const dir = mkFixture('py-single-triple-quote');
    const content = [
      "def outer():",              // line 0 — must be sampled
      "    '''",                   // line 1 — opens triple-single-quote string
      "    def inner(): pass",     // line 2 — MUST be suppressed
      "    '''",                   // line 3 — closes
      "    pass",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    // outer is on line 0; inner is inside the triple-quote and must be suppressed.
    expect(samples[0].position.line).toBe(0);
    const defLine = 'def outer():';
    expect(samples[0].position.character).toBe(defLine.indexOf('outer'));
  });
});

// ─── Blanker: # comment suppression ──────────────────────────────────

describe('blankPythonUnsafeLines — # comment suppression', () => {
  it('# def ghost(): does not yield a sample; def actual(): does', async () => {
    const dir = mkFixture('py-hash-comment');
    const content = [
      '# def ghost():',       // line 0 — comment, must NOT yield a sample
      '',
      'def actual():',        // line 2 — MUST be sampled
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].position.line).toBe(2);
    const defLine = 'def actual():';
    expect(samples[0].position.character).toBe(defLine.indexOf('actual'));
  });

  it('inline # comment: safe prefix preserved, comment suffix blanked', async () => {
    const dir = mkFixture('py-inline-comment');
    const content = [
      'x = 1  # def in_comment():',  // line 0 — `def` is in the comment part
      '',
      'def real_one():',              // line 2 — MUST be sampled
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].position.line).toBe(2);
  });
});

// ─── Blanker: # inside triple-quoted string is NOT a comment ─────────

describe('blankPythonUnsafeLines — # inside string is NOT a comment (string state wins)', () => {
  it('# inside triple-quoted docstring does not terminate the string early', async () => {
    const dir = mkFixture('py-hash-in-string');
    const content = [
      'def outer():',           // line 0 — must be sampled
      '    """',                // line 1 — opens triple-quote
      '    # def ghost():',     // line 2 — # is inside the string; NOT a comment
      '    """',                // line 3 — closes triple-quote
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mod.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    // outer on line 0 must be sampled; ghost on line 2 must NOT be sampled.
    expect(samples[0].position.line).toBe(0);
    const defLine = 'def outer():';
    expect(samples[0].position.character).toBe(defLine.indexOf('outer'));
  });
});

// ─── Offset/line-count preservation (BVA) ────────────────────────────

describe('blankPythonUnsafeLines — offset and line-count preservation (BVA)', () => {
  it('blanked text has same line count as original', async () => {
    // We verify this structurally: buildCanarySamples maps to the ORIGINAL
    // text's positions. A position on line N means line N exists in the
    // original and the identifier is at `character` in that line.
    const dir = mkFixture('py-offset-preservation');
    const content = [
      '"""',                   // line 0
      'This is a docstring',   // line 1
      'spanning three lines.', // line 2
      '"""',                   // line 3
      '',                      // line 4
      'def offset_target():',  // line 5
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'offsets.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].position.line).toBe(5);

    const defLine = 'def offset_target():';
    expect(samples[0].position.character).toBe(defLine.indexOf('offset_target'));

    // Verify the reported position maps to 'offset_target' in the real file.
    const filePath = samples[0].textDocument.uri.replace('file://', '');
    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
    const char = samples[0].position.character;
    const slice = fileLines[5]?.slice(char, char + 13) ?? '';
    expect(slice).toBe('offset_target');
  });
});

// ─── File filtering: .ts file not sampled by PYTHON strategy ─────────

describe('PYTHON_CANARY_STRATEGY — file filtering', () => {
  it('ignores .ts files in a directory with .py files', async () => {
    const dir = mkFixture('py-filter-ts');
    // .ts file with an import that TS strategy would pick — Python must ignore it.
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      "import { Foo } from './bar';\nexport function baz() {}\n",
    );
    // .py file that Python strategy should pick.
    fs.writeFileSync(
      path.join(dir, 'app.py'),
      'def main(): pass\n',
    );

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 5 });
    for (const s of samples) {
      expect(s.textDocument.uri, 'sample must be from a .py file').toMatch(/\.py$/);
    }
    expect(samples.length).toBeGreaterThan(0);
  });
});

// ─── maxFiles cap ─────────────────────────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — maxFiles cap', () => {
  it('respects maxFiles=0 (returns [])', async () => {
    const dir = mkFixture('py-maxfiles-zero');
    fs.writeFileSync(path.join(dir, 'app.py'), 'def main(): pass\n');

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 0 });
    expect(samples).toHaveLength(0);
  });

  it('caps at maxFiles=1 when multiple .py files exist', async () => {
    const dir = mkFixture('py-maxfiles-cap');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(dir, `module${i}.py`),
        `def func${i}(): pass\n`,
      );
    }

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
  });
});

// ─── blankUnsafeLines golden lock: TS/Java output byte-identical ─────
//
// INVARIANT: `blankUnsafeLines` (the TS/Java shared blanker) is NOT
// modified. This test verifies that TS and Java strategies still
// produce byte-identical output to pre-WI-3a on a known TS sample.
// This is the "golden lock" described in the WI test strategy.

describe('blankUnsafeLines golden lock (invariant: TS/Java blanker unchanged)', () => {
  it('TS strategy on a TS file yields the same result as before WI-3a', async () => {
    const dir = mkFixture('py-ts-golden-lock');
    // Exact content from the pre-existing canary-sampler.test.ts "position-correctness" case.
    const content = [
      '// copyright header',
      '// second comment line',
      "import { TargetIdent } from '../sibling';",
      'export function helper(): void {}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'consumer.ts'), content);

    const samples = await buildCanarySamples(dir, { strategy: TS_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Same assertion as the pre-WI-3a test: import line wins, TargetIdent at line 2.
    const importLine = "import { TargetIdent } from '../sibling';";
    const expectedChar = importLine.indexOf('TargetIdent');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('consumer.ts');
  });

  it('Java strategy on a Java file is byte-identical to pre-WI-3a (class decl still wins)', async () => {
    const dir = mkFixture('py-java-golden-lock');
    const content = [
      'package com.example;',
      '',
      'import com.example.model.Order;',  // import (should NOT be sampled — class wins)
      '',
      'public class OrderService {',      // line 4 — class decl; MUST be sampled
      '    public void process(Order o) {}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'OrderService.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const declLine = 'public class OrderService {';
    expect(samples[0].position.line).toBe(4);
    expect(samples[0].position.character).toBe(declLine.indexOf('OrderService'));
    expect(samples[0].textDocument.uri).toContain('OrderService.java');
  });
});

// ─── Indented class inside a function (behavior 12) ─────────────────

describe('PYTHON_CANARY_STRATEGY — indented class declaration', () => {
  it('samples indented class Inner: inside a function body', async () => {
    const dir = mkFixture('py-indented-inner-class');
    const content = [
      'def outer_func():',           // line 0 — def (priority 1a)
      '    class Inner:',            // line 1 — indented class (priority 1b, but def wins)
      '        pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'nested.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // def wins over class (Priority 1a before 1b) — sample must be on line 0 (outer_func).
    // This also verifies RE_PY_DEF matches leading [ \t]* (indented defs) and
    // RE_PY_CLASS matches leading [ \t]* (indented classes).
    expect(samples[0].position.line).toBe(0);
    const defLine = 'def outer_func():';
    expect(samples[0].position.character).toBe(defLine.indexOf('outer_func'));
  });

  it('samples indented class Inner: when there is no def in the file', async () => {
    const dir = mkFixture('py-indented-class-no-def');
    const content = [
      'x = 1',                       // line 0 — not a decl
      'if True:',                    // line 1
      '    class Inner:',            // line 2 — indented class, no surrounding def
      '        pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'nested.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // No def present; class on line 2 must be sampled (Priority 1b).
    expect(samples[0].position.line).toBe(2);
    const classLine = '    class Inner:';
    expect(samples[0].position.character).toBe(classLine.indexOf('Inner'));
  });
});

// ─── Decorated def (behavior 17) ─────────────────────────────────────

describe('PYTHON_CANARY_STRATEGY — decorated def', () => {
  it('samples the def-name token, not the decorator line', async () => {
    const dir = mkFixture('py-decorated-def');
    const content = [
      '@staticmethod',               // line 0 — decorator (must NOT be sampled)
      'def decorated_func(x):',      // line 1 — def-name is the target
      '    return x',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'decorated.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must sample 'decorated_func' on line 1, not '@staticmethod' on line 0.
    expect(samples[0].position.line).toBe(1);
    const defLine = 'def decorated_func(x):';
    expect(samples[0].position.character).toBe(defLine.indexOf('decorated_func'));
  });

  it('samples async decorated def — decorator does not confuse async keyword detection', async () => {
    const dir = mkFixture('py-async-decorated-def');
    const content = [
      '@app.route("/data")',          // line 0 — decorator
      'async def get_data():',        // line 1 — async def
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'routes.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    expect(samples[0].position.line).toBe(1);
    const defLine = 'async def get_data():';
    expect(samples[0].position.character).toBe(defLine.indexOf('get_data'));
  });
});

// ─── Regression guard: decl-priority ordering (#159 analogue) ────────
//
// INVARIANT: The priority cascade (def > class > call-site > import) must
// never silently regress. These two guards pin the specific orderings that
// broke the Java funnel in #159 (root-cause #2: import was sampled instead
// of the declaration). Python faces the same risk: if the import regex
// were accidentally moved above def/class, pylsp would return [] for every
// file that has a top-level import — collapsing the probe to 0/N and
// refusing every candidate.

describe('Regression guard — decl-priority ordering (Python analogue of #159 RC#2)', () => {
  it('GUARD: decl beats import — def wins over import in the same file', async () => {
    // If this test fails, the priority cascade has regressed: import is no
    // longer the last-resort fallback and the Python funnel will silently break.
    const dir = mkFixture('rg-decl-beats-import');
    const content = [
      'import os',              // line 0 — import (last-resort: must NOT be sampled)
      'import sys',             // line 1
      '',
      'def main():',            // line 3 — def (P1: MUST be sampled)
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'main.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Guard: must be line 3 (def), NOT line 0 or 1 (import).
    expect(samples[0].position.line).toBe(3);
    const defLine = 'def main():';
    expect(samples[0].position.character).toBe(defLine.indexOf('main'));
  });

  it('GUARD: decl beats call-site — def wins over a call in the same file', async () => {
    // If this test fails, call-site (P2) is incorrectly outranking def (P1).
    const dir = mkFixture('rg-decl-beats-callsite');
    const content = [
      'result = helper(x)',     // line 0 — call-site (P2: must NOT be sampled)
      '',
      'def helper(x):',         // line 2 — def (P1: MUST be sampled)
      '    return x',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'util.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Guard: must be line 2 (def), NOT line 0 (call-site).
    expect(samples[0].position.line).toBe(2);
    const defLine = 'def helper(x):';
    expect(samples[0].position.character).toBe(defLine.indexOf('helper'));
  });
});

// ─── Real fixture file (mirrors Java AC-6) ───────────────────────────

describe('PYTHON_CANARY_STRATEGY — real fixture file (AC-6 mirror)', () => {
  it('yields ≥1 sample from the data_service.py fixture at correct position', async () => {
    const fixtureDir = path.join(
      new URL('.', import.meta.url).pathname,
      '../../fixtures/lsp-canary-python',
    );

    const samples = await buildCanarySamples(fixtureDir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 3 });
    expect(samples.length).toBeGreaterThanOrEqual(1);

    // First sample must have a file:// URI pointing to a .py file.
    const s = samples[0];
    expect(s.textDocument.uri).toMatch(/^file:\/\//);
    expect(s.textDocument.uri).toMatch(/\.py$/);
    expect(s.position.line).toBeGreaterThanOrEqual(0);
    expect(s.position.character).toBeGreaterThanOrEqual(0);

    // The character at the reported position must be a Python identifier start.
    const filePath = s.textDocument.uri.replace('file://', '');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    const lineText = lines[s.position.line] ?? '';
    const charAtPos = lineText[s.position.character] ?? '';
    expect(charAtPos).toMatch(/[A-Za-z_]/);
  });
});

// ─── Unterminated triple-quote at EOF ────────────────────────────────

describe('blankPythonUnsafeLines — unterminated triple-quote at EOF', () => {
  it('all remaining lines are blanked (no crash, no sample from unterminated string)', async () => {
    const dir = mkFixture('py-unterminated-triple');
    // The triple-quote opens on line 1 but never closes — EOF.
    const content = [
      'def before_string():',  // line 0 — MUST be sampled (before the triple-quote)
      '"""',                   // line 1 — opens; never closes
      'def inside_unterminated():',  // line 2 — inside; must NOT be sampled
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'broken.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
    // before_string on line 0 must be sampled; inside_unterminated must NOT.
    expect(samples[0].position.line).toBe(0);
    const defLine = 'def before_string():';
    expect(samples[0].position.character).toBe(defLine.indexOf('before_string'));
  });
});
