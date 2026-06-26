/**
 * Integration regression guard: the parallel-parse worker path
 * (GITNEXUS_PARALLEL_PARSE=1 / parallelParse:true, now the DEFAULT) produces
 * a graph BYTE-IDENTICAL to the sequential path (GITNEXUS_PARALLEL_PARSE=0 /
 * parallelParse:false).
 *
 * Bug history (three separate regressions on perf/lsp-analyze-speedup):
 *
 *   1. General-call double-emission
 *      The worker fed general calls into processCallsFromExtracted, causing
 *      +678 false CALLS / −48 ACCESSES edges vs sequential.
 *      Fixed: separate Angular calls into result.angularCalls; only those flow
 *      into the Angular-call processor. General calls re-extracted sequentially.
 *
 *   2. Route channel misdirection
 *      The worker pushed FastAPI / Gin / Angular routes to result.routes
 *      (Spring-route bucket, later skipped because no controllerName/methodName)
 *      instead of result.decoratorRoutes.  Sequential path extracted them
 *      correctly → snapshot divergence on HANDLES_ROUTE edges.
 *      Fixed: worker places framework routes in result.decoratorRoutes.
 *
 *   3. Worker Property nodes lacked declaredType
 *      Property nodes emitted by the worker had no declaredType field →
 *      this.field read-ACCESSES disappeared + chained-call receiver resolution
 *      fell back to unresolved.
 *      Fixed: worker applies the same field-extractor registry as the
 *      sequential parsing-processor path.
 *
 *   4. Process-detection insertion-order sensitivity
 *      findEntryPoints tied-score sort, buildCallsGraph callee order,
 *      deduplicateTraces / deduplicateByEndpoints / limitedTraces sorts were
 *      not total-order → STEP_IN_PROCESS edge renumbering between the two paths
 *      (phantom detect_changes diffs, ~180 churned edges per run).
 *      Fixed: all sorts use length-desc + full-path-lexicographic tiebreak.
 *
 * Test strategy:
 *   - Generate a synthetic multi-language fixture whose TOTAL PARSEABLE BYTES
 *     exceed MIN_BYTES_FOR_WORKERS=512KB so the worker pool actually spawns.
 *     The fixture deliberately includes:
 *       • 10 TypeScript service files with typed class fields (covers Bug 3)
 *       • A FastAPI Python route file  (covers Bug 2 route-channel path)
 *       • A Gin Go route file          (covers Bug 2 route-channel path)
 *       • 3+ hop method call chains    (covers Bug 4 process-detection)
 *   - Assert the pool ACTUALLY SPAWNED by spying on console.warn for the
 *     "Parallel parse unavailable, falling back to sequential" message.
 *     If that warning fires, the test FAILS — not skips — with an instruction
 *     to run `npm run build`.
 *   - Run the full pipeline once with parallelParse:false (sequential) and
 *     once with parallelParse:true (parallel). Snapshot ALL relationships
 *     sorted by id and assert byte-equality.
 *   - Additional targeted assertions for STEP_IN_PROCESS and MEMBER_OF so a
 *     process-detection regression produces a named failure, not just "snapshots differ".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';

import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

// ── Fixture content ───────────────────────────────────────────────────────────

/**
 * FastAPI route file. Exercises the route-channel fix (Bug 2):
 * routes emitted by the worker must land in result.decoratorRoutes,
 * not result.routes (Spring bucket).
 */
