/**
 * WI-1: Repository Manifest Module
 *
 * Manages repository manifests for cross-repo dependency tracking.
 * Each manifest is stored at .gitnexus/repo_manifest.json
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Repository manifest for cross-repo resolution.
 * Stored at .gitnexus/repo_manifest.json
 */
export interface RepoManifest {
  /** Unique repository identifier */
  repoId: string;
  /** ISO timestamp when the repo was last indexed */
  indexedAt: string;
  /** List of dependency repo IDs */
  dependencies: string[];
  /** Optional: last indexed commit hash */
  lastCommit?: string;
  /** Optional: indexing statistics */
  stats?: {
    nodes: number;
    edges: number;
    communities: number;
  };
}

const MANIFEST_FILE = '.gitnexus/repo_manifest.json';

/**
 * Read the repository manifest from disk.
 * Returns null if the manifest does not exist or is invalid.
 *
 * @param repoPath - Absolute path to the repository root
 * @returns Parsed manifest or null if not found/invalid
 */
export async function readManifest(repoPath: string): Promise<RepoManifest | null> {
  const manifestPath = path.join(repoPath, MANIFEST_FILE);

  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate required fields
    if (typeof parsed.repoId !== 'string' || typeof parsed.indexedAt !== 'string') {
      return null;
    }

    // Ensure dependencies is an array (backward compatibility)
    return {
      repoId: parsed.repoId,
      indexedAt: parsed.indexedAt,
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
      lastCommit: parsed.lastCommit,
      stats: parsed.stats,
    };
  } catch {
    // File doesn't exist or JSON parse failed
    return null;
  }
}

/**
 * Write the repository manifest to disk.
 * Creates the .gitnexus directory if it doesn't exist.
 * Formats JSON with 2-space indentation for readability.
 *
 * @param repoPath - Absolute path to the repository root
 * @param manifest - The manifest to write
 */
export async function writeManifest(repoPath: string, manifest: RepoManifest): Promise<void> {
  const gitnexusDir = path.join(repoPath, '.gitnexus');
  const manifestPath = path.join(gitnexusDir, 'repo_manifest.json');

  // Ensure .gitnexus directory exists
  await fs.mkdir(gitnexusDir, { recursive: true });

  // Write with 2-space indentation for readability
  const content = JSON.stringify(manifest, null, 2);
  await fs.writeFile(manifestPath, content, 'utf-8');
}

/**
 * Create an empty manifest with defaults.
 * Useful for initializing a new repository.
 *
 * @param repoId - Unique repository identifier
 * @returns A new manifest with empty dependencies
 */
export function createEmptyManifest(repoId: string): RepoManifest {
  return {
    repoId,
    indexedAt: new Date().toISOString(),
    dependencies: [],
  };
}