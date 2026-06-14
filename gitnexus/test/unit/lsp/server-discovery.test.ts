/**
 * Unit Tests: server-discovery — binary resolution for LSP servers.
 *
 * Decision-table coverage for the 4 resolution sources
 * (node_modules/.bin | PATH | npx | absent) plus the spec-level
 * guarantees (version parsing, no installs).
 *
 * Strategy: mock `child_process` and `fs` via `vi.mock`, drive
 * each branch with a hoisted state object, and assert the public
 * `discoverServers()` contract end-to-end. `parseVersion` is
 * also unit-tested directly so the parsing logic is locked
 * down independently of the spawn plumbing.
 *
 * Isolation: tests use `discoverOne(bin, { cwd })` whenever they
 * need a clean directory tree (the staged binaries live in
 * /var/folders tmp dirs). The public `discoverServers()`
 * surface is exercised in one test that stages its binary
 * inside the project's actual cwd tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync as mockedExecFileSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Hoisted mock state ────────────────────────────────────────────────
//
// vi.hoisted() lets the mock factories (which run at module-load
// time, before vi.mock) share state with the test bodies (which
// run after imports). The factories only know the SHAPE of the
// state; the bodies fill it in per-test.

const { spawnBehavior, fsFiles, npxCalls, execFileCalls } = vi.hoisted(() => ({
  /**
   * Per-cmd response map. Key = the command name passed to
   * execFileSync. Value = the function that returns stdout for
   * that command, or throws to simulate "not found" / non-zero
   * exit / npx package missing.
   */
  spawnBehavior: new Map<string, (args: string[]) => string>(),

  /**
   * Mocked-on-disk files. Keys are absolute paths; presence
   * means `fs.statSync` reports a regular file.
   */
  fsFiles: new Set<string>(),

  /** All npx invocations recorded (cmd + args). */
  npxCalls: [] as Array<{ cmd: string; args: string[] }>,

  /** All execFileSync invocations recorded, for install-grep. */
  execFileCalls: [] as Array<{ cmd: string; args: string[] }>,
}));

// Mutable test fixtures — plain `let` bindings so the test
// bodies can flip them per-test. Cleared in beforeEach.
let npxResponse: string | null = null;

// ─── Mock factories ───────────────────────────────────────────────────

