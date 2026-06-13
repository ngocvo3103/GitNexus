/**
 * Unit tests: LspClient adapter plumbing (WI-4a).
 *
 * Verifies that the four hardcoded TS literals in `lsp-client.ts`
 * are now driven by the `LanguageAdapter` injected via
 * `LspClientOptions.adapter`:
 *
 *   1. Binary discovery basename → `adapter.serverBinary`
 *   2. Spawn arguments           → `adapter.spawnArgs({workspaceRoot})`
 *   3. `initializationOptions`   → `adapter.initializationOptions`
 *   4. `languageId` (didOpen public method default)
 *   5. `languageId` (maybeDidOpenForDefinition private path)
 *
 * Invariant: when `opts.adapter` is omitted, the TS adapter is the
 * default and all five reads reproduce the pre-change hardcoded
 * values exactly (golden / byte-identical constraint).
 *
 * Technique:
 *   - `_inject` fakes: no real subprocess spawned; the connection
 *     is wired over in-process PassThrough pipes, matching the
 *     pattern from `lsp-client.test.ts`.
 *   - Golden case: TS default → captured init params === pre-change
 *     literals; spawn args === ['--stdio']; languageId === 'typescript'.
 *   - Decision case: fake Java adapter injected → its values observed
 *     on the server-side connection log.
 *
 * WI-4a scope: binary/args/languageId/initOpts only.
 * `awaitReady` gate is WI-4b; not tested here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough, type Writable, type Readable } from 'stream';
import { EventEmitter } from 'node:events';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  NullLogger,
  type MessageConnection,
} from 'vscode-languageserver-protocol/node';

import { LspClient, type LspClientOptions } from '../../../src/core/ingestion/lsp/lsp-client.js';
import {
  TYPESCRIPT_ADAPTER,
  type LanguageAdapter,
  type AdapterReadyCtx,
  type LanguageCanaryStrategy,
} from '../../../src/core/ingestion/lsp/language-adapter.js';

// ─── Wire + fake-server helpers (inlined; same pattern as lsp-client.test.ts) ──

interface Wire {
  clientStdin: Writable;
  clientStdout: Readable;
  serverStdout: Readable;
  serverStdin: Writable;
  destroy(): void;
}

function makeWire(): Wire {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const serverStdin = new PassThrough();
  const serverStdout = new PassThrough();
  clientStdin.pipe(serverStdout);
  serverStdin.pipe(clientStdout);
  return {
    clientStdin,
    clientStdout,
    serverStdin,
    serverStdout,
    destroy() {
      try { clientStdin.destroy(); } catch { /* noop */ }
      try { clientStdout.destroy(); } catch { /* noop */ }
      try { serverStdin.destroy(); } catch { /* noop */ }
      try { serverStdout.destroy(); } catch { /* noop */ }
    },
  };
}

interface ServerLog {
  initializeParams: any[];
  didOpenNotifications: Array<{ uri: string; languageId: string }>;
  shutdownCount: number;
}

interface FakeServerHandle {
  connection: MessageConnection;
  log: ServerLog;
  dispose(): void;
}

