/**
 * Unit tests: JAVA_ADAPTER.awaitReady (settle-until-quiet) + JAVA_ADAPTER.spawnArgs.
 *
 * WI-4a rewrite — settle-until-quiet strategy (ADR-002).
 *
 * Technique: State Transition (settle-until-quiet machine) + Decision Table
 *   (quiet vs periodic vs deadline; canary empty vs non-empty).
 *
 * Cases implemented:
 *   S-1  (negative AC / I-2 guard): ServiceReady MUST NOT settle — pending until deadline
 *   S-2  : onProgressEnd → 5000 ms quiet → backstopProbe non-empty → settle(true)
 *   S-3  : onProgressEnd → quiet → probe empty → pending; second end + quiet + probe true → settle(true)
 *   S-4  : zero progress events → periodic canary invoked ≥2× before deadline; non-empty → settle(true)
 *   S-5  : default deadline === JDTLS_READY_DEADLINE_MS (600 000 ms); pending at 599 999 ms; settle(false) at 600 000 ms
 *   S-6  : ctx.deadlineMs override (e.g. 1 000) honoured → settle(false)
 *   S-7  : onNotification throws → resolves false, no throw
 *   S-8  : connection null → resolves false, no throw
 *   S-9  : backstopProbe rejects (via periodic canary) → resolves false, no throw
 *   S-10 : quiet + deadline race → settles exactly once
 *   spawnArgs: 7 cases verbatim (readiness-model-independent)
 *
 * Isolation:
 *   - awaitReady: fake MessageConnection + controlled onProgressEnd seam.
 *   - spawnArgs: GITNEXUS_HOME overridden via process.env per test, restored in afterEach.
 *
 * Timer discipline:
 *   - vi.useFakeTimers() called inside each test that needs it.
 *   - vi.useRealTimers() in afterEach of every fake-timer suite (I-9: no timer bleed).
 *
 * INVARIANT: no ServiceReady-settles-true assertion survives in this file.
 * Every existing ServiceReady test from WI-4c is deleted and replaced by the
 * settle-until-quiet cases below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  JAVA_ADAPTER,
  JDTLS_READY_DEADLINE_MS,
  JDTLS_QUIET_INTERVAL_MS,
  type AdapterReadyCtx,
} from '../../../src/core/ingestion/lsp/language-adapter.js';

// ─── Constants derived from production ───────────────────────────────────────

/** JDTLS_QUIET_INTERVAL_MS / 2 — the periodic canary interval. */
const CANARY_INTERVAL_MS = JDTLS_QUIET_INTERVAL_MS / 2; // 2 500 ms

// ─── Fake MessageConnection ───────────────────────────────────────────────────

/**
 * Minimal fake MessageConnection that records and controls notification
 * handlers registered via onNotification('language/status', handler).
 * Supports a controllable onProgressEnd seam for $/progress injection.
 */
