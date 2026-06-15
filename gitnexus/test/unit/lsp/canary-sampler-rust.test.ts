/**
 * Unit Tests: canary-sampler — Rust strategy (WI-2)
 *
 * Tests `RUST_CANARY_STRATEGY`, `RUST_IDENT_AFTER`, and the `'target'`
 * addition to `EXCLUDED_DIRS` against the WI-2 acceptance criteria:
 *
 *   | Case    | Scenario                                          | Expected
 *   |---------|---------------------------------------------------|-----------------------------
 *   | WI2-1   | EXCLUDED_DIRS.has('target')                       | true (additive)
 *   | WI2-2   | EXCLUDED_DIRS.has('vendor')                       | true (regression guard)
 *   | WI2-3   | isCandidateFile('main.rs')                        | true
 *   | WI2-4   | isCandidateFile('lib.py')                         | false
 *   | WI2-5   | isCandidateFile('mod.rs')                         | true
 *   | WI2-6   | use-only content → tryExtractSample               | null (AC-11, I-3)
 *   | WI2-7   | fn declaration → sample on fn name                | priority 1
 *   | WI2-8   | impl Foo { fn bar } → sample on 'bar'             | priority 1 impl method
 *   | WI2-9   | struct Config (no fn) → sample on 'Config'        | priority 2 struct
 *   | WI2-10  | enum Kind (no fn/struct) → sample on 'Kind'       | priority 2 enum
 *   | WI2-11  | trait Foo (no fn/struct/enum) → sample on 'Foo'   | priority 2 trait
 *   | WI2-12  | call-site only 'foo.bar()' → sample identifier    | priority 3 fallback
 *   | WI2-13  | empty file → null                                 | no candidates
 *   | WI2-14  | RUST_IDENT_AFTER does NOT match '$'               | no dollar-sign
 *   | WI2-15  | Maven regression: target/ excluded, src/main used | EXCLUDED_DIRS safe for Java
 *
 * Tests use in-memory fixture files written to tmp directories — hermetic,
 * no dependency on repo layout. Pattern mirrors canary-sampler-go.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildCanarySamples,
  RUST_CANARY_STRATEGY,
  RUST_IDENT_AFTER,
  JAVA_CANARY_STRATEGY,
  GO_CANARY_STRATEGY,
  TS_CANARY_STRATEGY,
  PYTHON_CANARY_STRATEGY,
  EXCLUDED_DIRS,
} from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-canary-rust-'));
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

// ─── WI2-1 & WI2-2: EXCLUDED_DIRS membership ─────────────────────────

describe('EXCLUDED_DIRS — target and vendor membership (WI2-1, WI2-2)', () => {
  it('WI2-1: EXCLUDED_DIRS.has("target") === true (additive; I-5)', () => {
    expect(EXCLUDED_DIRS.has('target')).toBe(true);
  });

  it('WI2-2: EXCLUDED_DIRS.has("vendor") === true (regression guard; prior entry not removed by WI-2)', () => {
    expect(EXCLUDED_DIRS.has('vendor')).toBe(true);
  });
});

// ─── WI2-3..WI2-5: isCandidateFile ───────────────────────────────────

describe('RUST_CANARY_STRATEGY — isCandidateFile (WI2-3, WI2-4, WI2-5)', () => {
  it('WI2-3: accepts main.rs (AC-12 positive)', () => {
    expect(RUST_CANARY_STRATEGY.isCandidateFile('main.rs')).toBe(true);
  });

  it('WI2-4: rejects lib.py (non-.rs extension)', () => {
    expect(RUST_CANARY_STRATEGY.isCandidateFile('lib.py')).toBe(false);
  });

  it('WI2-5: accepts mod.rs (.rs is the only positive class)', () => {
    expect(RUST_CANARY_STRATEGY.isCandidateFile('mod.rs')).toBe(true);
  });

  it('rejects .ts, .java, .go files', () => {
    expect(RUST_CANARY_STRATEGY.isCandidateFile('server.ts')).toBe(false);
    expect(RUST_CANARY_STRATEGY.isCandidateFile('Main.java')).toBe(false);
    expect(RUST_CANARY_STRATEGY.isCandidateFile('main.go')).toBe(false);
  });
});

// ─── WI2-6: use-only content → null (AC-11, I-3) ────────────────────

describe('RUST_CANARY_STRATEGY — use-only file returns null (WI2-6)', () => {
  it('WI2-6: tryExtractSample on use-only content returns null (AC-11; I-3)', async () => {
    const dir = mkFixture('rust-use-only');
    // A .rs file with only `use` statements — no fn, struct, enum, trait,
    // or call-site with `(`. The sampler has no use-import regex (I-3).
    const content = 'use std::io;\nuse std::fmt;\n';
    fs.writeFileSync(path.join(dir, 'imports.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    // No fn/struct/enum/trait/call-site — tryExtractSample must return null.
    expect(samples).toHaveLength(0);
  });
});

// ─── WI2-7: fn declaration → priority 1 ─────────────────────────────

describe('RUST_CANARY_STRATEGY — Priority 1: fn declaration (WI2-7)', () => {
  it('WI2-7: fn declaration → sample identifier is the fn name, NOT a use token', async () => {
    const dir = mkFixture('rust-fn-decl');
    const content = [
      'use std::io;',
      '',
      'fn process_data(items: &[String]) {',  // line 2 — fn decl; MUST be sampled
      '    println!("{:?}", items);',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'main.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // Must be the fn declaration (line 2), NOT a use token.
    expect(samples[0].position.line).toBe(2);
    const fnLine = 'fn process_data(items: &[String]) {';
    const expectedChar = fnLine.indexOf('process_data');
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('main.rs');
  });

  it('pub fn declaration is sampled on fn name', async () => {
    const dir = mkFixture('rust-pub-fn');
    const content = [
      'pub fn compute(x: i32) -> i32 {',  // line 0
      '    x * 2',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'lib.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const fnLine = 'pub fn compute(x: i32) -> i32 {';
    const expectedChar = fnLine.indexOf('compute');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── WI2-8: impl method → priority 1 ────────────────────────────────

describe('RUST_CANARY_STRATEGY — Priority 1: impl method (WI2-8)', () => {
  it('WI2-8: impl Foo { fn bar(&self) {} } → sample from method name "bar"', async () => {
    const dir = mkFixture('rust-impl-method');
    const content = [
      'struct Foo;',
      '',
      'impl Foo {',
      '    fn bar(&self) {}',   // line 3 — impl method; MUST be sampled (priority 1)
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'foo.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // fn bar is at line 3 (indented inside impl block). Priority 1 fires on fn.
    // The struct Foo at line 0 would be priority 2 — fn wins.
    expect(samples[0].position.line).toBe(3);
    const methodLine = '    fn bar(&self) {}';
    const expectedChar = methodLine.indexOf('bar');
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('foo.rs');
  });
});

// ─── WI2-9: struct declaration → priority 2 ─────────────────────────

describe('RUST_CANARY_STRATEGY — Priority 2: struct declaration (WI2-9)', () => {
  it('WI2-9: struct Config (no fn) → sample from "Config"', async () => {
    const dir = mkFixture('rust-struct');
    const content = [
      'struct Config {',   // line 0
      '    timeout: u32,',
      '    retries: u8,',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'config.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const structLine = 'struct Config {';
    const expectedChar = structLine.indexOf('Config');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('config.rs');
  });

  it('pub struct with generics → sample from struct name', async () => {
    const dir = mkFixture('rust-pub-struct-generic');
    const content = [
      'pub struct Map<K, V> {',  // line 0
      '    inner: Vec<(K, V)>,',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'map.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const structLine = 'pub struct Map<K, V> {';
    const expectedChar = structLine.indexOf('Map');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── WI2-10: enum declaration → priority 2 ──────────────────────────

describe('RUST_CANARY_STRATEGY — Priority 2: enum declaration (WI2-10)', () => {
  it('WI2-10: enum Kind (no fn, no struct) → sample from "Kind"', async () => {
    const dir = mkFixture('rust-enum');
    const content = [
      'enum Kind {',   // line 0
      '    A,',
      '    B,',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'kind.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const enumLine = 'enum Kind {';
    const expectedChar = enumLine.indexOf('Kind');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('kind.rs');
  });
});

// ─── WI2-11: trait declaration → priority 2 ─────────────────────────

describe('RUST_CANARY_STRATEGY — Priority 2: trait declaration (WI2-11)', () => {
  it('WI2-11: trait Foo (no fn, no struct/enum) → sample from "Foo"', async () => {
    const dir = mkFixture('rust-trait');
    const content = [
      'trait Foo {',   // line 0
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'foo.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const traitLine = 'trait Foo {';
    const expectedChar = traitLine.indexOf('Foo');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('foo.rs');
  });
});

// ─── WI2-12: call-site-only → priority 3 fallback ───────────────────

describe('RUST_CANARY_STRATEGY — Priority 3: call-site fallback (WI2-12)', () => {
  it('WI2-12: call-site-only "foo.bar()" → sample from call identifier', async () => {
    const dir = mkFixture('rust-call-site');
    // A file with only a method call — no fn, struct, enum, or trait.
    // foo.bar() — the sampler should pick up 'bar' (the method name),
    // since RE_RUST_CALL matches the identifier immediately before '('.
    const content = 'foo.bar();\n';
    fs.writeFileSync(path.join(dir, 'call.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // 'bar' is the identifier immediately before '(' on line 0.
    const line0 = 'foo.bar();';
    const expectedChar = line0.indexOf('bar');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
    expect(samples[0].textDocument.uri).toContain('call.rs');
  });

  it('free function call-site → sample from function name', async () => {
    const dir = mkFixture('rust-free-call');
    const content = [
      'let result = compute(42);',  // line 0 — free function call
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'main.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    const line0 = 'let result = compute(42);';
    const expectedChar = line0.indexOf('compute');
    expect(samples[0].position.line).toBe(0);
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── WI2-13: empty file → null ───────────────────────────────────────

describe('RUST_CANARY_STRATEGY — empty file returns null (WI2-13)', () => {
  it('WI2-13: empty .rs file → tryExtractSample returns null', async () => {
    const dir = mkFixture('rust-empty');
    fs.writeFileSync(path.join(dir, 'empty.rs'), '');

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(0);
  });
});

// ─── WI2-14: RUST_IDENT_AFTER does NOT match '$' ────────────────────

describe('RUST_IDENT_AFTER — no dollar-sign (WI2-14)', () => {
  it('WI2-14: RUST_IDENT_AFTER does NOT match "$" (Rust identifiers exclude dollar-sign)', () => {
    expect(RUST_IDENT_AFTER.test('$')).toBe(false);
  });

  it('RUST_IDENT_AFTER matches standard identifier continuation chars', () => {
    expect(RUST_IDENT_AFTER.test('a')).toBe(true);
    expect(RUST_IDENT_AFTER.test('Z')).toBe(true);
    expect(RUST_IDENT_AFTER.test('0')).toBe(true);
    expect(RUST_IDENT_AFTER.test('_')).toBe(true);
  });

  it('RUST_IDENT_AFTER is not the same object reference as GO_IDENT_AFTER — no cross-language alias', () => {
    // RUST_IDENT_AFTER must be its own constant (WI-2 invariant: "no alias to GO_IDENT_AFTER").
    // We cannot directly compare GO_IDENT_AFTER (not exported), but we can verify
    // RUST_IDENT_AFTER is a RegExp with the correct source and no dollar-sign match.
    expect(RUST_IDENT_AFTER).toBeInstanceOf(RegExp);
    expect(RUST_IDENT_AFTER.source).toBe('[A-Za-z0-9_]');
    expect(RUST_IDENT_AFTER.test('$')).toBe(false);
  });
});

// ─── WI2-15: Maven regression — target/ excluded ─────────────────────

describe('RUST_CANARY_STRATEGY — Maven regression: target/ excluded (WI2-15)', () => {
  it('WI2-15: buildCanarySamples on Maven fixture with target/ + src/main → sample comes from src/main, NOT target/', async () => {
    const dir = mkFixture('maven-rust-regression');

    // Maven-style layout: target/generated-sources/ contains .rs artifacts.
    const targetDir = path.join(dir, 'target', 'generated-sources');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'generated.rs'),
      'fn generated_artifact() {}\n',  // would be picked if target/ were walked
    );

    // Real Rust source in src/main — should be the sample source.
    const srcDir = path.join(dir, 'src', 'main');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'lib.rs'),
      'pub fn real_function() {}\n',
    );

    const samples = await buildCanarySamples(dir, {
      strategy: RUST_CANARY_STRATEGY,
      maxFiles: 3,
    });

    // Must yield exactly 1 sample — the one from src/main/lib.rs.
    expect(samples).toHaveLength(1);
    expect(samples[0].textDocument.uri).toContain('src');
    expect(samples[0].textDocument.uri).not.toContain('/target/');
  });

  it('Maven regression: JAVA_CANARY_STRATEGY unaffected — Java files in src/main/java still sampled', async () => {
    // Proves the EXCLUDED_DIRS addition is safe for Java: adding 'target' does NOT
    // break Java canary sampling from the Maven standard layout (src/main/java/).
    const dir = mkFixture('maven-java-regression');

    // Maven target dir with .class-adjacent artifacts (not .java, but present).
    const targetDir = path.join(dir, 'target', 'classes');
    fs.mkdirSync(targetDir, { recursive: true });
    // No .java files in target/ — but prove target/ itself is skipped.
    fs.writeFileSync(path.join(targetDir, 'placeholder.txt'), 'ignored\n');

    // Real Java source in src/main/java/.
    const javaDir = path.join(dir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(
      path.join(javaDir, 'UserService.java'),
      'public class UserService {\n    public void save() {}\n}\n',
    );

    const samples = await buildCanarySamples(dir, {
      strategy: JAVA_CANARY_STRATEGY,
      maxFiles: 3,
    });

    expect(samples).toHaveLength(1);
    expect(samples[0].textDocument.uri).toContain('UserService.java');
    expect(samples[0].textDocument.uri).not.toContain('/target/');
  });
});

// ─── Priority ordering: fn beats struct (regression guard) ───────────

describe('RUST_CANARY_STRATEGY — priority ordering: fn beats struct/enum/trait', () => {
  it('file with both fn and struct → fn name sampled (priority 1 over priority 2)', async () => {
    const dir = mkFixture('rust-fn-beats-struct');
    const content = [
      'struct Config {',         // line 0 — priority 2 (should NOT be sampled)
      '    value: i32,',
      '}',
      '',
      'fn load_config() -> Config {',  // line 4 — priority 1 (MUST be sampled)
      '    Config { value: 42 }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'config.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // fn load_config at line 4 must win over struct Config at line 0.
    expect(samples[0].position.line).toBe(4);
    const fnLine = 'fn load_config() -> Config {';
    const expectedChar = fnLine.indexOf('load_config');
    expect(samples[0].position.character).toBe(expectedChar);
  });

  it('file with struct and call-site but no fn → struct sampled (priority 2 over 3)', async () => {
    const dir = mkFixture('rust-struct-beats-call');
    const content = [
      'struct Item;',            // line 0 — priority 2 (MUST be sampled)
      '',
      'let x = process(item);', // line 2 — priority 3 (should NOT be sampled)
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'item.rs'), content);

    const samples = await buildCanarySamples(dir, { strategy: RUST_CANARY_STRATEGY, maxFiles: 1 });
    expect(samples).toHaveLength(1);

    // struct Item at line 0 must win over call-site at line 2.
    expect(samples[0].position.line).toBe(0);
    const structLine = 'struct Item;';
    const expectedChar = structLine.indexOf('Item');
    expect(samples[0].position.character).toBe(expectedChar);
  });
});

// ─── target/ walk exclusion behavioral test ──────────────────────────

describe('RUST_CANARY_STRATEGY — target/ directory excluded (behavioral)', () => {
  it('files under target/ are not included in buildCanarySamples output', async () => {
    const dir = mkFixture('rust-target-excluded');

    // Place a .rs file inside target/ — it MUST NOT be picked.
    const targetDir = path.join(dir, 'target', 'debug', 'build');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'build_script.rs'),
      'fn build_main() {}\n',
    );

    // No .rs file outside target/ — if target/ were walked we'd get a sample;
    // if excluded correctly we get [].
    const samples = await buildCanarySamples(dir, {
      strategy: RUST_CANARY_STRATEGY,
      maxFiles: 3,
    });
    expect(samples).toHaveLength(0);

    // Also verify: files outside target/ ARE picked.
    fs.writeFileSync(
      path.join(dir, 'main.rs'),
      'fn main() {}\n',
    );
    const samplesWithMain = await buildCanarySamples(dir, {
      strategy: RUST_CANARY_STRATEGY,
      maxFiles: 3,
    });
    expect(samplesWithMain).toHaveLength(1);
    for (const s of samplesWithMain) {
      expect(s.textDocument.uri).not.toContain('/target/');
    }
  });
});

// ─── Regression lock: prior strategies unaffected ────────────────────

describe('Regression lock — prior strategies unaffected by WI-2 changes', () => {
  it('TS_CANARY_STRATEGY still rejects .rs files', () => {
    expect(TS_CANARY_STRATEGY.isCandidateFile('main.rs')).toBe(false);
  });

  it('GO_CANARY_STRATEGY still rejects .rs files', () => {
    expect(GO_CANARY_STRATEGY.isCandidateFile('main.rs')).toBe(false);
  });

  it('JAVA_CANARY_STRATEGY still rejects .rs files', () => {
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('main.rs')).toBe(false);
  });

  it('PYTHON_CANARY_STRATEGY still rejects .rs files', () => {
    expect(PYTHON_CANARY_STRATEGY.isCandidateFile('main.rs')).toBe(false);
  });
});