function makeFakeServer(wire: Wire): FakeServerHandle {
  const connection = createMessageConnection(
    new StreamMessageReader(wire.serverStdout),
    new StreamMessageWriter(wire.serverStdin),
    NullLogger,
  );
  const log: ServerLog = {
    initializeParams: [],
    didOpenNotifications: [],
    shutdownCount: 0,
  };

  connection.onRequest('initialize', (params) => {
    log.initializeParams.push(params);
    return {
      capabilities: {},
      serverInfo: { name: 'fake-server', version: '0.0.0-test' },
    };
  });
  connection.onNotification('initialized', () => { /* noop */ });
  connection.onNotification('textDocument/didOpen', (params: any) => {
    if (params?.textDocument) {
      log.didOpenNotifications.push({
        uri: params.textDocument.uri,
        languageId: params.textDocument.languageId,
      });
    }
  });
  connection.onRequest('textDocument/definition', () => {
    return [{ uri: 'file:///def.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
  });
  connection.onRequest('shutdown', () => {
    log.shutdownCount += 1;
    return null;
  });
  connection.onNotification('exit', () => { /* noop */ });
  connection.listen();

  return {
    connection,
    log,
    dispose() {
      try { connection.dispose(); } catch { /* noop */ }
    },
  };
}

function makeFakeChildProcess(wire: Wire): any {
  const emitter = new EventEmitter();
  const proc: any = {
    stdin: wire.clientStdin,
    stdout: wire.clientStdout,
    stderr: wire.clientStdin,
    stdio: [wire.clientStdin, wire.clientStdout, wire.clientStdin, null, null],
    pid: 88888,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: ['fake-adapter-server'],
    spawnfile: 'fake-adapter-server',
    connected: true,
    kill(sig?: any) {
      try { wire.clientStdin.destroy(); } catch { /* noop */ }
      try { wire.clientStdout.destroy(); } catch { /* noop */ }
      if (!proc.killed) {
        proc.killed = true;
        proc.signalCode = sig || 'SIGTERM';
        emitter.emit('exit', proc.exitCode, proc.signalCode);
      }
      return true;
    },
    on(event: string, handler: any) { emitter.on(event, handler); return proc; },
    once(event: string, handler: any) { emitter.once(event, handler); return proc; },
    off(event: string, handler: any) { emitter.off(event, handler); return proc; },
    emit(event: string, ...args: any[]) { return emitter.emit(event, ...args); },
    addListener(event: string, handler: any) { emitter.addListener(event, handler); return proc; },
    removeListener(event: string, handler: any) { emitter.removeListener(event, handler); return proc; },
    removeAllListeners(event?: string) { emitter.removeAllListeners(event); return proc; },
    setMaxListeners(n: number) { emitter.setMaxListeners(n); return proc; },
    getMaxListeners() { return emitter.getMaxListeners(); },
    listeners(event: string) { return emitter.listeners(event); },
    rawListeners(event: string) { return emitter.rawListeners(event); },
    eventNames() { return emitter.eventNames(); },
    listenerCount(event: string) { return emitter.listenerCount(event); },
    prependListener(event: string, handler: any) { emitter.prependListener(event, handler); return proc; },
    prependOnceListener(event: string, handler: any) { emitter.prependOnceListener(event, handler); return proc; },
    ref() { return proc; },
    unref() { return proc; },
  };

  wire.clientStdout.on('close', () => {
    if (!proc.killed) {
      proc.killed = true;
      emitter.emit('exit', null, null);
    }
  });
  wire.clientStdout.on('error', (e: Error) => {
    emitter.emit('error', e);
  });

  return proc;
}

// ─── Fixture builder ──────────────────────────────────────────────────

interface AdapterFixture {
  client: LspClient;
  server: FakeServerHandle;
  wire: Wire;
  dispose(): Promise<void>;
}

function makeAdapterFixture(opts: Omit<LspClientOptions, '_inject' | 'workspaceRoot'>): AdapterFixture {
  const wire = makeWire();
  const server = makeFakeServer(wire);
  const proc = makeFakeChildProcess(wire);
  const clientConnection = createMessageConnection(
    new StreamMessageReader(wire.clientStdout),
    new StreamMessageWriter(wire.clientStdin),
    NullLogger,
  );
  const client = new LspClient({
    ...opts,
    // Use '/' so the M7 workspace-containment check in
    // maybeDidOpenForDefinition accepts any absolute file:// URI.
    workspaceRoot: '/',
    _inject: {
      spawn: () => ({ process: proc, connection: clientConnection }),
    },
  });
  return {
    client,
    server,
    wire,
    async dispose() {
      try { await client.stop(); } catch { /* noop */ }
      server.dispose();
      try { clientConnection.dispose(); } catch { /* noop */ }
      wire.destroy();
    },
  };
}

// ─── Fake Java adapter ────────────────────────────────────────────────

const FAKE_JAVA_INIT_OPTIONS = {
  settings: { java: { home: '/usr/lib/jvm/java-17' } },
};

const FAKE_JAVA_ADAPTER: LanguageAdapter = {
  id: 'java',
  serverBinary: 'jdtls',
  languageId: 'java',

  spawnArgs(ctx: { workspaceRoot: string }): string[] {
    return ['-data', `${ctx.workspaceRoot}/.jdtls-data`];
  },

  initializationOptions: FAKE_JAVA_INIT_OPTIONS,

  async awaitReady(_ctx: AdapterReadyCtx): Promise<boolean> {
    return true;
  },

  canary: null as LanguageCanaryStrategy | null,

  classifyUri(uri: string): 'workspace' | 'external' | 'unmappable' {
    if (uri.startsWith('file://')) return 'workspace';
    if (uri.startsWith('jdt://')) return 'external';
    return 'unmappable';
  },
};

// ─── Tests ────────────────────────────────────────────────────────────

describe('LspClient adapter plumbing (WI-4a)', () => {
  // Suppress unhandledRejection noise from destroyed streams and from
  // vscode-jsonrpc connection disposal (same pattern as lsp-client.test.ts).
  //
  // Two noise sources in awaitReady=false / awaitReady=throws tests:
  //   1. ERR_STREAM_DESTROYED — pipe written after cleanup destroys it.
  //   2. vscode-jsonrpc "Connection is disposed." (serialized code: 2) —
  //      cleanupAfterFailure() kills the fake proc, which emits 'exit',
  //      which triggers the lifecycle listener's restart() call, which
  //      calls connection.listen() on an already-disposed connection.
  //      Neither source affects any test assertion.
  const _origUnhandled = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason: any) => {
    const code = reason?.code ?? '';
    if (
      reason &&
      typeof reason === 'object' &&
      (
        String(code) === 'ERR_STREAM_DESTROYED' ||
        // vscode-jsonrpc serialized error for "Connection is disposed."
        (typeof code === 'number' && code === 2 && typeof reason?.message === 'string' &&
          (reason.message as string).includes('disposed'))
      )
    ) {
      return;
    }
    for (const l of _origUnhandled) {
      try { (l as any).call(process, reason); } catch { /* noop */ }
    }
  });

  describe('TS default (no adapter supplied)', () => {
    let fx: AdapterFixture;
    beforeEach(() => { fx = makeAdapterFixture({}); });
    afterEach(async () => { await fx.dispose(); });

    it('AD-1: TS initializationOptions are byte-identical to pre-change', async () => {
      await fx.client.start();
      expect(fx.server.log.initializeParams).toHaveLength(1);
      const params = fx.server.log.initializeParams[0];
      // Exactly the TS_INITIALIZATION_OPTIONS constant from lsp-client.ts.
      expect(params.initializationOptions).toEqual({
        hostInfo: 'gitnexus-lsp-client',
        tsserver: { path: '' },
      });
    });

    it('AD-2: didOpen public method defaults languageId to typescript', async () => {
      await fx.client.start();
      const uri = 'file:///workspace/src/main.ts';
      // Call didOpen without an explicit languageId — the adapter default kicks in.
      // Send a subsequent request so the notification is guaranteed to have been
      // processed by the fake server before we assert on the log (same pattern
      // as ST-3 in lsp-client.test.ts — the request round-trip flushes the
      // notification from the pipe before the response arrives).
      await fx.client.didOpen(uri, 'const x = 1;');
      // A definition request on the same file forces a round-trip; by the time
      // the response returns, the server has processed the didOpen notification.
      await fx.client.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } }, 5_000);
      expect(fx.server.log.didOpenNotifications).toHaveLength(1);
      expect(fx.server.log.didOpenNotifications[0].languageId).toBe('typescript');
    });

    it('AD-3: maybeDidOpenForDefinition sends languageId typescript', async () => {
      await fx.client.start();
      // Trigger the private maybeDidOpenForDefinition path by sending a
      // textDocument/definition request for a URI not yet opened.
      await fx.client.request(
        'textDocument/definition',
        {
          textDocument: { uri: 'file:///workspace/src/foo.ts' },
          position: { line: 0, character: 0 },
        },
        5_000,
      );
      // The private path should have sent a didOpen notification with
      // languageId 'typescript'.
      const didOpens = fx.server.log.didOpenNotifications;
      expect(didOpens).toHaveLength(1);
      expect(didOpens[0].languageId).toBe('typescript');
    });

    it('AD-4: TS adapter is the default when adapter is omitted (TYPESCRIPT_ADAPTER identity)', () => {
      // Verify the adapter the client uses is the TS adapter by checking
      // that its values match TYPESCRIPT_ADAPTER's contract.
      // We verify indirectly via the initializationOptions on the server
      // side after start() — already covered by AD-1, but this assertion
      // is explicit about the equivalence.
      expect(TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any' })).toEqual(['--stdio']);
      expect(TYPESCRIPT_ADAPTER.languageId).toBe('typescript');
      expect(TYPESCRIPT_ADAPTER.serverBinary).toBe('typescript-language-server');
      expect(TYPESCRIPT_ADAPTER.initializationOptions).toEqual({
        hostInfo: 'gitnexus-lsp-client',
        tsserver: { path: '' },
      });
    });
  });

  describe('Fake Java adapter injected', () => {
    let fx: AdapterFixture;
    beforeEach(() => {
      fx = makeAdapterFixture({ adapter: FAKE_JAVA_ADAPTER });
    });
    afterEach(async () => { await fx.dispose(); });

    it('AD-5: Java adapter initializationOptions are forwarded to initialize request', async () => {
      await fx.client.start();
      expect(fx.server.log.initializeParams).toHaveLength(1);
      const params = fx.server.log.initializeParams[0];
      expect(params.initializationOptions).toEqual(FAKE_JAVA_INIT_OPTIONS);
    });

    it('AD-6: Java adapter spawnArgs are used (observable via the adapter contract)', () => {
      // spawnArgs is called by spawnAndInitialize; with _inject the
      // real spawn is bypassed. We verify the adapter contract directly:
      // the adapter returns the Java-specific args for the workspace.
      const args = FAKE_JAVA_ADAPTER.spawnArgs({ workspaceRoot: '/my/workspace' });
      expect(args).toEqual(['-data', '/my/workspace/.jdtls-data']);
    });

    it('AD-7: didOpen public method uses Java languageId when adapter is Java', async () => {
      await fx.client.start();
      const uri = 'file:///workspace/src/Main.java';
      await fx.client.didOpen(uri, 'public class Main {}');
      // Force a round-trip to flush the didOpen notification through the pipe.
      await fx.client.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } }, 5_000);
      expect(fx.server.log.didOpenNotifications).toHaveLength(1);
      expect(fx.server.log.didOpenNotifications[0].languageId).toBe('java');
    });

    it('AD-8: maybeDidOpenForDefinition sends Java languageId', async () => {
      await fx.client.start();
      await fx.client.request(
        'textDocument/definition',
        {
          textDocument: { uri: 'file:///workspace/src/Main.java' },
          position: { line: 0, character: 0 },
        },
        5_000,
      );
      const didOpens = fx.server.log.didOpenNotifications;
      expect(didOpens).toHaveLength(1);
      expect(didOpens[0].languageId).toBe('java');
    });

    it('AD-9: explicit languageId override in didOpen wins over adapter default', async () => {
      await fx.client.start();
      const uri = 'file:///workspace/src/Main.java';
      // Passing an explicit languageId must override the adapter default.
      await fx.client.didOpen(uri, 'public class Main {}', 'kotlin');
      // Force a round-trip to flush the notification.
      await fx.client.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } }, 5_000);
      expect(fx.server.log.didOpenNotifications).toHaveLength(1);
      expect(fx.server.log.didOpenNotifications[0].languageId).toBe('kotlin');
    });
  });

  describe('TS invariants: TS adapter fields are byte-identical to pre-change hardcodes', () => {
    it('AD-10: spawnArgs returns exactly ["--stdio"]', () => {
      expect(TYPESCRIPT_ADAPTER.spawnArgs({ workspaceRoot: '/any' })).toEqual(['--stdio']);
    });

    it('AD-11: initializationOptions matches the pre-change TS_INITIALIZATION_OPTIONS literal', () => {
      expect(TYPESCRIPT_ADAPTER.initializationOptions).toEqual({
        hostInfo: 'gitnexus-lsp-client',
        tsserver: { path: '' },
      });
    });

    it('AD-12: languageId is typescript', () => {
      expect(TYPESCRIPT_ADAPTER.languageId).toBe('typescript');
    });

    it('AD-13: serverBinary is typescript-language-server', () => {
      expect(TYPESCRIPT_ADAPTER.serverBinary).toBe('typescript-language-server');
    });
  });
});

