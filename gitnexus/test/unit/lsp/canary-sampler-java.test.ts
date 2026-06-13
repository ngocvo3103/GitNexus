/**
 * Unit Tests: canary-sampler — Java strategy (WI-2, AC-6)
 *
 * Tests the `JAVA_CANARY_STRATEGY` against the `TS_CANARY_STRATEGY`
 * regression lock and per-behaviour checks:
 *
 *   | Strategy | Fixture                            | Expected
 *   |----------|------------------------------------|---------------------------------------------
 *   | TS       | existing TS files (AC regression)  | same output as before WI-2 (golden lock)
 *   | Java     | import decl                        | ≥1 sample; position at import segment
 *   | Java     | class decl (no imports)            | sample at class name
 *   | Java     | method decl (no imports/class)     | sample at method name
 *   | Java     | comment-blanking (line comment)    | class name inside // comment never emitted
 *   | Java     | comment-blanking (block comment)   | class name inside block comment never emitted
 *   | Java     | .ts file in java fixture dir       | ignored (isCandidateFile returns false)
 *   | Java     | empty dir                          | [] (no samples)
 *
 * Tests use in-memory fixture files written to tmp directories so
 * they are hermetic (no dependency on repo layout).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCanarySamples, TS_CANARY_STRATEGY, JAVA_CANARY_STRATEGY } from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-canary-java-'));
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

// ─── AC regression lock: TS strategy output unchanged ────────────────

describe('TS_CANARY_STRATEGY regression lock (AC-2)', () => {
  it('TS strategy on a known TS file yields same position as before WI-2', async () => {
    const dir = mkFixture('ts-regression-lock');
    // Exact content used in existing canary-sampler.test.ts "position-correctness" case.
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

    // Same assertion as the pre-WI-2 test: import line wins, TargetIdent at line 2.
    const importLine = "import { TargetIdent } from '../sibling';";
    const expectedChar = importLine.indexOf('TargetIdent');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toBe('file://' + path.join(dir, 'consumer.ts'));
  });

  it('default strategy (no opts) identical to TS_CANARY_STRATEGY for a TS file', async () => {
    const dir = mkFixture('ts-default-vs-explicit');
    const content = "import { Foo } from './bar';\nexport function baz() {}\n";
    fs.writeFileSync(path.join(dir, 'a.ts'), content);

    const withDefault = await buildCanarySamples(dir, { maxFiles: 1 });
    const withExplicit = await buildCanarySamples(dir, { strategy: TS_CANARY_STRATEGY, maxFiles: 1 });

    expect(withDefault).toEqual(withExplicit);
  });

  it('null strategy falls back to TS_CANARY_STRATEGY', async () => {
    const dir = mkFixture('ts-null-strategy');
    const content = "import { X } from './y';\n";
    fs.writeFileSync(path.join(dir, 'a.ts'), content);

    const withNull = await buildCanarySamples(dir, { strategy: null, maxFiles: 1 });
    const withExplicit = await buildCanarySamples(dir, { strategy: TS_CANARY_STRATEGY, maxFiles: 1 });

    expect(withNull).toEqual(withExplicit);
  });
});

// ─── Java strategy: isCandidateFile ─────────────────────────────────

describe('JAVA_CANARY_STRATEGY — isCandidateFile', () => {
  it('accepts .java files', () => {
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('Foo.java')).toBe(true);
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('com_example_Bar.java')).toBe(true);
  });

  it('rejects .ts files', () => {
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('index.ts')).toBe(false);
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('main.tsx')).toBe(false);
  });

  it('rejects non-java files', () => {
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('README.md')).toBe(false);
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('pom.xml')).toBe(false);
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('build.gradle')).toBe(false);
  });
});

// ─── Java strategy: type-decl wins over import (#159 root cause #2) ──
//
// REGRESSION GUARD. The pre-fix strategy put the FQN import FIRST, which
// shipped the #159 Java funnel broken: jdtls returns [] for a
// `textDocument/definition` request on the type token inside an `import`
// declaration (it is a reference declaration, not a navigable usage), so
// the workspace-readiness probe scored 0/N on every Java file with
// imports and the whole Mode-A funnel refused every candidate. The type
// declaration name resolves reliably (jdtls returns the declaration's own
// Location), so it MUST be sampled in preference to the import. These
// tests pin that ordering so the regression cannot silently return.

describe('JAVA_CANARY_STRATEGY — type decl beats import (#159 RC#2 regression guard)', () => {
  it('a file with BOTH an import and a class decl samples the CLASS, not the import', async () => {
    const dir = mkFixture('java-import-and-class');
    const content = [
      'package com.example.service;',
      '',
      'import com.example.model.Order;',   // line 2 — import: jdtls returns [] here (the bug)
      '',
      'public class OrderService {',       // line 4 — type decl: jdtls RESOLVES here
      '    public void process(Order o) {}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'OrderService.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // MUST be the class declaration on line 4 — NOT the import on line 2.
    // Sampling line 2 is exactly the #159 root-cause-#2 bug.
    const declLine = 'public class OrderService {';
    const expectedChar = declLine.indexOf('OrderService');
    expect(samples[0].position.line).toBe(4);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('OrderService.java');
  });

  it('import is sampled ONLY as a last-resort fallback (no type decl, no method)', async () => {
    // Pathological compilation unit: an import but neither a top-level
    // type declaration nor a method signature. Vanishingly rare in real
    // Java, but the import fallback must still yield *a* sample so the
    // file is not silently dropped from the canary set.
    const dir = mkFixture('java-import-only');
    const content = [
      'package com.example;',
      '',
      'import static com.example.Constants.MAX_SIZE;',  // line 2 — the only candidate
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'package-info.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const importLine = 'import static com.example.Constants.MAX_SIZE;';
    const expectedChar = importLine.indexOf('MAX_SIZE');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── Java strategy: Priority 1 — class/interface/enum decl ──────────

describe('JAVA_CANARY_STRATEGY — type declaration (Priority 1)', () => {
  it('extracts class name when no imports present', async () => {
    const dir = mkFixture('java-class-decl');
    const content = [
      'package com.example;',
      '',
      'public class MyService {',   // line 2
      '    void doWork() {}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'MyService.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const declLine = 'public class MyService {';
    const expectedChar = declLine.indexOf('MyService');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('extracts interface name', async () => {
    const dir = mkFixture('java-interface-decl');
    const content = [
      'package com.example;',
      '',
      'public interface PaymentProcessor {',   // line 2
      '    void process();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'PaymentProcessor.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const declLine = 'public interface PaymentProcessor {';
    const expectedChar = declLine.indexOf('PaymentProcessor');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('extracts enum name', async () => {
    const dir = mkFixture('java-enum-decl');
    const content = [
      'package com.example;',
      '',
      'public enum Status {',   // line 2
      '    PENDING, ACTIVE, CLOSED',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'Status.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const declLine = 'public enum Status {';
    const expectedChar = declLine.indexOf('Status');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── Java strategy: Priority 3 — method signature ───────────────────

describe('JAVA_CANARY_STRATEGY — method signature (Priority 3)', () => {
  it('falls through to method name when no import or type decl matches', async () => {
    // An unusual file with no import, no class/interface/enum — just a method body.
    // In practice this won't happen, but we test the fallthrough chain.
    const dir = mkFixture('java-method-only');
    const content = [
      '// Standalone method in default package',
      'void processRequest(String input) {',   // line 1
      '    // body',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'handler.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const methodLine = 'void processRequest(String input) {';
    const expectedChar = methodLine.indexOf('processRequest');
    expect(samples[0].position.line).toBe(1);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── Java strategy: comment blanking — invariant ────────────────────

describe('JAVA_CANARY_STRATEGY — comment blanking (invariant: no false positives)', () => {
  it('class name inside a // line comment is never yielded as a sample position', async () => {
    const dir = mkFixture('java-line-comment-blanking');
    // The only "class" keyword is in a line comment.
    // The real class keyword comes after, and that's what should be yielded.
    const content = [
      '// public class CommentedClass {',    // line 0 — in comment, must NOT be picked
      '',
      'public class RealClass {',            // line 2 — must be picked
      '    void run() {}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'RealClass.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must point to line 2 (RealClass), NOT line 0 (CommentedClass in line comment).
    expect(samples[0].position.line).toBe(2);
    const declLine = 'public class RealClass {';
    const expectedChar = declLine.indexOf('RealClass');
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('class name inside a block comment is never yielded as a sample position', async () => {
    const dir = mkFixture('java-block-comment-blanking');
    const content = [
      '/*',
      ' * public class InsideBlockComment {',  // line 1 — in block comment, must NOT be picked
      ' */',
      '',
      'public class RealImpl {',               // line 4 — must be picked
      '    void run() {}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'RealImpl.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must point to line 4 (RealImpl), NOT line 1 (InsideBlockComment in block comment).
    expect(samples[0].position.line).toBe(4);
    const declLine = 'public class RealImpl {';
    const expectedChar = declLine.indexOf('RealImpl');
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('import/type names inside a block comment are never yielded (type decl wins)', async () => {
    const dir = mkFixture('java-block-comment-import-blanking');
    const content = [
      '/*',
      ' * import com.example.CommentedImport;',  // line 1 — in block comment
      ' */',
      '',
      'import com.example.RealImport;',           // line 4 — real import (now demoted)
      '',
      'public class Foo {}',                      // line 6 — type decl now wins (#159 RC#2)
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'Foo.java'), content);

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Post-#159-RC#2: the type declaration (line 6) is sampled in
    // preference to the import (line 4). The commented import on line 1
    // is never picked (comment-blanking invariant holds either way).
    expect(samples[0].position.line).toBe(6);
    const declLine = 'public class Foo {}';
    const expectedChar = declLine.indexOf('Foo');
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── Java strategy: file filtering ──────────────────────────────────

describe('JAVA_CANARY_STRATEGY — file filtering', () => {
  it('ignores .ts files in a directory that also has .java files', async () => {
    const dir = mkFixture('java-filter-ts');
    // The .ts file has an import that TS strategy would pick — Java strategy must ignore it.
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      "import { Foo } from './bar';\nexport function baz() {}\n",
    );
    fs.writeFileSync(
      path.join(dir, 'Service.java'),
      'public class Service {}\n',
    );

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 5 });
    // All samples must come from .java files only.
    for (const s of samples) {
      expect(s.textDocument.uri, 'sample must be from a .java file').toMatch(/\.java$/);
    }
    // At least one .java sample must be present.
    expect(samples.length).toBeGreaterThan(0);
  });

  it('returns [] for a directory with no .java files', async () => {
    const dir = mkFixture('java-no-java-files');
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>\n');
    // Even a .ts file should not match the Java strategy.
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      "import { X } from './y';\n",
    );

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('returns [] for an empty directory', async () => {
    const dir = mkFixture('java-empty-dir');
    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });
});

