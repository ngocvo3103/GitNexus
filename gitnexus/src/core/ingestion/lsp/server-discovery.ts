/**
 * Server Discovery — resolve language server binaries.
 *
 * Pure detection. Never installs. Never throws on absence —
 * returns `{ typescript: null }` when the binary cannot be
 * located through any of the resolution sources.
 *
 * Resolution order (per `server-discovery` component spec, KD-3):
 *   1. `node_modules/.bin/typescript-language-server` walking up
 *      from `process.cwd()` until a `node_modules` directory is
 *      found.
 *   2. `process.env.PATH` — `where` on Windows, `which` on Unix
 *      (via `child_process.execFileSync`, same pattern as
 *      `cli/analyze.ts`).
 *   3. `npx typescript-language-server --version` as a last-resort
 *      probe (PATH/Node resolution through npx).
 *
 * The discovered binary is verified by spawning it with
 * `--version` to extract a version string. Parsing is defensive:
 * any failure (non-zero exit, malformed output) results in
 * `version: "unknown"`. The spec calls this out explicitly.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** A successfully located server, with absolute path + version. */
export interface DiscoveredServer {
  path: string;
  version: string;
}

/** Result of `discoverServers()`. Each value is null/undefined when the
 *  language's server could not be located through any source.
 *  `java` is undefined (omitted) when absent so that callers that only
 *  destructure `typescript` see no change — a strictly additive widening. */
export type DiscoveredServers = {
  typescript: DiscoveredServer | null;
  java?: DiscoveredServer | null;
};

/** The binary basename we look up for TypeScript. Exported for tests. */
export const TYPESCRIPT_LANGUAGE_SERVER_BIN = 'typescript-language-server';

/** The binary basename we look up for Java (jdtls). Exported for tests. */
export const JDTLS_BIN = 'jdtls';

/**
 * Find the nearest ancestor directory that contains a
 * `node_modules` subdirectory. Returns the path to that
 * `node_modules`, or `null` when none is found (caller-rooted
 * search, no `node_modules` anywhere up the tree).
 *
 * Pure fs.stat — never throws.
 *
 * S2 (security): when `workspaceRoot` is supplied, the
 * walk is BOUNDED to that directory — we stop at
 * `workspaceRoot` (inclusive). The pre-S2 code walked
 * up to the filesystem root, which meant a parent
 * directory of `process.cwd()` could supply an
 * untrusted `node_modules/.bin/typescript-language-server`
 * shim. Source 3 (npx) post-validates by re-resolving
 * through `whichOnPath`; Source 1 had no equivalent
 * guard. Bounding the walk to the workspace closes
 * that gap. If the candidate is found but the resolved
 * path escapes `workspaceRoot` via symlinks, the
 * `realpathSync` post-check below rejects it.
 */