const FASTAPI_CONTENT = `"""FastAPI route fixture for parallel-parity integration test.

Exercises Bug 2 (route-channel): these routes must appear in both
sequential and parallel snapshots — if the worker misdirects them
to the Spring-route bucket they are silently dropped in the parallel path.
"""
from fastapi import FastAPI, APIRouter

app = FastAPI()
router = APIRouter()


@app.get("/items")
async def list_items():
    """Return all items."""
    return []


@app.post("/items")
async def create_item(name: str, price: float):
    """Create and persist a new item."""
    validated = validate_item(name, price)
    return save_item(validated)


@app.put("/items/{item_id}")
async def update_item(item_id: int, name: str):
    """Update an existing item."""
    return {"id": item_id, "name": name}


@app.delete("/items/{item_id}")
async def delete_item(item_id: int):
    """Remove an item by id."""
    return {"deleted": item_id}


@router.get("/orders")
async def list_orders():
    """Return all orders."""
    return []


@router.post("/orders")
async def create_order(item_id: int, quantity: int):
    """Place a new order."""
    return {"item_id": item_id, "quantity": quantity}


def validate_item(name: str, price: float) -> dict:
    """Validate item fields before persistence."""
    if price <= 0:
        raise ValueError("price must be positive")
    return {"name": name.strip(), "price": price}


def save_item(item: dict) -> dict:
    """Persist item to the database."""
    return {**item, "id": 1}
`;

/**
 * Gin route file. Exercises the route-channel fix (Bug 2) for Go.
 */
const GIN_CONTENT = `package main

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// Item is a data model for the inventory.
type Item struct {
	ID    int     \`json:"id"\`
	Name  string  \`json:"name"\`
	Price float64 \`json:"price"\`
}

func main() {
	r := gin.Default()
	r.GET("/items", listItems)
	r.POST("/items", createItem)
	r.PUT("/items/:id", updateItem)
	r.DELETE("/items/:id", deleteItem)
	r.GET("/categories", listCategories)
	r.POST("/categories", createCategory)
	r.Run(":8080")
}

func listItems(c *gin.Context) {
	items := fetchAllItems()
	enriched := enrichItems(items)
	c.JSON(http.StatusOK, enriched)
}

func createItem(c *gin.Context) {
	var item Item
	if err := c.ShouldBindJSON(&item); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	saved := persistItem(item)
	c.JSON(http.StatusCreated, saved)
}

func updateItem(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var item Item
	c.ShouldBindJSON(&item)
	item.ID = id
	updated := persistItem(item)
	c.JSON(http.StatusOK, updated)
}

func deleteItem(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	removeItem(id)
	c.JSON(http.StatusNoContent, nil)
}

func listCategories(c *gin.Context) {
	cats := fetchCategories()
	c.JSON(http.StatusOK, cats)
}

func createCategory(c *gin.Context) {
	var cat map[string]string
	c.ShouldBindJSON(&cat)
	result := persistCategory(cat)
	c.JSON(http.StatusCreated, result)
}

func fetchAllItems() []Item                         { return nil }
func enrichItems(items []Item) []Item               { return items }
func persistItem(item Item) Item                    { return item }
func removeItem(_ int)                              {}
func fetchCategories() []string                     { return nil }
func persistCategory(cat map[string]string) map[string]string { return cat }
`;

/**
 * Generate a TypeScript service file with:
 *   - 12 exported interfaces (broad symbol surface)
 *   - Typed class fields (exercises Bug 3 / declaredType fix)
 *   - 25 handleX/fetchX/queryX/formatX method groups forming 3-hop call chains
 *     (exercises Bug 4 / process-detection)
 *   - 10 standalone exported functions
 *
 * Target size: ~35-45 KB per file.  10 files × 40 KB ≈ 400 KB combined
 * TypeScript parseable bytes.  With the Python and Go files the fixture
 * comfortably exceeds the MIN_BYTES_FOR_WORKERS = 512 KB gate.
 *
 * NOTE: if the total-bytes assertion in beforeAll fails, increase
 * NUM_METHOD_GROUPS below or add more service files.
 */
