/**
 * Cross-Repo Import Resolver
 *
 * Resolves which consumer-repo symbols depend on changed dep-repo symbols
 * using a 3-stage resolution strategy:
 *   Stage 1: File-path IMPORTS match (confidence 0.9)
 *   Stage 2: Class-name match (confidence 0.8)
 *   Stage 3: Package-path match (confidence 0.7)
 *
 * Stages run in order. If a stage returns results, subsequent stages are skipped.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type MatchMethod = 'file-imports' | 'class-name' | 'package-path';

export interface ResolvedConsumer {
  id: string;              // Consumer repo symbol ID (e.g., "Method:src/.../BondServiceImpl.java:getBondbyId")
  name: string;            // Symbol name (e.g., "getBondbyId")
  filePath: string;        // File path in consumer repo (e.g., "src/.../BondServiceImpl.java")
  confidence: number;      // 0.9 (file-imports), 0.8 (class-name), 0.7 (package-path)
  matchMethod: MatchMethod;
  matchedDepSymbol: string; // ID of the dep symbol that matched
}

export interface ChangedSymbol {
  id: string;              // Symbol ID in dep repo (e.g., "Class:src/.../TradingDto.java:TradingDto")
  name: string;            // Symbol name (e.g., "TradingDto")
  filePath: string;        // File path in dep repo (e.g., "src/.../TradingDto.java")
}

export interface RepoHandle {
  repoId: string;
  query: (query: string, params: Record<string, unknown>) => Promise<unknown[]>;
}

/**
 * Cypher query result row — supports both named properties and positional access.
 * Kùzu can return rows as objects with named keys OR as arrays with positional values.
 */
type CypherRow = Record<string, unknown> & { [index: number]: unknown };