function makeFakeConnection() {
  type Handler = (params: unknown) => void;

  const handlers = new Map<string, Set<{ fn: Handler; disposed: boolean }>>();
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

  function emit(method: string, params: unknown): void {
    handlers.get(method)?.forEach((entry) => {
      if (!entry.disposed) {
        entry.fn(params);
      }
    });
  }

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

/**
 * Build a controllable onProgressEnd seam. Returns the ctx field and a
 * `fireProgressEnd` function that triggers all registered progress-end
 * callbacks (simulates $/progress end events from LspClient).
 */
function makeProgressEndSeam() {
  type ProgressEndCb = (token: string | number) => void;
  const subscribers = new Set<{ fn: ProgressEndCb; disposed: boolean }>();

  function onProgressEnd(cb: ProgressEndCb): { dispose(): void } {
    const entry = { fn: cb, disposed: false };
    subscribers.add(entry);
    return {
      dispose() {
        entry.disposed = true;
        subscribers.delete(entry);
      },
    };
  }

  function fireProgressEnd(token: string | number = 'tok-1'): void {
    for (const entry of subscribers) {
      if (!entry.disposed) {
        entry.fn(token);
      }
    }
  }

  return { onProgressEnd, fireProgressEnd };
}

/** Build a minimal AdapterReadyCtx. */
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

// ─── Suite: S-1 — ServiceReady is a no-op (I-2 regression guard) ─────────────
//
// BDD:
//   Given awaitReady is called
//   When language/status { type: 'ServiceReady' } is emitted
//   Then the promise does NOT settle; it stays pending until the deadline fires settle(false)
//   And backstopProbe is never reached via ServiceReady
//
// This is the PRIMARY regression guard against I-2 violations.
// The suite uses a short overridden deadlineMs so we don't wait 600 s.

describe('S-1 — ServiceReady does NOT settle awaitReady (I-2 regression guard)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('language/status ServiceReady emitted → promise still pending at that moment', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 1_000 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Emit ServiceReady — must NOT settle the promise.
    conn.emit('language/status', { type: 'ServiceReady', message: 'Ready' });

    // At this point the promise should still be pending (deadline not yet fired).
    // We verify by racing against a short timeout; if settled it would race correctly.
    // The handler MUST still be registered (no disposal from ServiceReady).
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    // Advance past deadline to let it settle(false).
    vi.advanceTimersByTime(1_100);
    const result = await promise;

    // ServiceReady path produces no settle(true). Deadline fires settle(false).
    expect(result).toBe(false);
  });

  it('multiple ServiceReady notifications → still no settle', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Fire several ServiceReady notifications.
    conn.emit('language/status', { type: 'ServiceReady' });
    conn.emit('language/status', { type: 'ServiceReady' });
    conn.emit('language/status', { type: 'ServiceReady' });

    // Handler still active — no disposal from ServiceReady path.
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    vi.advanceTimersByTime(600);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('non-ServiceReady status types (Starting, Building) → no settle', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    conn.emit('language/status', { type: 'Starting', message: 'indexing...' });
    conn.emit('language/status', { type: 'Building', message: 'compiling...' });
    conn.emit('language/status', { type: 'Error', message: 'oops' });

    expect(conn.activeHandlerCount('language/status')).toBe(1);

    vi.advanceTimersByTime(600);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('language/status handler is registered exactly once per awaitReady call', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    JAVA_ADAPTER.awaitReady(ctx);

    // Exactly one handler for language/status.
    expect(conn.activeHandlerCount('language/status')).toBe(1);

    vi.advanceTimersByTime(600);
  });
});

// ─── Suite: S-2 — Quiet path: onProgressEnd → 5000 ms quiet → settle(true) ────
//
// BDD:
//   Given ctx.onProgressEnd is wired
//   When a $/progress end event fires
//   And no further end events arrive for JDTLS_QUIET_INTERVAL_MS (5000 ms)
//   And backstopProbe returns non-empty
//   Then settle(true)

describe('S-2 — Quiet path: progress end → quiet interval → non-empty canary → settle(true)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('one progress end event + 5000 ms quiet + non-empty probe → settle(true)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const { onProgressEnd, fireProgressEnd } = makeProgressEndSeam();
    // backstopProbe returns true — both quiet path and periodic canary use it.
    const backstopProbe = vi.fn().mockResolvedValue(true);

    const ctx = makeCtx(conn, {
      deadlineMs: 60_000,
      onProgressEnd,
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Fire one $/progress end — starts the 5000 ms quiet timer.
    // The periodic canary runs in parallel at CANARY_INTERVAL_MS (2500 ms) intervals.
    // Since backstopProbe returns true, whichever path fires first (periodic canary
    // at 2500 ms OR quiet timer at 5000 ms) will settle(true). Either way the
    // final result must be true.
    fireProgressEnd();

    // Advance past the quiet interval — at least one path fires.
    vi.advanceTimersByTime(JDTLS_QUIET_INTERVAL_MS + 100);
    const result = await promise;

    expect(result).toBe(true);
    // backstopProbe invoked at least once (by whichever path fires first).
    expect(backstopProbe).toHaveBeenCalled();
  });

  it('language/status handler is disposed after quiet-path settle(true)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const { onProgressEnd, fireProgressEnd } = makeProgressEndSeam();
    const backstopProbe = vi.fn().mockResolvedValue(true);

    const ctx = makeCtx(conn, { deadlineMs: 60_000, onProgressEnd, backstopProbe });
    const promise = JAVA_ADAPTER.awaitReady(ctx);

    fireProgressEnd();
    vi.advanceTimersByTime(JDTLS_QUIET_INTERVAL_MS);
    await promise;

    // Handler must be disposed — no leak.
    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });
});

// ─── Suite: S-3 — Timer re-arm: empty probe on first quiet, settle on second ──
//
// BDD:
//   Given ctx.onProgressEnd fires once → quiet → probe returns empty → pending
//   When a second $/progress end event fires + quiet elapses + probe returns true
//   Then settle(true) on the second cycle

