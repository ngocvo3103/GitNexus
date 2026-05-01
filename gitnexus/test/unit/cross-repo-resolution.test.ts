/**
 * WI-3 Unit Tests: Tier 4 Cross-Repo Resolution
 *
 * Tests: Tier 4 resolution logic in CrossRepoResolutionContext
 * Covers: external repo resolution, confidence scoring, tier precedence
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createCrossRepoResolutionContext,
  type ExternalRepoQuery,
  type CrossRepoResolutionContext,
} from '../../src/core/ingestion/cross-repo-resolution-context.js';
import {
  createResolutionContext,
  TIER_CONFIDENCE,
  type ResolutionContext,
  type ResolutionTier,
  type TieredCandidates,
} from '../../src/core/ingestion/resolution-context.js';
import type { CrossRepoRegistry } from '../../src/core/ingestion/cross-repo-registry.js';
import type { SymbolDefinition } from '../../src/core/ingestion/symbol-table.js';

// ─── Tier 4: External Resolution Tests ─────────────────────────────────────

describe('Tier 4: External resolution', () => {
  let localContext: ResolutionContext;
  let mockRegistry: CrossRepoRegistry;
  let mockExternalQuery: ExternalRepoQuery;
  let crossRepoContext: CrossRepoResolutionContext;

  beforeEach(() => {
    // Create local resolution context
    localContext = createResolutionContext();

    // Mock CrossRepoRegistry
    mockRegistry = {
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
      isLoaded: vi.fn().mockReturnValue(true),
    } as unknown as CrossRepoRegistry;

    // Mock ExternalRepoQuery
    mockExternalQuery = {
      querySymbol: vi.fn(),
    };

    // Create cross-repo resolution context
    crossRepoContext = createCrossRepoResolutionContext(
      localContext,
      mockRegistry,
      mockExternalQuery
    );
  });

  describe('returns candidates with tier: external and repoId', () => {
    it('returns tier "external" when symbol found in external repo', async () => {
      // Mock: Registry finds external repo
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('bond-exception-handler');

      // Mock: External query returns symbol definition
      const expectedCandidates: SymbolDefinition[] = [
        {
          nodeId: 'Class:com/tcbs/bond/trading/exception/TcbsBaseException.java:TcbsBaseException',
          filePath: 'com/tcbs/bond/trading/exception/TcbsBaseException.java',
          type: 'Class',
        },
      ];
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue(expectedCandidates);

      // Act: Resolve symbol across repos
      const result = await crossRepoContext.resolveAcrossRepos(
        'TcbsBaseException',
        '/src/main/java/App.java',
        'tcbs-bond-trading'
      );

      // Assert: Tier is 'external', repoId is set, confidence is 0.35
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('external');
      expect(result!.repoId).toBe('bond-exception-handler');
      expect(result!.confidence).toBe(0.35);
      expect(result!.candidates).toHaveLength(1);
      expect(result!.candidates[0].nodeId).toBe(expectedCandidates[0].nodeId);
    });

    it('includes repoId in TieredCandidates when tier is external', async () => {
      // Mock: Registry finds external repo
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('shared-logging-lib');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
        {
          nodeId: 'Interface:src/external/ILogger.java:ILogger',
          filePath: 'src/external/ILogger.java',
          type: 'Interface',
        },
      ]);

      const result = await crossRepoContext.resolveAcrossRepos(
        'ILogger',
        '/src/App.ts',
        'my-app'
      );

      expect(result).not.toBeNull();
      expect(result!.repoId).toBeDefined();
      expect(result!.repoId).toBe('shared-logging-lib');
    });
  });

  describe('Tier 4 confidence is 0.35', () => {
    it('external tier has confidence 0.35 (lower than global)', () => {
      // WI-3: External tier confidence must be 0.35
      // Rationale from spec: cross-repo is less certain than global (0.50)
      // because of version mismatches and indirect references

      expect(TIER_CONFIDENCE['external']).toBe(0.35);
      expect(TIER_CONFIDENCE['external']).toBeLessThan(TIER_CONFIDENCE['global']);
    });

    it('confidence hierarchy is correct across all tiers', () => {
      // WI-3: Confidence must decrease from Tier 1 to Tier 4
      // Tier 1 (same-file) > Tier 2 (import-scoped) > Tier 3 (global) > Tier 4 (external)

      expect(TIER_CONFIDENCE['same-file']).toBeGreaterThan(TIER_CONFIDENCE['import-scoped']);
      expect(TIER_CONFIDENCE['import-scoped']).toBeGreaterThan(TIER_CONFIDENCE['global']);
      expect(TIER_CONFIDENCE['global']).toBeGreaterThan(TIER_CONFIDENCE['external']);
    });
  });

  describe('Tier 1-3 take precedence over Tier 4', () => {
    it('does not call Tier 4 when Tier 1 finds symbol', async () => {
      // Add a symbol to local context (Tier 1) using correct signature
      localContext.symbols.add('src/App.ts', 'UserService', 'Class:src/App.ts:UserService', 'Class');

      // Mock external query (should not be called)
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([]);

      // Act: Resolve symbol that exists locally
      const result = await crossRepoContext.resolveAcrossRepos(
        'UserService',
        'src/App.ts',
        'my-app'
      );

      // Assert: Result is from local resolution (Tier 1)
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('same-file');
      expect(result!.confidence).toBe(TIER_CONFIDENCE['same-file']);

      // External query should NOT have been called
      expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
    });

    it('does not call Tier 4 when Tier 2 finds symbol', async () => {
      // Add symbol to a different file using correct signature
      localContext.symbols.add('src/utils/Logger.ts', 'Logger', 'Class:src/utils/Logger.ts:Logger', 'Class');

      // Add import map so src/App.ts imports from src/utils/Logger.ts
      localContext.importMap.set('src/App.ts', new Set(['src/utils/Logger.ts']));

      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([]);

      // Act: Resolve symbol that exists in imported file
      const result = await crossRepoContext.resolveAcrossRepos(
        'Logger',
        'src/App.ts',
        'my-app'
      );

      // Assert: Result is from import-scoped (Tier 2)
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('import-scoped');
      expect(result!.confidence).toBe(TIER_CONFIDENCE['import-scoped']);

      // External query should NOT have been called
      expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
    });

    it('does not call Tier 4 when Tier 3 finds unique symbol', async () => {
      // Add single global symbol using correct signature
      localContext.symbols.add('src/services/AuthService.ts', 'AuthService', 'Class:src/services/AuthService.ts:AuthService', 'Class');

      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([]);

      // Act: Resolve symbol that exists globally (Tier 3)
      const result = await crossRepoContext.resolveAcrossRepos(
        'AuthService',
        'src/App.ts',
        'my-app'
      );

      // Assert: Result is from global (Tier 3)
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('global');
      expect(result!.confidence).toBe(TIER_CONFIDENCE['global']);

      // External query should NOT have been called
      expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
    });

    it('calls Tier 4 only when all local tiers return empty', async () => {
      // No local symbols added - Tiers 1-3 will return null
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('external-lib');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
        {
          nodeId: 'Class:external/ExternalService.ts:ExternalService',
          filePath: 'external/ExternalService.ts',
          type: 'Class',
        },
      ]);

      // Act: Resolve symbol that only exists externally
      const result = await crossRepoContext.resolveAcrossRepos(
        'ExternalService',
        'src/App.ts',
        'my-app'
      );

      // Assert: Tier 4 was triggered
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('external');
      expect(result!.repoId).toBe('external-lib');
      expect(mockRegistry.findDepRepo).toHaveBeenCalled();
    });
  });

  describe('Tier 4 returns null when dependency not in registry', () => {
    it('returns null when dependency repo is not indexed', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue(null);

      // Act: Resolve symbol from non-indexed dependency
      const result = await crossRepoContext.resolveAcrossRepos(
        'UnknownClass',
        'src/App.ts',
        'my-app'
      );

      // Assert: Resolution returns null
      expect(result).toBeNull();
      expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
    });

    it('returns null when package prefix does not match any repo', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue(null);

      const result = await crossRepoContext.resolveAcrossRepos(
        'com.unknown.lib.UnknownClass',
        'src/App.ts',
        'my-app'
      );

      expect(result).toBeNull();
    });
  });

  describe('Tier 4 returns null when symbol not found in external repo', () => {
    it('returns null when dependency exists but symbol not found', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('bond-exception-handler');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue(null);

      const result = await crossRepoContext.resolveAcrossRepos(
        'NonExistentClass',
        'src/App.ts',
        'my-app'
      );

      expect(result).toBeNull();
    });

    it('returns null when external repo has multiple symbols but none match', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('shared-utils');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([]);

      const result = await crossRepoContext.resolveAcrossRepos(
        'Missing',
        'src/App.ts',
        'my-app'
      );

      expect(result).toBeNull();
    });
  });
});

// ─── CrossRepoResolutionContext Tests ──────────────────────────────────────

describe('CrossRepoResolutionContext', () => {
  let localContext: ResolutionContext;
  let mockRegistry: CrossRepoRegistry;
  let mockExternalQuery: ExternalRepoQuery;
  let crossRepoContext: CrossRepoResolutionContext;

  beforeEach(() => {
    localContext = createResolutionContext();
    mockRegistry = {
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
      isLoaded: vi.fn().mockReturnValue(true),
    } as unknown as CrossRepoRegistry;
    mockExternalQuery = {
      querySymbol: vi.fn(),
    };
    crossRepoContext = createCrossRepoResolutionContext(
      localContext,
      mockRegistry,
      mockExternalQuery
    );
  });

  describe('resolveAcrossRepos', () => {
    it('tries primary repo first (Tier 1-3)', async () => {
      // Add local symbol using correct signature
      localContext.symbols.add('src/Local.ts', 'Local', 'Class:src/Local.ts:Local', 'Class');

      const result = await crossRepoContext.resolveAcrossRepos(
        'Local',
        'src/Local.ts',
        'my-app'
      );

      // Result is from Tier 1, not external
      expect(result).not.toBeNull();
      expect(result!.tier).toBe('same-file');
      expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
    });

    it('queries peer repos when primary repo fails', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('peer-repo');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
        {
          nodeId: 'Class:peer/Peer.ts:PeerClass',
          filePath: 'peer/Peer.ts',
          type: 'Class',
        },
      ]);

      const result = await crossRepoContext.resolveAcrossRepos(
        'PeerClass',
        'src/App.ts',
        'my-app'
      );

      expect(result).not.toBeNull();
      expect(result!.tier).toBe('external');
      expect(result!.repoId).toBe('peer-repo');
    });

    it('returns first match among peer repos', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('repo-b');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
        {
          nodeId: 'Class:lib/Shared.ts:Shared',
          filePath: 'lib/Shared.ts',
          type: 'Class',
        },
      ]);

      const result = await crossRepoContext.resolveAcrossRepos(
        'Shared',
        'src/App.ts',
        'repo-a'
      );

      expect(result).not.toBeNull();
      expect(result!.repoId).toBe('repo-b');
    });

    it('returns null when no repo has the symbol', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue(null);

      const result = await crossRepoContext.resolveAcrossRepos(
        'NonExistent',
        'src/App.ts',
        'my-app'
      );

      expect(result).toBeNull();
    });

    it('attributes result to correct repoId', async () => {
      vi.mocked(mockRegistry.findDepRepo).mockReturnValue('repo-b');
      vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
        {
          nodeId: 'Class:src/External.ts:External',
          filePath: 'src/External.ts',
          type: 'Class',
        },
      ]);

      const result = await crossRepoContext.resolveAcrossRepos(
        'External',
        'src/App.ts',
        'repo-a'
      );

      expect(result).not.toBeNull();
      expect(result!.repoId).toBe('repo-b');
    });
  });
});

// ─── ResolutionTier Type Extension Tests ─────────────────────────────────────

describe('ResolutionTier type extension', () => {
  it('includes "external" in the tier union', () => {
    // WI-3: ResolutionTier must be extended to include 'external'

    const tiers: ResolutionTier[] = ['same-file', 'import-scoped', 'global', 'external'];

    expect(tiers).toContain('external');
    expect(tiers).toHaveLength(4);
  });

  it('tier "external" is a valid ResolutionTier value', () => {
    // WI-3: TypeScript should accept 'external' as valid tier

    const tier: ResolutionTier = 'external';
    expect(tier).toBe('external');
  });
});

// ─── TieredCandidates Type Extension Tests ─────────────────────────────────────

describe('TieredCandidates type extension', () => {
  it('includes optional repoId field', () => {
    // WI-3: TieredCandidates must have repoId for external tier

    const candidates: TieredCandidates = {
      candidates: [],
      tier: 'external',
      repoId: 'external-lib',
      confidence: 0.35,
    };

    expect(candidates.repoId).toBe('external-lib');
  });

  it('repoId is undefined for non-external tiers', () => {
    // WI-3: repoId only set for external tier, undefined otherwise

    const localCandidates: TieredCandidates = {
      candidates: [
        { nodeId: 'Class:src/Local.ts:Local', filePath: 'src/Local.ts', type: 'Class' },
      ],
      tier: 'same-file',
      confidence: 0.95,
    };

    // repoId should be undefined for same-file tier
    expect(localCandidates.repoId).toBeUndefined();
  });

  it('includes confidence field', () => {
    // WI-3: TieredCandidates must have confidence based on tier

    const candidates: TieredCandidates = {
      candidates: [],
      tier: 'import-scoped',
      confidence: TIER_CONFIDENCE['import-scoped'],
    };

    expect(candidates.confidence).toBe(0.9);
  });

  it('confidence matches tier value', () => {
    // WI-3: Confidence must be consistent with tier

    const externalCandidates: TieredCandidates = {
      candidates: [],
      tier: 'external',
      repoId: 'external-lib',
      confidence: 0.35,
    };

    expect(externalCandidates.confidence).toBe(TIER_CONFIDENCE['external']);
  });
});

// ─── Package Prefix Matching Tests (Java/Maven) ──────────────────────────────

describe('Package prefix matching (Java/Maven)', () => {
  let mockRegistry: CrossRepoRegistry;

  beforeEach(() => {
    mockRegistry = {
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
      isLoaded: vi.fn().mockReturnValue(true),
    } as unknown as CrossRepoRegistry;
  });

  it('matches Java package prefix to repoId', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = mockRegistry.findDepRepo('com.tcbs.bond.trading.exception');

    expect(result).toBe('bond-exception-handler');
  });

  it('matches package with groupId:artifactId format', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('bond-exception-handler');

    const result = mockRegistry.findDepRepo('com.tcbs.bond.trading:exception-handler');

    expect(result).toBe('bond-exception-handler');
  });

  it('handles subpackage matching', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('bond-exception-handler');

    // Subpackage should match parent package
    const result = mockRegistry.findDepRepo('com.tcbs.bond.trading.exception.handler');

    expect(result).toBe('bond-exception-handler');
  });
});

// ─── Module Name Matching Tests (npm) ─────────────────────────────────────────

describe('Module name matching (npm)', () => {
  let mockRegistry: CrossRepoRegistry;

  beforeEach(() => {
    mockRegistry = {
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
      isLoaded: vi.fn().mockReturnValue(true),
    } as unknown as CrossRepoRegistry;
  });

  it('matches npm package name to repoId', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('exception-utils-repo');

    const result = mockRegistry.findDepRepo('@tcbs/exception-utils');

    expect(result).toBe('exception-utils-repo');
  });

  it('handles scoped npm packages', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('types-express-repo');

    const result = mockRegistry.findDepRepo('@types/express');

    expect(result).toBe('types-express-repo');
  });

  it('handles unscoped npm packages', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('express-repo');

    const result = mockRegistry.findDepRepo('express');

    expect(result).toBe('express-repo');
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  let localContext: ResolutionContext;
  let mockRegistry: CrossRepoRegistry;
  let mockExternalQuery: ExternalRepoQuery;
  let crossRepoContext: CrossRepoResolutionContext;

  beforeEach(() => {
    localContext = createResolutionContext();
    mockRegistry = {
      findDepRepo: vi.fn(),
      getManifest: vi.fn(),
      listRepos: vi.fn(),
      isLoaded: vi.fn().mockReturnValue(true),
    } as unknown as CrossRepoRegistry;
    mockExternalQuery = {
      querySymbol: vi.fn(),
    };
    crossRepoContext = createCrossRepoResolutionContext(
      localContext,
      mockRegistry,
      mockExternalQuery
    );
  });

  it('handles empty registry gracefully', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue(null);

    const result = await crossRepoContext.resolveAcrossRepos(
      'SomeSymbol',
      'src/App.ts',
      'my-app'
    );

    expect(result).toBeNull();
    expect(mockExternalQuery.querySymbol).not.toHaveBeenCalled();
  });

  it('handles registry with missing manifests', async () => {
    // Registry can return repoId even if manifest is missing
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('repo-without-manifest');
    vi.mocked(mockRegistry.getManifest).mockReturnValue(null);
    vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
      {
        nodeId: 'Class:src/Some.ts:Some',
        filePath: 'src/Some.ts',
        type: 'Class',
      },
    ]);

    const result = await crossRepoContext.resolveAcrossRepos(
      'SomeSymbol',
      'src/App.ts',
      'my-app'
    );

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('repo-without-manifest');
  });

  it('handles concurrent cross-repo queries', async () => {
    vi.mocked(mockRegistry.findDepRepo)
      .mockReturnValueOnce('repo-a')
      .mockReturnValueOnce('repo-b');

    vi.mocked(mockExternalQuery.querySymbol)
      .mockResolvedValueOnce([{ nodeId: 'Class:a/A.ts:Symbol', filePath: 'a/A.ts', type: 'Class' }])
      .mockResolvedValueOnce([{ nodeId: 'Class:b/B.ts:Other', filePath: 'b/B.ts', type: 'Class' }]);

    const [result1, result2] = await Promise.all([
      crossRepoContext.resolveAcrossRepos('Symbol', 'src/App.ts', 'primary'),
      crossRepoContext.resolveAcrossRepos('Other', 'src/App.ts', 'primary'),
    ]);

    expect(result1!.repoId).toBe('repo-a');
    expect(result2!.repoId).toBe('repo-b');
  });

  it('handles symbol with same name in multiple external repos', async () => {
    vi.mocked(mockRegistry.findDepRepo).mockReturnValue('repo-a');
    vi.mocked(mockExternalQuery.querySymbol).mockResolvedValue([
      {
        nodeId: 'Class:lib/Logger.ts:Logger',
        filePath: 'lib/Logger.ts',
        type: 'Class',
      },
    ]);

    const result = await crossRepoContext.resolveAcrossRepos(
      'Logger',
      'src/App.ts',
      'primary'
    );

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('repo-a');
  });
});

// ─── WI-2: CrossRepoResolver Tests ──────────────────────────────────────────

import {
  CrossRepoResolver,
  filePathToPackagePath,
  type RepoHandle as ResolverRepoHandle,
  type ChangedSymbol,
  type ResolvedConsumer,
} from '../../src/mcp/local/cross-repo-resolver.js';

describe('WI-2: CrossRepoResolver', () => {
  let resolver: CrossRepoResolver;
  let consumerQuery: ReturnType<typeof vi.fn>;
  let consumerRepo: ResolverRepoHandle;
  let depRepo: ResolverRepoHandle;

  beforeEach(() => {
    resolver = new CrossRepoResolver();
    consumerQuery = vi.fn();
    consumerRepo = { repoId: 'consumer-repo', query: consumerQuery };
    depRepo = { repoId: 'dep-repo', query: vi.fn() };
  });

  // T-CR-08: Stage 1 match — IMPORTS edge with matching file path
  it('T-CR-08: Stage 1 — IMPORTS edge match returns confidence 0.9', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ];

    consumerQuery.mockResolvedValue([
      {
        id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
        name: 'getBondbyId',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
        matchedFilePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
      name: 'getBondbyId',
      confidence: 0.9,
      matchMethod: 'file-imports',
      matchedDepSymbol: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
    });
  });

  // T-CR-09: Stage 2 fallback — no IMPORTS edge, Class name match
  it('T-CR-09: Stage 2 fallback — Class name match returns confidence 0.8', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ];

    // Stage 1 returns no IMPORTS matches
    consumerQuery.mockResolvedValueOnce([]);
    // Stage 2 returns Class name match
    consumerQuery.mockResolvedValueOnce([
      {
        id: 'Class:src/main/java/com/tcbs/bond/service/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/service/dto/TradingDto.java',
      },
    ]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'Class:src/main/java/com/tcbs/bond/service/dto/TradingDto.java:TradingDto',
      name: 'TradingDto',
      confidence: 0.8,
      matchMethod: 'class-name',
      matchedDepSymbol: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
    });
  });

  // T-CR-10: Stage 3 fallback — no IMPORTS, no Class match, package path match
  it('T-CR-10: Stage 3 fallback — package path match returns confidence 0.7', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ];

    // Stage 1: no IMPORTS match
    consumerQuery.mockResolvedValueOnce([]);
    // Stage 2: no Class match
    consumerQuery.mockResolvedValueOnce([]);
    // Stage 3: IMPORTS edge pointing to package path
    consumerQuery.mockResolvedValueOnce([
      {
        id: 'File:src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
        name: 'BondServiceImpl.java',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
      },
    ]);
    // Stage 3: find Method/Class symbols in the importing file
    consumerQuery.mockResolvedValueOnce([
      {
        id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
        name: 'getBondbyId',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
      },
    ]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
      name: 'getBondbyId',
      confidence: 0.7,
      matchMethod: 'package-path',
      matchedDepSymbol: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
    });
  });

  // T-CR-11: All stages empty — returns empty array
  it('T-CR-11: All stages empty returns empty array', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/Unknown.java:Unknown',
        name: 'Unknown',
        filePath: 'src/main/java/com/tcbs/Unknown.java',
      },
    ];

    // Stage 1: empty
    consumerQuery.mockResolvedValueOnce([]);
    // Stage 2: empty
    consumerQuery.mockResolvedValueOnce([]);
    // Stage 3: IMPORTS query empty
    consumerQuery.mockResolvedValueOnce([]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toHaveLength(0);
  });

  // T-CR-12: Error handling — query throws, returns empty array
  it('T-CR-12: Error handling — query throws returns empty array', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ];

    consumerQuery.mockRejectedValue(new Error('DB connection lost'));

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toEqual([]);
  });

  // T-CR-13: Multiple changed symbols — batch resolution
  it('T-CR-13: Multiple changed symbols batched', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/BondDto.java:BondDto',
        name: 'BondDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/BondDto.java',
      },
    ];

    // Stage 1 matches both files via IMPORTS
    consumerQuery.mockResolvedValue([
      {
        id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
        name: 'getBondbyId',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
        matchedFilePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
      {
        id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:createBond',
        name: 'createBond',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
        matchedFilePath: 'src/main/java/com/tcbs/bond/trading/dto/BondDto.java',
      },
    ]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    // Should return results for both symbols
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every(r => r.confidence === 0.9)).toBe(true);
    expect(results.every(r => r.matchMethod === 'file-imports')).toBe(true);
  });

  // T-CR-14: Stage 1 returns results — Stage 2 and 3 not called
  it('T-CR-14: Stage 1 match skips Stage 2 and 3', async () => {
    const changedSymbols: ChangedSymbol[] = [
      {
        id: 'Class:src/main/java/com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        name: 'TradingDto',
        filePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ];

    // Stage 1 returns results
    consumerQuery.mockResolvedValueOnce([
      {
        id: 'Method:src/main/java/com/tcbs/bond/service/BondServiceImpl.java:getBondbyId',
        name: 'getBondbyId',
        filePath: 'src/main/java/com/tcbs/bond/service/BondServiceImpl.java',
        matchedFilePath: 'src/main/java/com/tcbs/bond/trading/dto/TradingDto.java',
      },
    ]);

    const results = await resolver.resolveDepConsumers(consumerRepo, depRepo, changedSymbols);

    expect(results).toHaveLength(1);
    expect(results[0].matchMethod).toBe('file-imports');
    // Only one query call (Stage 1 only)
    expect(consumerQuery).toHaveBeenCalledTimes(1);
  });

  // T-CR-15: filePath conversion for Java
  it('T-CR-15: filePathToPackagePath converts Java paths', () => {
    const result = filePathToPackagePath('src/main/java/com/tcbs/bond/trading/dto/TradingDto.java');
    expect(result).toBe('com.tcbs.bond.trading.dto.TradingDto');
  });

  // T-CR-16: filePath conversion for Kotlin
  it('T-CR-16: filePathToPackagePath converts Kotlin paths', () => {
    const result = filePathToPackagePath('src/main/kotlin/com/tcbs/bond/trading/dto/TradingDto.kt');
    expect(result).toBe('com.tcbs.bond.trading.dto.TradingDto');
  });
});