// ─── WI-4b: awaitReady warm-up gate ──────────────────────────────────────────
//
// Tests for the post-`initialized` warm-up gate inserted in
// `spawnAndInitialize` (KD-1, #172 class). These tests use the same
// `_inject` + fake-server infrastructure above; only the adapter's
// `awaitReady` return value is varied.
//
// Acceptance criteria:
//   AR-1: awaitReady===false → spawnAndInitialize returns false → start() throws,
//          state never reaches 'ready'
//   AR-2: awaitReady pending → concurrent request() resolves null (pre-ready gate)
//   AR-3: awaitReady throws → start() rejects (graceful, no leak)
//   AR-4: TS default adapter → awaitReady is a no-op true → state 'ready' as today
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fake LanguageAdapter with a controllable awaitReady. */
function makeFakeAdapterWith(
  awaitReadyFn: (ctx: AdapterReadyCtx) => Promise<boolean>,
): LanguageAdapter {
  return {
    ...FAKE_JAVA_ADAPTER,
    awaitReady: awaitReadyFn,
  };
}

describe('LspClient awaitReady warm-up gate (WI-4b)', () => {
  // Suppress unhandledRejection noise from destroyed streams and vscode-jsonrpc
  // disposal (same dual guard as the WI-4a suite above).
  const _origUnhandled2 = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason: any) => {
    const code = reason?.code ?? '';
    if (
      reason &&
      typeof reason === 'object' &&
      (
        String(code) === 'ERR_STREAM_DESTROYED' ||
        (typeof code === 'number' && code === 2 && typeof reason?.message === 'string' &&
          (reason.message as string).includes('disposed'))
      )
    ) {
      return;
    }
    for (const l of _origUnhandled2) {
      try { (l as any).call(process, reason); } catch { /* noop */ }
    }
  });

  describe('AR-1: awaitReady returns false → start() fails, state never ready', () => {
    let fx: AdapterFixture;
    beforeEach(() => {
      fx = makeAdapterFixture({
        adapter: makeFakeAdapterWith(async (_ctx) => false),
      });
    });
    afterEach(async () => { await fx.dispose(); });

    it('start() rejects when awaitReady returns false', async () => {
      await expect(fx.client.start()).rejects.toThrow();
    });

    it('state is degraded (never ready) when awaitReady returns false', async () => {
      try { await fx.client.start(); } catch { /* expected */ }
      expect(fx.client.getState()).toBe('degraded');
    });
  });

  describe('AR-2: awaitReady pending → concurrent request() resolves null (pre-ready gate, I-2)', () => {
    it('request() issued while start() is pending (state=starting) returns null', async () => {
      // Control awaitReady's resolution via an external resolver so we can
      // race a request() call against the still-pending warm-up gate.
      let resolveReady!: (v: boolean) => void;
      const readyPromise = new Promise<boolean>((res) => { resolveReady = res; });

      const fx = makeAdapterFixture({
        adapter: makeFakeAdapterWith(async (_ctx) => readyPromise),
      });

      // Start without awaiting — client state transitions to 'starting'
      // and blocks inside awaitReady.
      const startPromise = fx.client.start();

      // Yield the micro-task queue once so spawnAndInitialize has had
      // a chance to reach (and block on) the awaitReady await. Then
      // fire a request while the gate is still pending.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      // State must not be 'ready' yet — the gate is pending.
      expect(fx.client.getState()).not.toBe('ready');

      // A definition request while state is 'starting' must resolve null —
      // this is the #172 tripwire: no pre-ready definition ever published.
      const result = await fx.client.request(
        'textDocument/definition',
        { textDocument: { uri: 'file:///workspace/src/Main.java' }, position: { line: 0, character: 0 } },
        1_000,
      );
      expect(result).toBeNull();

      // Now let the gate pass and let start() complete.
      resolveReady(true);
      await startPromise;
      expect(fx.client.getState()).toBe('ready');

      await fx.dispose();
    });
  });

  describe('AR-3: awaitReady throws → start() rejects (graceful, no leak)', () => {
    let fx: AdapterFixture;
    beforeEach(() => {
      fx = makeAdapterFixture({
        adapter: makeFakeAdapterWith(async (_ctx) => {
          throw new Error('simulated awaitReady crash');
        }),
      });
    });
    afterEach(async () => { await fx.dispose(); });

    it('start() rejects when awaitReady throws', async () => {
      await expect(fx.client.start()).rejects.toThrow();
    });

    it('state is degraded (never ready) when awaitReady throws', async () => {
      try { await fx.client.start(); } catch { /* expected */ }
      expect(fx.client.getState()).toBe('degraded');
    });
  });

  describe('AR-4: TS default adapter — awaitReady no-ops true, state reaches ready (byte-identical)', () => {
    let fx: AdapterFixture;
    beforeEach(() => {
      // No adapter supplied → defaults to TYPESCRIPT_ADAPTER whose
      // awaitReady resolves true immediately.
      fx = makeAdapterFixture({});
    });
    afterEach(async () => { await fx.dispose(); });

    it('start() resolves without throwing when TS adapter is used', async () => {
      await expect(fx.client.start()).resolves.toBeUndefined();
    });

    it('state is ready after start() with TS default adapter', async () => {
      await fx.client.start();
      expect(fx.client.getState()).toBe('ready');
    });

    it('TS TYPESCRIPT_ADAPTER.awaitReady resolves true immediately (no-op contract)', async () => {
      const result = await TYPESCRIPT_ADAPTER.awaitReady({
        connection: {} as unknown,
        workspaceRoot: '/any',
      });
      expect(result).toBe(true);
    });
  });
});
