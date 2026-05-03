/**
 * WI-2 Unit Tests: Dependency Extraction
 *
 * Tests: parsePomXml, parsePackageJson, extractDependencies
 * Covers Maven pom.xml and npm package.json dependency extraction
 *
 * NOTE: These tests are designed to FAIL initially (TDD approach).
 * Implementation of dependency-extractor.ts is pending.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  parsePomXml,
  parsePackageJson,
  extractDependencies,
  MavenDependency,
  NpmDependency,
  ExtractionResult,
  getEffectiveScope,
} from '../../src/core/ingestion/dependency-extractor.js';
import { createTempDir } from '../helpers/test-db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types (re-declare for tests until module exists)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maven dependency extracted from pom.xml
 */
interface ExpectedMavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: 'compile' | 'runtime' | 'provided' | 'test' | 'system';
}

/**
 * npm dependency extracted from package.json
 */
interface ExpectedNpmDependency {
  name: string;
  version: string;
  isDev: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures Path Constants
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, '../fixtures/cross-repo');
const REPO_A_POM = path.join(FIXTURES_DIR, 'repo-a/pom.xml');
const REPO_B_PACKAGE = path.join(FIXTURES_DIR, 'repo-b/package.json');
const EMPTY_MAVEN_POM = path.join(FIXTURES_DIR, 'empty-maven/pom.xml');
const EMPTY_NPM_PACKAGE = path.join(FIXTURES_DIR, 'empty-npm/package.json');
const MALFORMED_MAVEN_POM = path.join(FIXTURES_DIR, 'malformed-maven/pom.xml');
const MALFORMED_NPM_PACKAGE = path.join(FIXTURES_DIR, 'malformed-npm/package.json');
const MULTI_MODULE_PARENT = path.join(FIXTURES_DIR, 'multi-module/parent/pom.xml');
const MULTI_MODULE_A = path.join(FIXTURES_DIR, 'multi-module/module-a/pom.xml');
const MULTI_MODULE_B = path.join(FIXTURES_DIR, 'multi-module/module-b/pom.xml');

