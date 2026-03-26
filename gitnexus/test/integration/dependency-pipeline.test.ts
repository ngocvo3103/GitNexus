/**
 * WI-2 Integration Tests: Pipeline Dependency Extraction
 *
 * Tests: Dependency extraction is integrated into the ingestion pipeline
 * Manifest is written to .gitnexus/repo_manifest.json
 *
 * NOTE: These tests are designed to FAIL initially (TDD approach).
 * Implementation of dependency extraction in pipeline is pending.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { readManifest, RepoManifest } from '../../src/storage/repo-manifest.js';
import { createTempDir } from '../helpers/test-db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Pipeline dependency extraction integration', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let repoPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-pipeline-deps-');
    repoPath = tmpHandle.dbPath;
    manifestPath = path.join(repoPath, '.gitnexus', 'repo_manifest.json');
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  describe('manifest file creation', () => {
    it('creates .gitnexus directory if it does not exist', async () => {
      // WI-2: Pipeline should create .gitnexus/ during dependency extraction
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
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
</project>`;

      await fs.writeFile(path.join(repoPath, 'pom.xml'), pomXml);

      // Run pipeline with skipGraphPhases for speed
      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      // Verify .gitnexus directory was created
      const gitnexusDir = path.join(repoPath, '.gitnexus');
      const dirExists = await fs.stat(gitnexusDir).then(() => true).catch(() => false);
      expect(dirExists).toBe(true);
    });

    it('writes repo_manifest.json after dependency extraction', async () => {
      // WI-2: Manifest file should be written during pipeline
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
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
</project>`;

      await fs.writeFile(path.join(repoPath, 'pom.xml'), pomXml);

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      // Verify manifest file exists
      const manifestExists = await fs.stat(manifestPath).then(() => true).catch(() => false);
      expect(manifestExists).toBe(true);
    });
  });

  describe('manifest content', () => {
    it('populates dependencies array from pom.xml', async () => {
      // WI-2: Manifest should contain extracted Maven dependencies
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
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
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.15.0</version>
    </dependency>
  </dependencies>
</project>`;

      await fs.writeFile(path.join(repoPath, 'pom.xml'), pomXml);

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toBeDefined();
      expect(manifest?.dependencies?.length).toBe(2);

      // Check dependency names are in groupId:artifactId format
      const depNames = manifest?.dependencies ?? [];
      expect(depNames).toContain('org.apache.commons:commons-lang3');
      expect(depNames).toContain('com.fasterxml.jackson.core:jackson-databind');
    });

    it('populates dependencies array from package.json', async () => {
      // WI-2: Manifest should contain extracted npm dependencies
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          express: '^4.18.0',
          lodash: '^4.17.0',
        },
        devDependencies: {
          jest: '^29.0.0',
        },
      };

      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify(packageJson)
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toBeDefined();

      // Check dependency names
      const depNames = manifest?.dependencies ?? [];
      expect(depNames).toContain('express');
      expect(depNames).toContain('lodash');
      expect(depNames).toContain('jest');
    });

    it('sets repoId from directory name', async () => {
      // WI-2: repoId should default to directory basename
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {},
      };

      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify(packageJson)
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.repoId).toBe(path.basename(repoPath));
    });

    it('sets indexedAt timestamp', async () => {
      // WI-2: Manifest should include indexing timestamp
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {},
      };

      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify(packageJson)
      );

      const beforeTime = Date.now();
      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });
      const afterTime = Date.now();

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();

      const indexedAtTime = new Date(manifest!.indexedAt).getTime();
      expect(indexedAtTime).toBeGreaterThanOrEqual(beforeTime);
      expect(indexedAtTime).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('dependency filtering', () => {
    it('excludes test-scoped Maven dependencies from manifest', async () => {
      // WI-2: Test dependencies should not appear in manifest
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
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
      <scope>compile</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.9.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`;

      await fs.writeFile(path.join(repoPath, 'pom.xml'), pomXml);

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      const depNames = manifest?.dependencies ?? [];

      expect(depNames).toContain('org.apache.commons:commons-lang3');
      expect(depNames).not.toContain('org.junit.jupiter:junit-jupiter');
    });

    it('includes devDependencies in npm manifest (Phase 1)', async () => {
      // WI-2: Phase 1 includes devDependencies in manifest
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          express: '^4.18.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
          '@types/node': '^18.0.0',
        },
      };

      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify(packageJson)
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      const depNames = manifest?.dependencies ?? [];

      expect(depNames).toContain('express');
      expect(depNames).toContain('typescript');
      expect(depNames).toContain('@types/node');
    });
  });

  describe('error handling', () => {
    it('handles projects without any manifest file', async () => {
      // WI-2: Projects without pom.xml or package.json should produce empty manifest
      // Create a simple source file so pipeline has something to scan
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(repoPath, 'src', 'index.js'),
        'console.log("hello");'
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toEqual([]);
    });

    it('handles malformed pom.xml gracefully', async () => {
      // WI-2: Malformed XML should produce empty manifest (not crash)
      await fs.writeFile(
        path.join(repoPath, 'pom.xml'),
        '<?xml version="1.0"?><project><invalid'
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toEqual([]);
    });

    it('handles malformed package.json gracefully', async () => {
      // WI-2: Malformed JSON should produce empty manifest (not crash)
      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        '{ invalid json }'
      );

      await runPipelineFromRepo(repoPath, () => {}, { skipGraphPhases: true });

      const manifest = await readManifest(repoPath);
      expect(manifest).not.toBeNull();
      expect(manifest?.dependencies).toEqual([]);
    });
  });

  describe('progress reporting', () => {
    it('reports dependency extraction progress', async () => {
      // WI-2: Pipeline should report progress during dependency extraction
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: { express: '^4.18.0' },
      };

      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify(packageJson)
      );

      const progressMessages: string[] = [];
      await runPipelineFromRepo(
        repoPath,
        (progress) => {
          progressMessages.push(progress.message);
        },
        { skipGraphPhases: true }
      );

      // Should have a progress message about dependency extraction
      const depsProgress = progressMessages.find(
        (msg) =>
          msg.toLowerCase().includes('depend') ||
          msg.toLowerCase().includes('manifest')
      );
      expect(depsProgress).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Phase Order Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Pipeline phase order', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let repoPath: string;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-phase-order-');
    repoPath = tmpHandle.dbPath;
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  it('extracts dependencies after file scan and before parsing', async () => {
    // WI-2: Dependency extraction should happen after scan, before parse
    // This ensures dependencies are available for import resolution
    const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>ordered-project</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>external-lib</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`;

    await fs.writeFile(path.join(repoPath, 'pom.xml'), pomXml);

    const phases: string[] = [];
    await runPipelineFromRepo(
      repoPath,
      (progress) => {
        phases.push(progress.phase);
      },
      { skipGraphPhases: true }
    );

    // Find indices of relevant phases
    const extractingIdx = phases.indexOf('extracting');
    const structureIdx = phases.indexOf('structure');
    const parsingIdx = phases.indexOf('parsing');

    // Phase order should be: extracting -> structure -> (deps) -> parsing
    expect(extractingIdx).toBeLessThan(structureIdx);
    expect(structureIdx).toBeLessThan(parsingIdx);
  });
});