function findNearestNodeModulesBin(
  binaryName: string,
  startDir: string = process.cwd(),
  workspaceRoot?: string,
): string | null {
  // path.resolve normalizes and gives us an absolute anchor so
  // the parent-walk terminates at the filesystem root (parent
  // of '/' is '/', which we catch below).
  let dir = path.resolve(startDir);

  // S2: bound the walk. When `workspaceRoot` is provided,
  // resolve + normalize it once. The loop below stops
  // BEFORE the parent-cross when `dir === rootAbs`.
  const rootAbs = workspaceRoot
    ? path.resolve(workspaceRoot)
    : null;

  // Symlink-loop guard. Cheap, but worth the few bytes.
  const visited = new Set<string>();
  while (true) {
    if (visited.has(dir)) return null; // symlink loop guard
    visited.add(dir);

    const candidate = path.join(dir, 'node_modules', '.bin', binaryName);
    if (existsFile(candidate)) {
      // S2 post-check: even if the candidate is lexically
      // inside the workspace, a symlink could point
      // outside. Resolve through realpathSync and re-test
      // containment. Falls back to the lexical path on
      // a non-resolvable target.
      if (rootAbs !== null) {
        let realCandidate: string;
        try {
          realCandidate = fs.realpathSync(candidate);
        } catch {
          realCandidate = candidate;
        }
        const rel = path.relative(rootAbs, realCandidate);
        const inside =
          rel !== '' &&
          !rel.startsWith('..') &&
          !path.isAbsolute(rel);
        if (!inside) {
          // Symlink escapes the workspace — refuse and
          // keep walking to the parent to give a
          // legitimate in-workspace binary a chance.
          // We deliberately do NOT return the candidate.
        } else {
          return candidate;
        }
      } else {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    if (rootAbs !== null && dir === rootAbs) {
      // Walked to the workspace boundary and didn't find
      // a candidate above it. Refuse — do not look in
      // untrusted parent directories.
      return null;
    }
    dir = parent;
  }
}

/** `fs.existsSync` + isFile check. Never throws. */
function existsFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Look up `binaryName` on `process.env.PATH`. Uses `where` on
 * Windows and `which` on Unix/POSIX. Returns the absolute path
 * to the first match (whichever PATH comes first), or `null`
 * when nothing is found.
 *
 * The `which` command exits non-zero + prints to stderr when
 * the binary is not on PATH. We capture both, suppress errors
 * silently — absence is a normal outcome, not a failure.
 */
function whichOnPath(binaryName: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const stdout = execFileSync(cmd, [binaryName], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
    }).toString();
    // `where` may print multiple matches (one per line); `which`
    // prints one. Take the first non-empty line.
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) return null;
    // Defensive: confirm the file actually exists. `which` on
    // macOS can occasionally return a stale path.
    return existsFile(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Parse the version out of a `--version` output. Examples:
 *   `typescript-language-server 4.3.3`  -> `4.3.3`
 *   `4.3.3`                             -> `4.3.3`
 *   `v4.3.3\n`                          -> `4.3.3`
 *   `typescript-language-server 4.3.3 (commit abc123)` -> `4.3.3`
 *
 * Returns `"unknown"` when no plausible semver-shaped token
 * (dotted numeric, possibly prefixed with `v`) is found.
 */
export function parseVersion(rawOutput: string): string {
  // First semver-shaped token wins. Allow optional `v` prefix.
  // Anchored: `\d+\.\d+\.\d+` covers 3-part versions; `\d+`
  // allows the trailing "0" in "1.0" too.
  const m = rawOutput.match(/v?(\d+(?:\.\d+){1,3})/);
  return m ? m[1] : 'unknown';
}

/**
 * Outcome of a `--version` probe. We must distinguish three cases
 * so `finalize` can honor its documented intent ("the version may
 * be unknown, but the server is still there") WITHOUT resurrecting
 * a binary that genuinely is not on disk:
 *
 *   - `{ ran: true,  stdout }` — the binary executed (any exit code,
 *     any stdout, including an empty string or a non-version banner).
 *     The server EXISTS; the version may parse or fall back to
 *     `'unknown'`.
 *   - `{ ran: false }`         — the binary could not be executed at
 *     all (`ENOENT`/`EACCES` — it is not a runnable file at that
 *     path). The located path is a phantom; drop it.
 *
 * The load-bearing case (#159 jdtls): `jdtls --version` spins a full
 * JVM that exceeds the 5s cap and is killed with `ETIMEDOUT`, and
 * even when allowed to finish it prints only a logback/spifly banner
 * to STDERR (never a version token to stdout). Both of those are
 * `ran: true` outcomes — the server is on PATH and launchable, it is
 * simply slow and silent about its version. The pre-fix code mapped
 * BOTH the timeout-throw and the absent-binary-throw to the same
 * `null`, so `finalize` dropped the located jdtls and `discoverServers()`
 * omitted the `java` key — collapsing the whole Java funnel.
 */
type VersionProbe = { ran: true; stdout: string } | { ran: false };

/**
 * Spawn `binaryPath` with `--version`. Never throws.
 *
 * Returns `{ ran: true, stdout }` whenever the process was actually
 * launched — INCLUDING the timeout case (`ETIMEDOUT`: the binary was
 * spawned and then killed for being slow) and the non-zero-exit case
 * (the binary ran and chose to exit non-zero). Only a spawn-level
 * failure that proves the path is not an executable file
 * (`ENOENT` / `EACCES` / `ENOTDIR`) maps to `{ ran: false }`.
 *
 * Rationale: the caller already proved the file EXISTS via
 * `fs.statSync` before we get here, so "located + launchable but
 * slow/silent" must NOT be conflated with "absent". A slow JVM-class
 * server (jdtls) is a first-class supported case.
 */
function runVersion(binaryPath: string): VersionProbe {
  try {
    const stdout = execFileSync(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
    }).toString();
    return { ran: true, stdout };
  } catch (err: unknown) {
    // Distinguish "could not launch the binary at all" from "launched
    // but slow / non-zero / silent". `execFileSync` surfaces the OS
    // spawn error code on `.code`; a process that launched and was then
    // killed for timeout carries `ETIMEDOUT`, and a process that ran and
    // exited non-zero carries a numeric `.status` with no spawn-error
    // `.code`. Only the genuine "not a runnable file" codes drop it.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      return { ran: false };
    }
    // ETIMEDOUT, non-zero exit, malformed output, or any other runtime
    // failure: the binary was launchable. Keep it; version is unknown.
    return { ran: true, stdout: '' };
  }
}