// ─────────────────────────────────────────────────────────────────────────────
// Maven pom.xml Parsing Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePomXml', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tmpHandle) {
      await tmpHandle.cleanup();
    }
  });

  describe('single-module Maven project', () => {
    it('extracts groupId:artifactId pairs from dependencies', async () => {
      // WI-2: parsePomXml should extract all dependency coordinates
      const result = await parsePomXml(REPO_A_POM);

      expect(result).toBeDefined();
      expect(result.dependencies).toBeDefined();
      expect(result.dependencies.length).toBeGreaterThan(0);

      // Check for expected production dependencies
      const depIds = result.dependencies.map(d => `${d.groupId}:${d.artifactId}`);
      expect(depIds).toContain('com.tcbs.bond.trading:exception-handler');
      expect(depIds).toContain('com.tcbs.matching:matching-client');
    });

    it('extracts versions for each dependency', async () => {
      // WI-2: Each dependency should have its version extracted
      const result = await parsePomXml(REPO_A_POM);

      const exceptionHandler = result.dependencies.find(
        d => d.artifactId === 'exception-handler'
      );
      expect(exceptionHandler).toBeDefined();
      expect(exceptionHandler?.version).toBe('1.0.0');

      const matchingClient = result.dependencies.find(
        d => d.artifactId === 'matching-client'
      );
      expect(matchingClient).toBeDefined();
      expect(matchingClient?.version).toBe('3.0.0');
    });

    it('filters out test-scoped dependencies', async () => {
      // WI-2: Dependencies with <scope>test</scope> should NOT be included
      const result = await parsePomXml(REPO_A_POM);

      const junitDep = result.dependencies.find(
        d => d.artifactId === 'junit-jupiter'
      );
      expect(junitDep).toBeUndefined();
    });

    it('includes compile, runtime, and provided scoped dependencies', async () => {
      // WI-2: Only test scope should be filtered out
      const result = await parsePomXml(REPO_A_POM);

      // compile scope (explicit)
      const exceptionHandler = result.dependencies.find(
        d => d.artifactId === 'exception-handler'
      );
      expect(exceptionHandler).toBeDefined();

      // compile scope (implicit - no scope means compile)
      const matchingClient = result.dependencies.find(
        d => d.artifactId === 'matching-client'
      );
      expect(matchingClient).toBeDefined();

      // runtime scope
      const postgresql = result.dependencies.find(
        d => d.artifactId === 'postgresql'
      );
      expect(postgresql).toBeDefined();

      // provided scope
      const servlet = result.dependencies.find(
        d => d.artifactId === 'javax.servlet-api'
      );
      expect(servlet).toBeDefined();
    });

    it('returns empty dependencies array for pom with no dependencies', async () => {
      // WI-2: Handle pom.xml with empty dependencies section
      const result = await parsePomXml(EMPTY_MAVEN_POM);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });
  });

  describe('malformed XML handling', () => {
    it('returns empty result for malformed pom.xml', async () => {
      // WI-2: Gracefully handle malformed XML without throwing
      const result = await parsePomXml(MALFORMED_MAVEN_POM);

      // Should not throw, should return empty/empty result
      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });

    it('returns empty result when pom.xml does not exist', async () => {
      // WI-2: Handle missing manifest file gracefully
      tmpHandle = await createTempDir('gitnexus-pom-missing-');
      const nonExistentPath = path.join(tmpHandle.dbPath, 'non-existent-pom.xml');

      const result = await parsePomXml(nonExistentPath);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });
  });

  describe('dependency scope handling', () => {
    it('preserves scope information in extracted dependencies', async () => {
      // WI-2: Scope should be preserved for downstream filtering
      const result = await parsePomXml(REPO_A_POM);

      const runtimeDep = result.dependencies.find(
        d => d.artifactId === 'postgresql'
      );
      expect(runtimeDep?.scope).toBe('runtime');

      const providedDep = result.dependencies.find(
        d => d.artifactId === 'javax.servlet-api'
      );
      expect(providedDep?.scope).toBe('provided');
    });

    it('defaults scope to compile when not specified', async () => {
      // WI-2: Maven default scope is compile
      const result = await parsePomXml(REPO_A_POM);

      const matchingClient = result.dependencies.find(
        d => d.artifactId === 'matching-client'
      );
      expect(matchingClient?.scope).toBe('compile');
    });
  });

  describe('dependency coordinate normalization', () => {
    it('normalizes groupId:artifactId to dependency name', async () => {
      // WI-2: Each dependency should have a normalized name for cross-repo matching
      const result = await parsePomXml(REPO_A_POM);

      const exceptionHandler = result.dependencies.find(
        d => d.artifactId === 'exception-handler'
      );
      expect(exceptionHandler?.name).toBe('com.tcbs.bond.trading:exception-handler');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// npm package.json Parsing Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePackageJson', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;

  afterEach(async () => {
    if (tmpHandle) {
      await tmpHandle.cleanup();
    }
  });

  describe('dependencies extraction', () => {
    it('extracts dependencies from package.json', async () => {
      // WI-2: parsePackageJson should extract all dependencies
      const result = await parsePackageJson(REPO_B_PACKAGE);

      expect(result).toBeDefined();
      expect(result.dependencies).toBeDefined();
      expect(result.dependencies.length).toBeGreaterThan(0);

      const depNames = result.dependencies.map(d => d.name);
      expect(depNames).toContain('express');
      expect(depNames).toContain('body-parser');
    });

    it('extracts devDependencies from package.json', async () => {
      // WI-2: Phase 1 includes both dependencies and devDependencies
      const result = await parsePackageJson(REPO_B_PACKAGE);

      const devDepNames = result.dependencies
        .filter(d => d.isDev)
        .map(d => d.name);
      expect(devDepNames).toContain('@types/node');
      expect(devDepNames).toContain('typescript');
      expect(devDepNames).toContain('jest');
    });

    it('handles scoped packages (@org/package)', async () => {
      // WI-2: Scoped npm packages should be extracted correctly
      const result = await parsePackageJson(REPO_B_PACKAGE);

      const scopedDep = result.dependencies.find(
        d => d.name === '@tcbs/bond-trading-core'
      );
      expect(scopedDep).toBeDefined();
      expect(scopedDep?.version).toBe('^2.1.0');

      const scopedDevDep = result.dependencies.find(
        d => d.name === '@types/express'
      );
      expect(scopedDevDep).toBeDefined();
    });

    it('extracts version specifiers for each dependency', async () => {
      // WI-2: Version specifiers should be preserved (exact, caret, tilde)
      const result = await parsePackageJson(REPO_B_PACKAGE);

      const express = result.dependencies.find(d => d.name === 'express');
      expect(express?.version).toBe('^4.18.0');

      const bodyParser = result.dependencies.find(d => d.name === 'body-parser');
      expect(bodyParser?.version).toBe('1.20.0');
    });

    it('distinguishes between dependencies and devDependencies', async () => {
      // WI-2: isDev flag should correctly identify devDependencies
      const result = await parsePackageJson(REPO_B_PACKAGE);

      const express = result.dependencies.find(d => d.name === 'express');
      expect(express?.isDev).toBe(false);

      const jest = result.dependencies.find(d => d.name === 'jest');
      expect(jest?.isDev).toBe(true);
    });
  });

  describe('empty dependencies handling', () => {
    it('returns empty array for package.json without dependencies', async () => {
      // WI-2: Projects without dependencies are valid
      const result = await parsePackageJson(EMPTY_NPM_PACKAGE);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });
  });

  describe('malformed JSON handling', () => {
    it('returns empty result for malformed package.json', async () => {
      // WI-2: Gracefully handle malformed JSON without throwing
      const result = await parsePackageJson(MALFORMED_NPM_PACKAGE);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });

    it('returns empty result when package.json does not exist', async () => {
      // WI-2: Handle missing manifest file gracefully
      tmpHandle = await createTempDir('gitnexus-package-missing-');
      const nonExistentPath = path.join(tmpHandle.dbPath, 'non-existent-package.json');

      const result = await parsePackageJson(nonExistentPath);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
    });
  });

  describe('ecosystem identification', () => {
    it('marks all dependencies as npm ecosystem', async () => {
      // WI-2: All dependencies from package.json should have ecosystem='npm'
      const result = await parsePackageJson(REPO_B_PACKAGE);

      for (const dep of result.dependencies) {
        expect(dep.ecosystem).toBe('npm');
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractDependencies Tests (Unified Interface)
// ─────────────────────────────────────────────────────────────────────────────

describe('extractDependencies', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let projectDir: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-deps-extract-');
    projectDir = tmpHandle.dbPath;
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  describe('manifest detection', () => {
    it('detects and parses pom.xml when present', async () => {
      // WI-2: Auto-detect Maven project
      await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>test-project</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.12.0</version>
    </dependency>
  </dependencies>
</project>`
      );

      const result = await extractDependencies(projectDir);

      expect(result).toBeDefined();
      expect(result.ecosystem).toBe('maven');
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].name).toBe('org.apache.commons:commons-lang3');
    });

    it('detects and parses package.json when present', async () => {
      // WI-2: Auto-detect npm project
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {
            lodash: '^4.17.0',
          },
        })
      );

      const result = await extractDependencies(projectDir);

      expect(result).toBeDefined();
      expect(result.ecosystem).toBe('npm');
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].name).toBe('lodash');
    });

    it('prefers pom.xml over package.json when both exist', async () => {
      // WI-2: Maven takes precedence in hybrid projects
      await fs.writeFile(
        path.join(projectDir, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>hybrid-project</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.0</version>
    </dependency>
  </dependencies>
</project>`
      );
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'hybrid-project',
          dependencies: { express: '^4.18.0' },
        })
      );

      const result = await extractDependencies(projectDir);

      expect(result.ecosystem).toBe('maven');
      expect(result.dependencies[0].name).toBe('org.slf4j:slf4j-api');
    });

    it('returns empty manifest when no manifest file found', async () => {
      // WI-2: Projects without build manifests should still produce valid manifest
      const result = await extractDependencies(projectDir);

      expect(result).toBeDefined();
      expect(result.dependencies).toEqual([]);
      expect(result.ecosystem).toBe('unknown');
    });
  });

  describe('manifest generation', () => {
    it('generates repoId from directory name', async () => {
      // WI-2: Repository ID should default to directory name
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = await extractDependencies(projectDir);

      expect(result.repoId).toBeDefined();
      expect(result.repoId).toBe(path.basename(projectDir));
    });

    it('generates indexedAt timestamp', async () => {
      // WI-2: Manifest should include indexing timestamp
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );

      const result = await extractDependencies(projectDir);

      expect(result.indexedAt).toBeDefined();
      expect(new Date(result.indexedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Model Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MavenDependency model', () => {
  it('requires groupId, artifactId, and version', () => {
    // WI-2: Maven dependency must have all required fields
    const dep: MavenDependency = {
      name: 'org.apache.commons:commons-lang3',
      groupId: 'org.apache.commons',
      artifactId: 'commons-lang3',
      version: '3.12.0',
      ecosystem: 'maven',
      scope: 'compile',
    };

    expect(dep.groupId).toBe('org.apache.commons');
    expect(dep.artifactId).toBe('commons-lang3');
    expect(dep.version).toBe('3.12.0');
  });

  it('scope defaults to compile', () => {
    // WI-2: Maven default scope behavior - scope is optional, defaults to 'compile' via helper
    const dep: MavenDependency = {
      name: 'org.example:lib',
      groupId: 'org.example',
      artifactId: 'lib',
      version: '1.0.0',
      ecosystem: 'maven',
    };

    // scope is optional, so it's undefined when not specified
    expect(dep.scope).toBeUndefined();
    // Use getEffectiveScope to get the default 'compile'
    expect(getEffectiveScope(dep)).toBe('compile');
  });
});

describe('NpmDependency model', () => {
  it('requires name, version, and isDev flag', () => {
    // WI-2: npm dependency must have all required fields
    const dep: NpmDependency = {
      name: 'express',
      version: '^4.18.0',
      isDev: false,
      ecosystem: 'npm',
    };

    expect(dep.name).toBe('express');
    expect(dep.version).toBe('^4.18.0');
    expect(dep.isDev).toBe(false);
  });

  it('supports scoped package names', () => {
    // WI-2: Scoped packages (@org/package) are valid
    const scopedDep: NpmDependency = {
      name: '@types/node',
      version: '^18.0.0',
      isDev: true,
      ecosystem: 'npm',
    };

    expect(scopedDep.name).toContain('/');
    expect(scopedDep.name).toMatch(/^@[\w-]+\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases and Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  describe('Maven edge cases', () => {
    it('handles dependencies without explicit version (managed by parent)', async () => {
      // WI-2: Dependencies in modules may inherit version from parent
      const result = await parsePomXml(MULTI_MODULE_A);

      // shared-lib version comes from parent's dependencyManagement
      const sharedLib = result.dependencies.find(
        d => d.artifactId === 'shared-lib'
      );
      expect(sharedLib).toBeDefined();
      // Version may be empty when managed by parent
    });

    it('handles empty groupId in local dependencies', async () => {
      // WI-2: Some projects may have empty/missing groupId
      // Should handle gracefully without throwing
      const tmpDir = await createTempDir('gitnexus-empty-groupid-');
      try {
        const pomPath = path.join(tmpDir.dbPath, 'pom.xml');
        await fs.writeFile(
          pomPath,
          `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>parent</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId></groupId>
      <artifactId>local-lib</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`
        );

        const result = await parsePomXml(pomPath);
        expect(result).toBeDefined();
        // Should either skip empty groupId or include with empty string
      } finally {
        await tmpDir.cleanup();
      }
    });
  });

  describe('npm edge cases', () => {
    it('handles package.json with empty dependencies object', async () => {
      // WI-2: Valid to have empty dependencies object
      const tmpDir = await createTempDir('gitnexus-empty-deps-');
      try {
        const pkgPath = path.join(tmpDir.dbPath, 'package.json');
        await fs.writeFile(
          pkgPath,
          JSON.stringify({
            name: 'empty-deps',
            version: '1.0.0',
            dependencies: {},
            devDependencies: {},
          })
        );

        const result = await parsePackageJson(pkgPath);
        expect(result.dependencies).toEqual([]);
      } finally {
        await tmpDir.cleanup();
      }
    });

    it('handles package.json without devDependencies field', async () => {
      // WI-2: devDependencies is optional
      const tmpDir = await createTempDir('gitnexus-no-dev-deps-');
      try {
        const pkgPath = path.join(tmpDir.dbPath, 'package.json');
        await fs.writeFile(
          pkgPath,
          JSON.stringify({
            name: 'no-dev-deps',
            version: '1.0.0',
            dependencies: { lodash: '^4.17.0' },
          })
        );

        const result = await parsePackageJson(pkgPath);
        expect(result.dependencies).toHaveLength(1);
        expect(result.dependencies[0].name).toBe('lodash');
        expect(result.dependencies[0].isDev).toBe(false);
      } finally {
        await tmpDir.cleanup();
      }
    });

    it('handles package.json without dependencies field', async () => {
      // WI-2: dependencies is optional
      const tmpDir = await createTempDir('gitnexus-no-deps-');
      try {
        const pkgPath = path.join(tmpDir.dbPath, 'package.json');
        await fs.writeFile(
          pkgPath,
          JSON.stringify({
            name: 'no-deps',
            version: '1.0.0',
            devDependencies: { jest: '^29.0.0' },
          })
        );

        const result = await parsePackageJson(pkgPath);
        expect(result.dependencies).toHaveLength(1);
        expect(result.dependencies[0].name).toBe('jest');
        expect(result.dependencies[0].isDev).toBe(true);
      } finally {
        await tmpDir.cleanup();
      }
    });
  });
});