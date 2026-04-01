/**
 * WI-2: Dependency Extraction Module
 *
 * Parses pom.xml (Maven) and package.json (npm) to extract external dependencies.
 * Used for cross-repo dependency tracking and import resolution.
 */

import fs from 'fs/promises';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maven dependency extracted from pom.xml
 */
export interface MavenDependency {
  name: string; // groupId:artifactId
  groupId: string;
  artifactId: string;
  version: string;
  ecosystem: 'maven';
  scope?: 'compile' | 'runtime' | 'provided' | 'test' | 'system';
}

/**
 * Get the effective scope for a Maven dependency.
 * Defaults to 'compile' if not specified.
 */
export function getEffectiveScope(dep: MavenDependency): 'compile' | 'runtime' | 'provided' | 'test' | 'system' {
  return dep.scope ?? 'compile';
}

/**
 * npm dependency extracted from package.json
 */
export interface NpmDependency {
  name: string;
  version: string;
  isDev: boolean;
  ecosystem: 'npm';
}

/**
 * Combined dependency type
 */
export type Dependency = MavenDependency | NpmDependency;

/**
 * Result of dependency extraction
 */
export interface ExtractionResult {
  repoId: string;
  indexedAt: string;
  dependencies: Dependency[];
  ecosystem: 'maven' | 'npm' | 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Parser (lightweight, for pom.xml parsing)
// Uses regex-based extraction for reliability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract dependencies from pom.xml content using regex.
 * This is simpler and more reliable than a full XML parser for the specific case.
 */
function extractMavenDependencies(content: string): MavenDependency[] {
  const dependencies: MavenDependency[] = [];
  
  // Remove XML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  
  // Find all <dependency> blocks
  // Matches <dependency>, <dependency >, or <dependency attr="...">
  const depRegex = /<dependency[^>]*>([\s\S]*?)<\/dependency>/g;
  let match;
  
  while ((match = depRegex.exec(content)) !== null) {
    const depContent = match[1];
    
    // Extract child elements
    const groupId = extractElement(depContent, 'groupId');
    const artifactId = extractElement(depContent, 'artifactId');
    const version = extractElement(depContent, 'version');
    const scopeText = extractElement(depContent, 'scope');
    
    // Skip if missing required fields
    if (!artifactId) continue;
    
    // Validate and normalize scope
    const validScopes = ['compile', 'runtime', 'provided', 'test', 'system'] as const;
    const scope = scopeText?.toLowerCase() ?? 'compile';
    const normalizedScope = validScopes.includes(scope as any) 
      ? scope as MavenDependency['scope']
      : 'compile';
    
    // Skip test-scoped dependencies
    if (normalizedScope === 'test') continue;
    
    // Skip empty groupId (local dependencies)
    if (!groupId) continue;
    
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      groupId,
      artifactId,
      version: version ?? '',
      ecosystem: 'maven',
      scope: normalizedScope,
    });
  }
  
  return dependencies;
}

/**
 * Extract text content of an XML element.
 */
function extractElement(content: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Maven pom.xml Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Maven pom.xml file and extract dependencies.
 *
 * @param filePath - Path to pom.xml
 * @returns ExtractionResult with Maven dependencies
 */
export async function parsePomXml(filePath: string): Promise<ExtractionResult> {
  const repoId = path.basename(path.dirname(filePath));
  const indexedAt = new Date().toISOString();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const dependencies = extractMavenDependencies(content);

    return {
      repoId,
      indexedAt,
      dependencies,
      ecosystem: 'maven',
    };
  } catch {
    // File doesn't exist or read error
    return { repoId, indexedAt, dependencies: [], ecosystem: 'maven' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// npm package.json Parser
// ─────────────────────────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Parse an npm package.json file and extract dependencies.
 *
 * @param filePath - Path to package.json
 * @returns ExtractionResult with npm dependencies
 */
export async function parsePackageJson(filePath: string): Promise<ExtractionResult> {
  const repoId = path.basename(path.dirname(filePath));
  const indexedAt = new Date().toISOString();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const pkg: PackageJson = JSON.parse(content);

    const dependencies: NpmDependency[] = [];

    // Extract regular dependencies
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        dependencies.push({
          name,
          version,
          isDev: false,
          ecosystem: 'npm',
        });
      }
    }

    // Extract devDependencies
    if (pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies)) {
        dependencies.push({
          name,
          version,
          isDev: true,
          ecosystem: 'npm',
        });
      }
    }

    return {
      repoId,
      indexedAt,
      dependencies,
      ecosystem: 'npm',
    };
  } catch {
    // File doesn't exist, JSON parse error, or other error
    return { repoId, indexedAt, dependencies: [], ecosystem: 'npm' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Extractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract dependencies from a repository.
 * Detects and parses pom.xml or package.json (prefers pom.xml if both exist).
 *
 * @param repoPath - Path to the repository root
 * @returns ExtractionResult with all extracted dependencies
 */
export async function extractDependencies(repoPath: string): Promise<ExtractionResult> {
  const repoId = path.basename(repoPath);
  const indexedAt = new Date().toISOString();
  const emptyResult: ExtractionResult = {
    repoId,
    indexedAt,
    dependencies: [],
    ecosystem: 'unknown',
  };

  const pomPath = path.join(repoPath, 'pom.xml');
  const pkgPath = path.join(repoPath, 'package.json');

  // Check for pom.xml (Maven takes precedence)
  const pomExists = await fileExists(pomPath);
  if (pomExists) {
    return parsePomXml(pomPath);
  }

  // Check for package.json
  const pkgExists = await fileExists(pkgPath);
  if (pkgExists) {
    return parsePackageJson(pkgPath);
  }

  // No manifest file found
  return emptyResult;
}