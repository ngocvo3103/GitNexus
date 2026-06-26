/**
 * Unit Tests: adaptive early-bail (mode-a-reconciler).
 *
 * The dispatch loop stops probing once it has issued LSP_EARLY_BAIL_SAMPLE
 * `textDocument/definition` requests with ZERO useful resolutions — the server
 * is demonstrably not resolving this repo (e.g. pylsp on dynamic Python). The
 * remaining candidates are skipped and KEEP their heuristic edge (identical to
 * probing-and-getting-empty under the observed 0-hit rate).
 *
 * Invariants:
 *   EB-1  0-hit feed > sample  → bail trips; probed ≈ sample, bailed > 0.
 *   EB-2  server resolves (non-vendor location) → NEVER bails; all probed.
 *   EB-3  earlyBail:false      → never bails even on a 0-hit feed; all probed.
 *   EB-4  vendor-only resolutions (site-packages) count as 0 hits → bail trips.
 *   EB-5  feed ≤ sample        → never bails (nothing to gain).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  withReconciliationSession,
  LSP_EARLY_BAIL_SAMPLE,
  type WithReconciliationSessionDeps,
  type ReconciliationProbeFn,
  type ReconciliationLspClient,
  type ReconciliationRepo,
  type Candidate,
  type SessionMeta,
} from '../../../src/core/ingestion/mode-a-reconciler.js';

const REPO: ReconciliationRepo = { id: 'r1', repoPath: '/workspace/repo' };

function makeClient(requestImpl: () => Promise<unknown>): ReconciliationLspClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    request: vi.fn(requestImpl),
    getState: vi.fn(() => 'ready'),
  } as unknown as ReconciliationLspClient;
}

function makeDeps(
  client: ReconciliationLspClient,
  over: Partial<WithReconciliationSessionDeps> = {},
): WithReconciliationSessionDeps {
  return {
    discoverServers: vi.fn(async () => ({
      typescript: { path: '/bin/typescript-language-server', version: '4.3.3' },
    })),
    createLspClient: vi.fn(() => client),
    probe: vi.fn(async () => ({ ready: true })) as unknown as ReconciliationProbeFn,
    handToEngine: vi.fn(async () => undefined),
    ...over,
  };
}

function recallCandidates(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceId: `src:${i}`,
    calledName: `fn${i}`,
    file: `src/m${i}.py`,
    line: i,
    character: 0,
  })) as Candidate[];
}

async function runMeta(
  candidates: Candidate[],
  deps: WithReconciliationSessionDeps,
): Promise<SessionMeta> {
  let captured: SessionMeta | undefined;
  await withReconciliationSession(REPO, candidates, async (_sel, meta) => {
    captured = meta;
    return undefined;
  }, deps);
  if (!captured) throw new Error('work-fn never called — gate refused');
  return captured;
}

const inRepoLoc = [{ uri: 'file:///workspace/repo/src/target.py', range: { start: { line: 1, character: 0 } } }];
const vendorLoc = [{ uri: 'file:///workspace/repo/.venv/lib/python3.12/site-packages/numpy/core.py', range: { start: { line: 1, character: 0 } } }];

describe('adaptive early-bail', () => {
  const TOTAL = LSP_EARLY_BAIL_SAMPLE + 50;

  it('EB-1: 0-hit feed larger than the sample → bail trips, remaining kept', async () => {
    const client = makeClient(async () => null); // every probe empty
    const meta = await runMeta(recallCandidates(TOTAL), makeDeps(client));
    expect(meta.earlyBailed).toBe(true);
    // probed ≈ sample (a few extra in-flight under the 8-way pool are allowed).
    expect(meta.probed).toBeGreaterThanOrEqual(LSP_EARLY_BAIL_SAMPLE);
    expect(meta.probed).toBeLessThan(TOTAL);
    expect(meta.bailed ?? 0).toBeGreaterThan(0);
    // Every candidate is accounted for exactly once.
    expect(meta.probed + (meta.bailed ?? 0) + (meta.preFilteredExternal ?? 0)).toBe(TOTAL);
  });

  it('EB-2: server resolves in-repo → never bails, all probed', async () => {
    const client = makeClient(async () => inRepoLoc);
    const meta = await runMeta(recallCandidates(TOTAL), makeDeps(client));
    expect(meta.earlyBailed).toBeFalsy();
    expect(meta.bailed ?? 0).toBe(0);
    expect(meta.probed).toBe(TOTAL);
  });

  it('EB-3: earlyBail:false → exhaustive probing even on a 0-hit feed', async () => {
    const client = makeClient(async () => null);
    const meta = await runMeta(recallCandidates(TOTAL), makeDeps(client, { earlyBail: false }));
    expect(meta.earlyBailed).toBeFalsy();
    expect(meta.bailed ?? 0).toBe(0);
    expect(meta.probed).toBe(TOTAL);
  });

  it('EB-4: vendor-only resolutions count as 0 hits → bail trips', async () => {
    const client = makeClient(async () => vendorLoc); // non-empty but site-packages
    const meta = await runMeta(recallCandidates(TOTAL), makeDeps(client));
    expect(meta.earlyBailed).toBe(true);
    expect(meta.bailed ?? 0).toBeGreaterThan(0);
  });

  it('EB-5: feed at or below the sample → never bails', async () => {
    const client = makeClient(async () => null);
    const meta = await runMeta(recallCandidates(LSP_EARLY_BAIL_SAMPLE), makeDeps(client));
    expect(meta.earlyBailed).toBeFalsy();
    expect(meta.probed).toBe(LSP_EARLY_BAIL_SAMPLE);
  });
});
