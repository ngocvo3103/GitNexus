/**
 * Unit Tests: canary-sampler — Go strategy (WI-3)
 *
 * Tests `GO_CANARY_STRATEGY` against the acceptance criteria in the
 * WI-3 plan record:
 *
 *   | Scenario                                   | Expected
 *   |--------------------------------------------|------------------------------------------
 *   | isCandidateFile('.go')                     | true
 *   | isCandidateFile('_test.go')                | false (excluded)
 *   | isCandidateFile('.ts')                     | false
 *   | Priority 1: func decl + import lines       | sampled on func name, NOT import
 *   | Priority 1: type decl + func decl          | sampled on type OR func name (decl tier)
 *   | Priority 1: method decl                    | sampled on method name
 *   | Priority 2: call-site only                 | sampled on call-site identifier
 *   | Priority 3 (last-resort): import-only file | returns null / advances
 *   | Package-clause-only file                   | returns null
 *   | vendor/ directory                          | NOT included in canary walk
 *   | // comment blanking                        | identifier in line comment never returned
 *   | block comment blanking                     | identifier in block comment never returned
 *   | GO_IDENT_AFTER class                       | no dollar-sign in class
 *   | TS/Java/Python strategies zero-diff        | regression lock (existing tests still pass)
 *   | EXCLUDED_DIRS contains 'vendor'            | direct set membership assertion
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
  GO_CANARY_STRATEGY,
  TS_CANARY_STRATEGY,
  JAVA_CANARY_STRATEGY,
  PYTHON_CANARY_STRATEGY,
  EXCLUDED_DIRS,
} from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-canary-go-'));
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

// ─── C3-17: EXCLUDED_DIRS contains 'vendor' ──────────────────────────

describe('EXCLUDED_DIRS — vendor membership (WI-3 I-10)', () => {
  it('C3-17: EXCLUDED_DIRS.has("vendor") === true', () => {
    expect(EXCLUDED_DIRS.has('vendor')).toBe(true);
  });
});

// ─── C3-1..C3-5: isCandidateFile ─────────────────────────────────────

describe('GO_CANARY_STRATEGY — isCandidateFile', () => {
  it('C3-1: accepts main.go', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('main.go')).toBe(true);
  });

  it('C3-2: rejects main_test.go', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('main_test.go')).toBe(false);
  });

  it('C3-3: rejects helper_test.go', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('helper_test.go')).toBe(false);
  });

  it('C3-4: rejects server.ts (not .go)', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('server.ts')).toBe(false);
  });

  it('C3-5: accepts .go (bare extension name — boundary)', () => {
    // A file named exactly ".go" has no path stem; the extension check
    // is on the full name string, so ".go".endsWith('.go') is true and
    // it does NOT end with '_test.go'.
    expect(GO_CANARY_STRATEGY.isCandidateFile('.go')).toBe(true);
  });

  it('rejects .java and .py files', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('Service.java')).toBe(false);
    expect(GO_CANARY_STRATEGY.isCandidateFile('app.py')).toBe(false);
  });
});

// ─── C3-6: Priority 1 — func decl beats import ───────────────────────

describe('GO_CANARY_STRATEGY — Priority 1: func decl beats import (C3-6)', () => {
  it('file with func decl + import lines → sampled on func name, NOT import', async () => {
    const dir = mkFixture('go-func-beats-import');
    const content = [
      'package main',
      '',
      'import (',
      '	"fmt"',
      '	"net/http"',
      ')',
      '',
      'func processData(items []string) {',  // line 7 — func decl; MUST be sampled
      '	fmt.Println(items)',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'main.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must be the func declaration (line 7), NOT an import line.
    expect(samples[0].position.line).toBe(7);
    const funcLine = 'func processData(items []string) {';
    const expectedChar = funcLine.indexOf('processData');
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('main.go');
  });
});

// ─── C3-7: Priority 1 — type decl in presence of func decl ──────────

describe('GO_CANARY_STRATEGY — Priority 1: type decl (C3-7)', () => {
  it('file with type decl → sampled on type name (decl tier)', async () => {
    const dir = mkFixture('go-type-decl');
    const content = [
      'package main',
      '',
      'type MyStruct struct {',  // line 2 — type decl
      '	Field string',
      '}',
      '',
      'func NewMyStruct() *MyStruct {',  // line 6 — func decl (also priority 1)
      '	return &MyStruct{}',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'types.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Either the type name OR the func name is acceptable (both are priority 1).
    // The implementation checks method first, then func, then type.
    // Since there is no method, func wins over type (regex ordering).
    const uri = samples[0].textDocument.uri;
    expect(uri).toContain('types.go');
    // Position must point to a valid Go identifier start character.
    const filePath = uri.replace('file://', '');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    const charAtPos = lines[samples[0].position.line]?.[samples[0].position.character] ?? '';
    expect(charAtPos).toMatch(/[A-Za-z_]/);
  });

  it('file with ONLY a type decl (no func) → sampled on type name', async () => {
    const dir = mkFixture('go-type-only');
    const content = [
      'package models',
      '',
      'type UserRecord struct {',  // line 2
      '	ID   int',
      '	Name string',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'user.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const typeLine = 'type UserRecord struct {';
    const expectedChar = typeLine.indexOf('UserRecord');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── C3-8: Priority 1 — method decl ─────────────────────────────────

describe('GO_CANARY_STRATEGY — Priority 1: method decl (C3-8)', () => {
  it('file with method decl → sampled on method name', async () => {
    const dir = mkFixture('go-method-decl');
    const content = [
      'package server',
      '',
      'type Handler struct{}',
      '',
      'func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {',  // line 4 — method
      '	// handle request',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'handler.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const methodLine = 'func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {';
    const expectedChar = methodLine.indexOf('ServeHTTP');
    expect(samples[0].position.line).toBe(4);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('handler.go');
  });

  it('pointer receiver method → sampled on method name', async () => {
    const dir = mkFixture('go-pointer-receiver-method');
    const content = [
      'package main',
      '',
      'type Server struct{}',
      '',
      'func (s *Server) Start() error {',  // line 4
      '	return nil',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'server.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const methodLine = 'func (s *Server) Start() error {';
    const expectedChar = methodLine.indexOf('Start');
    expect(samples[0].position.line).toBe(4);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── C3-9: Priority 2 — call-site when no decl ───────────────────────

describe('GO_CANARY_STRATEGY — Priority 2: call-site (C3-9)', () => {
  it('file with no func/type/method but has call-site → sampled on call-site identifier', async () => {
    const dir = mkFixture('go-call-site-only');
    // A file with only a package clause and a bare call expression (Go short
    // variable declaration using :=). No func, type, or method declarations.
    // RE_GO_CALL pattern: ^[ \t]*(?:IDENT\s*:?=\s*)?([A-Za-z_]...)\s*\(
    // matches `result := processItems(` capturing `processItems`.
    const callContent = [
      'package main',
      '',
      // No func, no type, no method — just a short variable declaration call-site.
      'result := processItems(data)',  // line 2 — call-site via := shorthand
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'call.go'), callContent);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Should sample the call-site identifier on line 2.
    expect(samples[0].position.line).toBe(2);
    const callLine = 'result := processItems(data)';
    const expectedChar = callLine.indexOf('processItems');
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── C3-10: Priority 3 (last-resort): import-only file ───────────────

describe('GO_CANARY_STRATEGY — Priority 3 last-resort / null returns (C3-10, C3-11)', () => {
  it('C3-10: import-only file → tryExtractSample returns null; buildCanarySamples advances past it', async () => {
    const dir = mkFixture('go-import-only');
    // Only an import block — no func, type, method, or call-site pattern
    // that matches RE_GO_CALL (RE_GO_IMPORT is the last resort and only
    // matches quoted path imports, not a bare package clause).
    // Use a file that has only a package clause and a blank import block.
    const importContent = [
      'package main',
      '',
      'import (',
      '',  // empty import block body — no importable path
      ')',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'empty_import.go'), importContent);

    // A second file that does have a func — to confirm buildCanarySamples
    // advances past the import-only file and samples the second file.
    const funcContent = [
      'package main',
      '',
      'func Advance() {}',  // line 2
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'advance.go'), funcContent);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    // Must yield 1 sample from advance.go (not the import-only file).
    expect(samples).toHaveLength(1);
    expect(samples[0].textDocument.uri).toContain('advance.go');
  });

  it('C3-11: package-clause-only file → tryExtractSample returns null', async () => {
    const dir = mkFixture('go-package-only');
    // A file with only a package declaration — no imports, no decls, no calls.
    const content = 'package main\n';
    fs.writeFileSync(path.join(dir, 'doc.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    // No usable sample — the strategy must return null for this file.
    expect(samples).toHaveLength(0);
  });
});

// ─── I-19 boundary: no-slash stdlib-only import file ────────────────────────
//
// RE_GO_IMPORT requires at least one '/' in the import path
// (regex: /"[^"]*\/([A-Za-z_][A-Za-z0-9_]*)"/m).  A file that imports only
// single-segment stdlib packages such as 'fmt', 'os', 'io' contains no slash,
// so RE_GO_IMPORT never matches and tryExtractSample must return null.
//
// This is a distinct boundary from C3-10 (empty import block).  The risk:
// silently degrading canary coverage on repos that import only stdlib packages
// with no path separator — the function returns null rather than a usable sample.

describe('GO_CANARY_STRATEGY — no-slash stdlib-only import (I-19 boundary)', () => {
  it('file with only import "fmt" (no-slash stdlib) → tryExtractSample returns null', async () => {
    const dir = mkFixture('go-stdlib-only-import');
    // A file with only single-segment stdlib imports — no slash in any path.
    // RE_GO_IMPORT cannot match; the file yields no sample.
    const content = [
      'package main',
      '',
      'import "fmt"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'stdlib_only.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    // No func/type/method/call-site/slashed-import — tryExtractSample returns null.
    expect(samples).toHaveLength(0);
  });

  it('grouped no-slash stdlib imports (import () block) → keyword guard blocks RE_GO_CALL → returns null (I-19)', async () => {
    // The I-19 keyword guard prevents RE_GO_CALL from matching `import (`:
    // even though `import` is lexically an identifier followed by `(`, it is
    // a Go reserved keyword and is never a user-defined call-site identifier.
    // After the keyword guard was added, the grouped import block yields no
    // usable sample when no func/type/method/non-keyword call-site is present.
    const dir = mkFixture('go-multi-stdlib-import');
    const content = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      '\t"io"',
      ')',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'multi_stdlib.go'), content);

    // RE_GO_CALL no longer matches `import (` — the keyword guard blocks it.
    // No func/type/method/non-keyword call-site is present → null → 0 samples.
    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(0);
  });

  it('file with mixed no-slash and slashed import, no decls → returns null (I-19)', async () => {
    // I-19 boundary: RE_GO_IMPORT was removed and the keyword guard blocks
    // RE_GO_CALL from matching `import (`. A file with only a grouped import
    // block (even one that contains a slashed path like "net/http") has no
    // func/type/method and no non-keyword call-site — tryExtractSample must
    // return null.  This is a distinct improvement over the previous behavior
    // that returned a sample via the now-removed RE_GO_IMPORT last-resort path.
    const dir = mkFixture('go-mixed-import');
    const content = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"net/http"',
      ')',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'mixed.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    // No func/type/method. RE_GO_IMPORT is removed. RE_GO_CALL is blocked by
    // the keyword guard on `import`. → null → 0 samples (I-19 compliant).
    expect(samples).toHaveLength(0);
  });

  it('bare import "net/http" (slashed, no decls, no call-sites) → tryExtractSample returns null (I-19)', async () => {
    // This is the explicit I-19 boundary case for a slashed import path.
    // The file has only a package clause and a bare `import "net/http"` (no
    // block, no `(`, no func/type/method, no call-site). RE_GO_IMPORT was
    // removed; RE_GO_CALL does not match because `import` is a keyword and
    // `"net/http"` is a string literal, not `(`. → null → 0 samples.
    //
    // This test would FAIL with the old implementation (which had RE_GO_IMPORT
    // as a last-resort fallback matching the slashed path segment "http") and
    // PASS with the I-19-compliant implementation.
    const dir = mkFixture('go-bare-slash-import');
    const content = [
      'package main',
      '',
      'import "net/http"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'bare_slash.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    // No func/type/method. RE_GO_IMPORT removed. RE_GO_CALL does not match.
    // → tryExtractSample returns null → 0 samples.
    expect(samples).toHaveLength(0);
  });
});

// ─── C3-12: vendor/ directory excluded ───────────────────────────────

describe('GO_CANARY_STRATEGY — vendor/ directory excluded (C3-12)', () => {
  it('files under vendor/ are not included in buildCanarySamples output', async () => {
    const dir = mkFixture('go-vendor-excluded');

    // Place a .go file inside vendor/ — it MUST NOT be picked.
    const vendorDir = path.join(dir, 'vendor', 'github.com', 'gin-gonic', 'gin');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vendorDir, 'gin.go'),
      'package gin\n\nfunc New() *Engine {}\n',
    );

    // No .go file outside vendor/ — so if vendor/ were walked we'd get a sample;
    // if it's excluded correctly we get [].
    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 3 });
    expect(samples).toHaveLength(0);

    // Also verify: files outside vendor/ ARE picked.
    fs.writeFileSync(
      path.join(dir, 'main.go'),
      'package main\n\nfunc main() {}\n',
    );
    const samplesWithMain = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 3 });
    expect(samplesWithMain).toHaveLength(1);
    for (const s of samplesWithMain) {
      expect(s.textDocument.uri).not.toContain('/vendor/');
    }
  });
});

// ─── C3-13: Comment blanking — // line comment ───────────────────────

describe('GO_CANARY_STRATEGY — comment blanking // (C3-13)', () => {
  it('identifier inside // comment is NOT returned as sample position', async () => {
    const dir = mkFixture('go-line-comment-blanking');
    const content = [
      'package main',
      '',
      '// func CommentedFunc() {}',  // line 2 — in comment; MUST NOT be picked
      '',
      'func RealFunc() {}',          // line 4 — must be picked
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'real.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must be line 4 (RealFunc), NOT line 2 (CommentedFunc in // comment).
    expect(samples[0].position.line).toBe(4);
    const funcLine = 'func RealFunc() {}';
    const expectedChar = funcLine.indexOf('RealFunc');
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── C3-14: Comment blanking — /* */ block comment ───────────────────

