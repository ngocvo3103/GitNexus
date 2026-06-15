/**
 * Unit tests: JAVA_ADAPTER.awaitReady — inline canary-probe path (WI-4b).
 *
 * Scope: the `canary !== null` deadline path exercised through the
 * REAL inline probe (no injected `backstopProbe`; no `ctx.onProgressEnd`).
 * The inline probe calls `buildCanarySamples` then — if samples found —
 * `textDocument/didOpen` (sendNotification) + `textDocument/definition`
 * (sendRequest) on the raw MessageConnection.
 *
 * Cases:
 *   CB-1 (preserved): WI-2 wiring — JAVA_ADAPTER.canary === JAVA_CANARY_STRATEGY,
 *         TYPESCRIPT_ADAPTER.canary === TS_CANARY_STRATEGY, isCandidateFile shape.
 *   CB-2: non-existent workspace → buildCanarySamples returns [] → deadline →
 *         settle(false); sendRequest NEVER called.
 *   CB-3: real Java fixture workspace with .java files → samples found → periodic
 *         canary fires → sendRequest rejects → resolves false (no throw).
 *   CB-4: every settle path disposes the language/status handler exactly once
 *         (disposeCallCount===1, activeHandlerCount('language/status')===0).
 *   CB-5 (I-2 negative guard): ServiceReady emitted before deadline → does NOT
 *         settle; promise stays pending; deadline fires settle(false).
 *
 * Deleted from prior version (contradict I-2):
 *   - 'ServiceReady before deadline still wins even when canary is non-null'
 *   - The prior 'resolves false when sendRequest throws' test used an empty
 *     workspace and therefore never reached sendRequest — replaced by CB-3.
 *
 * Invariants:
 *   I-2: ServiceReady MUST NOT trigger settle(true) — the registered handler
 *        is intentionally a no-op consumer.
 *   vi.useRealTimers() in afterEach of every fake-timer suite (no timer bleed).
 *   Inline probe issues didOpen before textDocument/definition (matches production).
 *   sendRequest is NOT called when buildCanarySamples returns [].
 *
 * Technique: Decision Table (samples×sendRequest) + State Transition (CB-5:
 *   awaiting_settle → emits ServiceReady → still awaiting_settle → deadline →
 *   settled(false)) + Error Guessing (dispose leak / double-settle).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  JAVA_ADAPTER,
  TYPESCRIPT_ADAPTER,
  JDTLS_QUIET_INTERVAL_MS,
  type AdapterReadyCtx,
} from '../../../src/core/ingestion/lsp/language-adapter.js';
import { JAVA_CANARY_STRATEGY, TS_CANARY_STRATEGY } from '../../../src/core/ingestion/lsp/canary-sampler.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Periodic canary interval = JDTLS_QUIET_INTERVAL_MS / 2. */
const CANARY_INTERVAL_MS = JDTLS_QUIET_INTERVAL_MS / 2; // 2 500 ms

/**
 * Absolute path to the Java canary fixture directory.
 * Contains OrderService.java with an import statement — so
 * buildCanarySamples(JAVA_CANARY_STRATEGY) returns ≥1 sample.
 */
const JAVA_FIXTURE_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../fixtures/lsp-canary-java',
);

// ─── Fake connection with sendRequest + sendNotification support ──────────────

type NotifHandler = (params: unknown) => void;

interface FakeConnectionOpts {
  /** Controls what sendRequest resolves to. Default: resolves null. */
  sendRequestResult?: unknown;
  /** If true, sendRequest rejects instead of resolving. */
  sendRequestRejects?: boolean;
}

/**
 * Fake MessageConnection that supports:
 *   - onNotification / emit (language/status, $/progress, etc.)
 *   - sendNotification (no-op stub; production calls didOpen via this)
 *   - sendRequest (controllable resolve or reject)
 *   - activeHandlerCount / disposeCallCount / sendRequestCallCount
 */
