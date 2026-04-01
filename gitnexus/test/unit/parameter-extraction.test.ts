/**
 * Unit Tests: Parameter Extraction
 *
 * Tests the extractMethodSignature function for Java/Kotlin source code.
 * Covers parameter names, types, and annotations extraction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import Kotlin from 'tree-sitter-kotlin';

// Import the function to test
import { extractMethodSignature, ParameterInfo } from '../../src/core/ingestion/utils.js';

describe('extractMethodSignature', () => {
  const parser = new Parser();

  describe('Java', () => {
    beforeEach(() => {
      parser.setLanguage(Java);
    });

    it('extracts simple parameters without annotations', () => {
      const code = `
        public void process(String name, int count) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0); // method_declaration

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameterCount).toBe(2);
      expect(sig.parameters).toHaveLength(2);
      expect(sig.parameters![0]).toEqual({ name: 'name', type: 'String', annotations: [] });
      expect(sig.parameters![1]).toEqual({ name: 'count', type: 'int', annotations: [] });
    });

    it('extracts @PathVariable parameter', () => {
      const code = `
        public User getUser(@PathVariable("id") Long id) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('id');
      expect(sig.parameters![0].type).toBe('Long');
      expect(sig.parameters![0].annotations).toContain('@PathVariable');
    });

    it('extracts @RequestBody parameter', () => {
      const code = `
        public ResponseEntity<Void> create(@RequestBody @Valid UserDto user) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('user');
      expect(sig.parameters![0].type).toBe('UserDto');
      expect(sig.parameters![0].annotations).toContain('@RequestBody');
      expect(sig.parameters![0].annotations).toContain('@Valid');
    });

    it('extracts @RequestParam with value', () => {
      const code = `
        public List<User> search(@RequestParam(value = "q", required = false) String query) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('query');
      expect(sig.parameters![0].type).toBe('String');
      expect(sig.parameters![0].annotations).toContain('@RequestParam');
    });

    it('extracts @RequestHeader parameter', () => {
      const code = `
        public ResponseEntity<Void> handle(@RequestHeader("X-Auth-Token") String token) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('token');
      expect(sig.parameters![0].annotations).toContain('@RequestHeader');
    });

    it('extracts multiple parameters with mixed annotations', () => {
      const code = `
        public ResponseEntity<Void> update(
          @PathVariable Long id,
          @RequestBody @Valid UpdateDto dto,
          @RequestHeader("X-Version") String version
        ) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(3);
      expect(sig.parameters![0].name).toBe('id');
      expect(sig.parameters![0].annotations).toContain('@PathVariable');
      expect(sig.parameters![1].name).toBe('dto');
      expect(sig.parameters![1].annotations).toContain('@RequestBody');
      expect(sig.parameters![1].annotations).toContain('@Valid');
      expect(sig.parameters![2].name).toBe('version');
      expect(sig.parameters![2].annotations).toContain('@RequestHeader');
    });

    it('extracts validation annotations (@NotNull, @Size)', () => {
      const code = `
        public void save(@NotNull @Size(max = 100) String name) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].annotations).toContain('@NotNull');
      expect(sig.parameters![0].annotations).toContain('@Size');
    });

    it('extracts return type', () => {
      const code = `
        public List<User> getAllUsers() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.returnType).toBe('List<User>');
    });

    it('handles void return type', () => {
      const code = `
        public void process() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      // void return type is intentionally returned as undefined
      // (implementation skips void to normalize "no meaningful return")
      expect(sig.returnType).toBeUndefined();
    });

    it('handles no parameters', () => {
      const code = `
        public String getName() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameterCount).toBe(0);
      expect(sig.parameters).toHaveLength(0);
    });

    it('handles varargs parameter', () => {
      const code = `
        public void process(String... names) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      // Varargs are detected: parameterCount becomes undefined, varargs param not in array
      expect(sig.parameterCount).toBeUndefined();
      expect(sig.parameters).toEqual([]);
      // void return type is intentionally returned as undefined
      expect(sig.returnType).toBeUndefined();
    });
  });

  describe.skip('Kotlin', () => {
    beforeEach(() => {
      parser.setLanguage(Kotlin);
    });

    it('extracts simple parameters', () => {
      const code = `
        fun process(name: String, count: Int) {}
      `;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(funcNode!);

      expect(sig.parameterCount).toBe(2);
    });

    it('extracts parameter with default value', () => {
      const code = `
        fun greet(name: String = "World") {}
      `;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(funcNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('name');
    });
  });

  describe('Edge cases', () => {
    beforeEach(() => {
      parser.setLanguage(Java);
    });

    it('handles null node gracefully', () => {
      const sig = extractMethodSignature(null);
      expect(sig.parameterCount).toBe(0);
      expect(sig.parameters).toBeUndefined();
    });

    it('handles generic types', () => {
      const code = `
        public void process(List<Map<String, Object>> data) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].type).toContain('List');
    });

    it('handles array type', () => {
      const code = `
        public void process(String[] names) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const sig = extractMethodSignature(methodNode!);

      expect(sig.parameters).toHaveLength(1);
      expect(sig.parameters![0].name).toBe('names');
      expect(sig.parameters![0].type).toContain('String');
    });
  });
});