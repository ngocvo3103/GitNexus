// LOCAL-ONLY E2E — requires tcbs-bond-trading repos on local filesystem.
// Run manually: npx vitest run test/integration/document-endpoint-all.test.ts
// Do NOT commit to CI. Delete manually after verification.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { createRequire } from 'module';
import yaml from 'js-yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

// Absolute file:// URL to tsx loader — needed when spawning CLI with cwd
// outside the project tree (bare 'tsx' specifier won't resolve there).
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

const PROJECT_PATHS = [
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading',
  '/Users/NgocVo_1/Documents/sourceCode/bond-exception-handler',
  '/Users/NgocVo_1/Documents/sourceCode/matching-engine-client',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp-message',
  '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading-core',
];

function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

describe('document-endpoint --all E2E', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Analyze each project so the graph index is populated before --all runs.
    // --all reads from the local graph index (LadybugDB), not from source files.
    for (const projectPath of PROJECT_PATHS) {
      if (!fs.existsSync(projectPath)) continue;
      const result = runCliRaw(['analyze', projectPath], projectPath, 300000);
      // Don't fail beforeAll — log and continue
      if (result.status !== 0 && result.status !== null) {
        console.warn(`analyze warning for ${projectPath}:`, result.stderr.slice(0, 200));
      }
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-all-'));
  }, 300000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: Happy path ───────────────────────────────────────────

  it('P0: --all --repo tcbs-bond-trading --outputPath writes .openapi.yaml files', async () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path not found: ${projectPath}. Cannot run local-only E2E.`);
    }

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading', '--outputPath', tmpDir],
      projectPath,
      300000,
    );

    if (result.status === null) throw new Error('CLI timed out');

    // Accept exit 0 (all succeeded) or exit 1 (some endpoints failed, but batch completed)
    expect([0, 1], `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toContain(result.status);

    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    expect(yamlFiles.length).toBeGreaterThan(0);
  }, 300000);

  // ─── Test 2: YAML validity ────────────────────────────────────────

  it('P0: each YAML file is valid openapi 3.1.0 with paths key', () => {
    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    expect(yamlFiles.length).toBeGreaterThan(0);

    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(tmpDir, file), 'utf8');
      let parsed: Record<string, unknown>;
      expect(() => { parsed = yaml.load(content) as Record<string, unknown>; }).not.toThrow();
      expect(parsed).toHaveProperty('openapi', '3.1.0');
      expect(parsed).toHaveProperty('paths');
    }
  }, 60000);

  // ─── Test 3: Filename convention ──────────────────────────────────

  it('P1: filenames match METHOD_path.openapi.yaml convention', () => {
    const yamlFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.openapi.yaml'));
    const methodPathRegex = /^[A-Z]+_.+\.openapi\.yaml$/;

    for (const file of yamlFiles) {
      expect(file).toMatch(methodPathRegex);
      expect(file).not.toMatch(/[\/{} ]/);
    }
  }, 30000);

  // ─── Test 4: Progress output ──────────────────────────────────────

  it('P1: stderr contains Written: progress indicator', async () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return; // already validated in test 1

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading', '--outputPath', tmpDir],
      projectPath,
      300000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect([0, 1]).toContain(result.status);
    expect(result.stderr).toMatch(/Written:/);
  }, 300000);

  // ─── Test 5: Mutual exclusion --all + --method ────────────────────

  it('P1: --all + --method is rejected (mutually exclusive)', () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return;

    const result = runCliRaw(
      [
        'document-endpoint',
        '--all',
        '--method', 'GET',
        '--path', '/foo',
        '--repo', 'tcbs-bond-trading',
        '--outputPath', tmpDir,
      ],
      projectPath,
      30000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(
      combined.toLowerCase().includes('mutually exclusive') ||
      combined.toLowerCase().includes('cannot be used with') ||
      combined.toLowerCase().includes('--method'),
    ).toBe(true);
  }, 30000);

  // ─── Test 6: --all requires --outputPath ──────────────────────────

  it('P1: --all without --outputPath is rejected', () => {
    const projectPath = PROJECT_PATHS[0];
    if (!fs.existsSync(projectPath)) return;

    const result = runCliRaw(
      ['document-endpoint', '--all', '--repo', 'tcbs-bond-trading'],
      projectPath,
      30000,
    );

    if (result.status === null) throw new Error('CLI timed out');
    expect(result.status).toBe(1);
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toMatch(/required|outputPath|missing/i);
  }, 30000);
});
