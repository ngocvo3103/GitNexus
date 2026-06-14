/**
 * Unit Tests: csv-generator — relationship row + source column (WI-1, #159 P3 Mode A)
 * and position columns (sourceLine / sourceCol, #174).
 *
 * Verifies the serializer-side default for the 7th `source` column and
 * the 8th/9th `sourceLine`/`sourceCol` columns on CodeRelation. The header
 * MUST be 9-wide and every row MUST emit a non-NULL `source` value
 * (default 'heuristic'). When `line`/`column` are present they serialize
 * as plain integers; when absent they serialize as `""` (quoted empty) so
 * Kùzu reads the cell as NULL for INT64 — a bare empty field (,,) causes
 * Kùzu to count only 8 values for a 9-col header and reject the row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';

let tmpHandle: TestDBHandle;
let csvDir: string;
let repoDir: string;

beforeAll(async () => {
  tmpHandle = await createTempDir('csv-generator-wi1-');
  csvDir = path.join(tmpHandle.dbPath, 'csv');
  repoDir = path.join(tmpHandle.dbPath, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'a.ts'), 'export function alpha() { return 1; }');
  await fs.writeFile(path.join(repoDir, 'src', 'b.ts'), 'export function beta() { return 2; }');
});

afterAll(async () => {
  try { await tmpHandle.cleanup(); } catch { /* best-effort */ }
});

describe('streamAllCSVsToDisk — relations.csv source + position columns (WI-1, #174)', () => {
  it('emits a 9-column header: from,to,type,confidence,reason,step,source,sourceLine,sourceCol', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        { sourceId: 'func:alpha', targetId: 'func:beta', type: 'CALLS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines[0]).toBe('from,to,type,confidence,reason,step,source,sourceLine,sourceCol');
  });

  it('defaults the 7th field to "heuristic" when GraphRelationship.source is omitted', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        // No `source` field on the test rel — buildTestGraph passes through
        // whatever is on the input, so the underlying GraphRelationship
        // has no `source` property. The serializer must default to 'heuristic'.
        { sourceId: 'func:alpha', targetId: 'func:beta', type: 'CALLS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);
    // Row layout: "from","to","type",confidence,"reason",step,"source",sourceLine,sourceCol
    const dataCols = lines[1].split(',');
    expect(dataCols).toHaveLength(9);
    expect(dataCols[6]).toBe('"heuristic"');
    // No line/col on the rel → quoted-empty (NULL sentinel for Kùzu INT64)
    expect(dataCols[7]).toBe('""');
    expect(dataCols[8]).toBe('""');
  });

  it('carries the explicit source value when GraphRelationship.source is set', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );

    // Add the rel manually so we can set `source` on it (buildTestGraph's
    // helper does not pass through the new optional field).
    graph.addRelationship({
      id: 'func:alpha-CALLS-func:beta',
      sourceId: 'func:alpha',
      targetId: 'func:beta',
      type: 'CALLS',
      confidence: 0.7,
      reason: '',
      source: 'lsp-corrected',
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    const dataCols = lines[1].split(',');
    expect(dataCols).toHaveLength(9);
    expect(dataCols[6]).toBe('"lsp-corrected"');
    // No line/col → quoted-empty
    expect(dataCols[7]).toBe('""');
    expect(dataCols[8]).toBe('""');
  });

  it('every rel row has exactly 9 fields (no truncation, no extra)', async () => {
    // Build a graph with 3 rels of varying source settings.
    const graph = buildTestGraph(
      [
        { id: 'file:a', label: 'File', name: 'a', filePath: 'a' },
        { id: 'file:b', label: 'File', name: 'b', filePath: 'b' },
        { id: 'file:c', label: 'File', name: 'c', filePath: 'c' },
        { id: 'func:x', label: 'Function', name: 'x', filePath: 'a', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:y', label: 'Function', name: 'y', filePath: 'b', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:z', label: 'Function', name: 'z', filePath: 'c', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );
    graph.addRelationship({ id: 'r1', sourceId: 'func:x', targetId: 'func:y', type: 'CALLS', confidence: 0.5, reason: '', step: 0 });
    graph.addRelationship({ id: 'r2', sourceId: 'func:y', targetId: 'func:z', type: 'CALLS', confidence: 0.7, reason: 'x', step: 1, source: 'lsp-confirmed' });
    graph.addRelationship({ id: 'r3', sourceId: 'func:z', targetId: 'func:x', type: 'CALLS', confidence: 0.7, reason: 'y', step: 2, source: 'lsp-recall' });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(4); // header + 3 rows
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      expect(cols).toHaveLength(9);
    }
    // Sanity: the explicit-source rows carry the value, the default-source
    // row carries "heuristic".
    expect(lines[1].split(',')[6]).toBe('"heuristic"');
    expect(lines[2].split(',')[6]).toBe('"lsp-confirmed"');
    expect(lines[3].split(',')[6]).toBe('"lsp-recall"');
    // All rows without line/col emit quoted-empty
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      expect(cols[7]).toBe('""');
      expect(cols[8]).toBe('""');
    }
  });

  it('positioned row: line and column serialize as plain integers (#174)', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );

    graph.addRelationship({
      id: 'r-positioned',
      sourceId: 'func:alpha',
      targetId: 'func:beta',
      type: 'CALLS',
      confidence: 1.0,
      reason: '',
      source: 'lsp-confirmed',
      line: 42,
      column: 7,
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const cols = lines[1].split(',');
    expect(cols).toHaveLength(9);
    expect(cols[7]).toBe('42');  // sourceLine — plain integer, not quoted
    expect(cols[8]).toBe('7');   // sourceCol  — plain integer, not quoted
  });

  it('mixed batch: positioned + unpositioned rows both yield correct 9-col output (#174)', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'file:src/c.ts', label: 'File', name: 'c.ts', filePath: 'src/c.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta',  label: 'Function', name: 'beta',  filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:gamma', label: 'Function', name: 'gamma', filePath: 'src/c.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );

    // Positioned edge
    graph.addRelationship({
      id: 'r-pos',
      sourceId: 'func:alpha',
      targetId: 'func:beta',
      type: 'CALLS',
      confidence: 1.0,
      reason: '',
      line: 10,
      column: 3,
    });
    // Unpositioned edge (no line/column)
    graph.addRelationship({
      id: 'r-unpos',
      sourceId: 'func:beta',
      targetId: 'func:gamma',
      type: 'CALLS',
      confidence: 0.5,
      reason: '',
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows

    const posRow   = lines[1].split(',');
    const unposRow = lines[2].split(',');

    // Both rows must be 9 columns — Kùzu rejects any row with fewer/more.
    expect(posRow).toHaveLength(9);
    expect(unposRow).toHaveLength(9);

    // Positioned: integer values
    expect(posRow[7]).toBe('10');
    expect(posRow[8]).toBe('3');

    // Unpositioned: quoted empty → NULL in Kùzu INT64
    expect(unposRow[7]).toBe('""');
    expect(unposRow[8]).toBe('""');
  });
});