/**
 * Finalize a candidate path: spawn `--version`, parse, return
 * a `DiscoveredServer` or `null` if the binary could not be
 * launched at all. We accept "I exist and was launchable" as
 * evidence — the version may be `unknown` (slow/silent server,
 * e.g. jdtls), but the server is still there.
 */
function finalize(candidatePath: string): DiscoveredServer | null {
  const probe = runVersion(candidatePath);
  // Only drop the located path if the binary genuinely could not be
  // launched (phantom path / not executable). A launchable-but-silent
  // binary is kept with version 'unknown' — honoring the documented
  // intent and unblocking JVM-class servers whose --version is slow.
  if (!probe.ran) return null;
  return {
    path: candidatePath,
    version: parseVersion(probe.stdout),
  };
}

/**
 * Try `npx <binary> --version`. npx has its own resolution
 * (it will use local node_modules/.bin first, then PATH, then
 * the npm registry cache) so this is genuinely a "last resort"
 * that catches environments where neither PATH nor the local
 * tree has the binary on the user's shell.
 *
 * SECURITY: the npx path itself is NEVER a spawn target. npx is
 * a launcher, not the language server — spawning `npx --stdio`
 * would not produce a TS server. Worse, the on-disk `npx`
 * binary could be a malicious shim placed earlier in PATH.
 * The version probe is preserved for diagnostics (it confirms
 * the npx chain can reach the package), but a `DiscoveredServer`
 * is only returned when the probe succeeds AND we can resolve
 * a real, on-disk `typescript-language-server` binary path
 * (via `whichOnPath(binaryName)`). If that resolution fails,
 * this function returns `null` and the upstream consumer
 * (`LspClient.spawnAndInitialize`) will treat the discovery
 * as absent — preserving the no-throw / null-on-absence
 * contract without trusting an unverified binary path.
 *
 * Returns a `DiscoveredServer` on success, `null` on failure.
 * We use `npm exec` style via the `npx` binary; `--no-install`
 * is honored where supported to keep this strictly a probe.
 */
