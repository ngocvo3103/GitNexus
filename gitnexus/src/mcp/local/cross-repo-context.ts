/**
 * Cross-Repo Context for Document Generation
 *
 * Passed from LocalBackend to document-endpoint to enable
 * type resolution across indexed dependency repositories.
 */

/**
 * Cross-repo resolution capabilities for document generation.
 * Passed from LocalBackend to enable type resolution across indexed repos.
 */
export interface CrossRepoContext {
  /** Find which repo provides a dependency by package prefix */
  findDepRepo: (packagePrefix: string) => Promise<string | null>;

  /** Query multiple repos in parallel */
  queryMultipleRepos: (
    repoIds: string[],
    query: string,
    params: Record<string, unknown>
  ) => Promise<Array<{ repoId: string; results: unknown[] }>>;

  /** Get all known dependency repos for the primary repo */
  listDepRepos: () => Promise<string[]>;
}