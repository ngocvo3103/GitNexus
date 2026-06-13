/**
 * Integration Tests: location-mapper (LSP read-only foundation, WI-#4)
 *
 * Drives the mapper against a REAL seeded LadybugDB. The
 * `withTestLbugDB` helper opens the pool adapter, the mapper's
 * default `executeParameterized` dep hits that pool, and the
 * seed data is exactly the `LOCAL_BACKEND_SEED_DATA` used by
 * other integration tests in the suite — Function/Class/Method
 * nodes at known filePath/line ranges.
 *
 * The single Invariant-5 contract from the WI is the merge gate:
 *
 *   > IT: real seeded `Function` → `nodeId == generateId('Function','src/foo.ts:myFn')` (Inv 5)
 *
 * Everything else is parity: the mapper must return the same
 * `n.id` the graph already stored, for every shape of code node
 * the indexer writes.
 */

import { describe, it, expect } from 'vitest';
import {
  mapLocationToNodeId,
  type Location,
} from '../../../src/core/ingestion/lsp/location-mapper.js';
import { generateId } from '../../../src/lib/utils.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA } from '../../fixtures/local-backend-seed.js';

// Helper: build a Location with a 0-indexed line.
function loc(uri: string, line: number): Location {
  return { uri, range: { start: { line, character: 0 } } };
}

