/**
 * Unit tests: JAVA_ADAPTER.awaitReady + JAVA_ADAPTER.spawnArgs (WI-4c).
 *
 * Technique: state (ready-signal / deadline-no-signal / error) +
 *            decision (-data dir under GITNEXUS_HOME).
 *
 * Isolation:
 *   - awaitReady: a fake MessageConnection with controllable onNotification
 *     and dispose mechanics — no real jdtls spawned.
 *   - spawnArgs: GITNEXUS_HOME overridden via process.env per test to assert
 *     the path derivation; always restored in afterEach.
 *
 * Timer strategy: vi.useFakeTimers() for deadline cases so the tests run
 * in <1 ms rather than 120 seconds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { JAVA_ADAPTER, type AdapterReadyCtx } from '../../../src/core/ingestion/lsp/language-adapter.js';

// ─── Fake MessageConnection ───────────────────────────────────────────────────

/**
 * Minimal fake MessageConnection that records and controls notification
 * handlers registered via onNotification('language/status', handler).
 *
 * Each call to onNotification returns a Disposable whose dispose() removes
 * the handler registration from the recording list so tests can assert
 * the handler was disposed.
 */
function makeFakeConnection() {
  type Handler = (params: unknown) => void;

  // Tracks active handlers by method name.
  const handlers = new Map<string, Set<{ fn: Handler; disposed: boolean }>>();

  // Track how many times dispose was called (for leak assertions).
  let disposeCallCount = 0;

  function onNotification(method: string, handler: Handler): { dispose(): void } {
    if (!handlers.has(method)) {
      handlers.set(method, new Set());
    }
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

  /** Emit a notification to all currently registered handlers for `method`. */
  function emit(method: string, params: unknown): void {
    handlers.get(method)?.forEach((entry) => {
      if (!entry.disposed) {
        entry.fn(params);
      }
    });
  }

  /** Count active (not yet disposed) handlers for `method`. */
  function activeHandlerCount(method: string): number {
    let count = 0;
    handlers.get(method)?.forEach((entry) => {
      if (!entry.disposed) count++;
    });
    return count;
  }

  return {
    onNotification,
    emit,
    activeHandlerCount,
    get disposeCallCount() {
      return disposeCallCount;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal AdapterReadyCtx. deadlineMs is required for deadline tests. */
function makeCtx(
  connection: ReturnType<typeof makeFakeConnection>,
  overrides?: Partial<Omit<AdapterReadyCtx, 'connection'>>,
): AdapterReadyCtx {
  return {
    connection,
    workspaceRoot: '/fake/workspace',
    ...overrides,
  };
}

// ─── Suite: JAVA_ADAPTER.awaitReady — ready signal ───────────────────────────

describe('JAVA_ADAPTER.awaitReady — ready signal', () => {
  it('resolves true when ServiceReady notification arrives before deadline', async () => {
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 5_000 });

    // Start awaiting — do NOT await yet; we need to emit before the deadline.
    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Emit the ServiceReady notification synchronously (microtask will resolve).
    conn.emit('language/status', { type: 'ServiceReady', message: 'Ready' });

    const result = await promise;
    expect(result).toBe(true);
  });

  it('handler is disposed after resolving true on ServiceReady', async () => {
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 5_000 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    conn.emit('language/status', { type: 'ServiceReady' });
    await promise;

    // The handler must have been disposed — no active handlers remain.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });

  it('ignores non-ServiceReady status notifications and keeps waiting', async () => {
    const conn = makeFakeConnection();
    // Short deadline so the test doesn't hang; use fake timers.
    vi.useFakeTimers();
    const ctx = makeCtx(conn, { deadlineMs: 100 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Emit an intermediate status — should NOT resolve yet.
    conn.emit('language/status', { type: 'Starting', message: 'indexing...' });

    // Handler must still be active at this point.
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    // Advance past deadline to let it settle.
    vi.advanceTimersByTime(200);
    const result = await promise;

    expect(result).toBe(false); // deadline fired, canary null
    vi.useRealTimers();
  });

  it('handler is registered exactly once per awaitReady call', async () => {
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 5_000 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    // Before resolving: exactly one handler registered.
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    conn.emit('language/status', { type: 'ServiceReady' });
    await promise;
  });

  it('only resolves true once even if ServiceReady fires multiple times', async () => {
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 5_000 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    conn.emit('language/status', { type: 'ServiceReady' });
    conn.emit('language/status', { type: 'ServiceReady' }); // second emit — ignored

    const result = await promise;
    expect(result).toBe(true);
    // Dispose called exactly once (first settle wins).
    expect(conn.disposeCallCount).toBe(1);
  });
});

// ─── Suite: JAVA_ADAPTER.awaitReady — deadline / canary-null path ────────────

describe('JAVA_ADAPTER.awaitReady — deadline with canary null', () => {
  // Patch JAVA_ADAPTER.canary to null for this suite so the canary-null
  // branch (settle false) is exercisable regardless of WI-2 wiring state.
  const originalCanary = JAVA_ADAPTER.canary;
  beforeEach(() => {
    (JAVA_ADAPTER as unknown as Record<string, unknown>).canary = null;
  });
  afterEach(() => {
    (JAVA_ADAPTER as unknown as Record<string, unknown>).canary = originalCanary;
    vi.useRealTimers();
  });

  it('resolves false at the deadline when no ready signal and canary is null', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 1_000 });

    // Confirm the suite's beforeEach patched canary to null.
    expect(JAVA_ADAPTER.canary).toBeNull();

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // No notification emitted — let the deadline fire.
    vi.advanceTimersByTime(1_100);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('resolves false (not a rejection) on deadline timeout', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600);

    // Must resolve (not reject).
    await expect(promise).resolves.toBe(false);
  });

  it('handler is disposed on deadline even when no ready signal arrived', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600);
    await promise;

    // Handler must be disposed — no leak.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });

  it('uses default 120_000ms deadline when ctx.deadlineMs is undefined', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    // No deadlineMs — must use 120_000ms default.
    const ctx = makeCtx(conn, { deadlineMs: undefined });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // At 119_999ms the handler should still be active.
    vi.advanceTimersByTime(119_999);
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    // At 120_001ms the deadline fires.
    vi.advanceTimersByTime(2);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('resolves before the deadline if ServiceReady fires early', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 10_000 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Fire ready at 1s — well before 10s deadline.
    vi.advanceTimersByTime(1_000);
    conn.emit('language/status', { type: 'ServiceReady' });

    const result = await promise;
    expect(result).toBe(true);
  });
});

// ─── Suite: JAVA_ADAPTER.awaitReady — deadline with canary non-null (KD-1 backstop) ────
//
// BDD Scenario: awaitReady deadline — canary backstop probe invoked and respected
//
// Technique: state-transition + decision table
//   State: canary = non-null stub, ServiceReady never arrives → deadline fires
//   Decision: backstopProbe returns true → settle(true); returns false → settle(false)
//
// Risk: if the backstop ignores the probe result and always settles(true) (the
// original WI-2 placeholder), the readiness gate is bypassed — pre-ready defs
// get published (the #172 class). Both true and false probe outcomes must be
// tested to catch a hardcoded settle(true) regression.

describe('JAVA_ADAPTER.awaitReady — deadline with canary non-null (KD-1 backstop)', () => {
  // Use a non-null stub canary. The actual canary strategy is JAVA_CANARY_STRATEGY
  // but the deadline backstop doesn't care about its sampling logic — it only
  // checks canary !== null before calling backstopProbe. A minimal stub satisfies.
  const stubCanary = {
    isCandidateFile: () => true,
    tryExtractSample: () => null,
  };
  const originalCanary = JAVA_ADAPTER.canary;

  beforeEach(() => {
    (JAVA_ADAPTER as unknown as Record<string, unknown>).canary = stubCanary;
  });
  afterEach(() => {
    (JAVA_ADAPTER as unknown as Record<string, unknown>).canary = originalCanary;
    vi.useRealTimers();
  });

  it('invokes backstopProbe at the deadline when canary is non-null', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx(conn, { deadlineMs: 1_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(1_100);
    await promise;

    // The probe MUST be called exactly once — not zero (ignored), not multiple.
    expect(backstopProbe).toHaveBeenCalledTimes(1);
  });

  it('resolves true when backstopProbe returns true (probe result is respected)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx(conn, { deadlineMs: 1_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(1_100);

    const result = await promise;
    expect(result).toBe(true);
  });

  it('resolves false when backstopProbe returns false (probe result is respected — no hardcoded true)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(false);
    const ctx = makeCtx(conn, { deadlineMs: 1_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(1_100);

    const result = await promise;
    // If production code hardcodes settle(true) instead of using the probe result,
    // this assertion catches it.
    expect(result).toBe(false);
  });

  it('resolves false (degrades gracefully) when backstopProbe rejects', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockRejectedValue(new Error('probe failed'));
    const ctx = makeCtx(conn, { deadlineMs: 1_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(1_100);

    // Must not throw or propagate the rejection — degrade to false.
    await expect(promise).resolves.toBe(false);
  });

  it('handler is disposed on deadline when canary is non-null (no notification leak)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx(conn, { deadlineMs: 500, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600);
    await promise;

    // The notification handler must be disposed even when the backstop fires.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });

  it('ServiceReady before deadline resolves true without invoking backstopProbe', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(false);
    const ctx = makeCtx(conn, { deadlineMs: 5_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    // Server signals ready at 1s — well before 5s deadline.
    vi.advanceTimersByTime(1_000);
    conn.emit('language/status', { type: 'ServiceReady' });

    const result = await promise;
    expect(result).toBe(true);
    // Backstop must NOT be called — the ready signal settled it first.
    expect(backstopProbe).not.toHaveBeenCalled();
  });
});

// ─── Suite: JAVA_ADAPTER.awaitReady — error / degraded paths ─────────────────

describe('JAVA_ADAPTER.awaitReady — error / degraded paths', () => {
  it('resolves false (not throws) when connection.onNotification throws', async () => {
    const brokenConn = {
      onNotification(_method: string, _handler: unknown): never {
        throw new Error('connection already disposed');
      },
    };

    const ctx: AdapterReadyCtx = {
      connection: brokenConn,
      workspaceRoot: '/any',
      deadlineMs: 1_000,
    };

    // Must not throw or reject.
    await expect(JAVA_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
  });

  it('resolves false when the connection object is null (extreme degradation)', async () => {
    const ctx: AdapterReadyCtx = {
      connection: null,
      workspaceRoot: '/any',
      deadlineMs: 1_000,
    };

    // Casting null to MessageConnection will throw on onNotification — must degrade.
    await expect(JAVA_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
  });
});

// ─── Suite: JAVA_ADAPTER.spawnArgs ───────────────────────────────────────────

describe('JAVA_ADAPTER.spawnArgs', () => {
  const originalGitnexusHome = process.env.GITNEXUS_HOME;

  beforeEach(() => {
    // Each test sets its own GITNEXUS_HOME override.
  });

  afterEach(() => {
    // Restore original env.
    if (originalGitnexusHome === undefined) {
      delete process.env.GITNEXUS_HOME;
    } else {
      process.env.GITNEXUS_HOME = originalGitnexusHome;
    }
  });

  it('returns ["-data", <dir>] with exactly two elements', () => {
    process.env.GITNEXUS_HOME = '/tmp/test-home-a';
    const args = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-data');
    expect(typeof args[1]).toBe('string');
  });

  it('the -data dir is under GITNEXUS_HOME (not shared/global ~/.gitnexus)', () => {
    process.env.GITNEXUS_HOME = '/tmp/test-home-b';
    const args = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });
    const dataDir = args[1];
    expect(dataDir).toMatch(/^\/tmp\/test-home-b\//);
  });

  it('contains a "jdtls" segment in the -data dir path', () => {
    process.env.GITNEXUS_HOME = '/tmp/test-home-c';
    const args = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });
    const dataDir = args[1];
    // Path should look like <GITNEXUS_HOME>/jdtls/<hash>
    expect(dataDir).toMatch(/\/jdtls\//);
  });

  it('two different GITNEXUS_HOME values yield different -data dirs', () => {
    process.env.GITNEXUS_HOME = '/tmp/run-1';
    const args1 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });

    process.env.GITNEXUS_HOME = '/tmp/run-2';
    const args2 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });

    // Different GITNEXUS_HOME → different dirs (per-run isolation I-5).
    expect(args1[1]).not.toBe(args2[1]);
  });

  it('same GITNEXUS_HOME + same workspaceRoot → same -data dir (stable mapping)', () => {
    process.env.GITNEXUS_HOME = '/tmp/stable-home';
    const args1 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });
    const args2 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo' });
    // Stable within the same run (idempotent, safe to call multiple times).
    expect(args1[1]).toBe(args2[1]);
  });

  it('different workspaceRoot → different -data dirs (no cross-workspace collision)', () => {
    process.env.GITNEXUS_HOME = '/tmp/shared-home';
    const args1 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo-a' });
    const args2 = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/repo-b' });
    // Different workspace → different hash → different -data dir.
    expect(args1[1]).not.toBe(args2[1]);
  });

  it('the -data dir path contains no spaces or unsafe characters (filesystem safe)', () => {
    process.env.GITNEXUS_HOME = '/tmp/safe-home';
    const args = JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/workspace/my repo with spaces' });
    const dataDir = args[1];
    // The hash segment must be hex-only (no spaces/special chars).
    // Path segments up to the hash are under our control (/jdtls/<hexhash>).
    const segments = dataDir.split('/');
    const hashSegment = segments[segments.length - 1];
    expect(hashSegment).toMatch(/^[0-9a-f]+$/);
  });
});