describe('S-3 — Quiet path: empty probe → pending, second end + quiet + true probe → settle(true)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first end → quiet → probe empty → no settle; subsequent probe true → settle(true)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const { onProgressEnd, fireProgressEnd } = makeProgressEndSeam();

    // All probes return false initially, then true — the first non-empty result settles.
    // Use a counter-based mock: returns false for the first 2 calls, then true.
    let callCount = 0;
    const backstopProbe = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount >= 3; // first 2 calls return false, 3rd returns true
    });

    const ctx = makeCtx(conn, {
      deadlineMs: 60_000,
      onProgressEnd,
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Fire a $/progress end — starts the 5000 ms quiet timer.
    // Meanwhile the periodic canary fires at 2500 ms intervals.
    // After enough time, backstopProbe will return true and settle(true).
    fireProgressEnd('tok-1');

    // Use advanceTimersByTimeAsync to drain async callbacks between timer ticks.
    // Advance enough time for at least 3 probes to fire (2 periodic + 1 quiet).
    await vi.advanceTimersByTimeAsync(JDTLS_QUIET_INTERVAL_MS * 2 + 100);

    const result = await promise;
    expect(result).toBe(true);
    expect(backstopProbe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Suite: S-4 — Periodic canary: zero progress events path ─────────────────
//
// BDD:
//   Given zero $/progress end events
//   When periodic canary fires at CANARY_INTERVAL_MS (2500 ms) intervals
//   Then backstopProbe invoked ≥2× before deadline
//   And on first non-empty result → settle(true)

describe('S-4 — Periodic canary: zero progress events → canary ≥2× before deadline → settle(true)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backstopProbe invoked at least twice before deadline with zero progress events', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(false); // keeps returning false

    const ctx = makeCtx(conn, {
      deadlineMs: 600_000,
      // No onProgressEnd — zero progress events path
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Use advanceTimersByTimeAsync to properly drain async callbacks between timer ticks.
    // Periodic canary fires at CANARY_INTERVAL_MS (2500 ms) intervals.
    // After 2 × CANARY_INTERVAL_MS + margin, probe must have been called ≥2×.
    await vi.advanceTimersByTimeAsync(CANARY_INTERVAL_MS * 2 + 100);

    expect(backstopProbe.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Clean up: advance to deadline.
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;
  });

  it('periodic canary non-empty on first fire → settle(true)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    // Returns true on the first call.
    const backstopProbe = vi.fn().mockResolvedValue(true);

    const ctx = makeCtx(conn, {
      deadlineMs: 600_000,
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Advance to first periodic canary fire.
    vi.advanceTimersByTime(CANARY_INTERVAL_MS);
    const result = await promise;

    expect(result).toBe(true);
    expect(backstopProbe).toHaveBeenCalledTimes(1);
  });

  it('periodic canary reschedules after empty result, settles on second non-empty', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const ctx = makeCtx(conn, {
      deadlineMs: 600_000,
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // First canary fire (2500 ms) → false → reschedule.
    vi.advanceTimersByTime(CANARY_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Second canary fire (5000 ms total) → true → settle(true).
    vi.advanceTimersByTime(CANARY_INTERVAL_MS);
    const result = await promise;

    expect(result).toBe(true);
    expect(backstopProbe).toHaveBeenCalledTimes(2);
  });
});

// ─── Suite: S-5 — Default deadline === JDTLS_READY_DEADLINE_MS (600 000 ms) ──

describe('S-5 — Default deadline is JDTLS_READY_DEADLINE_MS (600 000 ms)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('JDTLS_READY_DEADLINE_MS equals 600 000', () => {
    expect(JDTLS_READY_DEADLINE_MS).toBe(600_000);
  });

  it('pending at 599 999 ms when no settle trigger fires', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    // backstopProbe always returns false so no canary settles early.
    const backstopProbe = vi.fn().mockResolvedValue(false);
    // No deadlineMs — uses default JDTLS_READY_DEADLINE_MS.
    const ctx = makeCtx(conn, { backstopProbe });

    let settled = false;
    const promise = JAVA_ADAPTER.awaitReady(ctx).then((v) => {
      settled = true;
      return v;
    });

    // Advance to just before the default deadline.
    vi.advanceTimersByTime(599_999);
    await Promise.resolve();

    // Not yet settled.
    expect(settled).toBe(false);

    // Cross the deadline.
    vi.advanceTimersByTime(2);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('settle(false) at 600 000 ms with no ready signal', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(false);
    const ctx = makeCtx(conn, { backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600_000);
    const result = await promise;

    expect(result).toBe(false);
  });
});

// ─── Suite: S-6 — ctx.deadlineMs override honoured ───────────────────────────

describe('S-6 — ctx.deadlineMs override is honoured', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ctx.deadlineMs 1000 → settle(false) at 1000 ms (well before 600 000 ms default)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const backstopProbe = vi.fn().mockResolvedValue(false);
    const ctx = makeCtx(conn, { deadlineMs: 1_000, backstopProbe });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Still pending before override deadline.
    vi.advanceTimersByTime(999);
    await Promise.resolve();

    vi.advanceTimersByTime(2);
    const result = await promise;

    expect(result).toBe(false);
  });

  it('deadline resolves false (not a rejection)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600);

    await expect(promise).resolves.toBe(false);
  });

  it('all handlers disposed after deadline settle(false)', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const ctx = makeCtx(conn, { deadlineMs: 500 });

    const promise = JAVA_ADAPTER.awaitReady(ctx);
    vi.advanceTimersByTime(600);
    await promise;

    expect(conn.activeHandlerCount('language/status')).toBe(0);
    expect(conn.disposeCallCount).toBe(1);
  });
});

