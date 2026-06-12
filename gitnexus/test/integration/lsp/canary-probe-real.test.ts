/**
 * Integration Test: canary-sampler + workspace-readiness-probe (real binary).
 *
 * gh #172 AC-3: closes the test vacuity gap where the probe was
 * never exercised against a real language server with samples that
 * can actually produce a non-empty definition response.
 *
 * This is the FIRST test in the repo that asserts a non-empty
 * textDocument/definition response from a real typescript-language-server.
 * Prior tests either mocked the client or used a package.json canary
 * (which always returns [] since TSLS doesn't serve JSON definitions).
 *
 * Gating: skipped when `typescript-language-server` is absent from
 * PATH or node_modules/.bin (same pattern as lsp-client-real.test.ts).
 * CI runners without the binary continue to pass; this test only
 * activates in environments where the binary is available.
 *
 * What we verify:
 *   1. `buildCanarySamples` on a small TS fixture returns at least one
 *      sample — proving the FS walker finds and parses import positions.
 *   2. `probeWorkspaceReadiness` with those real samples returns
 *      `ready === true` — proving the probe can actually report ready:true
 *      (which was structurally impossible with the package.json canary).
 *   3. At least one raw `textDocument/definition` response is non-empty
 *      (non-null, length > 0) — directly asserting what the probe counts
 *      as a "resolve". This is the first assertion in the repo on this
 *      shape.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import { buildCanarySamples } from '../../../src/core/ingestion/lsp/canary-sampler.js';
import { probeWorkspaceReadiness } from '../../../src/core/ingestion/lsp/workspace-readiness-probe.js';

describe('canary-sampler + workspace-readiness-probe (real binary — IT, guarded)', () => {
  let typescriptBinary: { path: string; version: string } | null = null;
  let fixtureDir: string;

  beforeAll(async () => {
    const result = await discoverServers();
    typescriptBinary = result.typescript;
    if (!typescriptBinary) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:canary-probe-real] SKIP — typescript-language-server not found on PATH or in node_modules/.bin',
      );
      return;
    }

    // Use the actual gitnexus project as the workspace. This is the
    // only reliable choice for a "resolved workspace" test:
    //   - It has node_modules present (TypeScript is already installed).
    //   - It has a tsconfig.json that covers the source files.
    //   - The language server can build and resolve the module graph
    //     immediately because the project dependencies are already on disk.
    //
    // A bare tmpdir fixture (with no node_modules) causes TSLS to fail
    // to resolve cross-file imports, yielding [] for every definition
    // request — indistinguishable from a workspace-not-built scenario.
    // Using process.cwd() (which vitest sets to the gitnexus/ workdir)
    // mirrors the approach in lsp-client-real.test.ts.
    fixtureDir = process.cwd();
  });

  afterAll(() => {
    // fixtureDir is process.cwd() — never delete it.
  });

  it('buildCanarySamples finds at least one sample in the TS fixture', async () => {
    if (!typescriptBinary) return; // guarded skip

    const samples = await buildCanarySamples(fixtureDir);
    expect(samples.length).toBeGreaterThan(0);

    // The first sample must be a well-formed LSP position.
    const s = samples[0];
    expect(s.textDocument.uri).toMatch(/^file:\/\//);
    expect(typeof s.position.line).toBe('number');
    expect(typeof s.position.character).toBe('number');
    expect(s.position.line).toBeGreaterThanOrEqual(0);
    expect(s.position.character).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it('probeWorkspaceReadiness returns ready:true with real TS samples (AC-3 — first non-empty define assertion)', async () => {
    if (!typescriptBinary) return; // guarded skip

    // This is the FIRST test in the repo asserting a NON-EMPTY
    // textDocument/definition response from a real language server.
    // Previous tests either mocked the client or used a package.json
    // path which always returns [] (TSLS ignores JSON files).

    const samples = await buildCanarySamples(fixtureDir);
    expect(samples.length).toBeGreaterThan(0);

    const client = new LspClient({
      binaryPath: typescriptBinary!.path,
      workspaceRoot: fixtureDir,
    });

    try {
      await client.start();
      expect(client.getState()).toBe('ready');

      // AC-3: probe must report ready:true — structurally impossible
      // with the old package.json canary.
      const probeResult = await probeWorkspaceReadiness(client, samples, {
        perRequestTimeoutMs: 10_000,
      });
      expect(probeResult.ready, `probe reason: ${probeResult.reason}`).toBe(true);

      // Assert at least one raw definition response is non-empty.
      // This directly validates what the probe counts as a "resolve":
      // a non-null, non-empty array from textDocument/definition.
      //
      // This is the FIRST assertion in the repo on this shape.
      let foundNonEmpty = false;
      for (const sample of samples) {
        const result = await client.request<any[]>(
          'textDocument/definition',
          {
            textDocument: sample.textDocument,
            position: sample.position,
          },
          10_000,
        );
        if (result !== null && Array.isArray(result) && result.length > 0) {
          foundNonEmpty = true;
          // Validate the Location shape.
          expect(result[0]).toHaveProperty('uri');
          expect(result[0]).toHaveProperty('range');
          break;
        }
      }

      expect(
        foundNonEmpty,
        'At least one textDocument/definition request must return a non-empty Location[] ' +
          '— the probe cannot report ready:true without at least one such resolve',
      ).toBe(true);
    } finally {
      await client.stop();
    }
  }, 60_000);
});