function tryNpx(binaryName: string): DiscoveredServer | null {
  // Probe the npx chain. If npx cannot reach the package at
  // all (network/registry miss, local not found), exit cleanly
  // with `null` — there's nothing more to do.
  let rawVersion: string;
  try {
    // `npx --no-install <bin> --version` runs the binary if it's
    // resolvable through npx's own PATH, but does NOT download.
    // On older npx versions, `--no-install` is unsupported, so we
    // fall back to the bare form and accept that very-old npx
    // may attempt an install — but it will still fail cleanly
    // when no package is registered under that name, and our
    // try/catch returns null in that case (no side-effect leak).
    const args = ['--no-install', binaryName, '--version'];
    rawVersion = execFileSync('npx', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
    }).toString();
  } catch {
    return null;
  }

  const version = parseVersion(rawVersion);
  // `rawVersion` may parse to `"unknown"`, but the probe still
  // succeeded (npx executed the binary). At this point we
  // need an actual, verified on-disk path to the language
  // server. npx did not give us one (it just executed), so
  // we re-resolve through PATH — this is the same lookup
  // used by Source 2, but at this point Source 2 has already
  // failed, so a hit here means the binary became reachable
  // only after the npx chain installed/cached it. If that
  // resolution also fails, we MUST return `null` rather than
  // synthesize a `DiscoveredServer` from the npx path itself.
  const resolved = whichOnPath(binaryName);
  if (!resolved) return null;

  // Sanity check: confirm the resolved path points to a real
  // executable file. `whichOnPath` already calls `existsFile`,
  // but the post-npx path may be a freshly-written shim that
  // could have been replaced between the lookup and the
  // caller spawning it. Re-stat at the moment of return so
  // we do not hand back a stale absolute path.
  if (!existsFile(resolved)) return null;

  return { path: resolved, version };
}

/**
 * Discover language-server binaries. Returns a `DiscoveredServers` map
 * with one entry per supported language. Each value is `null` when the
 * server is not found through any of the three resolution sources.
 *
 * Currently discovered:
 *   - `typescript`: `typescript-language-server`
 *   - `java`: `jdtls` (PATH source hits `/opt/homebrew/bin/jdtls`;
 *              node_modules source is a harmless miss for jdtls)
 *
 * Order (per spec, KD-3):
 *   1. node_modules/.bin walking up from cwd
 *   2. PATH (where/which)
 *   3. npx fallback
 *
 * Never throws. Never installs.
 *
 * NOTE: `java` is omitted (undefined) when jdtls is absent, so callers
 * that only destructure `typescript` see no change — purely additive.
 */
export async function discoverServers(): Promise<DiscoveredServers> {
  const [typescript, java] = await Promise.all([
    discoverOne(TYPESCRIPT_LANGUAGE_SERVER_BIN),
    discoverOne(JDTLS_BIN),
  ]);
  // `java` is included in the result only when jdtls is actually found.
  // Absent jdtls yields `undefined` (omitted key) rather than `null` so
  // that existing callers relying on `toEqual({ typescript: … })` do not
  // observe a new key. Callers interested in Java use `result.java ?? null`.
  return { typescript, ...(java !== null ? { java } : {}) };
}

/**
 * Single-binary discovery. Exported for unit tests so they can
 * drive the resolution table directly. The async signature is
 * kept for forward-compatibility (e.g. if we ever swap to a
 * real async fs API) and to match the public `discoverServers`
 * contract.
 *
 * `opts.workspaceRoot` (optional) — when supplied, Source 1's
 * parent walk is BOUNDED to that directory and any candidate
 * whose realpath escapes the workspace is rejected. This is
 * the S2 hardening: the pre-S2 walk could pick up untrusted
 * `node_modules/.bin/typescript-language-server` shims in any
 * parent directory of `process.cwd()`. Source 3 already
 * post-validated; Source 1 did not.
 */
export async function discoverOne(
  binaryName: string,
  opts: {
    cwd?: string;
    pathEnv?: string;
    workspaceRoot?: string;
  } = {},
): Promise<DiscoveredServer | null> {
  const cwd = opts.cwd ?? process.cwd();

  // Source 1: node_modules/.bin (S2-bounded to workspaceRoot
  // when supplied)
  const fromNodeModules = findNearestNodeModulesBin(
    binaryName,
    cwd,
    opts.workspaceRoot,
  );
  if (fromNodeModules) {
    const result = finalize(fromNodeModules);
    if (result) return result;
    // Binary exists at that path but refused `--version` — keep
    // trying the other sources; an env-installed one may behave.
  }

  // Source 2: PATH (where/which)
  const fromPath = whichOnPath(binaryName);
  if (fromPath) {
    const result = finalize(fromPath);
    if (result) return result;
  }

  // Source 3: npx fallback
  return tryNpx(binaryName);
}