function generateServiceFile(serviceName: string): string {
  const NUM_INTERFACES = 12;
  const NUM_TYPE_ALIASES = 4;
  const NUM_METHOD_GROUPS = 25; // each group = 4 methods ≈ 40 lines
  const NUM_STANDALONE_FUNCTIONS = 10;

  const L: string[] = [];

  L.push(`/**`);
  L.push(` * ${serviceName} — auto-generated fixture for parallel-parity integration test.`);
  L.push(` *`);
  L.push(` * DO NOT EDIT — this file is produced by generateServiceFile() in`);
  L.push(` * test/integration/parallel-parity.test.ts and is regenerated on each test run.`);
  L.push(` */`);
  L.push(``);

  // Imports (give the file realistic import structure)
  L.push(`import type { Logger } from '../utils/logger';`);
  L.push(`import type { Database } from '../utils/database';`);
  L.push(`import type { Cache } from '../utils/cache';`);
  L.push(`import type { EventEmitter } from '../utils/events';`);
  L.push(``);

  // Interfaces
  for (let i = 0; i < NUM_INTERFACES; i++) {
    L.push(`/** ${serviceName} data transfer object ${i} */`);
    L.push(`export interface ${serviceName}Dto${i} {`);
    L.push(`  id: string;`);
    L.push(`  name: string;`);
    L.push(`  code: string;`);
    L.push(`  description: string;`);
    L.push(`  status: 'active' | 'inactive' | 'pending' | 'archived';`);
    L.push(`  priority: number;`);
    L.push(`  createdAt: Date;`);
    L.push(`  updatedAt: Date;`);
    L.push(`  createdBy: string;`);
    L.push(`  metadata: Record<string, unknown>;`);
    L.push(`  tags: string[];`);
    L.push(`  version: number;`);
    L.push(`}`);
    L.push(``);
  }

  // Type aliases
  for (let i = 0; i < NUM_TYPE_ALIASES; i++) {
    L.push(`export type ${serviceName}Result${i} = {`);
    L.push(`  success: boolean;`);
    L.push(`  data: ${serviceName}Dto0 | null;`);
    L.push(`  errors: string[];`);
    L.push(`  warnings: string[];`);
    L.push(`  timestamp: number;`);
    L.push(`  requestId: string;`);
    L.push(`};`);
    L.push(``);
  }

  // Main service class — typed fields exercise the declaredType fix (Bug 3).
  // The sequential path emits declaredType for each class property.
  // The parallel (worker) path must also emit declaredType so that
  // `this.cache.get(...)` resolves as a Cache.get() call in both paths.
  L.push(`/** ${serviceName} — manages the full lifecycle of ${serviceName} entities. */`);
  L.push(`export class ${serviceName} {`);
  L.push(`  /** @type {Logger} Logger instance — used to verify declaredType parity (Bug 3) */`);
  L.push(`  private readonly logger: Logger;`);
  L.push(`  /** @type {Database} Primary database connection */`);
  L.push(`  private readonly database: Database;`);
  L.push(`  /** @type {Cache<string, ${serviceName}Dto0>} Read-through cache */`);
  L.push(`  private readonly cache: Cache<string, ${serviceName}Dto0>;`);
  L.push(`  /** @type {EventEmitter} Domain-event bus */`);
  L.push(`  private readonly events: EventEmitter;`);
  L.push(`  /** @type {Map<string, ${serviceName}Dto0>} In-flight items keyed by id */`);
  L.push(`  private readonly pendingMap: Map<string, ${serviceName}Dto0>;`);
  L.push(`  /** @type {Set<string>} Ids currently locked for mutation */`);
  L.push(`  private readonly lockedIds: Set<string>;`);
  L.push(`  /** @type {${serviceName}Dto0 | null} Currently authenticated entity context */`);
  L.push(`  private currentContext: ${serviceName}Dto0 | null = null;`);
  L.push(`  /** @type {number} Configured page size for pagination */`);
  L.push(`  private readonly pageSize: number = 50;`);
  L.push(``);
  L.push(`  constructor(`);
  L.push(`    logger: Logger,`);
  L.push(`    database: Database,`);
  L.push(`    cache: Cache<string, ${serviceName}Dto0>,`);
  L.push(`    events: EventEmitter,`);
  L.push(`  ) {`);
  L.push(`    this.logger = logger;`);
  L.push(`    this.database = database;`);
  L.push(`    this.cache = cache;`);
  L.push(`    this.events = events;`);
  L.push(`    this.pendingMap = new Map();`);
  L.push(`    this.lockedIds = new Set();`);
  L.push(`  }`);
  L.push(``);

  // Method groups (25 groups × 4 methods × ~10 lines = ~1000 lines)
  // Each group: handle*(id) → fetch*(id) → query*(id) → format*()
  // This creates the 3-hop call chain that process detection traces.
  for (let i = 0; i < NUM_METHOD_GROUPS; i++) {
    const S = `Record${i}`;

    // Entry-point method (handle*): name matches ^handle[A-Z] → high entry-point score
    L.push(`  /**`);
    L.push(`   * Handle ${S} lifecycle request — entry point for the ${S} flow.`);
    L.push(`   * Calls fetch${S} which calls query${S} (3-hop chain for process detection).`);
    L.push(`   * @param id — entity identifier`);
    L.push(`   * @param opts — optional processing hints`);
    L.push(`   */`);
    L.push(`  handle${S}(id: string, opts: Record<string, unknown> = {}): ${serviceName}Result0 {`);
    L.push(`    this.logger.info(\`[${serviceName}] handle${S} id=\${id}\`);`);
    L.push(`    if (this.lockedIds.has(id)) {`);
    L.push(`      return { success: false, data: null, errors: ['locked'], warnings: [], timestamp: Date.now(), requestId: id };`);
    L.push(`    }`);
    L.push(`    const raw = this.fetch${S}(id);`);
    L.push(`    if (!raw) {`);
    L.push(`      return { success: false, data: null, errors: ['not_found'], warnings: [], timestamp: Date.now(), requestId: id };`);
    L.push(`    }`);
    L.push(`    const formatted = this.format${S}(raw);`);
    L.push(`    this.events.emit(\`${serviceName.toLowerCase()}.${S.toLowerCase()}.handled\`, formatted);`);
    L.push(`    return { success: true, data: formatted, errors: [], warnings: [], timestamp: Date.now(), requestId: id };`);
    L.push(`  }`);
    L.push(``);

    // Fetch method: calls query* and populates cache
    L.push(`  /**`);
    L.push(`   * Fetch ${S} by id — checks cache then delegates to query${S}.`);
    L.push(`   */`);
    L.push(`  private fetch${S}(id: string): ${serviceName}Dto0 | null {`);
    L.push(`    const hit = this.cache.get(id);`);
    L.push(`    if (hit) return hit;`);
    L.push(`    const record = this.query${S}(id);`);
    L.push(`    if (record) {`);
    L.push(`      this.cache.set(id, record);`);
    L.push(`      this.pendingMap.set(id, record);`);
    L.push(`    }`);
    L.push(`    return record;`);
    L.push(`  }`);
    L.push(``);

    // Query method: terminal step (hits database, no further service calls)
    L.push(`  /**`);
    L.push(`   * Query ${S} from the database — terminal step in the ${S} flow.`);
    L.push(`   */`);
    L.push(`  private query${S}(id: string): ${serviceName}Dto0 | null {`);
    L.push(`    return this.database.findById<${serviceName}Dto0>('${serviceName.toLowerCase()}_${i}', id) ?? null;`);
    L.push(`  }`);
    L.push(``);

    // Format method: data transformation, no further service calls
    L.push(`  /**`);
    L.push(`   * Apply output formatting and normalization for ${S}.`);
    L.push(`   */`);
    L.push(`  private format${S}(dto: ${serviceName}Dto0): ${serviceName}Dto0 {`);
    L.push(`    return {`);
    L.push(`      ...dto,`);
    L.push(`      name: dto.name.trim(),`);
    L.push(`      description: dto.description.trim(),`);
    L.push(`      updatedAt: new Date(),`);
    L.push(`      version: dto.version + 1,`);
    L.push(`    };`);
    L.push(`  }`);
    L.push(``);
  }

  L.push(`}`);
  L.push(``);

  // Standalone exported functions (add to symbol surface, exercise process detection)
  for (let i = 0; i < NUM_STANDALONE_FUNCTIONS; i++) {
    L.push(`/**`);
    L.push(` * Process a batch of ${serviceName} entities — standalone utility #${i}.`);
    L.push(` * Exported for cross-file use (isExported=true → higher entry-point score).`);
    L.push(` */`);
    L.push(`export function process${serviceName}Batch${i}(`);
    L.push(`  items: ${serviceName}Dto0[],`);
    L.push(`  opts: { limit?: number; sortKey?: keyof ${serviceName}Dto0 } = {},`);
    L.push(`): ${serviceName}Dto0[] {`);
    L.push(`  const { limit = 100, sortKey = 'id' } = opts;`);
    L.push(`  const sorted = [...items].sort((a, b) => {`);
    L.push(`    const av = String(a[sortKey] ?? '');`);
    L.push(`    const bv = String(b[sortKey] ?? '');`);
    L.push(`    return av < bv ? -1 : av > bv ? 1 : 0;`);
    L.push(`  });`);
    L.push(`  return sorted.slice(0, limit);`);
    L.push(`}`);
    L.push(``);
  }

  return L.join('\n');
}