vi.mock('child_process', () => ({
  // Single dispatch: look up the cmd in spawnBehavior; if missing,
  // throw (mimicking "command not found"). Each test registers
  // exactly the responses it needs; an absent test registers none.
  execFileSync: vi.fn((cmd: string, args: any) => {
    const a = (args ?? []) as string[];
    execFileCalls.push({ cmd, args: a });
    if (cmd === 'npx') {
      npxCalls.push({ cmd, args: a });
      // npxResponse null = "no successful npx result registered"
      // — fall through to the spawn map, which throws when no
      // handler is registered. npxResponse set = return that
      // verbatim as stdout (success path).
      if (npxResponse !== null) return npxResponse;
    }
    const handler = spawnBehavior.get(cmd);
    if (!handler) {
      const e: any = new Error(`spawn ${cmd} ENOENT`);
      e.code = 'ENOENT';
      e.status = 127;
      throw e;
    }
    return handler(a);
  }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // The implementation imports `fs` as a default import
  // (`import fs from 'fs'`) which under esModuleInterop resolves
  // to the namespace. We must mock BOTH the namespace AND the
  // default export so both call-sites get the same mocked fn.
  const statSyncMock = vi.fn((p: string) => {
    const abs = path.resolve(p);
    if (fsFiles.has(abs)) {
      return { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false };
    }
    const e: any = new Error(`ENOENT: no such file or directory, stat '${p}'`);
    e.code = 'ENOENT';
    throw e;
  });
  const existsSyncMock = vi.fn((p: string) => fsFiles.has(path.resolve(p)));
  return {
    ...actual,
    statSync: statSyncMock,
    existsSync: existsSyncMock,
    default: { ...actual, statSync: statSyncMock, existsSync: existsSyncMock },
  };
});

// ─── Imports under test ───────────────────────────────────────────────

import {
  discoverServers,
  discoverOne,
  parseVersion,
  TYPESCRIPT_LANGUAGE_SERVER_BIN,
  JDTLS_BIN,
  PYLSP_BIN,
  GOPLS_BIN,
} from '../../../src/core/ingestion/lsp/server-discovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function stageBinary(absPath: string): void {
  fsFiles.add(path.resolve(absPath));
}

function registerSpawn(cmd: string, handler: (args: string[]) => string): void {
  spawnBehavior.set(cmd, handler);
}

beforeEach(() => {
  spawnBehavior.clear();
  fsFiles.clear();
  npxCalls.length = 0;
  execFileCalls.length = 0;
  npxResponse = null;
  // Re-apply default impl to `execFileSync` — some tests override
  // it with mockImplementation and we must restore the factory
  // behavior between tests.
  (mockedExecFileSync as any).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('server-discovery', () => {
  describe('discoverServers (public surface)', () => {
    it('exports the expected signature', () => {
      expect(typeof discoverServers).toBe('function');
    });

    it('returns the documented result shape on success', async () => {
      // discoverServers() uses process.cwd() — stage the binary
      // in the project's existing node_modules/.bin so the
      // walker finds it without us having to override cwd.
      // The gitnexus project doesn't ship the binary, so we
      // add a synthetic entry to fsFiles for its notional path.
      const projectNmBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(projectNmBin);
      registerSpawn(projectNmBin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverServers();

      expect(result).toEqual({
        typescript: { path: projectNmBin, version: '4.3.3' },
      });
    });
  });

  describe('decision table: resolution source', () => {
    // ── 1) node_modules/.bin ────────────────────────────────────────
    it('resolves from node_modules/.bin (walking up from cwd)', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-nm-'));
      const nestedCwd = path.join(projectRoot, 'src', 'core');
      fs.mkdirSync(nestedCwd, { recursive: true });
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: nestedCwd });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(bin);
      expect(result!.version).toBe('4.3.3');
      // Sanity: the binary was spawned with `--version` exactly.
      const versionCall = execFileCalls.find(
        (c) => c.cmd === bin && c.args[0] === '--version',
      );
      expect(versionCall).toBeDefined();

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('walks up multiple levels to find a node_modules', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-deep-'));
      const deep = path.join(projectRoot, 'a', 'b', 'c', 'd', 'e');
      fs.mkdirSync(deep, { recursive: true });
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => '4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: deep });
      expect(result?.path).toBe(bin);

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    // ── S2: workspaceRoot bounds the parent walk ──────────────────
    it('S2: stops the parent walk at workspaceRoot (rejects shim above the workspace)', async () => {
      // Workspace root = `workspaceInner`. The untrusted shim
      // lives in `workspaceOuter/node_modules/.bin/...` —
      // OUTSIDE the workspace, but the parent walk would
      // normally find it on its way to the filesystem root.
      const workspaceOuter = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-s2-outer-'));
      const workspaceInner = path.join(workspaceOuter, 'project');
      const nestedCwd = path.join(workspaceInner, 'src', 'core');
      fs.mkdirSync(nestedCwd, { recursive: true });

      // Untrusted shim — lexically above `workspaceInner`.
      const shim = path.join(
        workspaceOuter,
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(shim);
      registerSpawn(shim, () => 'evil-version\n');

      // The bounded walk must NOT find the shim. It should
      // fall through to PATH (also empty), and npx (also
      // empty), so the final result is `null`.
      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: nestedCwd,
        workspaceRoot: workspaceInner,
      });
      expect(result).toBeNull();

      // Sanity: without the `workspaceRoot` bound, the same
      // fixture WOULD find the shim — confirms the bound is
      // the load-bearing change.
      const resultUnbounded = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: nestedCwd,
      });
      expect(resultUnbounded?.path).toBe(shim);

      fs.rmSync(workspaceOuter, { recursive: true, force: true });
    });

    it('S2: in-workspace binary is found even when one is staged above the workspace', async () => {
      // Two `node_modules/.bin/...` stages: one above the
      // workspace (untrusted), one inside (trusted). The
      // bounded walk must find the in-workspace one and
      // ignore the outer shim.
      const workspaceOuter = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-s2-2-outer-'));
      const workspaceInner = path.join(workspaceOuter, 'project');
      const nestedCwd = path.join(workspaceInner, 'src');
      fs.mkdirSync(nestedCwd, { recursive: true });

      const shim = path.join(
        workspaceOuter,
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(shim);
      registerSpawn(shim, () => 'evil\n');

      const trusted = path.join(
        workspaceInner,
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(trusted);
      registerSpawn(trusted, () => '4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: nestedCwd,
        workspaceRoot: workspaceInner,
      });
      expect(result?.path).toBe(trusted);
      expect(result?.version).toBe('4.3.3');

      fs.rmSync(workspaceOuter, { recursive: true, force: true });
    });

    // ── 2) PATH fallback ────────────────────────────────────────────
    it('falls back to PATH (which/where) when node_modules has nothing', async () => {
      const fakeBin = '/fake/bin/typescript-language-server';
      stageBinary(fakeBin);
      registerSpawn(fakeBin, () => 'typescript-language-server 5.0.0 (commit abc)\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${fakeBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/cwd/that/definitely/has/no/node_modules',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(fakeBin);
      expect(result!.version).toBe('5.0.0');
    });

    it('PATH fallback handles multi-match where output (uses first line)', async () => {
      const fakeBin1 = '/fake/bin/typescript-language-server';
      const fakeBin2 = '/usr/local/bin/typescript-language-server';
      stageBinary(fakeBin1);
      stageBinary(fakeBin2);
      registerSpawn(fakeBin1, () => 'typescript-language-server 4.3.3\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${fakeBin1}\n${fakeBin2}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result!.path).toBe(fakeBin1);
    });

    // ── 3) npx fallback ─────────────────────────────────────────────
    it('falls back to npx when node_modules and PATH both miss', async () => {
      // SECURITY FIX: tryNpx() no longer synthesizes a
      // DiscoveredServer from the npx binary path. It still
      // runs the npx version probe for diagnostics, but only
      // returns a DiscoveredServer when it can subsequently
      // resolve the actual typescript-language-server binary
      // on disk (via whichOnPath). To simulate that, we stage
      // both the npx binary AND a real typescript-language-server
      // binary that the post-probe PATH lookup will find.
      const npxBin = '/usr/local/bin/npx';
      const tsBin = '/opt/npx-cache/typescript-language-server';
      stageBinary(npxBin);
      stageBinary(tsBin);
      npxResponse = 'typescript-language-server 4.3.3\n';
      // whichOnPath(binaryName) is the post-probe resolution
      // — register `which` to return the staged ts server.
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${tsBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.version).toBe('4.3.3');
      // The returned path is the verified language server, NOT
      // the npx binary — this is the security-critical invariant.
      expect(result!.path).toBe(tsBin);
      expect(result!.path).not.toBe(npxBin);
      // npx was actually invoked with --no-install + the binary.
      expect(npxCalls.length).toBe(1);
      expect(npxCalls[0].args).toEqual(['--no-install', TYPESCRIPT_LANGUAGE_SERVER_BIN, '--version']);
    });

    it('returns null from npx branch when the post-probe PATH resolution fails', async () => {
      // npx probe succeeds (npx found the package), but the
      // subsequent whichOnPath('typescript-language-server')
      // fails — no real binary on disk. tryNpx() must return
      // null rather than synthesize a DiscoveredServer from
      // the npx path. This is the MAJOR security finding fix.
      npxResponse = 'typescript-language-server 4.3.3\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);
      // Deliberately do NOT stage any typescript-language-server
      // binary, and do NOT register a `which` handler — both
      // resolution attempts must return null.

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).toBeNull();
      // Sanity: npx was attempted (diagnostic probe ran), but
      // no DiscoveredServer was returned.
      expect(npxCalls.length).toBe(1);
    });

    it('never returns the npx binary path as the DiscoveredServer.path', async () => {
      // Even when npx succeeds and the post-probe resolution
      // finds a binary, the returned `path` field must be the
      // verified language server — not the npx launcher.
      const npxBin = '/usr/local/bin/npx';
      const tsBin = '/usr/local/lib/node_modules/.bin/typescript-language-server';
      stageBinary(npxBin);
      stageBinary(tsBin);
      npxResponse = 'typescript-language-server 4.3.3\n';
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${tsBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).not.toMatch(/npx/);
      expect(result!.path).toBe(tsBin);
    });

    // ── 4) absent everywhere ────────────────────────────────────────
    it('returns null when the server is absent everywhere (no throw)', async () => {
      // Stage nothing, register nothing — every spawn throws.
      // discoverOne must not throw and must return null.
      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();
    });

    it('discoverServers returns { typescript: null } when absent', async () => {
      // Force a guaranteed-empty cwd by stubbing the project's
      // real node_modules tree. We do this by NOT staging any
      // file at the project's notional path — the test before
      // this one that needed to stage one ran with `stageBinary`
      // and we cleared `fsFiles` in beforeEach.
      const result = await discoverServers();
      expect(result).toEqual({ typescript: null });
    });

    it('never throws on any failure path (sync + async safety)', async () => {
      const result = await discoverServers();
      expect(result).toBeDefined();
      expect(result.typescript).toBeNull();
    });
  });

  describe('parseVersion (defensive parser)', () => {
    // ── 5) version parsing ──────────────────────────────────────────
    it('extracts a clean x.y.z version', () => {
      expect(parseVersion('typescript-language-server 4.3.3')).toBe('4.3.3');
    });

    it('strips a leading v prefix', () => {
      expect(parseVersion('v4.3.3')).toBe('4.3.3');
    });

    it('handles x.y.z (commit hash) suffixes', () => {
      expect(parseVersion('typescript-language-server 4.3.3 (commit abc1234)')).toBe('4.3.3');
    });

    it('handles 4-part versions (4.3.3.1)', () => {
      expect(parseVersion('typescript-language-server 4.3.3.1')).toBe('4.3.3.1');
    });

    it('handles 2-part versions (1.0)', () => {
      expect(parseVersion('typescript-language-server 1.0')).toBe('1.0');
    });

    it('falls back to "unknown" on garbage input', () => {
      expect(parseVersion('something completely unparseable')).toBe('unknown');
      expect(parseVersion('')).toBe('unknown');
      expect(parseVersion('\n\n')).toBe('unknown');
    });

    it('integrates with discoverOne (version parsed from --version stdout)', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-ver-'));
      const bin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      stageBinary(bin);
      registerSpawn(bin, () => 'typescript-language-server 4.3.3\n');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, { cwd: projectRoot });
      expect(result?.version).toBe('4.3.3');

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
  });

  describe('no-install guarantee', () => {
    // ── 6) never installs ───────────────────────────────────────────
    it('does not invoke npm install / npm i / yarn add / pnpm add', async () => {
      // The implementation should NEVER spawn a package manager
      // mutator. The only npx invocations allowed use the
      // `--no-install` flag. (We assert against the bare-arg
      // form to avoid false positives on the flag itself.)
      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();

      for (const call of execFileCalls) {
        const argv = [call.cmd, ...(call.args ?? [])].join(' ').toLowerCase();
        // No bare "install" subcommand (npm install / yarn install / pnpm install)
        expect(argv, `discover must not invoke: ${argv}`).not.toMatch(/(^|\s)(npm|yarn|pnpm)\s+install\b/);
        // No `npm i <pkg>`, `yarn add <pkg>`, or `pnpm add <pkg>`
        expect(argv, `discover must not invoke: ${argv}`).not.toMatch(/(^|\s)(npm\s+i|yarn\s+add|pnpm\s+add)\b\s+\S+/);
      }
    });

    it('npx fallback uses --no-install (no side-effect download)', async () => {
      npxResponse = 'typescript-language-server 4.3.3\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);

      await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      // The npx invocation MUST include --no-install to prevent
      // a stray download when the binary is missing.
      expect(npxCalls.length).toBe(1);
      expect(npxCalls[0].args).toContain('--no-install');
    });

    it('never writes to the filesystem (no fs.writeFile, no fs.mkdir)', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const rmSpy = vi.spyOn(fs, 'rmSync');

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();

      expect(writeSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolution-source priority', () => {
    it('node_modules wins over PATH when both are available', async () => {
      // Stage BOTH: a node_modules binary AND a PATH binary.
      // The node_modules one must win (lower-numbered source).
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-prio-'));
      const nmBin = path.join(projectRoot, 'node_modules', '.bin', TYPESCRIPT_LANGUAGE_SERVER_BIN);
      const pathBin = '/opt/bin/typescript-language-server';
      stageBinary(nmBin);
      stageBinary(pathBin);

      registerSpawn(nmBin, () => 'typescript-language-server 9.9.9\n');
      registerSpawn(pathBin, () => 'typescript-language-server 1.0.0\n');

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${pathBin}\n`);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: projectRoot,
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(nmBin);
      expect(result!.version).toBe('9.9.9');

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('PATH wins over npx when both are available', async () => {
      const pathBin = '/opt/bin/typescript-language-server';
      stageBinary(pathBin);
      registerSpawn(pathBin, () => 'typescript-language-server 5.0.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${pathBin}\n`);

      // If the impl falls through to npx, npxCalls would grow.
      npxResponse = 'typescript-language-server 1.0.0\n';
      const npxBin = '/usr/local/bin/npx';
      stageBinary(npxBin);

      const result = await discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pathBin);
      expect(result!.version).toBe('5.0.0');
      // npx must NOT have been called.
      expect(npxCalls.length).toBe(0);
    });
  });

  // ─── WI-3: jdtls discovery ────────────────────────────────────────────
  //
  // Acceptance criteria (EP: jdtls present / absent) + TS-unchanged
  // equivalence. These tests exercise `discoverServers()` end-to-end
  // with a mocked PATH so they do not require a real jdtls installation.

  describe('WI-3 — jdtls discovery via discoverServers()', () => {
    it('exports JDTLS_BIN constant with the correct value', () => {
      expect(JDTLS_BIN).toBe('jdtls');
    });

    it('AC: mocked PATH with jdtls → java entry non-null in discoverServers result', async () => {
      // Stage a fake jdtls binary on PATH and a TS binary on node_modules
      // so both entries can be exercised in a single discoverServers() call.
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(jdtlsBin);
      stageBinary(tsBin);

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        // which is called for both binaries; route by the requested name.
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      registerSpawn(jdtlsBin, () => 'jdtls 1.26.0\n');

      const result = await discoverServers();

      // java entry is present and non-null
      expect(result.java).not.toBeNull();
      expect(result.java).not.toBeUndefined();
      expect(result.java!.path).toBe(jdtlsBin);
      expect(result.java!.version).toBe('1.26.0');
    });

    it('AC: absent jdtls → java entry is absent (undefined) in discoverServers result', async () => {
      // Stage only a TS binary — no jdtls anywhere.
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(tsBin);
      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      // No which handler, no jdtls staged → discoverOne(JDTLS_BIN) → null

      const result = await discoverServers();

      // java is omitted (undefined) when jdtls is absent — not `null` —
      // so that existing callers whose toEqual asserts only { typescript }
      // continue to pass (toEqual ignores undefined-valued keys).
      expect(result.java).toBeUndefined();
      // Confirm result.java is falsy in any case
      expect(result.java ?? null).toBeNull();
    });

    it('AC: typescript entry is identical to today when jdtls is also discovered', async () => {
      // Both binaries present — verify the typescript entry is byte-identical
      // to what discoverServers() returned before WI-3 (path + version intact).
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      stageBinary(tsBin);
      stageBinary(jdtlsBin);

      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      registerSpawn(jdtlsBin, () => 'jdtls 1.26.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });

      const result = await discoverServers();

      // The typescript entry must be exactly what it was before WI-3.
      expect(result.typescript).toEqual({ path: tsBin, version: '4.3.3' });
    });

    it('AC: typescript entry is null when TS absent even if jdtls is present', async () => {
      // TS absent, jdtls present — confirm the two are discovered independently.
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      stageBinary(jdtlsBin);

      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      registerSpawn(jdtlsBin, () => 'jdtls 1.26.0\n');

      const result = await discoverServers();

      expect(result.typescript).toBeNull();
      expect(result.java).not.toBeNull();
      expect(result.java!.path).toBe(jdtlsBin);
    });

    it('discoverOne reused for jdtls — same resolution sources (PATH hit)', async () => {
      // Verify discoverOne(JDTLS_BIN) follows the standard resolution chain.
      const jdtlsBin = '/usr/local/bin/jdtls';
      stageBinary(jdtlsBin);
      registerSpawn(jdtlsBin, () => 'jdtls 1.26.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, () => `${jdtlsBin}\n`);

      const result = await discoverOne(JDTLS_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(jdtlsBin);
      expect(result!.version).toBe('1.26.0');
    });

    it('discoverOne reused for jdtls — absent everywhere returns null', async () => {
      const result = await discoverOne(JDTLS_BIN, {
        cwd: '/nonexistent/empty',
      });
      expect(result).toBeNull();
    });

    // ── #159 root cause #1 — slow/silent --version must NOT drop the binary ──
    //
    // REGRESSION GUARD. jdtls spins a full JVM on `--version`: it exceeds
    // the 5s probe cap (execFileSync throws ETIMEDOUT) and even when allowed
    // to finish prints only a logback/spifly banner to STDERR (no version
    // token on stdout). The pre-fix `finalize()` mapped that ETIMEDOUT throw
    // to `null` and DROPPED the already-located binary, so `discoverServers()`
    // omitted the `java` key and the entire Mode-A Java funnel refused every
    // candidate (`server <unknown>`). A binary a resolution source already
    // LOCATED must survive a slow/silent `--version` with `version:'unknown'`.

    it('RC#1: a located jdtls whose --version TIMES OUT is kept with version "unknown"', async () => {
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      stageBinary(jdtlsBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // Simulate the slow-JVM timeout: execFileSync throws ETIMEDOUT when it
      // runs `jdtls --version` (the binary launched, then was killed for being
      // slow — NOT an ENOENT "binary missing").
      registerSpawn(jdtlsBin, () => {
        throw Object.assign(new Error('spawnSync jdtls ETIMEDOUT'), {
          code: 'ETIMEDOUT',
        });
      });

      const result = await discoverOne(JDTLS_BIN, { cwd: '/nonexistent/empty' });

      // The located binary MUST be kept — dropping it is the #159 bug.
      expect(result).not.toBeNull();
      expect(result!.path).toBe(jdtlsBin);
      expect(result!.version).toBe('unknown');
    });

    it('RC#1: a located jdtls whose --version prints NO version token is kept with version "unknown"', async () => {
      // Even when --version returns under the cap, jdtls emits only a banner
      // with no semver token → parseVersion → 'unknown'. The binary is still
      // present and launchable, so it must be kept.
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      stageBinary(jdtlsBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      registerSpawn(
        jdtlsBin,
        () => 'WARNING: Using incubator modules: jdk.incubator.vector\n',
      );

      const result = await discoverOne(JDTLS_BIN, { cwd: '/nonexistent/empty' });
      expect(result).not.toBeNull();
      expect(result!.path).toBe(jdtlsBin);
      expect(result!.version).toBe('unknown');
    });

    it('RC#1 boundary: a TRULY-absent binary (ENOENT spawn) is still dropped (null)', async () => {
      // The fix must NOT resurrect a phantom path. If the located path turns
      // out not to be a runnable file (ENOENT/EACCES on spawn), discovery
      // still returns null so we never hand back a non-existent server.
      const phantom = '/opt/homebrew/bin/jdtls';
      stageBinary(phantom); // statSync says it exists (located)…
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${phantom}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // …but spawning it fails ENOENT (e.g. deleted between stat and spawn):
      registerSpawn(phantom, () => {
        throw Object.assign(new Error('spawn jdtls ENOENT'), {
          code: 'ENOENT',
          status: 127,
        });
      });

      const result = await discoverOne(JDTLS_BIN, { cwd: '/nonexistent/empty' });
      expect(result).toBeNull();
    });
  });

  // ─── WI-4: pylsp discovery ────────────────────────────────────────────
  //
  // Decision table on 4 resolution sources (node_modules/.bin | PATH | npx | absent)
  // mirroring the WI-3 jdtls pattern. Tests also verify the spread-omit invariant
  // (python omitted when absent) and the "never drop" guarantee from RC#1.

  describe('WI-4 — pylsp discovery via discoverServers()', () => {
    it('exports PYLSP_BIN constant with the correct value', () => {
      expect(PYLSP_BIN).toBe('pylsp');
    });

    // ── Case 1: node_modules/.bin hit ──────────────────────────────
    it('case 1: pylsp staged at node_modules/.bin → python entry version 1.14.0', async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-sd-pylsp-nm-'));
      const pylspBin = path.join(projectRoot, 'node_modules', '.bin', PYLSP_BIN);
      stageBinary(pylspBin);
      registerSpawn(pylspBin, () => 'pylsp v1.14.0\n');

      const result = await discoverOne(PYLSP_BIN, { cwd: projectRoot });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pylspBin);
      expect(result!.version).toBe('1.14.0');

      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    // ── Case 2: PATH hit ────────────────────────────────────────────
    it('case 2: pylsp on PATH → python entry version 1.12.0', async () => {
      const pylspBin = '/Users/NgocVo_1/.local/bin/pylsp';
      stageBinary(pylspBin);
      registerSpawn(pylspBin, () => 'pylsp 1.12.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === PYLSP_BIN) return `${pylspBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });

      const result = await discoverOne(PYLSP_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pylspBin);
      expect(result!.version).toBe('1.12.0');
    });

    // ── Case 3: npx fallback ────────────────────────────────────────
    it('case 3: pylsp absent from node_modules/.bin and PATH, npx fallback sets path', async () => {
      const pylspBin = '/usr/local/lib/node_modules/.bin/pylsp';
      stageBinary(pylspBin);
      npxResponse = 'pylsp 1.14.0\n';
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === PYLSP_BIN) return `${pylspBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });

      const result = await discoverOne(PYLSP_BIN, {
        cwd: '/nonexistent/empty',
      });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pylspBin);
    });

    // ── Case 4: absent everywhere ───────────────────────────────────
    it('case 4: pylsp absent from all sources → python undefined; typescript still resolves', async () => {
      // Stage a TS binary so typescript is found; pylsp is absent.
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(tsBin);
      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      // No pylsp anywhere.

      const result = await discoverServers();

      expect(result.python).toBeUndefined();
      expect(result.typescript).not.toBeNull();
      expect(result.typescript!.version).toBe('4.3.3');
    });

    // ── Case 5: --version exits non-zero → version 'unknown', never drop ──
    it('case 5: pylsp --version exits non-zero → python.version === "unknown" (never drop)', async () => {
      const pylspBin = '/usr/local/bin/pylsp';
      stageBinary(pylspBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === PYLSP_BIN) return `${pylspBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // Non-zero exit: execFileSync throws with a numeric status (no ENOENT code).
      registerSpawn(pylspBin, () => {
        const e: any = new Error('Command failed with exit code 1');
        e.status = 1;
        // Deliberately no `code` property — this is a runtime exit, not spawn failure.
        throw e;
      });

      const result = await discoverOne(PYLSP_BIN, { cwd: '/nonexistent/empty' });

      // Must be kept with 'unknown' — not dropped.
      expect(result).not.toBeNull();
      expect(result!.path).toBe(pylspBin);
      expect(result!.version).toBe('unknown');
    });

    // ── Case 6: garbled version string → version 'unknown', never drop ──
    it('case 6: pylsp --version returns garbled string → python.version === "unknown"', async () => {
      const pylspBin = '/usr/local/bin/pylsp';
      stageBinary(pylspBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === PYLSP_BIN) return `${pylspBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      registerSpawn(pylspBin, () => 'something completely garbled with no version token\n');

      const result = await discoverOne(PYLSP_BIN, { cwd: '/nonexistent/empty' });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(pylspBin);
      expect(result!.version).toBe('unknown');
    });

    // ── Case 7: PYLSP_BIN exported value ─── (covered by the first it() above)

    // ── Case 8: existing JDTLS and TS assertions unaffected ────────
    it('case 8: pylsp present does not affect typescript or java entries', async () => {
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      const jdtlsBin = '/opt/homebrew/bin/jdtls';
      const pylspBin = '/usr/local/bin/pylsp';
      stageBinary(tsBin);
      stageBinary(jdtlsBin);
      stageBinary(pylspBin);

      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      registerSpawn(jdtlsBin, () => 'jdtls 1.26.0\n');
      registerSpawn(pylspBin, () => 'pylsp v1.14.0\n');
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === JDTLS_BIN) return `${jdtlsBin}\n`;
        if (args[0] === PYLSP_BIN) return `${pylspBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });

      const result = await discoverServers();

      // Existing entries must be byte-identical to pre-WI-4 values.
      expect(result.typescript).toEqual({ path: tsBin, version: '4.3.3' });
      expect(result.java).toEqual({ path: jdtlsBin, version: '1.26.0' });
      // Python is now also present.
      expect(result.python).not.toBeNull();
      expect(result.python!.path).toBe(pylspBin);
      expect(result.python!.version).toBe('1.14.0');
    });

    // ── spread-omit invariant: absent python key is omitted not null ──
    it('spread-omit: absent pylsp yields python===undefined (toEqual sees no python key)', async () => {
      // The critical invariant: when python is absent, discoverServers() must
      // omit the key entirely (not include `python: null`). This ensures the
      // existing `toEqual({ typescript: null })` test stays green.
      const result = await discoverServers();

      // python key must be absent (undefined), not null.
      expect(result.python).toBeUndefined();
      // toEqual ignores undefined-valued keys, so this passes:
      expect(result).toEqual({ typescript: null });
    });
  });

  // ─── WI-4 (gopls): gopls / Go server discovery ───────────────────────────
  //
  // EP (present/absent binary) + BVA (version string format) +
  // Error Guessing (--version flag rejected → version:'unknown', R2-3).
  // C4-1..C4-9 as specified in the plan.

  describe('WI-4 (gopls) — gopls discovery via discoverServers()', () => {
    // C4-7: constant value
    it('C4-7: GOPLS_BIN constant === "gopls"', () => {
      expect(GOPLS_BIN).toBe('gopls');
    });

    // C4-1: parseVersion extracts semver from the gopls version subcommand banner
    it('C4-1: parseVersion("golang.org/x/tools/gopls v0.22.0") === "0.22.0"', () => {
      expect(parseVersion('golang.org/x/tools/gopls v0.22.0')).toBe('0.22.0');
    });

    // C4-2: pre-release suffix stripped
    it('C4-2: parseVersion("golang.org/x/tools/gopls v0.22.0-pre") === "0.22.0"', () => {
      expect(parseVersion('golang.org/x/tools/gopls v0.22.0-pre')).toBe('0.22.0');
    });

    // C4-3: gopls absent from PATH → no 'go' key; other keys unaffected
    it('C4-3: gopls absent → result has no "go" key; typescript/java/python unaffected', async () => {
      // Stage only a TS binary; gopls absent everywhere.
      const tsBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(tsBin);
      registerSpawn(tsBin, () => 'typescript-language-server 4.3.3\n');
      // No gopls staged, no which handler for gopls.

      const result = await discoverServers();

      // go key must be absent (undefined) — additive spread-omit invariant.
      expect(result.go).toBeUndefined();
      // Other keys must be unaffected.
      expect(result.typescript).not.toBeNull();
      expect(result.typescript!.version).toBe('4.3.3');
    });

    // C4-4: gopls present but --version flag rejected (exit 2, R2-3 production probe path)
    // Production probe: `gopls --version` exits 2 with "flag provided but not defined: -version"
    // on stderr, no semver on stdout. runVersion() maps this to { ran: true, stdout: '' }
    // (non-ENOENT exit code), so finalize() keeps the binary with version 'unknown'.
    it('C4-4: gopls --version flag rejected (exit 2) → result.go = {path, version:"unknown"} (R2-3)', async () => {
      const goplsBin = '/Users/NgocVo_1/.local/bin/gopls';
      stageBinary(goplsBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === GOPLS_BIN) return `${goplsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // Simulate `gopls --version` → exit 2 (no ENOENT code — binary DID launch).
      registerSpawn(goplsBin, () => {
        const e: any = new Error('flag provided but not defined: -version');
        e.status = 2;
        // No `code` property — this is a runtime exit, not a spawn failure.
        throw e;
      });

      const result = await discoverServers();

      expect(result.go).not.toBeNull();
      expect(result.go).not.toBeUndefined();
      expect(result.go!.path).toBe(goplsBin);
      expect(result.go!.version).toBe('unknown');
    });

    // C4-5: gopls present, stdout empty / version unrecognized → version 'unknown'
    it('C4-5: gopls stdout empty / version unrecognized → result.go.version === "unknown"', async () => {
      const goplsBin = '/usr/local/bin/gopls';
      stageBinary(goplsBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === GOPLS_BIN) return `${goplsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // Returns stdout with no semver token.
      registerSpawn(goplsBin, () => 'something completely unrecognized\n');

      const result = await discoverOne(GOPLS_BIN, { cwd: '/nonexistent/empty' });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(goplsBin);
      expect(result!.version).toBe('unknown');
    });

    // C4-6: discoverServers() never throws when gopls is absent
    it('C4-6: discoverServers() never throws when gopls is absent', async () => {
      // Nothing staged — all discovery paths return null.
      await expect(discoverServers()).resolves.toBeDefined();
    });

    // C4-8: gopls present on PATH → result has go key with correct path
    it('C4-8: gopls staged in PATH → result has go key with correct path', async () => {
      const goplsBin = '/usr/local/bin/gopls';
      stageBinary(goplsBin);
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      registerSpawn(whichCmd, (args) => {
        if (args[0] === GOPLS_BIN) return `${goplsBin}\n`;
        throw Object.assign(new Error('not found'), { code: 'ENOENT', status: 1 });
      });
      // gopls version subcommand banner (production probe uses --version flag which
      // exits 2; but any stdout with no semver token yields 'unknown').
      registerSpawn(goplsBin, () => 'gopls 0.22.0\n');

      const result = await discoverOne(GOPLS_BIN, { cwd: '/nonexistent/empty' });

      expect(result).not.toBeNull();
      expect(result!.path).toBe(goplsBin);
      // Version parsing works when the binary cooperates.
      expect(result!.version).toBe('0.22.0');
    });

    // C4-9: existing 'returns documented result shape on success' test unchanged
    // (additive spread guard — the go key is omitted when gopls is absent,
    //  so toEqual({ typescript: ... }) continues to pass unmodified)
    it('C4-9: spread-omit: absent gopls yields go===undefined; existing toEqual assertions unaffected', async () => {
      // Replicate the exact fixture from the 'returns documented result shape' test
      // to confirm the additive spread does not inject a new `go` key.
      const projectNmBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        TYPESCRIPT_LANGUAGE_SERVER_BIN,
      );
      stageBinary(projectNmBin);
      registerSpawn(projectNmBin, () => 'typescript-language-server 4.3.3\n');
      // gopls absent — no which handler, no staged binary.

      const result = await discoverServers();

      // go key must be absent (undefined), not null.
      expect(result.go).toBeUndefined();
      // The shape is identical to the pre-gopls baseline — toEqual still passes.
      expect(result).toEqual({
        typescript: { path: projectNmBin, version: '4.3.3' },
      });
    });
  });
});