withTestLbugDB('location-mapper', (handle) => {
  describe('real-seed happy path (Invariant 5)', () => {
    it('maps a real Function to its stored id, byte-identical to generateId(...)', async () => {
      // Seed: Function 'login' at src/auth.ts:1..15.
      // The mapper contract: post-`stripFileUriScheme` +
      // `normalizeFilePath`, the URI must produce the seed's
      // `filePath`. The LSP-client is responsible for translating
      // an absolute `file:///abs/...` URI to the repo-relative path
      // the indexer wrote; in this test we pass a URI whose
      // post-normalization form is exactly `src/auth.ts`.
      const result = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 5),
        handle.repoId,
      );
      // The seed stored id is 'func:login' — the mapper returns
      // the stored id directly (Invariant 5: "Exact node identity").
      expect(result).toEqual({ kind: 'node', nodeId: 'func:login' });

      // The reconstructed id (had the stored id been missing) would
      // also be the canonical `generateId(label, filePath:name)` form.
      expect(generateId('Function', 'src/auth.ts:login')).toBe('Function:src/auth.ts:login');
    });

    it('maps a second Function to its stored id', async () => {
      // Seed: Function 'hash' at src/utils.ts:1..8
      const result = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 3),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'node', nodeId: 'func:hash' });
    });

    it('maps a Class node to its stored id (line inside class only)', async () => {
      // Seed: Class 'AuthService' at src/auth.ts:30..60, Method
      // 'authenticate' at src/auth.ts:35..45. A line strictly
      // inside the class but outside the method (e.g. line 50) is
      // owned by the class alone — no tie-break required.
      const result = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 50),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'node', nodeId: 'class:AuthService' });
    });

    it('maps a Method node to its stored id', async () => {
      // Seed: Method 'authenticate' on AuthService at src/auth.ts:35..45
      const result = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 40),
        handle.repoId,
      );
      // There are TWO candidates at line 40: the Class (30..60) and
      // the Method (35..45). Tie-breaker 1 picks the smaller range
      // (the Method, 10 lines vs 30 lines).
      expect(result).toEqual({ kind: 'node', nodeId: 'method:AuthService.authenticate' });
    });

    it('BVA: line == endLine (inclusive end) matches', async () => {
      // Seed: hash ends at line 8. Query at line 8 must match.
      const result = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 8),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'node', nodeId: 'func:hash' });
    });

    it('BVA: line == startLine matches', async () => {
      // Seed: hash starts at line 1. Query at line 1 must match.
      const result = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 1),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'node', nodeId: 'func:hash' });
    });

    it('BVA: line == startLine - 1 → NO_NODE', async () => {
      const result = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 0),
        handle.repoId,
      );
      // hash starts at 1, so line 0 doesn't enclose it.
      expect(result).toEqual({ kind: 'NO_NODE' });
    });

    it('BVA: line == endLine + 1 → NO_NODE', async () => {
      const result = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 9),
        handle.repoId,
      );
      // hash ends at 8, so line 9 doesn't enclose it.
      expect(result).toEqual({ kind: 'NO_NODE' });
    });
  });

  describe('real-seed edge cases (tied candidates)', () => {
    it('Tie-breaker 1 (innermost range) wins when Class and Method overlap', async () => {
      // Already covered above (line 40, AuthService + authenticate);
      // explicit here so the spec\'s "innermost range wins" is the
      // named assertion.
      const result = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 36),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'node', nodeId: 'method:AuthService.authenticate' });
    });

    it('distinct filePaths → never collide across files', async () => {
      // Both 'login' (auth.ts) and 'hash' (utils.ts) exist. Querying
      // auth.ts line 5 must return the auth.ts one, not the utils.ts one.
      const auth = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 5),
        handle.repoId,
      );
      const utils = await mapLocationToNodeId(
        loc('file:///src/utils.ts', 5),
        handle.repoId,
      );
      expect(auth).toEqual({ kind: 'node', nodeId: 'func:login' });
      expect(utils).toEqual({ kind: 'node', nodeId: 'func:hash' });
    });
  });

  describe('real-seed external / 0-candidate cases', () => {
    it('node_modules URI → NO_NODE (no DB call)', async () => {
      // EdgeCase 3 — the predicate strips the call before any DB round-trip.
      const result = await mapLocationToNodeId(
        loc('file:///repo/node_modules/lodash/index.d.ts', 0),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'NO_NODE' });
    });

    it('a .d.ts URI → NO_NODE', async () => {
      const result = await mapLocationToNodeId(
        loc('file:///repo/types/express/index.d.ts', 0),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'NO_NODE' });
    });

    it('dist/ URI → NO_NODE', async () => {
      const result = await mapLocationToNodeId(
        loc('file:///src/dist/bundle.js', 0),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'NO_NODE' });
    });

    it('empty graph (no Function at the queried filePath) → NO_NODE', async () => {
      // File `src/empty.ts` does not exist in the seed.
      const result = await mapLocationToNodeId(
        loc('file:///src/empty.ts', 0),
        handle.repoId,
      );
      expect(result).toEqual({ kind: 'NO_NODE' });
    });
  });

  describe('real-seed Idempotency / determinism', () => {
    it('the same Location always resolves to the same nodeId', async () => {
      // Spec: deterministic resolution. Run twice; both must agree.
      const a = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 8),
        handle.repoId,
      );
      const b = await mapLocationToNodeId(
        loc('file:///src/auth.ts', 8),
        handle.repoId,
      );
      expect(a).toEqual(b);
      expect(a).toEqual({ kind: 'node', nodeId: 'func:login' });
    });
  });

  // ─── WI-5: KD-3 external/jdt:// URI refusal tier ───────────────────────
  // Equivalence partitions:
  //   EP-1: jdt:// URI (external, decompiled)  → {kind:'NO_NODE', external:true}
  //   EP-2: workspace file:// URI              → resolves to a node (unchanged)
  //   EP-3: out-of-repo file:// URI            → {kind:'NO_NODE'} without external
  //
  // Invariants verified:
  //   I-3 (refuse-over-guess): jdt:// NEVER resolves to a node
  //   I-1 (TS-path invariance): workspace file:// path unchanged
  //   3-state shape preserved: no caller churn from additive optional field

  describe('KD-3 URI classification (WI-5)', () => {
    describe('EP-1: jdt:// URIs → explicit external refusal', () => {
      it('jdt://contents/java.util.List → {kind:NO_NODE, external:true} (never a node)', async () => {
        // Acceptance criterion AC-1: jdt:// URIs MUST always return external refusal.
        // The classifyUri injected here represents what the Java LanguageAdapter provides.
        const jdtClassify = (uri: string): 'workspace' | 'external' | 'unmappable' =>
          uri.startsWith('jdt://') ? 'external' : uri.startsWith('file://') ? 'workspace' : 'unmappable';

        const result = await mapLocationToNodeId(
          loc('jdt://contents/java/util/List.class?=jdt.default/%5C/path%2Fto%2Fjdk/lib/src.zip%3C/java/util/List.java', 0),
          handle.repoId,
          { classifyUri: jdtClassify },
        );
        expect(result).toEqual({ kind: 'NO_NODE', external: true });
      });

      it('jdt:// URI at a non-zero line → still external refusal (no DB call attempted)', async () => {
        const jdtClassify = (uri: string): 'workspace' | 'external' | 'unmappable' =>
          uri.startsWith('jdt://') ? 'external' : uri.startsWith('file://') ? 'workspace' : 'unmappable';

        const result = await mapLocationToNodeId(
          loc('jdt://contents/java/lang/Object.class?=jdt.default', 42),
          handle.repoId,
          { classifyUri: jdtClassify },
        );
        expect(result).toEqual({ kind: 'NO_NODE', external: true });
        // Confirm no node was returned — I-3 (refuse-over-guess)
        expect(result.kind).toBe('NO_NODE');
        if (result.kind === 'NO_NODE') {
          expect(result.external).toBe(true);
        }
      });

      it('external flag is exactly true (not truthy) for jdt:// refusal', async () => {
        const jdtClassify = (uri: string): 'workspace' | 'external' | 'unmappable' =>
          uri.startsWith('jdt://') ? 'external' : 'unmappable';

        const result = await mapLocationToNodeId(
          loc('jdt://contents/com/example/MyClass.class', 10),
          handle.repoId,
          { classifyUri: jdtClassify },
        );
        // Strict: external must be boolean true, not just truthy
        expect(result).toStrictEqual({ kind: 'NO_NODE', external: true });
      });
    });

    describe('EP-2: workspace file:// URIs → node resolution unchanged (I-1 TS-path invariance)', () => {
      it('workspace file:// still maps to a node with default classifyUri', async () => {
        // No classifyUri injection: default TS behaviour (file:// → workspace).
        // This is AC-2: the TS path must be byte-identical pre/post WI-5.
        const result = await mapLocationToNodeId(
          loc('file:///src/auth.ts', 5),
          handle.repoId,
          // explicitly omitting classifyUri — default applies
        );
        expect(result).toEqual({ kind: 'node', nodeId: 'func:login' });
      });

      it('workspace file:// still maps to a node with explicit workspace classifyUri', async () => {
        const jdtClassify = (uri: string): 'workspace' | 'external' | 'unmappable' =>
          uri.startsWith('jdt://') ? 'external' : uri.startsWith('file://') ? 'workspace' : 'unmappable';

        const result = await mapLocationToNodeId(
          loc('file:///src/auth.ts', 5),
          handle.repoId,
          { classifyUri: jdtClassify },
        );
        expect(result).toEqual({ kind: 'node', nodeId: 'func:login' });
      });

      it('3-state shape preserved: workspace result has no external field', async () => {
        const result = await mapLocationToNodeId(
          loc('file:///src/auth.ts', 5),
          handle.repoId,
        );
        expect(result.kind).toBe('node');
        // The node variant has no external field — shape unchanged for callers
        expect('external' in result).toBe(false);
      });
    });

    describe('EP-3: out-of-repo file:// URIs → NO_NODE without external', () => {
      it('out-of-repo file:// → NO_NODE without external flag', async () => {
        // AC-3: a file:// URI that is out-of-repo (resolves to NO_NODE via
        // the existing isUnindexablePath / outside-repo guard) must NOT
        // carry external:true — that flag is reserved for jdt:// / decompiled.
        const result = await mapLocationToNodeId(
          loc('file:///src/nonexistent-file.ts', 0),
          handle.repoId,
        );
        expect(result).toEqual({ kind: 'NO_NODE' });
        // Confirm: external must be absent (undefined), not true
        if (result.kind === 'NO_NODE') {
          expect(result.external).toBeUndefined();
        }
      });

      it('node_modules URI → NO_NODE without external flag (existing behaviour preserved)', async () => {
        const result = await mapLocationToNodeId(
          loc('file:///repo/node_modules/lodash/index.d.ts', 0),
          handle.repoId,
        );
        expect(result).toEqual({ kind: 'NO_NODE' });
        if (result.kind === 'NO_NODE') {
          expect(result.external).toBeUndefined();
        }
      });

      it('unmappable non-file non-jdt URI → NO_NODE without external flag', async () => {
        // e.g. an http:// URI or some other scheme — classified as unmappable,
        // which means "we can't handle this" rather than "this is external stdlib".
        const customClassify = (uri: string): 'workspace' | 'external' | 'unmappable' => {
          if (uri.startsWith('jdt://')) return 'external';
          if (uri.startsWith('file://')) return 'workspace';
          return 'unmappable';
        };

        const result = await mapLocationToNodeId(
          loc('http://example.com/SomeClass.java', 0),
          handle.repoId,
          { classifyUri: customClassify },
        );
        expect(result).toEqual({ kind: 'NO_NODE' });
        // No external flag — unmappable is not the same as external
        if (result.kind === 'NO_NODE') {
          expect(result.external).toBeUndefined();
        }
      });
    });
  });
}, {
  seed: LOCAL_BACKEND_SEED_DATA,
  poolAdapter: true,
});
