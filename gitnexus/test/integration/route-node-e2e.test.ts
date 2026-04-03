/**
 * End-to-End Tests: Route Node Creation via Full Pipeline
 *
 * Tests that Route nodes are created when indexing a real Java Spring project.
 * This verifies the fix for the bug where sequential parsing (used for repos
 * under 1M files) was not extracting routes.
 *
 * Prerequisite: tcbs-bond-trading project must exist at the expected path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const TEST_REPO = process.env.TCBS_BOND_TRADING || '/Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading';

describe('Route Node E2E', () => {
  const repoExists = fs.existsSync(TEST_REPO);
  const describeFn = repoExists ? describe : describe.skip;

  describeFn('Route node creation', () => {
    beforeAll(() => {
      execSync('node dist/cli/index.js clean --all --force', {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
    });

    it('creates Route nodes for Java Spring controllers', () => {
      execSync(`node dist/cli/index.js analyze "${TEST_REPO}"`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });

      const routeCountResult = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN COUNT(r)" -r "${path.basename(TEST_REPO)}"`,
        { cwd: process.cwd(), encoding: 'utf-8' }
      );

      const match = routeCountResult.match(/\|\s*(\d+)\s*\|/);
      const routeCount = match ? parseInt(match[1], 10) : 0;

      expect(routeCount).toBeGreaterThan(0);
    });

    it('creates Route nodes with correct HTTP methods', () => {
      const result = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN DISTINCT r.httpMethod ORDER BY r.httpMethod LIMIT 10" -r "${path.basename(TEST_REPO)}"`,
        { cwd: process.cwd(), encoding: 'utf-8' }
      );

      // Check that result contains HTTP methods
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
      const hasValidMethod = validMethods.some(method => result.includes(method));
      expect(hasValidMethod).toBe(true);
    });

    it('creates Route nodes with controller and method names', () => {
      const result = execSync(
        `node dist/cli/index.js cypher "MATCH (r:Route) RETURN r.controllerName, r.methodName, r.routePath LIMIT 5" -r "${path.basename(TEST_REPO)}"`,
        { cwd: process.cwd(), encoding: 'utf-8' }
      );

      expect(result).toContain('Controller');
    });
  });
});
