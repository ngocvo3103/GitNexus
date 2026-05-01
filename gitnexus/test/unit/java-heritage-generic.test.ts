/**
 * Tests for Java generic heritage in JAVA_QUERIES tree-sitter patterns.
 *
 * BDD Feature: Java Generic Type Heritage Detection
 *   As a code intelligence system
 *   I want to capture class names from generic implements/extends clauses
 *   So that inheritance relationships are recorded even when type parameters are present
 *
 * Bug: Java tree-sitter queries for `implements` and `extends` only match
 * `(type_identifier)` directly, which misses the case where the parent type
 * is wrapped in `(generic_type ...)`.
 *
 * Fix required (WI-1, WI-2): add patterns
 *   (generic_type (type_identifier) @heritage.implements)
 *   (generic_type (type_identifier) @heritage.extends)
 * to JAVA_QUERIES in tree-sitter-queries.ts.
 *
 * Tests 1 and 4 (generic implements) fail until WI-1 is applied.
 * Test 3 (generic extends) fails until WI-2 is applied.
 * Test 2 (non-generic implements) should pass now — it is the regression guard.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { JAVA_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJava(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(source);
}

/**
 * Run JAVA_QUERIES against a parsed tree and return all capture nodes whose
 * capture name matches the given name.
 */
function captureTexts(tree: Parser.Tree, captureName: string): string[] {
  const language = (new Parser()).getLanguage
    ? (() => { const p = new Parser(); p.setLanguage(Java); return p.getLanguage(); })()
    : Java;

  const query = new Parser.Query(language, JAVA_QUERIES);
  const matches = query.matches(tree.rootNode);

  const texts: string[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === captureName) {
        texts.push(capture.node.text);
      }
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('JAVA_QUERIES — generic heritage captures', () => {

  // -------------------------------------------------------------------------
  // 1. Generic implements — FAILS until WI-1
  // -------------------------------------------------------------------------
  it('[WI-1] captures heritage.implements for generic interface: implements SomeInterface<String, Integer>', () => {
    /**
     * Scenario: Generic single implements
     *   Given a Java class that implements a generic interface
     *   When JAVA_QUERIES are executed against the AST
     *   Then a heritage.implements capture with text "SomeInterface" is found
     */
    const source = `class Foo implements SomeInterface<String, Integer> {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.implements');

    expect(captured).toContain('SomeInterface');
  });

  // -------------------------------------------------------------------------
  // 2. Non-generic implements — MUST pass now (regression guard)
  // -------------------------------------------------------------------------
  it('[REGRESSION] captures heritage.implements for plain interface: implements BondEventHandler', () => {
    /**
     * Scenario: Plain (non-generic) implements — already working
     *   Given a Java class that implements a plain (non-generic) interface
     *   When JAVA_QUERIES are executed against the AST
     *   Then a heritage.implements capture with text "BondEventHandler" is found
     */
    const source = `class Foo implements BondEventHandler {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.implements');

    expect(captured).toContain('BondEventHandler');
  });

  // -------------------------------------------------------------------------
  // 3. Generic extends — FAILS until WI-2
  // -------------------------------------------------------------------------
  it('[WI-2] captures heritage.extends for generic superclass: extends AbstractGenericClass<String>', () => {
    /**
     * Scenario: Generic extends
     *   Given a Java class that extends a generic superclass
     *   When JAVA_QUERIES are executed against the AST
     *   Then a heritage.extends capture with text "AbstractGenericClass" is found
     */
    const source = `class Foo extends AbstractGenericClass<String> {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.extends');

    expect(captured).toContain('AbstractGenericClass');
  });

  // -------------------------------------------------------------------------
  // 4. Mixed implements (plain + generic) — FAILS until WI-1
  // -------------------------------------------------------------------------
  it('[WI-1] captures both heritage.implements names when mixing plain and generic interfaces', () => {
    /**
     * Scenario: Multiple implements — plain and generic
     *   Given a Java class that implements both a plain and a generic interface
     *   When JAVA_QUERIES are executed against the AST
     *   Then heritage.implements captures contain both "SimpleInterface" and "GenericInterface"
     */
    const source = `class Foo implements SimpleInterface, GenericInterface<String, Map<String, Integer>> {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.implements');

    expect(captured).toContain('SimpleInterface');
    expect(captured).toContain('GenericInterface');
  });

  // -------------------------------------------------------------------------
  // 5. Interface extends generic interface — FAILS until interface heritage patterns added
  // -------------------------------------------------------------------------
  it('[WI-3] captures heritage.extends for interface extending generic interface: extends JpaRepository<User, Long>', () => {
    /**
     * Scenario: Interface extends generic interface
     *   Given a Java interface that extends a generic interface
     *   When JAVA_QUERIES are executed against the AST
     *   Then a heritage.extends capture with text "JpaRepository" is found
     */
    const source = `interface MyRepo extends JpaRepository<User, Long> {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.extends');

    expect(captured).toContain('JpaRepository');
  });

  // -------------------------------------------------------------------------
  // 6. Interface extends plain interface — regression guard for plain extends
  // -------------------------------------------------------------------------
  it('[REGRESSION] captures heritage.extends for interface extending plain interface: extends SimpleService', () => {
    /**
     * Scenario: Interface extends plain (non-generic) interface
     *   Given a Java interface that extends a plain interface
     *   When JAVA_QUERIES are executed against the AST
     *   Then a heritage.extends capture with text "SimpleService" is found
     */
    const source = `interface MyService extends SimpleService {}`;
    const tree = parseJava(source);
    const captured = captureTexts(tree, 'heritage.extends');

    expect(captured).toContain('SimpleService');
  });

});