function makeFakeConnectionWithSendRequest(opts: FakeConnectionOpts = {}) {
  const handlers = new Map<string, Set<{ fn: NotifHandler; disposed: boolean }>>();
  let disposeCallCount = 0;
  let sendRequestCallCount = 0;
  let sendNotificationCallCount = 0;

  function onNotification(method: string, handler: NotifHandler): { dispose(): void } {
    if (!handlers.has(method)) handlers.set(method, new Set());
    const entry = { fn: handler, disposed: false };
    handlers.get(method)!.add(entry);
    return {
      dispose() {
        disposeCallCount++;
        entry.disposed = true;
        handlers.get(method)?.delete(entry);
      },
    };
  }

  // Production inline probe calls conn.sendNotification('textDocument/didOpen', …)
  // before sendRequest. This stub records the call and resolves immediately.
  async function sendNotification(_method: string, _params: unknown): Promise<void> {
    sendNotificationCallCount++;
  }

  async function sendRequest<T>(_method: string, _params: unknown): Promise<T> {
    sendRequestCallCount++;
    if (opts.sendRequestRejects) {
      throw new Error('sendRequest failed (test)');
    }
    return (opts.sendRequestResult ?? null) as T;
  }

  function activeHandlerCount(method: string): number {
    let count = 0;
    handlers.get(method)?.forEach((e) => { if (!e.disposed) count++; });
    return count;
  }

  function emit(method: string, params: unknown): void {
    handlers.get(method)?.forEach((e) => { if (!e.disposed) e.fn(params); });
  }

  return {
    onNotification,
    sendNotification,
    sendRequest,
    emit,
    activeHandlerCount,
    get disposeCallCount() { return disposeCallCount; },
    get sendRequestCallCount() { return sendRequestCallCount; },
    get sendNotificationCallCount() { return sendNotificationCallCount; },
  };
}

function makeCtx(
  connection: ReturnType<typeof makeFakeConnectionWithSendRequest>,
  overrides?: Partial<Omit<AdapterReadyCtx, 'connection'>>,
): AdapterReadyCtx {
  return {
    connection,
    workspaceRoot: '/fake/empty-workspace', // no .java files → samples = []
    ...overrides,
  };
}

// ─── Suite CB-1: WI-2 canary strategy wiring (preserved verbatim) ─────────────
//
// These four assertions are orthogonal to the readiness model and must never
// be removed. They verify that the adapter constants are wired to the correct
// strategy objects (identity equality, not structural equality).

describe('CB-1 — WI-2 canary strategy wiring', () => {
  it('JAVA_ADAPTER.canary is JAVA_CANARY_STRATEGY (not null)', () => {
    expect(JAVA_ADAPTER.canary).not.toBeNull();
    expect(JAVA_ADAPTER.canary).toBe(JAVA_CANARY_STRATEGY);
  });

  it('TYPESCRIPT_ADAPTER.canary is TS_CANARY_STRATEGY (not null)', () => {
    expect(TYPESCRIPT_ADAPTER.canary).not.toBeNull();
    expect(TYPESCRIPT_ADAPTER.canary).toBe(TS_CANARY_STRATEGY);
  });

  it('JAVA_CANARY_STRATEGY.isCandidateFile accepts .java, rejects .ts', () => {
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('Foo.java')).toBe(true);
    expect(JAVA_CANARY_STRATEGY.isCandidateFile('Bar.ts')).toBe(false);
  });

  it('TS_CANARY_STRATEGY.isCandidateFile accepts .ts, rejects .java', () => {
    expect(TS_CANARY_STRATEGY.isCandidateFile('foo.ts')).toBe(true);
    expect(TS_CANARY_STRATEGY.isCandidateFile('Foo.java')).toBe(false);
  });
});

// ─── Suite CB-2..CB-5: deadline with canary non-null ──────────────────────────

