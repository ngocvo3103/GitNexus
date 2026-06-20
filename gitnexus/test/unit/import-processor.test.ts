import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildImportResolutionContext,
  processImportsFromExtracted,
  JAVA_EXTERNAL_PACKAGE_PREFIXES,
} from '../../src/core/ingestion/import-processor.js';
import type { ImportResolutionContext } from '../../src/core/ingestion/import-resolvers/types.js';
import { createResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import type { ExtractedImport } from '../../src/core/ingestion/workers/parse-worker.js';

describe('ResolutionContext.importMap', () => {
  it('creates an empty Map', () => {
    const map = createResolutionContext().importMap;
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('can be used to store import relationships', () => {
    const map = createResolutionContext().importMap;
    map.set('src/index.ts', new Set(['src/utils.ts', 'src/types.ts']));
    expect(map.get('src/index.ts')!.size).toBe(2);
    expect(map.get('src/index.ts')!.has('src/utils.ts')).toBe(true);
  });
});

describe('buildImportResolutionContext', () => {
  let ctx: ImportResolutionContext;
  const testPaths = [
    'src/index.ts',
    'src/utils.ts',
    'src/components/Button.tsx',
    'src/lib/helpers.ts',
  ];

  beforeEach(() => {
    ctx = buildImportResolutionContext(testPaths);
  });

  it('creates a Set of all file paths', () => {
    expect(ctx.allFilePaths).toBeInstanceOf(Set);
    expect(ctx.allFilePaths.size).toBe(4);
    expect(ctx.allFilePaths.has('src/index.ts')).toBe(true);
  });

  it('stores the original file list', () => {
    expect(ctx.allFileList).toBe(testPaths);
  });

  it('creates normalized file list with forward slashes', () => {
    const winPaths = ['src\\index.ts', 'src\\utils.ts'];
    const winCtx = buildImportResolutionContext(winPaths);
    expect(winCtx.normalizedFileList[0]).toBe('src/index.ts');
    expect(winCtx.normalizedFileList[1]).toBe('src/utils.ts');
  });

  it('creates a suffix index for O(1) lookups', () => {
    expect(ctx.index).toBeDefined();
    expect(typeof ctx.index.get).toBe('function');
  });

  it('initializes empty resolve cache', () => {
    expect(ctx.resolveCache).toBeInstanceOf(Map);
    expect(ctx.resolveCache.size).toBe(0);
  });

  it('handles empty paths array', () => {
    const emptyCtx = buildImportResolutionContext([]);
    expect(emptyCtx.allFilePaths.size).toBe(0);
    expect(emptyCtx.allFileList).toHaveLength(0);
  });

  describe('suffix index', () => {
    it('resolves file by suffix', () => {
      const result = ctx.index.get('utils.ts');
      expect(result).toBeDefined();
    });

    it('resolves file by full path', () => {
      const result = ctx.index.get('src/index.ts');
      expect(result).toBeDefined();
    });

    it('resolves nested component path', () => {
      const result = ctx.index.get('components/Button.tsx');
      expect(result).toBeDefined();
    });

    it('returns undefined for non-existent suffix', () => {
      const result = ctx.index.get('nonexistent.ts');
      expect(result).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-002 Phase 1 — WI-A1: javaExternalFqnIndex population
// Technique: Equivalence Partitioning (9 partitions) + Decision Table
//            (3 conditions × 2 values collapsed to 5 outcomes)
// All cases use the fast path (processImportsFromExtracted) — no tree-sitter
// required; the language and rawImportPath fields are supplied directly on the
// ExtractedImport objects.  Slow-path parity is covered by A1-I2 (integration).
// ─────────────────────────────────────────────────────────────────────────────

describe('javaExternalFqnIndex population', () => {
  const FILE_PATH = 'src/main/java/com/example/App.java';

  /** Build the minimal graph / context / file list needed for processImportsFromExtracted. */
  function makeEnv() {
    return {
      graph: createKnowledgeGraph(),
      ctx: createResolutionContext(),
      files: [{ path: FILE_PATH }],
    };
  }

  /** Run processImportsFromExtracted with an injected index and return it. */
  async function run(
    imps: ExtractedImport[],
    javaExternalFqnIndex: Map<string, Map<string, string>>,
  ) {
    const { graph, ctx, files } = makeEnv();
    await processImportsFromExtracted(
      graph,
      files,
      imps,
      ctx,
      undefined,   // onProgress
      undefined,   // repoRoot
      undefined,   // prebuiltCtx
      undefined,   // crossRepoRegistry
      javaExternalFqnIndex,
    );
    return javaExternalFqnIndex;
  }

  // A1-U1 [EP: java, non-wildcard, resolver null, prefix match java.*]
  it('A1-U1 — java.util.List resolver=null → entry written', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Java }],
      index,
    );
    expect(index.get(FILE_PATH)?.get('List')).toBe('java.util.List');
  });

  // A1-U2 [EP: java, non-wildcard, resolver null, prefix match org.springframework.*]
  it('A1-U2 — org.springframework.web.bind.annotation.RestController resolver=null → entry written', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'org.springframework.web.bind.annotation.RestController', language: SupportedLanguages.Java }],
      index,
    );
    expect(index.get(FILE_PATH)?.get('RestController')).toBe('org.springframework.web.bind.annotation.RestController');
  });

  // A1-U3 [EP: java, non-wildcard, resolver null, prefix match com.fasterxml.*]
  it('A1-U3 — com.fasterxml.jackson.databind.ObjectMapper resolver=null → entry written', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'com.fasterxml.jackson.databind.ObjectMapper', language: SupportedLanguages.Java }],
      index,
    );
    expect(index.get(FILE_PATH)?.get('ObjectMapper')).toBe('com.fasterxml.jackson.databind.ObjectMapper');
  });

  // A1-U4 [EP: java, wildcard, resolver null, prefix match]
  it('A1-U4 — java.util.* wildcard → NO entry written', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.*', language: SupportedLanguages.Java }],
      index,
    );
    // The file map must either be absent or contain no wildcard-derived key
    const fileMap = index.get(FILE_PATH);
    expect(fileMap === undefined || fileMap.size === 0).toBe(true);
  });

  // A1-U5 [EP: java, non-wildcard, resolver NON-NULL (in-repo), prefix match]
  // resolveJavaImport returns non-null when the file path exists in allFilePaths.
  it('A1-U5 — in-repo import resolver=non-null → NO entry written', async () => {
    const inRepoPath = 'src/main/java/org/springframework/Foo.java';
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    // The files list includes the target file, so the resolver resolves it
    const files = [{ path: FILE_PATH }, { path: inRepoPath }];
    const index: Map<string, Map<string, string>> = new Map();
    await processImportsFromExtracted(
      graph,
      files,
      [{ filePath: FILE_PATH, rawImportPath: 'org.springframework.Foo', language: SupportedLanguages.Java }],
      ctx,
      undefined, undefined, undefined, undefined,
      index,
    );
    // resolver finds org/springframework/Foo.java in the file list → result non-null → no entry
    expect(index.get(FILE_PATH)?.get('Foo')).toBeUndefined();
  });

  // A1-U6 [EP: non-Java language, non-wildcard, resolver null]
  it('A1-U6 — Kotlin language → language gate prevents population', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Kotlin }],
      index,
    );
    expect(index.get(FILE_PATH)).toBeUndefined();
  });

  it('A1-U6b — TypeScript language → language gate prevents population', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.TypeScript }],
      index,
    );
    expect(index.get(FILE_PATH)).toBeUndefined();
  });

  // A1-U7 [EP: no prefix match, resolver null]
  it('A1-U7 — com.example.internal.Bar no prefix match → NO entry written', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'com.example.internal.Bar', language: SupportedLanguages.Java }],
      index,
    );
    expect(index.get(FILE_PATH)?.get('Bar')).toBeUndefined();
  });

  // A1-U8 [same simpleClassName two imports: java.util.Date + java.sql.Date]
  it('A1-U8 — duplicate simpleClassName two external imports → last write wins, truthy', async () => {
    const index: Map<string, Map<string, string>> = new Map();
    await run(
      [
        { filePath: FILE_PATH, rawImportPath: 'java.util.Date', language: SupportedLanguages.Java },
        { filePath: FILE_PATH, rawImportPath: 'java.sql.Date', language: SupportedLanguages.Java },
      ],
      index,
    );
    // Both are external; whichever was last wins — what matters is truthy presence
    const fqn = index.get(FILE_PATH)?.get('Date');
    expect(fqn).toBeTruthy();
    expect(fqn).toMatch(/^java\.(util|sql)\.Date$/);
  });

  // A1-U9 [no side-effect on ctx — verifies I-9 partial: ctx contract preserved]
  it('A1-U9 — population does not mutate ctx.importMap or ctx.namedImportMap', async () => {
    const { graph, ctx, files } = makeEnv();
    const importMapSizeBefore = ctx.importMap.size;
    const namedImportMapSizeBefore = ctx.namedImportMap.size;
    const index: Map<string, Map<string, string>> = new Map();
    await processImportsFromExtracted(
      graph, files,
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Java }],
      ctx, undefined, undefined, undefined, undefined, index,
    );
    // The external import doesn't resolve to any in-repo file, so neither map grows
    expect(ctx.importMap.size).toBe(importMapSizeBefore);
    expect(ctx.namedImportMap.size).toBe(namedImportMapSizeBefore);
    // And the index was populated
    expect(index.get(FILE_PATH)?.get('List')).toBe('java.util.List');
  });

  // A1-U10 [fast path: imp.language enum gate]
  it('A1-U10 — fast path: Java lang → entry written; Kotlin lang → no entry', async () => {
    const indexJava: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Java }],
      indexJava,
    );
    expect(indexJava.get(FILE_PATH)?.get('List')).toBe('java.util.List');

    const indexKotlin: Map<string, Map<string, string>> = new Map();
    await run(
      [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Kotlin }],
      indexKotlin,
    );
    expect(indexKotlin.get(FILE_PATH)).toBeUndefined();
  });

  // A1-U11 [opts.lsp absent — index not passed → function runs without error]
  it('A1-U11 — no javaExternalFqnIndex arg → runs without error, no population attempted', async () => {
    const { graph, ctx, files } = makeEnv();
    // Call without the 9th arg (simulates non-LSP path)
    await expect(
      processImportsFromExtracted(
        graph, files,
        [{ filePath: FILE_PATH, rawImportPath: 'java.util.List', language: SupportedLanguages.Java }],
        ctx,
      ),
    ).resolves.toBeUndefined();
    // No side-effects on ctx either
    expect(ctx.importMap.size).toBe(0);
  });

  // Sanity: JAVA_EXTERNAL_PACKAGE_PREFIXES exports exactly 7 entries
  it('JAVA_EXTERNAL_PACKAGE_PREFIXES exports 7 known-external package prefixes', () => {
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('java.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('javax.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('jakarta.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('org.springframework.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('com.fasterxml.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('org.slf4j.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toContain('io.opentelemetry.');
    expect(JAVA_EXTERNAL_PACKAGE_PREFIXES).toHaveLength(7);
  });
});