// ─── Java strategy: on real fixture file ────────────────────────────

describe('JAVA_CANARY_STRATEGY — real fixture file (AC-6)', () => {
  it('yields ≥1 sample from the OrderService.java fixture at correct position', async () => {
    const fixtureDir = path.join(
      new URL('.', import.meta.url).pathname,
      '../../fixtures/lsp-canary-java',
    );

    const samples = await buildCanarySamples(fixtureDir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 3 });
    expect(samples.length).toBeGreaterThanOrEqual(1);

    // The first sample must have a file:// URI and a valid 0-indexed position.
    const s = samples[0];
    expect(s.textDocument.uri).toMatch(/^file:\/\//);
    expect(s.textDocument.uri).toMatch(/\.java$/);
    expect(s.position.line).toBeGreaterThanOrEqual(0);
    expect(s.position.character).toBeGreaterThanOrEqual(0);

    // Verify the position actually points to a Java identifier in the file.
    const filePath = s.textDocument.uri.replace('file://', '');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    const lineText = lines[s.position.line] ?? '';
    // The character at the reported position should be a Java identifier start.
    const charAtPos = lineText[s.position.character] ?? '';
    expect(charAtPos).toMatch(/[A-Za-z_]/);
  });
});

// ─── maxFiles cap works with Java strategy ───────────────────────────

describe('JAVA_CANARY_STRATEGY — maxFiles cap', () => {
  it('respects maxFiles=0 (returns [])', async () => {
    const dir = mkFixture('java-maxfiles-zero');
    fs.writeFileSync(path.join(dir, 'Foo.java'), 'public class Foo {}\n');

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 0 });
    expect(samples).toHaveLength(0);
  });

  it('caps at maxFiles=1 when multiple .java files exist', async () => {
    const dir = mkFixture('java-maxfiles-cap');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(dir, `Service${i}.java`),
        `public class Service${i} {}\n`,
      );
    }

    const samples = await buildCanarySamples(dir, { strategy: JAVA_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
  });
});