// ── Snapshot helper (mirrors mode-a-golden.test.ts) ──────────────────────────

/**
 * Produce a stable, sorted JSON string for all relationships in `graph`.
 * Sorted by id so the comparison is order-independent.
 * Includes step and source so STEP_IN_PROCESS regressions are visible.
 */
function snapshotRels(graph: KnowledgeGraph): string {
  const rels = [...graph.iterRelationships()].map(r => ({
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    confidence: r.confidence,
    reason: r.reason,
    step: r.step ?? null,
    source: r.source ?? null,
  }));
  rels.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(rels, null, 2);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DIST_WORKER = path.resolve(
  __dirname, '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js',
);

/**
 * The pipeline emits this warning when it intended to use workers (total
 * parseable bytes > 512KB) but could NOT spawn them — e.g. because dist/ is
 * missing or stale.  If we detect this warning in the parallel run, both
 * pipeline runs went sequential and the "parity" snapshot comparison would be
 * a false-green tautology.
 */
const FALLBACK_WARN_PATTERN = /Parallel parse unavailable, falling back to sequential/;

/**
 * 10 TypeScript service class names — enough files to comfortably exceed
 * the MIN_BYTES_FOR_WORKERS = 512 KB gate when combined with the route files.
 */
const SERVICE_NAMES = [
  'UserService',
  'OrderService',
  'ProductService',
  'PaymentService',
  'NotificationService',
  'AuthService',
  'AuditService',
  'CacheService',
  'EmailService',
  'ReportService',
];

// ── Test state ────────────────────────────────────────────────────────────────

let fixtureDir = '';
let seqSnapshot = '';
let parSnapshot = '';
let parallelFallbackWarns: string[] = [];

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeAll(async () => {
  // ── 1. Gate: dist worker must exist ───────────────────────────────────────
  //
  // The parallel parse path spawns a Worker thread from dist/.  If dist/ is
  // missing the pool silently falls back to sequential (with a console.warn).
  // We assert its existence BEFORE generating the fixture so the error message
  // is clear and actionable.
  expect(
    fs.existsSync(DIST_WORKER),
    `dist/core/ingestion/workers/parse-worker.js not found.\n` +
    `The parallel-parse integration test requires a compiled worker script.\n` +
    `Fix: cd gitnexus && npm run build`,
  ).toBe(true);

  // ── 2. Generate fixture in a temporary directory ──────────────────────────
  fixtureDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'gitnexus-parallel-parity-'),
  );

  const apiDir = path.join(fixtureDir, 'src', 'api');
  const svcDir = path.join(fixtureDir, 'src', 'services');
  await fsPromises.mkdir(apiDir, { recursive: true });
  await fsPromises.mkdir(svcDir, { recursive: true });

  // Route files — exercises route-channel fix (Bug 2)
  await fsPromises.writeFile(path.join(apiDir, 'routes.py'), FASTAPI_CONTENT, 'utf-8');
  await fsPromises.writeFile(path.join(apiDir, 'gin_routes.go'), GIN_CONTENT, 'utf-8');

  // TypeScript service files — exercises declaredType (Bug 3) + process detection (Bug 4)
  for (const svcName of SERVICE_NAMES) {
    await fsPromises.writeFile(
      path.join(svcDir, `${svcName.toLowerCase()}.ts`),
      generateServiceFile(svcName),
      'utf-8',
    );
  }

  // ── 3. Gate: fixture must trip the worker-pool byte threshold ────────────
  //
  // If total parseable bytes ≤ 512 KB both pipeline runs go sequential and
  // the parity test is a false-green tautology.  Fail with an actionable hint
  // rather than silently passing.
  let totalBytes = FASTAPI_CONTENT.length + GIN_CONTENT.length;
  const tsFiles = await fsPromises.readdir(svcDir);
  for (const f of tsFiles) {
    const stat = await fsPromises.stat(path.join(svcDir, f));
    totalBytes += stat.size;
  }

  expect(
    totalBytes,
    `Fixture total parseable bytes (${totalBytes}) must exceed 512 KB ` +
    `(MIN_BYTES_FOR_WORKERS=${512 * 1024}) so the worker pool actually spawns.\n` +
    `Increase NUM_METHOD_GROUPS in generateServiceFile() or add more SERVICE_NAMES.`,
  ).toBeGreaterThan(512 * 1024);

  // ── 4. Sequential run ─────────────────────────────────────────────────────
  const seqResult = await runPipelineFromRepo(fixtureDir, () => {}, {
    parallelParse: false,
  });
  seqSnapshot = snapshotRels(seqResult.graph);

  // ── 5. Parallel run — capture console.warn to detect pool fallback ────────
  //
  // The spy is scoped to the parallel run only so sequential-path warnings
  // (if any) don't pollute the fallback check.
  const warnSpy = vi.spyOn(console, 'warn');
  const parResult = await runPipelineFromRepo(fixtureDir, () => {}, {
    parallelParse: true,
  });
  parallelFallbackWarns = warnSpy.mock.calls
    .map(args => String(args[0]))
    .filter(msg => FALLBACK_WARN_PATTERN.test(msg));
  vi.restoreAllMocks();

  parSnapshot = snapshotRels(parResult.graph);
}, 300_000); // 5-minute budget for two full pipeline runs