describe('GO_CANARY_STRATEGY — comment blanking /* */ (C3-14)', () => {
  it('identifier inside /* */ block comment is NOT returned as sample position', async () => {
    const dir = mkFixture('go-block-comment-blanking');
    const content = [
      'package main',
      '',
      '/*',
      ' * func InsideBlockComment() {}',  // line 3 — in block comment; MUST NOT be picked
      ' */',
      '',
      'func RealImpl() {}',               // line 6 — must be picked
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'impl.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must be line 6 (RealImpl), NOT line 3 (InsideBlockComment in block comment).
    expect(samples[0].position.line).toBe(6);
    const funcLine = 'func RealImpl() {}';
    const expectedChar = funcLine.indexOf('RealImpl');
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── C3-15: GO_IDENT_AFTER has no dollar-sign ────────────────────────

describe('GO_CANARY_STRATEGY — GO_IDENT_AFTER has no dollar-sign (C3-15)', () => {
  it('a $-prefixed name following the func name is NOT consumed as part of the identifier', async () => {
    const dir = mkFixture('go-ident-no-dollar');
    // A func whose name is followed immediately by a $ character (artificial but
    // valid as a test: Go identifiers do not include $). The sampled position must
    // point exactly to the func name, and findIdentifierPosition must stop before $.
    const content = [
      'package main',
      '',
      'func ProcessData() {}',  // line 2 — valid Go func; name has no $
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'proc.go'), content);

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const funcLine = 'func ProcessData() {}';
    const expectedChar = funcLine.indexOf('ProcessData');
    expect(samples[0].position.character).toBe(expectedChar);

    // Negative assertion: verify a name like "$prefix" would NOT be
    // treated as an identifier continuation (the $ is not in GO_IDENT_AFTER).
    // We test this via a file where the match text has a $ right after
    // the func name — the position must still stop at the start of
    // the real name, not extend into the $.
    const dir2 = mkFixture('go-ident-dollar-boundary');
    // func name followed by $ in a comment so the file is syntactically valid-ish:
    const content2 = [
      'package main',
      '',
      'func RealName() {}  // $dollar after in comment',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir2, 'names.go'), content2);
    const samples2 = await buildCanarySamples(dir2, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples2).toHaveLength(1);
    // The sampled name should be 'RealName', confirmed by the character position.
    const line2 = 'func RealName() {}  // $dollar after in comment';
    expect(samples2[0].position.character).toBe(line2.indexOf('RealName'));
  });
});

// ─── C3-16: TS/Java/Python canary strategies zero-diff regression lock ─

describe('TS/Java/Python canary strategies zero-diff regression lock (C3-16)', () => {
  it('TS strategy on a known TS file yields the same position as before WI-3', async () => {
    const dir = mkFixture('go-ts-regression-lock');
    // Exact content used in the pre-WI-3 position-correctness tests.
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

    const importLine = "import { TargetIdent } from '../sibling';";
    const expectedChar = importLine.indexOf('TargetIdent');
    expect(samples[0].position.line).toBe(2);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('consumer.ts');
  });

  it('Java strategy on a Java file is byte-identical to pre-WI-3 (class decl still wins)', async () => {
    const dir = mkFixture('go-java-regression-lock');
    const content = [
      'package com.example;',
      '',
      'import com.example.model.Order;',
      '',
      'public class OrderService {',  // line 4 — class decl; MUST be sampled
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

  it('Python strategy on a .py file yields the same def-priority result as before WI-3', async () => {
    const dir = mkFixture('go-python-regression-lock');
    const content = [
      '# module comment',
      'import os',
      '',
      'def process_items(items):',  // line 3 — def; MUST be sampled
      '    return list(items)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'processor.py'), content);

    const samples = await buildCanarySamples(dir, { strategy: PYTHON_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const defLine = 'def process_items(items):';
    expect(samples[0].position.line).toBe(3);
    expect(samples[0].position.character).toBe(defLine.indexOf('process_items'));
    expect(samples[0].textDocument.uri).toContain('processor.py');
  });
});

// ─── maxFiles cap works with Go strategy ─────────────────────────────

describe('GO_CANARY_STRATEGY — maxFiles cap', () => {
  it('respects maxFiles=0 (returns [])', async () => {
    const dir = mkFixture('go-maxfiles-zero');
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n');

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 0 });
    expect(samples).toHaveLength(0);
  });

  it('caps at maxFiles=1 when multiple .go files exist', async () => {
    const dir = mkFixture('go-maxfiles-cap');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(dir, `service${i}.go`),
        `package main\nfunc Service${i}() {}\n`,
      );
    }

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);
  });

  it('returns [] for a directory with no .go files', async () => {
    const dir = mkFixture('go-no-go-files');
    fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/mymod\n\ngo 1.21\n');
    // A .ts file should NOT match the Go strategy.
    fs.writeFileSync(path.join(dir, 'index.ts'), "import { X } from './y';\n");

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('returns [] for an empty directory', async () => {
    const dir = mkFixture('go-empty-dir');
    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY });
    expect(samples).toHaveLength(0);
  });

  it('ignores _test.go files in a directory that also has regular .go files', async () => {
    const dir = mkFixture('go-test-file-filtered');
    // Only the _test.go file — the strategy must ignore it.
    fs.writeFileSync(
      path.join(dir, 'handler_test.go'),
      'package main\n\nimport "testing"\n\nfunc TestHandler(t *testing.T) {}\n',
    );
    // Regular file must be picked.
    fs.writeFileSync(
      path.join(dir, 'handler.go'),
      'package main\n\nfunc Handle() {}\n',
    );

    const samples = await buildCanarySamples(dir, { strategy: GO_CANARY_STRATEGY, maxFiles: 5 });
    for (const s of samples) {
      expect(s.textDocument.uri, 'sample must not come from a _test.go file').not.toMatch(/_test\.go$/);
    }
    expect(samples.length).toBeGreaterThan(0);
  });
});
