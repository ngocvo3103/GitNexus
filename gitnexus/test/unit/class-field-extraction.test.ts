import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import TypeScript from 'tree-sitter-typescript';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

// Import extractClassFields from parse-worker
// Note: This requires the function to be exported
import { extractClassFields, type FieldInfo } from '../../src/core/ingestion/workers/parse-worker.js';

const parser = new Parser();

// Helper to parse Java code
const parseJava = (code: string) => {
  parser.setLanguage(Java);
  return parser.parse(code);
};

// Helper to parse TypeScript code
const parseTypeScript = (code: string) => {
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
};

describe('extractClassFields - Java', () => {
  it('extracts simple fields from Java class', () => {
    const tree = parseJava(`
      public class User {
        private String name;
        private int age;
        protected boolean active;
      }
    `);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(classNode!.type).toBe('class_declaration');

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toHaveLength(3);

    const nameField = fields.find(f => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe('String');

    const ageField = fields.find(f => f.name === 'age');
    expect(ageField).toBeDefined();
    expect(ageField!.type).toBe('int');

    const activeField = fields.find(f => f.name === 'active');
    expect(activeField).toBeDefined();
    expect(activeField!.type).toBe('boolean');
  });

  it('extracts fields with annotations', () => {
    const tree = parseJava(`
      public class Entity {
        @Column(name = "user_id")
        private Long id;

        @NotNull
        @Size(max = 100)
        private String email;
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toHaveLength(2);

    const idField = fields.find(f => f.name === 'id');
    expect(idField).toBeDefined();
    expect(idField!.annotations).toContain('@Column');

    const emailField = fields.find(f => f.name === 'email');
    expect(emailField).toBeDefined();
    expect(emailField!.annotations).toContain('@NotNull');
    expect(emailField!.annotations).toContain('@Size');
  });

  it('extracts generic field types', () => {
    const tree = parseJava(`
      public class Repository {
        private List<User> users;
        private Map<String, Object> cache;
        private CompletableFuture<List<Item>> future;
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toHaveLength(3);

    const usersField = fields.find(f => f.name === 'users');
    expect(usersField).toBeDefined();
    expect(usersField!.type).toBe('List<User>');

    const cacheField = fields.find(f => f.name === 'cache');
    expect(cacheField).toBeDefined();
    expect(cacheField!.type).toBe('Map<String,Object>');

    const futureField = fields.find(f => f.name === 'future');
    expect(futureField).toBeDefined();
    expect(futureField!.type).toBe('CompletableFuture<List<Item>>');
  });

  it('extracts static final constants with values', () => {
    const tree = parseJava(`
      public class Constants {
        public static final String VERSION = "1.0.0";
        public static final int MAX_RETRIES = 3;
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toHaveLength(2);

    const versionField = fields.find(f => f.name === 'VERSION');
    expect(versionField).toBeDefined();
    expect(versionField!.modifiers).toContain('static');
    expect(versionField!.modifiers).toContain('final');
    expect(versionField!.value).toBe('1.0.0');

    const retriesField = fields.find(f => f.name === 'MAX_RETRIES');
    expect(retriesField).toBeDefined();
    expect(retriesField!.value).toBe('3');
  });

  it('returns empty array for class with no fields', () => {
    const tree = parseJava(`
      public class EmptyClass {
        public void doSomething() {}
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toEqual([]);
  });

  it('extracts array type fields', () => {
    const tree = parseJava(`
      public class Config {
        private String[] names;
        private int[] values;
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.Java);

    expect(fields).toHaveLength(2);

    const namesField = fields.find(f => f.name === 'names');
    expect(namesField).toBeDefined();
    expect(namesField!.type).toBe('String[]');

    const valuesField = fields.find(f => f.name === 'values');
    expect(valuesField).toBeDefined();
    expect(valuesField!.type).toBe('int[]');
  });
});

describe('extractClassFields - TypeScript', () => {
  it('extracts fields from TypeScript class', () => {
    const tree = parseTypeScript(`
      class User {
        public name: string;
        private age: number;
        protected active: boolean;
      }
    `);
    const classNode = tree.rootNode.child(0);
    expect(classNode).toBeDefined();
    expect(classNode!.type).toBe('class_declaration');

    const fields = extractClassFields(classNode!, SupportedLanguages.TypeScript);

    expect(fields).toHaveLength(3);

    const nameField = fields.find(f => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe('string');

    const ageField = fields.find(f => f.name === 'age');
    expect(ageField).toBeDefined();
    expect(ageField!.type).toBe('number');
  });

  it('extracts generic types from TypeScript class', () => {
    const tree = parseTypeScript(`
      class Repository {
        users: Map<string, User>;
        items: Array<Item>;
      }
    `);
    const classNode = tree.rootNode.child(0);

    const fields = extractClassFields(classNode!, SupportedLanguages.TypeScript);

    expect(fields).toHaveLength(2);

    const usersField = fields.find(f => f.name === 'users');
    expect(usersField).toBeDefined();
    expect(usersField!.type).toBe('Map<string, User>');

    const itemsField = fields.find(f => f.name === 'items');
    expect(itemsField).toBeDefined();
    expect(itemsField!.type).toBe('Array<Item>');
  });
});