afterAll(async () => {
  vi.restoreAllMocks();
  if (fixtureDir) {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parallel-parse parity (GITNEXUS_PARALLEL_PARSE=1 vs =0)', () => {
  // ── Pool-spawn gate (must pass before parity tests are meaningful) ─────────

  it('worker pool actually spawned during parallel run (no silent sequential fallback)', () => {
    // If the fallback warning fires, both runs went sequential and the parity
    // snapshot comparison below would be a false-green tautology.
    expect(
      parallelFallbackWarns,
      `Worker pool fell back to sequential during the parallel run.\n` +
      `Ensure dist/ is built: cd gitnexus && npm run build\n` +
      `Fallback message(s): ${parallelFallbackWarns.join('; ')}`,
    ).toHaveLength(0);
  });

  // ── Primary parity assertion ───────────────────────────────────────────────

  it('parallel and sequential pipeline runs produce byte-identical relationship snapshots', () => {
    // This is the master assertion. It covers ALL edge types (CALLS, CONTAINS,
    // IMPORTS, HAS_METHOD, HAS_PROPERTY, MEMBER_OF, STEP_IN_PROCESS,
    // HANDLES_ROUTE, …). A regression in ANY of the four bug areas will cause
    // a diff here.
    expect(parSnapshot).toBe(seqSnapshot);
  });

  // ── Targeted assertions (give named failures when parity breaks) ───────────

  it('(Bug 4) STEP_IN_PROCESS edges are byte-identical between paths', () => {
    // Process-detection insertion-order bugs produce different proc_<idx>
    // numbering → different STEP_IN_PROCESS edge ids and step numbers.
    const seqRels: Array<Record<string, unknown>> = JSON.parse(seqSnapshot);
    const parRels: Array<Record<string, unknown>> = JSON.parse(parSnapshot);

    const seqStep = seqRels.filter(r => r['type'] === 'STEP_IN_PROCESS');
    const parStep = parRels.filter(r => r['type'] === 'STEP_IN_PROCESS');

    // There must be at least one STEP_IN_PROCESS edge (fixture has 3-hop chains)
    expect(seqStep.length).toBeGreaterThan(0);
    expect(parStep).toEqual(seqStep);
  });

  it('(Bug 4) MEMBER_OF edges are byte-identical between paths', () => {
    // Community-detection produces MEMBER_OF edges. If insertion order affects
    // community assignment, MEMBER_OF edges diverge between paths.
    const seqRels: Array<Record<string, unknown>> = JSON.parse(seqSnapshot);
    const parRels: Array<Record<string, unknown>> = JSON.parse(parSnapshot);

    const seqMember = seqRels.filter(r => r['type'] === 'MEMBER_OF');
    const parMember = parRels.filter(r => r['type'] === 'MEMBER_OF');

    expect(seqMember.length).toBeGreaterThan(0);
    expect(parMember).toEqual(seqMember);
  });

  it('(Bug 2) HANDLES_ROUTE edges from FastAPI and Gin files are present in both paths', () => {
    // Route-channel bug: if the worker misdirects FastAPI/Gin routes to the
    // Spring bucket (result.routes) instead of result.decoratorRoutes, the
    // parallel path produces no HANDLES_ROUTE edges from route files while
    // the sequential path re-extracts them correctly → snapshot divergence.
    //
    // This assertion confirms the fixture exercises the route-channel path
    // and that routes are non-zero in both snapshots. The byte-identical
    // assertion above catches any count/content divergence.
    const seqRels: Array<Record<string, unknown>> = JSON.parse(seqSnapshot);
    const parRels: Array<Record<string, unknown>> = JSON.parse(parSnapshot);

    const seqRoutes = seqRels.filter(r => r['type'] === 'HANDLES_ROUTE');
    const parRoutes = parRels.filter(r => r['type'] === 'HANDLES_ROUTE');

    expect(seqRoutes.length).toBeGreaterThan(0);
    expect(parRoutes.length).toBeGreaterThan(0);
    expect(parRoutes).toEqual(seqRoutes);
  });

  it('(Bug 3) CALLS edge counts are non-zero and identical (declaredType chained-call fix)', () => {
    // The declaredType fix ensures that this.field receiver-type resolution
    // works in the worker path. Without it, chained calls via typed fields
    // (e.g. this.cache.get()) fail to resolve → fewer CALLS edges in the
    // parallel path than in the sequential path.
    const seqRels: Array<Record<string, unknown>> = JSON.parse(seqSnapshot);
    const parRels: Array<Record<string, unknown>> = JSON.parse(parSnapshot);

    const seqCalls = seqRels.filter(r => r['type'] === 'CALLS');
    const parCalls = parRels.filter(r => r['type'] === 'CALLS');

    expect(seqCalls.length).toBeGreaterThan(0);
    expect(parCalls.length).toBe(seqCalls.length);
  });
});
