/**
 * End-to-End Tests: Route Node Creation via Full Pipeline
 *
 * Tests that Route nodes are created when indexing a real Java Spring project.
 * This verifies the fix for the bug where sequential parsing (used for repos
 * under 1M files) was not extracting routes.
 *
 * Prerequisite: tcbs-bond-trading project must exist at the expected path AND
 * a built dist/cli/index.js must be present.
 *
 * #175 (GITNEXUS_HOME isolation): globalSetup sets process.env.GITNEXUS_HOME
 * to a per-run tmpdir before any test fork. All execSync calls below pass
 * `env: { ...process.env }` so the isolated registry is inherited. `analyze`
 * uses `--force` to bypass "already up to date" and always register the repo
 * in the isolated home. `clean --all --force` targets only the isolated home
 * (harmless — it never touches ~/.gitnexus).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const TEST_REPO = process.env.TCBS_BOND_TRADING || '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading';
const DIST_CLI = path.resolve(process.cwd(), 'dist/cli/index.js');

describe('Route Node E2E', () => {
  const repoExists = fs.existsSync(TEST_REPO);
  const distExists = fs.existsSync(DIST_CLI);

  // Self-gating: skip when the sibling repo or the built CLI is absent.
  // Under #175 GITNEXUS_HOME isolation the registry starts empty on every
  // run — that is intentional and safe because `analyze --force` below
  // re-registers the repo in the isolated home before any cypher query.
  const describeFn = (repoExists && distExists) ? describe : describe.skip;

  if (!repoExists) {
    it.skip(`route-node-e2e requires sibling tcbs-bond-trading repo at ${TEST_REPO}`, () => {});
  }
  if (!distExists) {
    it.skip(`route-node-e2e requires built CLI at ${DIST_CLI} (run: npm run build)`, () => {});
  }

  describeFn('Route node creation', () => {
    // Common execSync options — pass through process.env so GITNEXUS_HOME
    // (set by globalSetup for #175 isolation) reaches the CLI subprocesses.
    const execOpts = {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: 'pipe' as const,
      encoding: 'utf-8' as const,
    };

    beforeAll(() => {
      // Under #175 isolation this cleans only the per-run tmpdir, never
      // the developer's real ~/.gitnexus. Safe to run unconditionally.
      execSync('node dist/cli/index.js clean --all --force', execOpts);
    });

    it('creates Route nodes for Java Spring controllers', { timeout: 180_000 }, () => {
      // --force bypasses "already up to date" and ensures the repo is
      // registered in the isolated GITNEXUS_HOME for subsequent tests.
      execSync(`node dist/cli/index.js analyze --force "${TEST_REPO}"`, {
        ...execOpts,
        timeout: 120000,
      });

      const routeCountResult = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN COUNT(r)" -r "${path.basename(TEST_REPO)}"`,
        execOpts,
      );

      const match = routeCountResult.match(/\|\s*(\d+)\s*\|/);
      const routeCount = match ? parseInt(match[1], 10) : 0;

      expect(routeCount).toBeGreaterThan(0);
    });

    it('creates Route nodes with correct HTTP methods', () => {
      const result = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN DISTINCT r.httpMethod ORDER BY r.httpMethod LIMIT 10" -r "${path.basename(TEST_REPO)}"`,
        execOpts,
      );

      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
      const hasValidMethod = validMethods.some(method => result.includes(method));
      expect(hasValidMethod).toBe(true);
    });

    it('creates Route nodes with controller and method names', () => {
      const result = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN r.controllerName, r.methodName, r.routePath LIMIT 5" -r "${path.basename(TEST_REPO)}"`,
        execOpts,
      );

      expect(result).toContain('Controller');
    });
  });
});