describe('JAVA_ADAPTER.awaitReady — settle-until-quiet inline canary path (WI-4b)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── CB-2: no samples → deadline → false; sendRequest NOT called ──────────────
  //
  // BDD:
  //   Given workspaceRoot does not exist (buildCanarySamples returns [])
  //   When awaitReady is called with a short deadline
  //   And the deadline fires
  //   Then the promise resolves false
  //   And sendRequest was never called (no samples → runCanary returns false early)
  it('CB-2: non-existent workspace → no samples → deadline → resolve(false); sendRequest not called', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnectionWithSendRequest();
    const ctx = makeCtx(conn, {
      deadlineMs: 200,
      workspaceRoot: '/path/that/does/not/exist/at/all/ever',
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Advance past deadline; also past first CANARY_INTERVAL_MS to ensure the
    // periodic canary has run and confirmed zero samples.
    await vi.advanceTimersByTimeAsync(Math.max(300, CANARY_INTERVAL_MS + 100));
    const result = await promise;

    expect(result).toBe(false);
    // Critical: sendRequest must NOT have been called (empty samples → early exit).
    expect(conn.sendRequestCallCount).toBe(0);
  });

  // ── CB-3: samples found → sendRequest rejects → resolves false (no throw) ────
  //
  // BDD:
  //   Given workspaceRoot is a real Java fixture directory (contains OrderService.java)
  //   And fs.promises.readFile is mocked to resolve immediately (unit isolation — avoids
  //     real I/O scheduling under fake timers; the readFile result only affects didOpen
  //     content, not whether sendRequest is called)
  //   And the fake connection's sendRequest always rejects
  //   When awaitReady is called
  //   And the periodic canary fires (at CANARY_INTERVAL_MS)
  //   And the canary inline probe finds the .java file, sends didOpen, then sendRequest rejects
  //   Then awaitReady resolves false (does not reject or throw)
  //   And sendRequest was called at least once (proving the inline probe ran past the no-samples check)
  it('CB-3: samples found, sendRequest rejects → awaitReady resolves false without throwing', async () => {
    // Mock fs.promises.readFile to resolve immediately with empty content.
    // This prevents real I/O scheduling from interfering with fake-timer advancement:
    // the production catch { /* unreadable */ } swallows any error anyway, so the
    // resolved-with-'' mock is semantically equivalent for this test's purpose.
    const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('' as never);

    vi.useFakeTimers();
    const conn = makeFakeConnectionWithSendRequest({ sendRequestRejects: true });
    const ctx = makeCtx(conn, {
      // Deadline beyond the first periodic canary so runCanary has time to fire
      // and attempt sendRequest before deadline forces settle(false).
      deadlineMs: CANARY_INTERVAL_MS * 3,
      workspaceRoot: JAVA_FIXTURE_ROOT,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Advance past the first periodic canary interval (CANARY_INTERVAL_MS = 2 500 ms)
    // to trigger runCanary(). Then advance past the deadline (CANARY_INTERVAL_MS * 3)
    // to trigger settle(false). advanceTimersByTimeAsync flushes microtasks between
    // each timer step, ensuring the mocked readFile resolves before sendRequest is called.
    await vi.advanceTimersByTimeAsync(CANARY_INTERVAL_MS + 100);
    await vi.advanceTimersByTimeAsync(CANARY_INTERVAL_MS * 2 + 100);
    const result = await promise;

    // Must resolve (not reject), result must be false (sendRequest error → degrade).
    expect(result).toBe(false);
    // sendRequest must have been called at least once — proves inline probe ran past
    // the samples.length === 0 guard and reached the textDocument/definition request.
    expect(conn.sendRequestCallCount).toBeGreaterThanOrEqual(1);

    readFileSpy.mockRestore();
  });

  // ── CB-4: handler disposed exactly once on every settle path ─────────────────
  //
  // BDD:
  //   Given awaitReady is running with a short deadline
  //   When the deadline fires and settle(false) is called
  //   Then the language/status handler is disposed (activeHandlerCount === 0)
  //   And disposeCallCount === 1 (no double-dispose)
  it('CB-4: language/status handler disposed exactly once when deadline fires (no leak)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnectionWithSendRequest();
    const ctx = makeCtx(conn, { deadlineMs: 300 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });

  // ── CB-5: I-2 negative guard ──────────────────────────────────────────────────
  //
  // BDD (State Transition):
  //   State: awaiting_settle
  //   Event: language/status ServiceReady emitted at t=100ms (well before deadline)
  //   Expected next state: still awaiting_settle (no transition — no-op consumer)
  //   Event: deadline fires at t=600ms
  //   Expected next state: settled, resolve(false)
  //
  // This is the primary regression guard for I-2:
  //   ServiceReady MUST NOT trigger settle(true) in the settle-until-quiet model.
  //   The registered handler is an intentional no-op consumer.
  it('CB-5 (I-2 guard): ServiceReady before deadline does NOT settle; deadline fires settle(false)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnectionWithSendRequest();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Emit ServiceReady at t=100ms (well before the 500ms deadline).
    vi.advanceTimersByTime(100);
    conn.emit('language/status', { type: 'ServiceReady', message: 'Ready' });

    // Handler must still be registered — ServiceReady must NOT have disposed it.
    expect(conn.activeHandlerCount('language/status')).toBe(1);
    // disposeCallCount must still be 0 — no disposal from ServiceReady.
    expect(conn.disposeCallCount).toBe(0);

    // Advance past the deadline to trigger settle(false).
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    // Deadline must resolve false (ServiceReady produced no settle(true)).
    expect(result).toBe(false);
    // Handler disposed exactly once — by the deadline settle path, not by ServiceReady.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });
});