/** Extract a value from a Cypher row, preferring the named key over positional index. */
function rowStr(row: CypherRow, key: string, index: number): string {
  return (row[key] ?? row[index]) as string ?? '';
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Convert a file path to a Java/Kotlin/TS/JS/Python package-style path.
 * e.g. "src/main/java/com/tcbs/bond/trading/dto/TradingDto.java"
 *   → "com.tcbs.bond.trading.dto.TradingDto"
 */
export function filePathToPackagePath(filePath: string): string {
  let normalized = filePath
    .replace(/^src\/main\/(java|kotlin)\//, '')
    .replace(/^src\/test\/(java|kotlin)\//, '')
    .replace(/\.(java|kt|ts|js|py)$/, '');
  normalized = normalized.replace(/\//g, '.');
  return normalized;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export class CrossRepoResolver {
  /**
   * Resolve which consumer-repo symbols depend on changed dep-repo symbols.
   * Runs 3 stages in order, each only if the previous returned empty:
   *   Stage 1: File-path IMPORTS match (confidence 0.9)
   *   Stage 2: Class-name match (confidence 0.8)
   *   Stage 3: Package-path match (confidence 0.7)
   *
   * @returns Array of ResolvedConsumer objects. Empty if no matches found.
   * Never throws — returns empty on error.
   */
  async resolveDepConsumers(
    consumerRepo: RepoHandle,
    depRepo: RepoHandle,
    changedSymbols: ChangedSymbol[],
  ): Promise<ResolvedConsumer[]> {
    try {
      if (changedSymbols.length === 0) {
        return [];
      }

      // Stage 1: File-Path IMPORTS Match
      const stage1 = await this.stage1FileImports(consumerRepo, changedSymbols);
      if (stage1.length > 0) {
        return stage1;
      }

      // Stage 2: Class-Name Match
      const stage2 = await this.stage2ClassName(consumerRepo, changedSymbols);
      if (stage2.length > 0) {
        return stage2;
      }

      // Stage 3: Package-Path Match
      const stage3 = await this.stage3PackagePath(consumerRepo, changedSymbols);
      return stage3;
    } catch (e) {
      console.error('[GitNexus cross-repo-resolver]: resolveDepConsumers failed:', e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  // ── Stage 1: File-Path IMPORTS Match (confidence 0.9) ──────────────────

  private async stage1FileImports(
    consumerRepo: RepoHandle,
    changedSymbols: ChangedSymbol[],
  ): Promise<ResolvedConsumer[]> {
    // Collect unique file names from changed symbols
    const fileNames = [...new Set(
      changedSymbols.map(s => {
        const parts = s.filePath.split('/');
        return parts[parts.length - 1];
      }),
    )];

    // Build a map from fileName → changed symbol IDs for matching
    const fileNameToSymbols = new Map<string, ChangedSymbol[]>();
    for (const sym of changedSymbols) {
      const parts = sym.filePath.split('/');
      const fileName = parts[parts.length - 1];
      const existing = fileNameToSymbols.get(fileName) ?? [];
      existing.push(sym);
      fileNameToSymbols.set(fileName, existing);
    }

    const results: ResolvedConsumer[] = [];

    // Query each file name (Kùzu doesn't support list params in CONTAINS)
    for (const depFileName of fileNames) {
      try {
        const rows = await consumerRepo.query(
          `MATCH (importer)-[r:CodeRelation {type: 'IMPORTS'}]->(target:File)
           WHERE target.filePath CONTAINS $depFileName
           RETURN importer.id AS id, importer.name AS name, importer.filePath AS filePath, target.filePath AS matchedFilePath`,
          { depFileName },
        ) as CypherRow[];

        for (const row of rows) {
          const id = rowStr(row, 'id', 0);
          const name = rowStr(row, 'name', 1);
          const filePath = rowStr(row, 'filePath', 2);
          const matchedFilePath = rowStr(row, 'matchedFilePath', 3);

          // Find which changed symbol's file name matches
          for (const [fileName, syms] of fileNameToSymbols) {
            if (matchedFilePath?.includes(fileName) || filePath?.includes(fileName)) {
              // Use the first matching changed symbol as the matched dep
              const depSym = syms[0];
              results.push({
                id,
                name,
                filePath,
                confidence: 0.9,
                matchMethod: 'file-imports',
                matchedDepSymbol: depSym.id,
              });
              break;
            }
          }
        }
      } catch {
        // Individual file query failed — continue with next file
        continue;
      }
    }

    return results;
  }

  // ── Stage 2: Class-Name Match (confidence 0.8) ────────────────────────

  private async stage2ClassName(
    consumerRepo: RepoHandle,
    changedSymbols: ChangedSymbol[],
  ): Promise<ResolvedConsumer[]> {
    // Deduplicate symbol names
    const nameToSymbols = new Map<string, ChangedSymbol[]>();
    for (const sym of changedSymbols) {
      const existing = nameToSymbols.get(sym.name) ?? [];
      existing.push(sym);
      nameToSymbols.set(sym.name, existing);
    }

    const results: ResolvedConsumer[] = [];

    for (const [className, syms] of nameToSymbols) {
      try {
        const rows = await consumerRepo.query(
          `MATCH (c:Class) WHERE c.name = $className RETURN c.id AS id, c.name AS name, c.filePath AS filePath`,
          { className },
        ) as CypherRow[];

        for (const row of rows) {
          results.push({
            id: rowStr(row, 'id', 0),
            name: rowStr(row, 'name', 1),
            filePath: rowStr(row, 'filePath', 2),
            confidence: 0.8,
            matchMethod: 'class-name',
            matchedDepSymbol: syms[0].id,
          });
        }
      } catch {
        // Skip this name, continue with others
      }
    }

    return results;
  }

  // ── Stage 3: Package-Path Match (confidence 0.7) ──────────────────────

  private async stage3PackagePath(
    consumerRepo: RepoHandle,
    changedSymbols: ChangedSymbol[],
  ): Promise<ResolvedConsumer[]> {
    const results: ResolvedConsumer[] = [];

    for (const sym of changedSymbols) {
      try {
        const packagePath = filePathToPackagePath(sym.filePath);
        // Also derive the directory portion for filePath matching
        const packageDir = packagePath.includes('.')
          ? packagePath.substring(0, packagePath.lastIndexOf('.'))
          : packagePath;

        // Find importers that reference this package path
        const rows = await consumerRepo.query(
          `MATCH (importer)-[r:CodeRelation {type: 'IMPORTS'}]->(target)
           WHERE target.name CONTAINS $packagePath OR target.filePath CONTAINS $packageDir
           RETURN importer.id AS id, importer.name AS name, importer.filePath AS filePath`,
          { packagePath, packageDir },
        ) as CypherRow[];

        // For each importing file, find all Method/Class symbols
        const seenFiles = new Set<string>();
        for (const row of rows) {
          const importerFilePath = rowStr(row, 'filePath', 2);
          if (!importerFilePath || seenFiles.has(importerFilePath)) {
            continue;
          }
          seenFiles.add(importerFilePath);

          try {
            const symbols = await consumerRepo.query(
              `MATCH (s) WHERE s.filePath = $filePath RETURN s.id AS id, s.name AS name, s.filePath AS filePath, labels(s)[0] AS type`,
              { filePath: importerFilePath },
            ) as CypherRow[];

            for (const symRow of symbols) {
              results.push({
                id: rowStr(symRow, 'id', 0),
                name: rowStr(symRow, 'name', 1),
                filePath: rowStr(symRow, 'filePath', 2),
                confidence: 0.7,
                matchMethod: 'package-path',
                matchedDepSymbol: sym.id,
              });
            }
          } catch {
            // Skip this file, continue with others
          }
        }
      } catch {
        // Skip this symbol, continue with others
      }
    }

    return results;
  }
}