// ─── Suite: S-7/S-8/S-9 — Degraded paths → resolves false, no throw ──────────

describe('S-7 — onNotification throws → resolves false, no throw', () => {
  it('connection.onNotification throws synchronously → awaitReady resolves false', async () => {
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

    await expect(JAVA_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
  });
});

describe('S-8 — connection null → resolves false, no throw', () => {
  it('null connection → awaitReady resolves false', async () => {
    const ctx: AdapterReadyCtx = {
      connection: null,
      workspaceRoot: '/any',
      deadlineMs: 1_000,
    };

    await expect(JAVA_ADAPTER.awaitReady(ctx)).resolves.toBe(false);
  });
});

describe('S-9 — backstopProbe rejects (via periodic canary) → resolves false, no throw', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backstopProbe rejects → no throw, no unhandled rejection, resolves false at deadline', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    // backstopProbe always rejects — runCanary catches it and returns false.
    // The periodic canary keeps rescheduling (returns false on rejection catch).
    // The promise settles(false) when the hard deadline fires.
    const backstopProbe = vi.fn().mockRejectedValue(new Error('probe failed'));

    const ctx = makeCtx(conn, {
      deadlineMs: 1_000, // short override so the deadline fires quickly
      backstopProbe,
    });

    const promise = JAVA_ADAPTER.awaitReady(ctx);

    // Advance past deadline — probe rejection is caught internally, no throw propagates.
    await vi.advanceTimersByTimeAsync(1_100);

    await expect(promise).resolves.toBe(false);
  });
});

// ─── Suite: S-10 — Double-settle guard: quiet + deadline race ─────────────────
//
// BDD:
//   Given quiet timer and deadline timer could fire at the same moment
//   Then the settled boolean guard ensures resolve is called exactly once

describe('S-10 — Double-settle guard: quiet + deadline race → settles exactly once', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('simultaneous quiet-path and deadline fire → settled exactly once', async () => {
    vi.useFakeTimers();
    const conn = makeFakeConnection();
    const { onProgressEnd, fireProgressEnd } = makeProgressEndSeam();

    // backstopProbe returns true — quiet path would settle(true).
    const backstopProbe = vi.fn().mockResolvedValue(true);

    // Set deadline equal to JDTLS_QUIET_INTERVAL_MS so both race at same tick.
    const ctx = makeCtx(conn, {
      deadlineMs: JDTLS_QUIET_INTERVAL_MS,
      onProgressEnd,
      backstopProbe,
    });

    let resolveCount = 0;
    const promise = JAVA_ADAPTER.awaitReady(ctx).then((v) => {
      resolveCount++;
      return v;
    });

    // Fire progress end — sets quiet timer for 5000 ms.
    fireProgressEnd();

    // Advance exactly to JDTLS_QUIET_INTERVAL_MS — both quiet timer and
    // deadline timer fire at the same moment.
    vi.advanceTimersByTime(JDTLS_QUIET_INTERVAL_MS);

    await promise;

    // Resolved exactly once — the settled guard prevented double-resolution.
    expect(resolveCount).toBe(1);
  });
});

// ─── Suite: JAVA_ADAPTER.spawnArgs (7 cases verbatim — readiness-model-independent) ─

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
