/**
 * Unit Tests: sourceLine / sourceCol CSV serialization (#174)
 *
 * Verifies that:
 *   a) The rel CSV header includes `sourceLine` and `sourceCol` as the 8th/9th columns.
 *   b) A `GraphRelationship` with `line` and `column` set produces a CSV row
 *      that carries the integer values in the correct column positions.
 *   c) A `GraphRelationship` WITHOUT `line`/`column` produces empty strings
 *      (so Kùzu reads them as NULL).
 *   d) The byte-for-byte header matches what `lbug-adapter` expects from the
 *      COPY query (HEADER=true binds by name — `sourceLine`, `sourceCol`).
 *
 * These are pure-unit tests: no DB, no LSP, no file I/O beyond what
 * `streamAllCSVsToDisk` requires internally (it writes to a tmpdir).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { streamAllCSVsToDisk } from '../../../src/core/lbug/csv-generator.js';
import { buildTestGraph } from '../../helpers/test-graph.js';

// ─── helpers ──────────────────────────────────────────────────────────

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pos-csv-'));
});
afterAll(async () => {
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Run `streamAllCSVsToDisk` on `graph` and return the raw text of
 * the generated relations.csv. Uses a unique sub-dir per call so
 * parallel tests don't collide.
 */
async function generateRelCSV(graph: ReturnType<typeof buildTestGraph>, tag: string): Promise<string> {
  const csvDir = path.join(tmpDir, tag);
  await fs.mkdir(csvDir, { recursive: true });
  const result = await streamAllCSVsToDisk(graph, '/test', csvDir);
  return fs.readFile(result.relCsvPath, 'utf8');
}

// ─── tests ────────────────────────────────────────────────────────────

