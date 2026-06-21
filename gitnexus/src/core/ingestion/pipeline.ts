import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { isConfigFile, processConfigFiles } from './config-indexer.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted, processORMQueriesFromExtracted, processExpoRoutesWithRepoId, processExpoRouterNavigations, processDecoratorRoutesWithRepoId, processPHPRoutesWithRepoId, processNextjsRoutesWithRepoId, processNextjsFetchRoutes, processNextjsMiddleware, processToolDefsFromExtracted, buildRefusedFqnHistogram, type ProcessCallsOpts, type CorrectionFeedItem, type RecallFeedItem } from './call-processor.js';
import type { ExtractedRoute, ExtractedExpoNav, ExtractedORMQuery, ExtractedDecoratorRoute, ExtractedFetchCall, ExtractedToolDef } from './workers/parse-worker.js';
import type { CrossRepoRegistry } from './cross-repo-registry.js';
import { processHeritage, processHeritageFromExtracted, type ProcessHeritageOpts, type HeritageFeedItem } from './heritage-processor.js';
import { processAngularMetadataFromExtracted } from './angular-metadata-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { extractDependencies } from './dependency-extractor.js';
// WI-5 (#159 P3 Mode A): the reconciler is imported here — it lives at
// `core/ingestion/mode-a-reconciler.ts` and mutates ONLY the in-memory
// graph; it imports no direct-DB writer (I-7).
import { withReconciliationSession, applyDecisions, reconcileDecisions, candidateLocationKey, DEFAULT_CANDIDATE_CAP, type Candidate, type Location, type ReconciliationReport, type SessionMeta } from './mode-a-reconciler.js';
import { selectAdapter } from './lsp/language-adapter.js';
import { mapLocationToNodeId } from './lsp/location-mapper.js';
import type { DefinitionCache } from './lsp-definition-cache.js';
import { createInMemoryNodeQuery, type InMemoryNode } from './in-memory-node-query.js';
import { writeManifest } from '../../storage/repo-manifest.js';
import { createResolutionContext, type ResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDev = process.env.NODE_ENV === 'development';

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

export interface PipelineOptions {
  /** Skip MRO, community detection, and process extraction for faster test runs. */
  skipGraphPhases?: boolean;
  /**
   * #50: when provided, unresolved imports whose package maps to an indexed
   * dependency repo create an external File node + CROSS_IMPORTS edge. When
   * omitted (the default), ingestion is single-repo and creates no external nodes.
   */
  crossRepoRegistry?: CrossRepoRegistry;
  /**
   * WI-5 (#159 P3 Mode A): when `enabled` is true, the pipeline runs the
   * LSP reconciler over the heuristic CALLS feed AFTER all CALLS emission
   * completes. When omitted (the default), the default `analyze` (no flag)
   * is byte-identical — no server is started, the feeds are empty, the
   * reconciler is not invoked.
   *
   * `dryRun: true` prints every decision tuple and writes nothing
   * (AC-6 / KD-11). It is a child of `enabled` — when `dryRun` is true but
   * `enabled` is false, the option is a no-op.
   */
  lsp?: {
    enabled?: boolean;
    dryRun?: boolean;
    /**
     * WI-6 (#159 P3): override the candidate cap passed to
     * `withReconciliationSession` (default: `DEFAULT_CANDIDATE_CAP=2000`).
     * Must be a positive integer — the CLI validates this before the pipeline
     * is called. The `??` fallback in the LSP block picks the default when
     * `budget` is `undefined`.
     *
     * NOTE: `0 ?? DEFAULT_CANDIDATE_CAP` does NOT coalesce on zero — that
     * case is rejected at the CLI validation layer (`n <= 0` guard) before
     * it ever reaches this field.
     */
    budget?: number;
    /**
     * Lever 12 spot-check: sample rate in [0,1] for re-checking import-scoped
     * (0.90) CALLS edges via LSP. 0/undefined (default) leaves the feed exactly
     * as before (global tier only) — byte-identical. The CLI validates the range.
     */
    highTierSampleRate?: number;
    /**
     * Lever 13: max concurrent in-flight LSP requests. 1/undefined (default)
     * keeps the serial single-flight queue (byte-identical). > 1 lets the
     * server answer N definition requests concurrently. The CLI validates it.
     */
    pipeline?: number;
    /**
     * Lever 15 (incremental-only LSP): repo-relative POSIX paths of files
     * changed since a base ref. When non-empty, the LSP candidate feed is
     * scoped to call/heritage sites in these files only. Absent/empty → the
     * full feed is reconciled (byte-identical to today). Built by the CLI from
     * `git diff --name-only <ref>`.
     */
    changedFiles?: Set<string>;
    /**
     * Lever 14: a pre-built persisted definition cache. When present, the
     * reconciler consults it before each live request and stores results;
     * the pipeline flushes it after the session. Built by the CLI (which owns
     * the git/commit/clean-tree checks). Absent → no caching.
     */
    definitionCache?: DefinitionCache;
  };
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  let ctx: ResolutionContext;
  let symbolTable;
  let astCache = createASTCache(AST_CACHE_CAP);

  const cleanup = () => {
    astCache.clear();
    ctx.clear();
  };

  try {
    // ── Phase 1: Scan paths only (no content read) ─────────────────────
    onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const scannedFiles = await walkRepositoryPaths(repoPath, (current, total, filePath) => {
      const scanProgress = Math.round((current / total) * 15);
      onProgress({
        phase: 'extracting',
        percent: scanProgress,
        message: 'Scanning repository...',
        detail: filePath,
        stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
      });
    });

    const totalFiles = scannedFiles.length;

    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2: Structure (paths only — no content needed) ────────────
    onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles, nodesCreated: graph.nodeCount },
    });

    const allPaths = scannedFiles.map(f => f.path);
    processStructure(graph, allPaths);

    onProgress({
      phase: 'structure',
      percent: 20,
      message: 'Project structure analyzed',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2.5: Config Files (application*.properties/yml) ────────────
    // Index config files separately from source code parsing
    const configFileNames = allPaths.filter(isConfigFile);
    if (configFileNames.length > 0) {
      onProgress({
        phase: 'parsing',
        percent: 21,
        message: `Indexing ${configFileNames.length} config file${configFileNames.length !== 1 ? 's' : ''}...`,
        stats: { filesProcessed: 0, totalFiles: configFileNames.length, nodesCreated: graph.nodeCount },
      });

      const configFileContents = await readFileContents(repoPath, configFileNames);
      const configFiles = configFileNames
        .filter(p => configFileContents.has(p))
        .map(p => ({ path: p, content: configFileContents.get(p)! }));

      const propertyCount = processConfigFiles(graph, configFiles);
      
      if (isDev && propertyCount > 0) {
        console.log(`⚙️  Indexed ${propertyCount} properties from ${configFileNames.length} config file${configFileNames.length !== 1 ? 's' : ''}`);
      }
    }

    // ── Phase 2.5: Dependency Extraction ─────────────────────────────
    onProgress({
      phase: 'extracting',
      percent: 20,
      message: 'Extracting dependencies...',
    });

    let extractionRepoId: string | undefined;
    try {
      const extractionResult = await extractDependencies(repoPath);
      extractionRepoId = extractionResult.repoId;
      // Convert ExtractionResult to RepoManifest format
      const manifest: import('../../storage/repo-manifest.js').RepoManifest = {
        repoId: extractionResult.repoId,
        indexedAt: extractionResult.indexedAt,
        dependencies: extractionResult.dependencies.map(d => d.name),
      };
      if (isDev && manifest.dependencies.length > 0) {
        console.log(`📦 Extracted ${manifest.dependencies.length} dependencies from ${extractionResult.ecosystem}`);
      }
      try {
        await writeManifest(repoPath, manifest);
      } catch (manifestErr) {
        console.warn('Failed to write repo manifest:', (manifestErr as Error).message);
      }
    } catch (err) {
      // Non-fatal: dependency extraction failure shouldn't stop indexing
      console.warn('Dependency extraction failed:', (err as Error).message);
    }

    // Always initialize ctx/symbolTable — never leave them undefined
    ctx = createResolutionContext(graph, extractionRepoId);
    symbolTable = ctx.symbols;

    // ── Phase 3+4: Chunked read + parse ────────────────────────────────
    // Group parseable files into byte-budget chunks so only ~20MB of source
    // is in memory at a time. Each chunk is: read → parse → extract → free.

    const parseableScanned = scannedFiles.filter(f => {
      const lang = getLanguageFromFilename(f.path);
      return lang && isLanguageAvailable(lang);
    });

    // Warn about files skipped due to unavailable parsers
    const skippedByLang = new Map<string, number>();
    for (const f of scannedFiles) {
      const lang = getLanguageFromFilename(f.path);
      if (lang && !isLanguageAvailable(lang)) {
        skippedByLang.set(lang, (skippedByLang.get(lang) || 0) + 1);
      }
    }
    for (const [lang, count] of skippedByLang) {
      console.warn(`Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`);
    }

    const totalParseable = parseableScanned.length;

    if (totalParseable === 0) {
      onProgress({
        phase: 'parsing',
        percent: 82,
        message: 'No parseable files found — skipping parsing phase',
        stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
      });
    }

    // Build byte-budget chunks
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentBytes = 0;
    for (const file of parseableScanned) {
      if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(file.path);
      currentBytes += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const numChunks = chunks.length;

    if (isDev) {
      const totalMB = parseableScanned.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
      console.log(`📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`);
    }

    onProgress({
      phase: 'parsing',
      percent: 20,
      message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
      stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
    });

    // Don't spawn workers for tiny repos — overhead exceeds benefit
    const MIN_FILES_FOR_WORKERS = 1000000;
    const MIN_BYTES_FOR_WORKERS = 1024 * 1024 * 1024;  // 512KB threshold
    const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);

    // Create worker pool once, reuse across chunks
    let workerPool: WorkerPool | undefined;
    if (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS) {
      try {
        let workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
        // When running under vitest, import.meta.url points to src/ where no .js exists.
        // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
        const thisDir = fileURLToPath(new URL('.', import.meta.url));
        if (!fs.existsSync(fileURLToPath(workerUrl))) {
          const distWorker = path.resolve(thisDir, '..', '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
          if (fs.existsSync(distWorker)) {
            workerUrl = pathToFileURL(distWorker) as URL;
          }
        }
        workerPool = createWorkerPool(workerUrl);
      } catch (err) {
        if (isDev) console.warn('Worker pool creation failed, using sequential fallback:', (err as Error).message);
      }
    }

    let filesParsedSoFar = 0;

    // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
    const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
    astCache = createASTCache(maxChunkFiles);

    // Build import resolution context once — suffix index, file lists, resolve cache.
    // Reused across all chunks to avoid rebuilding O(files × path_depth) structures.
    const importCtx = buildImportResolutionContext(allPaths);
    const allPathObjects = allPaths.map(p => ({ path: p }));

    // Single-pass: parse + resolve imports/calls/heritage per chunk.
    // Calls/heritage use the symbol table built so far (symbols from earlier chunks
    // are already registered). This trades ~5% cross-chunk resolution accuracy for
    // 200-400MB less memory — critical for Linux-kernel-scale repos.
    const sequentialChunkPaths: string[][] = [];
    const sequentialChunkRoutes: ExtractedRoute[][] = [];
    // Accumulate expoNavCalls, ormQueries, fetchCalls across chunks for processing after all chunks
    const allExpoNavCalls: ExtractedExpoNav[] = [];
    const allORMQueries: ExtractedORMQuery[] = [];
    const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
    const allFetchCalls: ExtractedFetchCall[] = [];
    const allToolDefs: ExtractedToolDef[] = [];
    const allAngularMetadata: import('./workers/parse-worker.js').ExtractedAngularEdge[] = [];
    // #31: Angular CALLS extracted in the sequential parsing pass (DI/template).
    const allSequentialCalls: import('./workers/parse-worker.js').ExtractedCall[] = [];

    // WI-5 (#159 P3 Mode A): the candidate feed arrays. We pass them
    // as sinks into `processCallsFromExtracted` ONLY when
    // `options.lsp.enabled` is true; the default path leaves both
    // arrays empty and the call processor never references them
    // (the call processor checks `opts?.lsp` and `opts?.correctionFeed`
    // / `opts?.recallFeed` before pushing). One pair of arrays is
    // declared up front and SHARED across all chunks and the
    // sequential-fallback re-resolution, so the reconciler sees a
    // single merged feed.
    const correctionFeed: CorrectionFeedItem[] = [];
    const recallFeed: RecallFeedItem[] = [];

    // ADR-002 Phase 1: javaExternalFqnIndex is allocated ONCE under the opts.lsp gate
    // and passed by reference to both import-processor paths (population) and both
    // call-processor paths via ProcessCallsOpts (consumption).  Not allocated on the
    // default (non-LSP) analyze path so I-9 byte-identity is preserved by construction.
    const javaExternalFqnIndex: Map<string, Map<string, string>> | undefined =
      options?.lsp?.enabled ? new Map() : undefined;

    const lspFeedsOpt: ProcessCallsOpts | undefined = options?.lsp?.enabled
      ? {
          lsp: true,
          correctionFeed,
          recallFeed,
          javaExternalFqnIndex,
          highTierSampleRate: options.lsp.highTierSampleRate,
        }
      : undefined;

    // WI-4 / WI-6 (#159 P3 Mode A — heritage feed): the
    // heritage candidate feed. We pass it as a sink into
    // `processHeritageFromExtracted` (worker path) and
    // `processHeritage` (sequential fallback) ONLY when
    // `options.lsp.enabled` is true. The default path leaves
    // the array empty and the heritage processor never
    // references it (the heritage processor checks
    // `opts?.lsp && opts.heritageFeed` before pushing). One
    // array is declared up front and SHARED across all chunks
    // and the sequential-fallback re-resolution, so the
    // reconciler sees a single merged heritage feed. The
    // candidate-merge block below concats the heritage feed
    // into the same `Candidate[]` stream the CALLS feeds feed
    // into — exactly ONE `withReconciliationSession` call
    // drains the merged stream.
    const heritageFeed: HeritageFeedItem[] = [];
    const lspHeritageOpt: ProcessHeritageOpts | undefined = options?.lsp?.enabled
      ? { lsp: true, heritageFeed }
      : undefined;

    try {
      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const chunkPaths = chunks[chunkIdx];

        // Read content for this chunk only
        const chunkContents = await readFileContents(repoPath, chunkPaths);
        const chunkFiles = chunkPaths
          .filter(p => chunkContents.has(p))
          .map(p => ({ path: p, content: chunkContents.get(p)! }));

        // Parse this chunk (workers or sequential fallback)
        const chunkWorkerData = await processParsing(
          graph, chunkFiles, symbolTable, astCache,
          (current, _total, filePath) => {
            const globalCurrent = filesParsedSoFar + current;
            const parsingProgress = 20 + ((globalCurrent / totalParseable) * 62);
            onProgress({
              phase: 'parsing',
              percent: Math.round(parsingProgress),
              message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
              detail: filePath,
              stats: { filesProcessed: globalCurrent, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          },
          workerPool,
        );

        const chunkBasePercent = 20 + ((filesParsedSoFar / totalParseable) * 62);

        if (workerPool && chunkWorkerData) {
          // Worker path: use extracted data for imports, heritage, calls, routes
          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} files`,
              stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          }, repoPath, importCtx, options?.crossRepoRegistry, javaExternalFqnIndex);
          // Calls + Heritage + Routes — resolve in parallel (no shared mutable state between them)
          // This is safe because each writes disjoint relationship types into idempotent id-keyed Maps,
          // and the single-threaded event loop prevents races between synchronous addRelationship calls.

          // Heritage MUST run before calls: IMPLEMENTS edges (from heritage) are needed
          // for D5 call resolution to work correctly. Call resolution depends on
          // interface/implementation edges being established first.
          await processHeritageFromExtracted(
            graph,
            chunkWorkerData.heritage,
            ctx,
            (current, total) => {
              onProgress({
                phase: 'parsing',
                percent: Math.round(chunkBasePercent),
                message: `Resolving heritage (chunk ${chunkIdx + 1}/${numChunks})...`,
                detail: `${current}/${total} records`,
                stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
              });
            },
            lspHeritageOpt,
          );

          await processCallsFromExtracted(
            graph,
            chunkWorkerData.calls,
            ctx,
            (current, total) => {
              onProgress({
                phase: 'parsing',
                percent: Math.round(chunkBasePercent),
                message: `Resolving calls (chunk ${chunkIdx + 1}/${numChunks})...`,
                detail: `${current}/${total} files`,
                stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
              });
            },
            chunkWorkerData.constructorBindings,
            undefined, // typeEnvBindings — not used in the worker path
            lspFeedsOpt,
          );

          await processRoutesFromExtracted(
            graph,
            chunkWorkerData.routes ?? [],
            ctx,
            (current, total) => {
              onProgress({
                phase: 'parsing',
                percent: Math.round(chunkBasePercent),
                message: `Resolving routes (chunk ${chunkIdx + 1}/${numChunks})...`,
                detail: `${current}/${total} routes`,
                stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
              });
            },
          );
          // Accumulate expoNavCalls and ormQueries for post-processing after all chunks
          if (chunkWorkerData.expoNavCalls) {
            allExpoNavCalls.push(...chunkWorkerData.expoNavCalls);
          }
          if (chunkWorkerData.ormQueries) {
            allORMQueries.push(...chunkWorkerData.ormQueries);
          }
          // Accumulate decoratorRoutes (Express/Hono) for post-processing
          if (chunkWorkerData.decoratorRoutes) {
            allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes);
          }
          // Accumulate angularMetadata (NgModule edges) for post-processing
          if (chunkWorkerData.angularMetadata) {
            allAngularMetadata.push(...chunkWorkerData.angularMetadata);
          }
          // Accumulate fetchCalls for post-processing
          if (chunkWorkerData.fetchCalls) {
            allFetchCalls.push(...chunkWorkerData.fetchCalls);
          }
          // Accumulate toolDefs for post-processing
          if (chunkWorkerData.toolDefs) {
            allToolDefs.push(...chunkWorkerData.toolDefs);
          }
        } else {
          // Sequential path: processImports adds symbols, then heritage/calls are resolved
          // in the sequential fallback loop below (lines 351-365)
          await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths, options?.crossRepoRegistry, javaExternalFqnIndex);
          sequentialChunkPaths.push(chunkPaths);
          sequentialChunkRoutes.push(chunkWorkerData.routes ?? []);
          // Accumulate expoNavCalls and ormQueries for sequential path too
          if (chunkWorkerData.expoNavCalls) {
            allExpoNavCalls.push(...chunkWorkerData.expoNavCalls);
          }
          if (chunkWorkerData.ormQueries) {
            allORMQueries.push(...chunkWorkerData.ormQueries);
          }
          if (chunkWorkerData.decoratorRoutes) {
            allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes);
          }
          if (chunkWorkerData.angularMetadata) {
            allAngularMetadata.push(...chunkWorkerData.angularMetadata);
          }
          // #31: Angular CALLS extracted by the sequential parsing pass. The
          // general call graph is resolved via processCalls re-extraction below;
          // chunkWorkerData.calls carries ONLY the Angular DI/template calls here.
          if (chunkWorkerData.calls && chunkWorkerData.calls.length > 0) {
            allSequentialCalls.push(...chunkWorkerData.calls);
          }
          // Accumulate fetchCalls for sequential path too
          if (chunkWorkerData.fetchCalls) {
            allFetchCalls.push(...chunkWorkerData.fetchCalls);
          }
          // Accumulate toolDefs for sequential path too
          if (chunkWorkerData.toolDefs) {
            allToolDefs.push(...chunkWorkerData.toolDefs);
          }
        }

        filesParsedSoFar += chunkFiles.length;

        // Clear AST cache between chunks to free memory
        astCache.clear();
        // chunkContents + chunkFiles + chunkWorkerData go out of scope → GC reclaims
      }
    } finally {
      await workerPool?.terminate();
    }

    // Sequential fallback chunks: re-read source for call/heritage resolution
    for (let chunkIdx = 0; chunkIdx < sequentialChunkPaths.length; chunkIdx++) {
      const chunkPaths = sequentialChunkPaths[chunkIdx];
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      // WI-4 / WI-6: pass `lspHeritageOpt` so the AST-path
      // `processHeritage` populates the shared heritage feed
      // (mirrors the worker-path threading at `:388-403`).
      await processHeritage(graph, chunkFiles, astCache, ctx, undefined, lspHeritageOpt);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, ctx, undefined, undefined, undefined, undefined, undefined, lspFeedsOpt);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx, undefined, lspHeritageOpt);
      }
      const chunkRoutes = sequentialChunkRoutes[chunkIdx];
      if (chunkRoutes.length > 0) {
        await processRoutesFromExtracted(graph, chunkRoutes, ctx);
      }
      astCache.clear();
    }

    // Post-processing: Expo routes and ORM queries (accumulated across all chunks)
    // Process Expo Router routes and navigation
    const expoPaths = allPaths.filter(p => p.includes('app/'));
    if (expoPaths.length > 0) {
      const routeRegistry = processExpoRoutesWithRepoId(graph, expoPaths, ctx.repoId ?? '');
      if (allExpoNavCalls.length > 0) {
        processExpoRouterNavigations(graph, allExpoNavCalls, routeRegistry);
      }
    }

    // Process ORM queries
    if (allORMQueries.length > 0) {
      processORMQueriesFromExtracted(graph, allORMQueries);
    }

    // Process Express/Hono routes (decoratorRoutes extracted from JS/TS files)
    if (allDecoratorRoutes.length > 0) {
      processDecoratorRoutesWithRepoId(graph, allDecoratorRoutes, ctx.repoId ?? '');
    }

    // Process Angular @NgModule metadata edges (#32 — AppModule outgoing edges)
    if (allAngularMetadata.length > 0) {
      await processAngularMetadataFromExtracted(graph, allAngularMetadata, ctx);
    }

    // Process Angular CALLS edges (#31 — DI token -> service, template -> method).
    // Runs after the sequential fallback so component/service symbols exist.
    if (allSequentialCalls.length > 0) {
      await processCallsFromExtracted(
        graph,
        allSequentialCalls,
        ctx,
        undefined, // onProgress
        undefined, // constructorBindings
        undefined, // typeEnvBindings
        lspFeedsOpt,
      );
    }

    // Process MCP tool definitions (@mcp.tool() decorators)
    if (allToolDefs.length > 0) {
      await processToolDefsFromExtracted(graph, allToolDefs, ctx);
    }

    // Process PHP file-based routes (direct file routing in api/ directory)
    const phpApiPaths = allPaths.filter(p => p.endsWith('.php') && (p.startsWith('api/') || p.includes('/api/')));
    if (phpApiPaths.length > 0) {
      const phpContents = await readFileContents(repoPath, phpApiPaths);
      processPHPRoutesWithRepoId(graph, phpApiPaths, phpContents, ctx.repoId ?? '');
    }

    // Process Next.js App Router routes (app/api/**/route.ts files)
    // Match files like: app/api/grants/route.ts, app/api/users/[id]/route.ts
    const nextjsRoutePaths = allPaths.filter(p => /(?:^|\/)app\/api\/.*\/route\.(ts|js|tsx|jsx)$/.test(p));
    let nextjsRouteRegistry: Map<string, string> | undefined;
    if (nextjsRoutePaths.length > 0) {
      const nextjsContents = await readFileContents(repoPath, nextjsRoutePaths);
      nextjsRouteRegistry = processNextjsRoutesWithRepoId(graph, nextjsRoutePaths, nextjsContents, ctx.repoId ?? '');
    }

    // Process Next.js project-level middleware.ts and link to matching routes
    const allFileContents = await readFileContents(repoPath, allPaths);
    processNextjsMiddleware(graph, allPaths, allFileContents);

    // Process fetch() calls to create FETCHES edges to Route nodes
    if (allFetchCalls.length > 0 && nextjsRouteRegistry && nextjsRouteRegistry.size > 0) {
      // `allFileContents` was loaded above; filter it down to the
      // consumer file set rather than re-issuing `readFileContents`
      // for the same paths.
      const consumerPaths = [...new Set(allFetchCalls.map(c => c.filePath))];
      const consumerContents = new Map(
        consumerPaths
          .map(p => [p, allFileContents.get(p)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
      );
      processNextjsFetchRoutes(graph, allFetchCalls, nextjsRouteRegistry, consumerContents);
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      console.log(`🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`);
    }

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    (importCtx as any).suffixIndex = null;
    (importCtx as any).normalizedFileList = null;

    // ── WI-5 (#159 P3 Mode A) — LSP reconciliation ────────────────────
    // Runs AFTER every CALLS emitter has finished (the three
    // `processCallsFromExtracted` paths above + the Angular
    // sequential-fallback re-resolution) and BEFORE the
    // community/process phases mutate the graph further. The
    // reconciler mutates the in-memory graph in place; the
    // downstream load-to-LadybugDB path (lbug-adapter) is the
    // sole serialization surface, so the `source` column rides
    // through the normal CSV→COPY path.
    //
    // Default `analyze` (no `opts.lsp`) hits the `else` branch —
    // the array empty-checks short-circuit and no server is
    // ever discovered or started. The default path is byte-
    // identical.
    // The engine no longer carries `serverVersion` on its
    // report (the session has the authoritative value via
    // `SessionMeta`); we attach it here so the
    // observability print line keeps a single source of
    // truth and the type system is happy.
    type PipelineLspReport = ReconciliationReport & { serverVersion: string };
    let lspReport: PipelineLspReport | null = null;
    if (options?.lsp?.enabled) {
      const lspStart = Date.now();
      const dryRun = options.lsp.dryRun === true;

      // Build the in-memory node adapter the mapper needs. We
      // project the in-memory graph's nodes into the adapter's
      // minimal shape (`InMemoryNode`). The adapter itself is
      // read-only (KD-2); the reconciler mutates ONLY the
      // in-memory `KnowledgeGraph` it was given.
      const lspNodes: InMemoryNode[] = [];
      graph.forEachNode((n) => {
        // Every GraphNode carries a `properties` object by
        // type contract; the typeof guards below normalize
        // *missing* fields (the properties record is
        // partial in practice) to the empty/zero defaults
        // the adapter expects.
        const props = n.properties;
        lspNodes.push({
          id: n.id,
          name: typeof props.name === 'string' ? props.name : '',
          startLine: typeof props.startLine === 'number' ? props.startLine : 0,
          endLine: typeof props.endLine === 'number' ? props.endLine : 0,
          label: n.label,
          filePath: typeof props.filePath === 'string' ? props.filePath : '',
        });
      });
      const inMemoryQuery = createInMemoryNodeQuery(lspNodes);

      // Merge feeds into a single `Candidate[]` stream. The
      // session funnel stable-sorts by
      // (sourceId, calledName, line, character) and caps at
      // 2000 — see `withReconciliationSession` (KD-9). Recall
      // candidates lack `oldTargetId`; correction candidates
      // carry it. We unify the two shapes here. WI-1 / #159
      // also threads `oldRelId` so the engine's site-precise
      // `correct`/`confirm` can target the exact edge id
      // minted by the heuristic (call-processor.ts:668/:1537
      // `:L${line}` suffix).
      const candidates: Candidate[] = [];
      for (const c of correctionFeed) {
        candidates.push({
          sourceId: c.sourceId,
          calledName: c.calledName,
          oldTargetId: c.oldTargetId,
          oldRelId: c.oldRelId,
          file: c.file,
          line: c.line,
          character: c.character,
        });
      }

      // ADR-002 Phase 1 WI-A3: map from candidateLocationKey → calleeExternalFqn for
      // recall candidates that carry a provably-external Java FQN.  Populated here from
      // RecallFeedItem.calleeExternalFqn (injected by WI-A2 at recall-push time).
      // canSkipCandidate consults this map to skip LSP dispatch for confirmed-external
      // recall candidates.  Empty map on the default (non-LSP) analyze path: I-9 preserved.
      //
      // EP-J / I-2c (no false skips): the buildRecallExternalFqnMap helper enforces
      // that a key is present ONLY if EVERY recall item at that key carries a truthy
      // calleeExternalFqn.  Divergent pairs (one truthy, one absent) result in key
      // deletion so canSkipCandidate returns false → both twins probed → no internal
      // CALLS edge dropped.  See buildRecallExternalFqnMap JSDoc for the guard invariant.
      // EP-J unit tests (A3-U7b) target buildRecallExternalFqnMap directly; this comment
      // is the upstream pointer — see test/unit/lsp/mode-a-external-prefilter.test.ts.
      for (const r of recallFeed) {
        candidates.push({
          sourceId: r.sourceId,
          calledName: r.calledName,
          file: r.file,
          line: r.line,
          character: r.character,
        });
      }
      // Build the FQN map after the candidate-push loop (candidates.push is kept above
      // because the heritage loop and dedup follow immediately; extraction of just the
      // map-build logic keeps the push ordering stable — I-9 preserved).
      const recallExternalFqnMap = buildRecallExternalFqnMap(recallFeed);

      // WI-6 (#159 P3 Mode A — pipeline merge): concat the
      // heritage feed into the same `Candidate[]` stream.
      // The heritage processor emits a `HeritageFeedItem`
      // per heuristic heritage edge that passes the WI-4
      // gate (lsp on, TS-family, parent at global/unresolved
      // tier, position available, edge actually emitted).
      // Each `HeritageFeedItem` maps to a `Candidate` with
      // `relType` set (WI-5: `'IMPLEMENTS' | 'EXTENDS'`) and
      // `parentName` mapped to `calledName` (the parent
      // identifier is the LSP query target — KD-5: definition
      // at the parent position). `oldTargetId` / `oldRelId`
      // ride through unchanged so the engine can find the
      // heuristic edge and (on `correct`) remove it by exact
      // id. The shared 2000 cap applies to the merged stream
      // — CALLS + heritage compete for the deterministic
      // prefix after the stable sort (partitioning is a
      // documented follow-up).
      for (const h of heritageFeed) {
        candidates.push({
          sourceId: h.sourceId,
          calledName: h.parentName,
          oldTargetId: h.oldTargetId,
          oldRelId: h.oldRelId,
          relType: h.relType,
          file: h.file,
          line: h.line,
          character: h.character,
        });
      }

      // WI-1 (#166 P3 Mode A) — dedup merged stream by
      // `candidateLocationKey`. The active `processCalls` (`:492`,
      // wired this WI) and the Angular post-pass (`:531`) now
      // share these feed arrays. When the same call site is
      // reachable by both producers (e.g. an Angular component
      // file that also falls into the sequential fallback), the
      // session funnel would see the same candidate twice. The
      // funnel sorts but does not dedup, so we dedup here once
      // (O(n)) keyed on the canonical four-tuple the engine
      // itself uses (`mode-a-reconciler.ts:1626`). First writer
      // wins (Map iteration order is insertion order); the
      // correction shape carries `oldTargetId` so a correction
      // beats a recall when both arrive for the same site.
      const dedupedCandidates: Candidate[] = [];
      const seenKeys = new Set<string>();
      for (const c of candidates) {
        const k = candidateLocationKey(c);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        dedupedCandidates.push(c);
      }

      // Lever 15 (incremental-only LSP): when a changed-file set is supplied
      // (`--lsp-changed-since <ref>`), scope the candidate feed to call/heritage
      // sites in changed files only, removing the unchanged majority from the
      // serial dispatch. `candidate.file` and the git-diff paths are both
      // repo-relative POSIX. Default (no set / empty) → no filtering, the feed
      // is byte-identical to a full run.
      // `undefined` → feature off (full feed). A Set (even empty) → feature
      // ON: scope to it, so "nothing changed since ref" reconciles nothing
      // rather than falling back to a full run.
      const changedFiles = options?.lsp?.changedFiles;
      const scopedCandidates =
        changedFiles !== undefined
          ? dedupedCandidates.filter((c) => changedFiles.has(c.file))
          : dedupedCandidates;
      if (changedFiles !== undefined) {
        // eslint-disable-next-line no-console
        console.log(
          `  lsp-incremental: ${scopedCandidates.length} of ${dedupedCandidates.length} candidates in ${changedFiles.size} changed files`,
        );
      }

      // WI-5: capture N (total deduped candidates) and B (budget cap) BEFORE
      // withReconciliationSession so these values survive all exit paths —
      // gate-failure (null), error (rethrow), and success — and the funnel
      // line always has correct values even if the session never ran.
      const lspN = scopedCandidates.length;
      // WI-6: use the CLI-supplied budget when present; fall back to the
      // default 2000. The CLI validation layer guarantees `budget` is a
      // positive integer when defined — the `??` fallback here correctly
      // passes through `undefined` (not set) but NEVER `0` (rejected at CLI).
      const lspB = options?.lsp?.budget ?? DEFAULT_CANDIDATE_CAP;

      // WI-6 (#159 P3): select the language adapter once for this
      // repo. `selectAdapter` performs an extension census (KD-4)
      // and returns the dominant adapter or `null` (no supported
      // language). A `null` result is passed directly into the
      // session deps — the session short-circuits cleanly and
      // returns `null` without spawning anything.
      //
      // The adapter is threaded through three DI seams:
      //   1. `adapter` dep → session selects server binary + args.
      //   2. `probe` override → `buildCanarySamples` uses
      //      `adapter.canary` strategy so Java repos sample `.java`
      //      files instead of TypeScript files.
      //   3. `defaultCreateLspClient` → `LspClient` receives the
      //      adapter and spawns the correct binary.
      const lspAdapter = selectAdapter(repoPath);

      // Pre-resolve the repo root once for the entire reconciliation
      // session. mapLocationToNodeId calls realpathSync(repoPath) on
      // every invocation when only `repoPath` is supplied — for a
      // large Python repo (10k+ CALL candidates) that emits 10k
      // redundant stat(2) syscalls against the same constant value.
      // Supplying the pre-resolved root as `resolvedRepoPath` lets the
      // mapper skip that call entirely in the hot path.
      let resolvedRepoPath: string | undefined;
      try {
        resolvedRepoPath = fs.realpathSync(repoPath);
      } catch {
        // Non-existent or inaccessible repo root — leave undefined so
        // the mapper falls back to its own realpathSync on each call
        // (pre-existing behavior, preserves correctness).
        resolvedRepoPath = undefined;
      }

      // The session funnel is the single refuse path. The
      // per-candidate `textDocument/definition` requests are
      // issued inside it; the responses are collected into
      // `locations` via the `handToEngine` seam. We then run
      // the engine decision pass (`reconcileDecisions`) once,
      // followed by `applyDecisions` (which is a no-op in
      // dryRun).
      const locations = new Map<string, Location[]>();

      onProgress({
        phase: 'parsing',
        percent: 80,
        message: dryRun ? 'LSP dry-run: resolving candidates...' : 'LSP reconciliation: resolving candidates...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      // WS-B / I-2d: capture gate-failure reason + elapsed via side-channel so
      // pipeline.ts can emit the correct per-path funnel message when the session
      // returns null. Two distinct cases:
      //   'not-ready'  → 'LSP augmentation skipped: jdtls not ready after Xs'
      //                  (no budget suffix, per C5-12 / WS-B spec).
      //   'no-server'  → gate-failure format via buildLspSummaryLine (with suffix).
      //   'dispatch-error' → already logged in the reconcileDecisions catch below;
      //                  onGateFailure fires only when the session's own try/catch
      //                  fires, NOT for errors in reconcileDecisions/applyDecisions.
      let gateFailureReason: 'no-server' | 'not-ready' | 'dispatch-error' | null = null;
      let gateFailureElapsedS = '0.0';

      // I-8-replay: track candidate keys that canSkipCandidate pre-filtered so
      // reconcileDecisions can exclude them. Without this, they replay as [] →
      // NO_NODE → keep/refuse and inflate refused/kept counts incorrectly.
      const preFilteredKeys = new Set<string>();

      const sessionResult = await withReconciliationSession<{
        meta: SessionMeta;
        selectedCount: number;
        skipped: number;
        probed: number;
        preFilteredExternal: number;
      }>(
        { id: ctx.repoId ?? 'default', repoPath },
        scopedCandidates,
        async (selected, meta, skipped) => {
          // The session's own per-candidate loop drives the
          // `textDocument/definition` requests; the engine
          // seam is `handToEngine`. The session has already
          // populated `locations` by the time the work fn
          // runs. We return meta + skipped + the dispatch
          // counters directly (WS-B work-fn payload spec).
          // WI-5: meta.probed and meta.preFilteredExternal are set
          // by the dispatch loop before this work-fn is called.
          return {
            meta,
            selectedCount: selected.length,
            skipped,
            probed: meta.probed,
            preFilteredExternal: meta.preFilteredExternal,
          };
        },
        {
          // WI-6: pass the selected adapter (or null) so the
          // session can pick the correct discovered server and
          // spawn the correct binary. null → session short-circuits.
          adapter: lspAdapter,
          // probe: wire a real canary-based readiness check.
          // The `defaultProbe` in mode-a-reconciler.ts passes
          // empty samples → probe always refuses (structural no-op).
          // We override it here with `buildCanarySamples` so the
          // session can actually gate on whether the server has
          // resolved the workspace module graph.
          //
          // WI-6: pass `{ strategy: lspAdapter.canary }` so the
          // sampler uses the correct language strategy — Java repos
          // scan `.java` files; TS repos scan `.ts`/`.tsx`/etc.
          // `adapter.canary` may be `null` for stub adapters
          // (pre-WI-2); `buildCanarySamples` falls back to
          // TS_CANARY_STRATEGY safely in that case.
          //
          // The probe signature wants the full `LspClient`; the
          // session narrows it to `ReconciliationLspClient` for the
          // work-fn seam. The narrowing is behavior-preserving (the
          // four picked members are the only ones the probe touches
          // in this codepath) — a structural cast is sound but TS
          // can't prove it without the double-as. Mirrors the
          // casting pattern in defaultProbe (mode-a-reconciler.ts).
          probe: lspAdapter === null ? undefined : async (client) => {
            const { probeWorkspaceReadiness } = await import('./lsp/workspace-readiness-probe.js');
            const { buildCanarySamples } = await import('./lsp/canary-sampler.js');
            return probeWorkspaceReadiness(
              client as unknown as import('./lsp/lsp-client.js').LspClient,
              await buildCanarySamples(repoPath, { strategy: lspAdapter.canary }),
              { perRequestTimeoutMs: 3000 },
            );
          },
          // The session calls this once per candidate with
          // the normalized `Location[]` payload. We key on
          // the canonical four-tuple so the engine can look
          // it up later.
          handToEngine: async (candidate, responseLocs) => {
            // Use the SAME key helper the engine uses to look
            // up the payload — keeps producer/consumer in sync
            // if the key shape ever evolves.
            locations.set(candidateLocationKey(candidate), responseLocs);
          },
          // WI-6: pass the resolved budget as the session cap so
          // withReconciliationSession uses the CLI-supplied value
          // instead of its own DEFAULT_CANDIDATE_CAP default.
          cap: lspB,
          // Lever 13: request pipelining (default 1 = serial, byte-identical).
          maxInFlight: options?.lsp?.pipeline,
          // Lever 14: persisted definition cache (undefined → no caching).
          definitionCache: options?.lsp?.definitionCache,
          // WI-8: external pre-filter. Uses graph.getNode(oldTargetId)
          // to detect correction candidates whose heuristic target is
          // an external-zone node (NodeProperties.isExternal===true).
          // EP-D (BLOCKER): an absent node must NOT be skipped — it could
          // be a deleted workspace symbol that never had `isExternal` set.
          // The conservative rule is: only skip when the node is PRESENT
          // and isExternal===true; absent → probe (let the engine decide).
          //
          // I-8-replay invariant: when canSkipCandidate returns true, the
          // candidate key is recorded in `preFilteredKeys` so it can be
          // excluded from the reconcileDecisions replay set below. Without
          // exclusion, the engine would see locs=[] → NO_NODE → keep/refuse
          // and those outcomes would corrupt confirmed/corrected/recall/refused
          // counts (the candidate was never probed — it must not score).
          //
          // Invariants (I-2c — no false skips):
          //   - Recall candidates (no oldTargetId) → always false.
          //   - oldTargetId present but node is undefined → false
          //     (EP-D: conservative probe; a deleted workspace symbol must
          //     not be silently skipped — probe and let the engine decide).
          //   - oldTargetId present, node found, isExternal===true → true.
          //   - oldTargetId present, node found, isExternal===false → false
          //     (workspace-internal; must probe).
          //   - oldTargetId present, node found, isExternal===undefined
          //     (field absent) → false (conservative; probe).
          //
          // classifyUri is NOT used here — oldTargetId is a graph node id,
          // not a URI. isUnindexablePath is NOT used here — candidate.file
          // is the caller's .java source file, not the callee's location.
          canSkipCandidate: (candidate) => {
            if (!candidate.oldTargetId) {
              // ADR-002 Phase 1 WI-A3: recall candidate — check recallExternalFqnMap
              // before defaulting to probe.  If the FQN was populated by import-processor
              // (via RecallFeedItem.calleeExternalFqn) the callee is provably external and
              // we can skip LSP dispatch entirely.  I-8-replay: record the key so
              // reconcileDecisions excludes this candidate from its replay set.
              // I-2c: absent FQN → return false (conservative probe — never guess).
              const key = candidateLocationKey(candidate);
              const fqn = recallExternalFqnMap.get(key);
              if (fqn) {
                preFilteredKeys.add(key);
                return true;
              }
              return false;
            }
            const node = graph.getNode(candidate.oldTargetId);
            if (node === undefined) {
              // EP-D: node absent — could be a deleted workspace symbol.
              // Conservative: probe so the engine can decide; no false skip.
              return false;
            }
            // Node found: skip only when explicitly marked external.
            // isExternal===undefined (field absent) → false (probe).
            const skip = node.properties.isExternal === true;
            if (skip) {
              // I-8-replay: record the key so reconcileDecisions can skip it.
              preFilteredKeys.add(candidateLocationKey(candidate));
            }
            return skip;
          },
          // WS-B / I-2d: gate-failure discriminator side-channel.
          // pipeline.ts uses this to emit the correct funnel message per
          // reason (not-ready vs no-server vs dispatch-error).
          onGateFailure: (reason, elapsedS) => {
            gateFailureReason = reason;
            gateFailureElapsedS = elapsedS;
          },
        },
      );

      // `sessionResult` is the work fn's return value (or
      // `null` on gate failure). The `meta` is lost on a
      // gate failure, so we defensively default to an empty
      // string for the server version. The `skipped` count
      // is the session's real cap-rejection figure
      // (`feed.length − selected.length`) — we thread it
      // into the engine report so the summary line is
      // truthful.
      // WS-B: read probed/preFilteredExternal from the work-fn payload
      // directly (not via meta) — aligns with the specified return shape
      // {meta, selectedCount, skipped, probed, preFilteredExternal}.
      const serverVersion = sessionResult?.meta?.serverVersion ?? '';
      const sessionSkipped = sessionResult?.skipped ?? 0;
      // WI-5: probed/preFilteredExternal from the session's dispatch
      // loop (or 0 on gate-failure when the session returned null).
      const sessionProbed = sessionResult?.probed ?? 0;
      const sessionPreFiltered = sessionResult?.preFilteredExternal ?? 0;

      // ── Engine decision pass (per-candidate) ────────────────────
      // Replay every candidate through the decision table
      // using the `locations` map the session populated.
      // Candidates the session refused (no Location entry)
      // fall through to the engine as `[]` → NO_NODE →
      // keep/refuse per the decision table.
      let reconcileReport: ReconciliationReport;
      let applyResult: ReturnType<typeof applyDecisions>;
      try {
        // I-8-replay: exclude pre-filtered candidates so they do not
        // re-enter the engine with locs=[] and corrupt count buckets.
        const replayCandidates = preFilteredKeys.size > 0
          ? scopedCandidates.filter(c => !preFilteredKeys.has(candidateLocationKey(c)))
          : scopedCandidates;
        reconcileReport = await reconcileDecisions(
          graph,
          replayCandidates,
          locations,
          {
            mapLocationToNodeId: (loc, repoId) =>
              mapLocationToNodeId(loc, repoId, {
                executeParameterized: inMemoryQuery,
                repoPath,
                resolvedRepoPath,
                // KD-3: thread the adapter's URI classifier so jdt:// and
                // classpath:// URIs returned by jdtls are explicitly refused as
                // external (NO_NODE + external:true) rather than traversing the
                // full DB-query path and returning a plain NO_NODE. For Java repos
                // where 30–50% of CALLS target stdlib/Spring types, this avoids
                // hundreds of avoidable in-memory Cypher queries per run and
                // correctly flags each such refusal as an external one (not a
                // recall-miss) in any downstream metric.
                // Defensive null-guard: lspAdapter is non-null at this code path
                // (the session gate above short-circuits when lspAdapter is null),
                // but an optional-chain is cleaner than an assertion.
                classifyUri: lspAdapter?.classifyUri.bind(lspAdapter),
                // WI-5 (#159 P5): thread the adapter id so the mapper's
                // out-of-repo containment guard can tag Python site-packages
                // / stdlib `file://` URIs as `{ kind: 'NO_NODE', external: true }`
                // rather than bare `NO_NODE`. TS/Java paths omit this field
                // (lspAdapter?.id is 'typescript'/'java') — only 'python'
                // activates the external:true gate.
                adapterId: lspAdapter?.id,
              }),
            repoId: ctx.repoId ?? 'default',
            skipped: sessionSkipped,
          },
        );

        // ── Apply (skip every mutation in dryRun) ───────────────────
        // Roadmap lever 2: pass the per-language recall confidence so weak
        // single-method recall (TS/Python) is stamped below the WILL_BREAK
        // floor. Undefined ⇒ applyDecisions defaults to LSP_RECALL_CONFIDENCE.
        applyResult = applyDecisions(graph, reconcileReport.decisions, {
          dryRun,
          recallConfidence: lspAdapter?.recallConfidence,
        });
      } catch (lspErr) {
        // WI-5 (error path): reconcileDecisions or applyDecisions threw.
        // Emit the funnel line BEFORE rethrowing so the log is preserved
        // for triage. Use 0-sentinels for counters we never reached.
        const lspElapsed = ((Date.now() - lspStart) / 1000).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(buildLspSummaryLine(
          'dispatch-error',
          { confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: sessionSkipped, serverVersion: serverVersion || 'unknown', probed: sessionProbed },
          { N: lspN, B: lspB, elapsedS: lspElapsed },
        ));
        throw lspErr;
      }

      lspReport = {
        decisions: applyResult.decisions,
        confirmed: reconcileReport.confirmed,
        corrected: reconcileReport.corrected,
        recall: reconcileReport.recall,
        refused: reconcileReport.refused,
        skipped: reconcileReport.skipped,
        // WI-5: populated from SessionMeta (set by the dispatch loop).
        probed: sessionProbed,
        preFilteredExternal: sessionPreFiltered,
        // 0-edge diagnostic: mapped-vs-dropped tally from the engine.
        dropReasons: reconcileReport.dropReasons,
        serverVersion,
      };

      // ── Observability: dry-run report vs. summary line ──────────
      if (dryRun) {
        // AC-6: print every {action, from→to, why} tuple, write nothing.
        //
        // Security note: we print a TRUNCATED id (last
        // colon-segment, plus a prefix length cap) so the
        // full repo file paths in node ids never appear
        // verbatim in CI logs. A full id is
        // `Label:src/path/to/file.ts:Name:1` — the file
        // path can include private module names, machine
        // names from monorepos, etc. The truncated form
        // is enough for a human to triage and keeps the
        // log disclosure surface small.
        for (const d of lspReport.decisions) {
          const from = redactNodeId(d.from);
          const to = d.to ? redactNodeId(d.to) : '(none)';
          // m3: strip CR/LF from the formatted line so a
          // node id that happens to contain a control
          // char (theoretical — node ids are sanitized at
          // construction, but defense-in-depth) cannot
          // forge a log line. Same fix the `sanitizeUTF8`
          // helper applies on the file-content side. The
          // regex is applied to the WHOLE line so the
          // structure of the line is preserved.
          // eslint-disable-next-line no-console
          console.log(
            `  lsp-dry-run: ${d.action.padEnd(8)} ${from} -> ${to}  (${d.reason})`
              .replace(/[\r\n]+/g, ' '),
          );
        }
        // eslint-disable-next-line no-console
        console.log(buildLspSummaryLine('dry-run', { ...lspReport, decisionCount: lspReport.decisions.length }, { N: lspN, B: lspB, elapsedS: '' }));
      } else if (sessionResult === null) {
        // WS-B (gate-failure path): session returned null — no work fn ran.
        // Emit per-reason funnel message (I-2d discriminated outcome):
        //   'not-ready'  → 'LSP augmentation skipped: jdtls not ready after Xs'
        //                  NO budget suffix (C5-12 / WS-B spec).
        //   'no-server'  → gate-failure format with budget suffix.
        //   'dispatch-error' → covered by the reconcileDecisions catch above
        //                  (that path calls console.log + rethrows; it never
        //                  reaches this branch).
        //   null (unknown reason) → fall back to gate-failure format.
        if (gateFailureReason === 'not-ready') {
          // C5-12: budget suffix NOT emitted on this path.
          // eslint-disable-next-line no-console
          console.log(`  LSP augmentation skipped: jdtls not ready after ${gateFailureElapsedS}s`);
        } else {
          // 'no-server' or unknown reason → gate-failure format with budget suffix.
          const lspElapsed = gateFailureReason ? gateFailureElapsedS : ((Date.now() - lspStart) / 1000).toFixed(1);
          // eslint-disable-next-line no-console
          // lspReport is null on the gate-failure path (never assigned before this branch).
          // Spreading null yields {} at runtime; pass an explicit zero-sentinel instead so
          // the type contract is sound and a future change to buildLspSummaryLine that reads
          // any numeric field on this path cannot silently produce NaN output.
          console.log(buildLspSummaryLine('gate-failure', { confirmed: 0, corrected: 0, recall: 0, refused: 0, skipped: 0, probed: 0, serverVersion }, { N: lspN, B: lspB, elapsedS: lspElapsed }));
        }
      } else {
        // lspReport is guaranteed non-null on the success path: it is assigned
        // unconditionally before this else-branch is reached (sessionResult !== null
        // and no exception was thrown).  Narrow here so that any future early-return
        // inserted above cannot silently produce a runtime TypeError at the call sites below.
        if (lspReport === null) throw new Error('[pipeline] invariant violation: lspReport is null on success path');
        const lspElapsed = ((Date.now() - lspStart) / 1000).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(buildLspSummaryLine('success', lspReport, { N: lspN, B: lspB, elapsedS: lspElapsed }));
        // A4-I2 / VER-14: residual refused-FQN package histogram.
        // Uses the call-processor version which keys on probed Java recall items
        // that were NOT pre-filtered (calleeExternalFqn absent). This surfaces
        // under-coverage from Lombok, SLF4J, Apache Commons, Guava, etc. — exactly
        // the items that the FQN-based pipeline-internal helper (buildFqnPackageHistogram)
        // cannot reach because those items have no FQN entry in recallExternalFqnMap.
        // ADR-002 Phase 1: emit preFilteredExternal count for observability and E2E
        // test measurement (A4-E1 reads "lsp-prefiltered-external: N" from stdout).
        // Always emitted on the success path so E2E assertions don't need special flags.
        // eslint-disable-next-line no-console
        console.log(`  lsp-prefiltered-external: ${lspReport.preFilteredExternal}`);
        // 0-edge diagnostic: mapped-vs-dropped funnel. Makes a 253s/0-edge run
        // attributable (out-of-repo dominant = path-mapping bug; external dominant
        // = benign; db-miss dominant = index gap; probed≈0 = probe never fired).
        const dr = lspReport.dropReasons;
        if (dr) {
          // eslint-disable-next-line no-console
          console.log(
            `  lsp-map-funnel: mapped=${dr.mapped} no-loc=${dr.noLocation} ambiguous=${dr.ambiguous} ` +
              `external=${dr.external} out-of-repo=${dr.outOfRepo} db-miss=${dr.dbMiss} unmappable=${dr.unmappable}`,
          );
        }
        // Lever 14: persist the definition cache for the next re-index and
        // report hit/miss/store counts. dryRun writes nothing, so skip there.
        const defCache = options?.lsp?.definitionCache;
        if (defCache) {
          defCache.flush();
          const cs = defCache.stats;
          if (cs.hits + cs.misses + cs.stores > 0) {
            // eslint-disable-next-line no-console
            console.log(`  lsp-def-cache: hits=${cs.hits} misses=${cs.misses} stored=${cs.stores}`);
          }
        }
        const histogram = buildRefusedFqnHistogram(recallFeed);
        if (histogram.size > 0) {
          // eslint-disable-next-line no-console
          console.log('  lsp-refused-method:');
          for (const [method, count] of histogram) {
            // eslint-disable-next-line no-console
            // FIX #2 (log injection): method derives from user-controlled Java method names;
            // strip CR/LF to prevent forged log lines. Mirrors the dry-run path guard.
            console.log(`    ${method.replace(/[\r\n]+/g, ' ')}: ${count}`);
          }
        }
      }
    }

    let communityResult: Awaited<ReturnType<typeof processCommunities>> | undefined;
    let processResult: Awaited<ReturnType<typeof processProcesses>> | undefined;

    if (!options?.skipGraphPhases) {
      // ── Phase 4.5: Method Resolution Order ──────────────────────────────
      onProgress({
        phase: 'parsing',
        percent: 81,
        message: 'Computing method resolution order...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      const mroResult = computeMRO(graph);
      if (isDev && mroResult.entries.length > 0) {
        console.log(`🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities found, ${mroResult.overrideEdges} OVERRIDES edges`);
      }

      // ── Phase 5: Communities ───────────────────────────────────────────
      onProgress({
        phase: 'communities',
        percent: 82,
        message: 'Detecting code communities...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      communityResult = await processCommunities(graph, (message, progress) => {
        const communityProgress = 82 + (progress * 0.10);
        onProgress({
          phase: 'communities',
          percent: Math.round(communityProgress),
          message,
          stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
        });
      });

      if (isDev) {
        console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
      }

      communityResult.communities.forEach(comm => {
        graph.addNode({
          id: comm.id,
          label: 'Community' as const,
          properties: {
            name: comm.label,
            filePath: '',
            heuristicLabel: comm.heuristicLabel,
            cohesion: comm.cohesion,
            symbolCount: comm.symbolCount,
          }
        });
      });

      communityResult.memberships.forEach(membership => {
        graph.addRelationship({
          id: `${membership.nodeId}_member_of_${membership.communityId}`,
          type: 'MEMBER_OF',
          sourceId: membership.nodeId,
          targetId: membership.communityId,
          confidence: 1.0,
          reason: 'leiden-algorithm',
          source: 'heuristic',
        });
      });

      // ── Phase 6: Processes ─────────────────────────────────────────────
      onProgress({
        phase: 'processes',
        percent: 94,
        message: 'Detecting execution flows...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      let symbolCount = 0;
      graph.forEachNode(n => { if (n.label !== 'File') symbolCount++; });
      const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

      processResult = await processProcesses(
        graph,
        communityResult.memberships,
        (message, progress) => {
          const processProgress = 94 + (progress * 0.05);
          onProgress({
            phase: 'processes',
            percent: Math.round(processProgress),
            message,
            stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
          });
        },
        { maxProcesses: dynamicMaxProcesses, minSteps: 3 }
      );

      if (isDev) {
        console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
      }

      processResult.processes.forEach(proc => {
        graph.addNode({
          id: proc.id,
          label: 'Process' as const,
          properties: {
            name: proc.label,
            filePath: '',
            heuristicLabel: proc.heuristicLabel,
            processType: proc.processType,
            stepCount: proc.stepCount,
            communities: proc.communities,
            entryPointId: proc.entryPointId,
            terminalId: proc.terminalId,
          }
        });
      });

      processResult.steps.forEach(step => {
        graph.addRelationship({
          id: `${step.nodeId}_step_${step.step}_${step.processId}`,
          type: 'STEP_IN_PROCESS',
          sourceId: step.nodeId,
          targetId: step.processId,
          confidence: 1.0,
          reason: 'trace-detection',
          step: step.step,
          source: 'heuristic',
        });
      });
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      message: communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult, lspReport };
  } catch (error) {
    cleanup();
    throw error;
  }
};

/**
 * ADR-002 Phase 1 WI-A3 — EP-J (build-loop hardening).
 *
 * Build the `recallExternalFqnMap` from a `RecallFeedItem[]` feed.
 *
 * A key is added ONLY when EVERY recall item at that `candidateLocationKey`
 * carries a truthy `calleeExternalFqn`.  If any item at a key is absent/falsy
 * (callee is in-repo or unknown), the key is DELETED from the map so
 * `canSkipCandidate` returns false and both twins are probed — no internal
 * CALLS edge is dropped (I-2c conservative guarantee).
 *
 * This logic mirrors the inline loop in `runPipelineFromRepo` (pipeline.ts
 * ~lines 725-751) and is extracted here so that the EP-J unit tests can
 * exercise the ambiguous-key deletion in isolation, independent of the
 * session machinery.
 *
 * Invariant: if the `ambiguousKeys` delete logic is removed (i.e. the
 * `map.delete(key)` call on the falsy-FQN branch is elided), the test
 * "EP-J divergent-pair: external-first ordering → key ABSENT" will FAIL
 * because the map will retain the first external entry even when a later
 * non-external item shares the same key — producing a false skip (I-2c
 * violation).
 */
export function buildRecallExternalFqnMap(recallFeed: RecallFeedItem[]): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  for (const r of recallFeed) {
    const key = candidateLocationKey({
      sourceId: r.sourceId,
      calledName: r.calledName,
      file: r.file,
      line: r.line,
      character: r.character,
    } as Candidate);
    if (r.calleeExternalFqn) {
      if (!ambiguousKeys.has(key)) {
        map.set(key, r.calleeExternalFqn);
      }
    } else {
      // Absent/falsy FQN: mark key ambiguous and remove any prior external entry.
      ambiguousKeys.add(key);
      map.delete(key);
    }
  }
  return map;
}

/**
 * Redact a graph node id for log lines.
 *
 * Why: a full id is `Label:filePath:name[:overloadIndex]`
 * — the file path can include private module names,
 * monorepo layout, etc. We keep the label and the LAST
 * colon-segment (typically `name[:overloadIndex]`) and
 * abbreviate the dropped middle. The truncated form is
 * enough for a human to triage and keeps the CI log
 * disclosure surface small.
 *
 * Shape compatibility: the `analyze-lsp-mode-a.test.ts`
 * regex is
 * `/^  lsp-dry-run: (confirm|correct|add|keep|refuse)\s+\S+ -> .+?\s+\(.+\)$/`
 * — `\S+` accepts any non-space output, so the truncation
 * shape is compatible.
 */
export function redactNodeId(id: string): string {
  const parts = id.split(':');
  if (parts.length <= 2) return id; // `Label:name` — already short.
  const label = parts[0];
  const tail = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(':');
  const redacted = middle.length > 8 ? `${middle.slice(0, 4)}…${middle.slice(-3)}` : middle;
  return `${label}:${redacted}:${tail}`;
}

/**
 * WI-5: pure formatter for the LSP summary funnel line.
 * Used by `runPipelineFromRepo` on all non-error exit paths, and
 * exported so unit tests can assert the format without running the
 * full pipeline.
 *
 * @param path - which log path: 'success', 'gate-failure', or 'dry-run'
 * @param report - fields from lspReport (may be partial zeroes on gate-failure)
 * @param opts - N (total deduped candidates), B (budget cap), elapsed seconds string,
 *               plus dry-run decision count
 */
export function buildLspSummaryLine(
  path: 'success' | 'gate-failure' | 'dry-run' | 'dispatch-error',
  report: {
    confirmed: number;
    corrected: number;
    recall: number;
    refused: number;
    skipped: number;
    serverVersion: string;
    decisionCount?: number;
    /** probed count (dispatch-error path only) */
    probed?: number;
  },
  opts: { N: number; B: number; elapsedS: string },
): string {
  const budgetSuffix = ` (budget ${opts.B} of ${opts.N} candidates)`;
  const lspS = Math.max(0, opts.N - opts.B);
  if (path === 'dry-run') {
    return `  lsp-dry-run: ${report.decisionCount ?? 0} decision(s), 0 edges written${budgetSuffix}`;
  }
  if (path === 'gate-failure') {
    return (
      `  lsp: P=0 confirmed 0, corrected 0, recall +0, refused 0, ` +
      `skipped(cap) ${lspS}, server <${report.serverVersion || 'unknown'}> (${opts.elapsedS}s)` +
      budgetSuffix
    );
  }
  if (path === 'dispatch-error') {
    // reconcileDecisions or applyDecisions threw; use 0-sentinels for
    // counters we never reached. sessionProbed is threaded via report.probed.
    return (
      `  lsp: dispatch-error P=${report.probed ?? 0} confirmed 0, corrected 0, ` +
      `recall +0, refused 0, ` +
      `skipped(cap) ${report.skipped}, server <${report.serverVersion || 'unknown'}> (${opts.elapsedS}s)` +
      budgetSuffix
    );
  }
  // success path
  return (
    `  lsp: confirmed ${report.confirmed}, corrected ${report.corrected}, ` +
    `recall +${report.recall}, refused ${report.refused}, ` +
    `skipped(cap) ${report.skipped}, server <${report.serverVersion || 'unknown'}> (${opts.elapsedS}s)` +
    budgetSuffix
  );
}

/**
 * Topological sort of files by import dependencies.
 * Files with no imports (in-degree 0) go in level 0.
 * Files that only depend on level 0 go in level 1, etc.
 * Files involved in cycles (no entry point) are grouped in a final level
 * and contribute to cycleCount.
 *
 * @param importMap  Map of file path → set of files it imports
 * @returns levels array (each level is an array of file paths) and cycle count
 */
export function topologicalLevelSort(
  importMap: Map<string, Set<string>>
): { levels: string[][]; cycleCount: number } {
  // in-degree = number of unprocessed dependencies this file has
  // A file can be processed when all its dependencies (imports) are processed
  const inDegree = new Map<string, number>();
  // dependents = files that depend on this file (for notification)
  const dependents = new Map<string, Set<string>>();

  // Collect ALL files: both keys (files with imports) and values (imported files)
  const allFiles = new Set<string>(importMap.keys());
  for (const deps of importMap.values()) {
    for (const dep of deps) {
      allFiles.add(dep);
    }
  }

  // Initialize: all files start with in-degree 0
  for (const file of allFiles) {
    inDegree.set(file, 0);
    dependents.set(file, new Set());
  }

  // Compute in-degrees: for each file, count its dependencies (imports)
  // Build reverse graph: for each imported file, track who imports it
  for (const [file, deps] of importMap) {
    // in-degree is the number of dependencies this file has
    inDegree.set(file, deps.size);
    for (const dep of deps) {
      // dep is imported by file, so file depends on dep
      // When dep is processed, file should be notified
      dependents.get(dep)!.add(file);
    }
  }

  const levels: string[][] = [];
  let cycleCount = 0;

  // Kahn's algorithm: process nodes with in-degree 0 (no remaining dependencies)
  let queue: string[] = [];
  for (const [file, degree] of inDegree) {
    if (degree === 0) queue.push(file);
  }

  while (queue.length > 0) {
    // All nodes in current queue are at the same level
    levels.push([...queue]);
    
    // Process all nodes at current level and collect next level
    const nextQueue: string[] = [];
    for (const file of queue) {
      // Notify all dependents that this dependency is processed
      for (const dependent of dependents.get(file) ?? new Set()) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }
    
    queue = nextQueue;
  }

  // Remaining nodes are in cycles (no entry point found)
  const cycleNodes: string[] = [];
  for (const [file, degree] of inDegree) {
    if (degree > 0) {
      cycleNodes.push(file);
    }
  }

  if (cycleNodes.length > 0) {
    levels.push(cycleNodes);
    cycleCount = cycleNodes.length;
  }

  return { levels, cycleCount };
}
