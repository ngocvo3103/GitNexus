/**
 * Golden-lock test: TS_INITIALIZATION_OPTIONS parity.
 *
 * `language-adapter.ts` carries a local copy of `TS_INITIALIZATION_OPTIONS`
 * (see the comment at line 153-166) because the original in `lsp-client.ts`
 * is not yet exported (WI-4 pending). The two objects MUST remain byte-
 * identical or the TS-repo funnel diverges from the pre-adapter baseline.
 *
 * This test imports the adapter's `initializationOptions` and compares it
 * by deep equality to the expected literal that lsp-client.ts defines at
 * lines 192-199. Any future modification to either copy will be caught here
 * rather than silently diverging.
 *
 * When WI-4 exports TS_INITIALIZATION_OPTIONS from lsp-client.ts, update
 * this test to import the canonical value directly and remove the comment
 * block in language-adapter.ts.
 */

import { describe, it, expect } from 'vitest';
import { TYPESCRIPT_ADAPTER } from '../../../src/core/ingestion/lsp/language-adapter.js';

/**
 * The canonical value from lsp-client.ts (lines 192-199).
 * This is the source of truth for the TS server initialization options;
 * the copy in language-adapter.ts MUST equal this exactly.
 *
 * When WI-4 exports TS_INITIALIZATION_OPTIONS, replace this literal with:
 *   import { TS_INITIALIZATION_OPTIONS } from '...lsp-client.js'
 */
const CANONICAL_TS_INITIALIZATION_OPTIONS = {
  hostInfo: 'gitnexus-lsp-client',
  tsserver: {
    path: '', // empty -> bundled tsserver
  },
};

describe('TS_INITIALIZATION_OPTIONS golden-lock', () => {
  it('TYPESCRIPT_ADAPTER.initializationOptions is deep-equal to lsp-client.ts canonical value', () => {
    // If this test fails, both copies have diverged. Check:
    //   1. language-adapter.ts lines ~161-166 (local copy)
    //   2. lsp-client.ts lines ~192-199 (canonical)
    // Only ONE of them should be changed — and both must end up identical.
    expect(TYPESCRIPT_ADAPTER.initializationOptions).toEqual(
      CANONICAL_TS_INITIALIZATION_OPTIONS,
    );
  });

  it('hostInfo field matches exactly (string equality, not just truthy)', () => {
    const opts = TYPESCRIPT_ADAPTER.initializationOptions as Record<string, unknown>;
    expect(opts['hostInfo']).toBe('gitnexus-lsp-client');
  });

  it('tsserver.path is empty string (not undefined, not null, not a real path)', () => {
    const opts = TYPESCRIPT_ADAPTER.initializationOptions as Record<string, unknown>;
    const tsserver = opts['tsserver'] as Record<string, unknown>;
    expect(tsserver['path']).toBe('');
  });

  it('has no extra fields beyond hostInfo and tsserver', () => {
    const opts = TYPESCRIPT_ADAPTER.initializationOptions as Record<string, unknown>;
    const keys = Object.keys(opts).sort();
    expect(keys).toEqual(['hostInfo', 'tsserver']);
  });

  it('tsserver has no extra fields beyond path', () => {
    const opts = TYPESCRIPT_ADAPTER.initializationOptions as Record<string, unknown>;
    const tsserver = opts['tsserver'] as Record<string, unknown>;
    const keys = Object.keys(tsserver).sort();
    expect(keys).toEqual(['path']);
  });
});