describe('position columns CSV serialization (#174)', () => {
  describe('header', () => {
    it('relations.csv header includes sourceLine and sourceCol as 8th/9th columns', async () => {
      const graph = buildTestGraph(
        [{ id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' }],
        [],
      );
      const csv = await generateRelCSV(graph, 'header-check');
      const [header] = csv.split('\n');
      const cols = header.split(',');
      // Byte-for-byte match — lbug-adapter COPY binds by these exact names.
      expect(cols[7]).toBe('sourceLine');
      expect(cols[8]).toBe('sourceCol');
    });

    it('header byte-for-byte matches the COPY binding names', async () => {
      const graph = buildTestGraph(
        [{ id: 'File:x.ts', label: 'File', name: 'x.ts', filePath: 'x.ts' }],
        [],
      );
      const csv = await generateRelCSV(graph, 'header-binding');
      const [header] = csv.split('\n');
      // Full header assertion — if a column is renamed, both the serializer
      // and the COPY query must be updated together.
      expect(header).toBe('from,to,type,confidence,reason,step,source,sourceLine,sourceCol');
    });
  });

  describe('row with line + column set', () => {
    it('serializes line and column as plain integers in the 8th/9th CSV cells', async () => {
      const graph = buildTestGraph(
        [
          { id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' },
          { id: 'File:b.ts', label: 'File', name: 'b.ts', filePath: 'b.ts' },
          { id: 'Function:a.ts:foo:1', label: 'Function', name: 'foo', filePath: 'a.ts', startLine: 1, endLine: 5, isExported: true },
          { id: 'Function:b.ts:bar:1', label: 'Function', name: 'bar', filePath: 'b.ts', startLine: 1, endLine: 5, isExported: true },
        ],
        [
          {
            sourceId: 'Function:a.ts:foo:1',
            targetId: 'Function:b.ts:bar:1',
            type: 'CALLS',
            // #174: these are the fields the CSV serializer reads.
            line: 42,
            column: 7,
          },
        ],
      );
      const csv = await generateRelCSV(graph, 'positioned-row');
      const dataLines = csv.split('\n').filter((l) => l.trim() && !l.startsWith('from,'));
      expect(dataLines).toHaveLength(1);
      const cols = dataLines[0].split(',');
      // 8th column (index 7) = sourceLine
      expect(cols[7]).toBe('42');
      // 9th column (index 8) = sourceCol
      expect(cols[8]).toBe('7');
    });

    it('row with line=0, column=0 serializes as "0","0" (not empty/NULL)', async () => {
      const graph = buildTestGraph(
        [
          { id: 'File:c.ts', label: 'File', name: 'c.ts', filePath: 'c.ts' },
          { id: 'File:d.ts', label: 'File', name: 'd.ts', filePath: 'd.ts' },
          { id: 'Function:c.ts:g:1', label: 'Function', name: 'g', filePath: 'c.ts', startLine: 1, endLine: 2, isExported: true },
          { id: 'Function:d.ts:h:1', label: 'Function', name: 'h', filePath: 'd.ts', startLine: 1, endLine: 2, isExported: true },
        ],
        [{ sourceId: 'Function:c.ts:g:1', targetId: 'Function:d.ts:h:1', type: 'CALLS', line: 0, column: 0 }],
      );
      const csv = await generateRelCSV(graph, 'zero-position');
      const dataLines = csv.split('\n').filter((l) => l.trim() && !l.startsWith('from,'));
      const cols = dataLines[0].split(',');
      expect(cols[7]).toBe('0');
      expect(cols[8]).toBe('0');
    });
  });

  describe('row without line/column (legacy/synthetic)', () => {
    it('emits quoted-empty strings for sourceLine/sourceCol (→ NULL in Kùzu)', async () => {
      // Kùzu counts bare empty fields (,,) as fewer values than the header
      // declares — a 9-col header with two trailing bare empties gives 8
      // values and Kùzu rejects the row. Using "" (quoted empty) is counted
      // as one field and is read as NULL by Kùzu for INT64 columns.
      const graph = buildTestGraph(
        [
          { id: 'File:e.ts', label: 'File', name: 'e.ts', filePath: 'e.ts' },
          { id: 'File:f.ts', label: 'File', name: 'f.ts', filePath: 'f.ts' },
          { id: 'Function:e.ts:p:1', label: 'Function', name: 'p', filePath: 'e.ts', startLine: 1, endLine: 2, isExported: true },
          { id: 'Function:f.ts:q:1', label: 'Function', name: 'q', filePath: 'f.ts', startLine: 1, endLine: 2, isExported: true },
        ],
        // No line/column fields — simulates pre-#174 or synthetic edge.
        [{ sourceId: 'Function:e.ts:p:1', targetId: 'Function:f.ts:q:1', type: 'CALLS' }],
      );
      const csv = await generateRelCSV(graph, 'unpositioned-row');
      const dataLines = csv.split('\n').filter((l) => l.trim() && !l.startsWith('from,'));
      expect(dataLines).toHaveLength(1);
      const cols = dataLines[0].split(',');
      // Quoted-empty string → Kùzu reads as NULL for INT64 columns.
      // A bare empty (cols[7] === '') would cause "expected 9 values, got 8".
      expect(cols[7]).toBe('""');
      expect(cols[8]).toBe('""');
    });

    it('two rows: one positioned, one not — each carries correct cells', async () => {
      const graph = buildTestGraph(
        [
          { id: 'File:g.ts', label: 'File', name: 'g.ts', filePath: 'g.ts' },
          { id: 'File:h.ts', label: 'File', name: 'h.ts', filePath: 'h.ts' },
          { id: 'Function:g.ts:r:1', label: 'Function', name: 'r', filePath: 'g.ts', startLine: 1, endLine: 3, isExported: true },
          { id: 'Function:h.ts:s:1', label: 'Function', name: 's', filePath: 'h.ts', startLine: 1, endLine: 3, isExported: true },
          { id: 'Function:g.ts:t:5', label: 'Function', name: 't', filePath: 'g.ts', startLine: 5, endLine: 7, isExported: true },
        ],
        [
          { sourceId: 'Function:g.ts:r:1', targetId: 'Function:h.ts:s:1', type: 'CALLS', line: 10, column: 3 },
          { sourceId: 'Function:g.ts:t:5', targetId: 'Function:h.ts:s:1', type: 'CALLS' },
        ],
      );
      const csv = await generateRelCSV(graph, 'mixed-rows');
      const dataLines = csv.split('\n').filter((l) => l.trim() && !l.startsWith('from,'));
      expect(dataLines).toHaveLength(2);

      // Find the positioned row (ends ,10,3) and unpositioned row (ends ,"","")
      const posRow = dataLines.find((l) => l.endsWith(',10,3'));
      const unposRow = dataLines.find((l) => l.endsWith(',"",""'));
      expect(posRow).toBeDefined();
      expect(unposRow).toBeDefined();
    });
  });
});
