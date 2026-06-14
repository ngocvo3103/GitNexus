/**
 * Route Annotation Parser
 *
 * Shared utilities for extracting HTTP route information from
 * Java Spring @XxxMapping annotations in Method and Class content.
 * Used by both document-endpoint (path pattern search) and
 * impacted-endpoints (annotation-based route fallback).
 */

/** Mapping from Spring annotation suffix to HTTP method */
const ANNOTATION_TO_METHOD: Record<string, string> = {
  'GetMapping': 'GET',
  'PostMapping': 'POST',
  'PutMapping': 'PUT',
  'DeleteMapping': 'DELETE',
  'PatchMapping': 'PATCH',
};

/** Valid HTTP methods (used for validation and defaulting) */
export const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/**
 * Result of parsing a method-level mapping annotation.
 */
export interface ParsedMapping {
  /** Uppercase HTTP method (e.g. 'GET', 'POST') */
  httpMethod: string;
  /** Route path from the annotation (e.g. '/api/users') */
  routePath: string;
}

/**
 * Parse a method-level @XxxMapping annotation from method content.
 *
 * Handles these patterns:
 *   @GetMapping("/path")          → GET /path
 *   @PostMapping("/path")          → POST /path
 *   @PutMapping("/path")           → PUT /path
 *   @DeleteMapping("/path")        → DELETE /path
 *   @PatchMapping("/path")         → PATCH /path
 *   @RequestMapping(value = "/path", method = RequestMethod.GET) → GET /path
 *   @RequestMapping("/path")       → ANY /path (httpMethod = '*')
 *   @RequestMapping(value = "/path")→ ANY /path (httpMethod = '*')
 *
 * @param content - The method source content to search
 * @param defaultMethod - Fallback HTTP method when @RequestMapping has no method attribute.
 *                        Defaults to '*' (meaning "any") if not specified.
 * @returns ParsedMapping or null if no mapping annotation found
 */
export function parseMethodLevelMapping(
  content: string,
  defaultMethod: string = '*'
): ParsedMapping | null {
  if (!content) return null;

  // Try specific @XxxMapping annotations first (GetMapping, PostMapping, etc.)
  for (const [annotation, method] of Object.entries(ANNOTATION_TO_METHOD)) {
    // Pattern: @GetMapping("/path") or @GetMapping(value = "/path")
    const specificMatch = content.match(
      new RegExp(`@${annotation}\\s*\\(\\s*[^)]*value\\s*=\\s*["']([^"']+)["']`, 'i')
    ) || content.match(
      new RegExp(`@${annotation}\\s*\\(\\s*["']([^"']+)["']`, 'i')
    );
    if (specificMatch) {
      return { httpMethod: method, routePath: specificMatch[1] };
    }
  }

  // Try @RequestMapping with method attribute: @RequestMapping(value = "/path", method = RequestMethod.GET)
  const requestMappingMethodMatch = content.match(
    /@RequestMapping\s*\(\s*[^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/i
  );
  if (requestMappingMethodMatch) {
    const httpMethod = requestMappingMethodMatch[2].toUpperCase();
    if (VALID_HTTP_METHODS.has(httpMethod)) {
      return { httpMethod, routePath: requestMappingMethodMatch[1] };
    }
  }

  // Try @RequestMapping with method attribute in different order: @RequestMapping(method = RequestMethod.GET, value = "/path")
  const requestMappingMethodFirstMatch = content.match(
    /@RequestMapping\s*\(\s*[^)]*method\s*=\s*RequestMethod\.(\w+)[^)]*value\s*=\s*["']([^"']+)["']/i
  );
  if (requestMappingMethodFirstMatch) {
    const httpMethod = requestMappingMethodFirstMatch[1].toUpperCase();
    if (VALID_HTTP_METHODS.has(httpMethod)) {
      return { httpMethod, routePath: requestMappingMethodFirstMatch[2] };
    }
  }

  // Try plain @RequestMapping("/path") — no method attribute, use defaultMethod
  const plainRequestMappingMatch = content.match(
    /@RequestMapping\s*\(\s*["']([^"']+)["']/i
  ) || content.match(
    /@RequestMapping\s*\(\s*[^)]*value\s*=\s*["']([^"']+)["']/i
  );
  if (plainRequestMappingMatch) {
    return { httpMethod: defaultMethod, routePath: plainRequestMappingMatch[1] };
  }

  return null;
}

/**
 * Parse class-level @RequestMapping prefix from class content.
 *
 * Looks for @RequestMapping("/prefix") or @RequestMapping(value = "/prefix")
 * that appears before the class/interface keyword.
 *
 * Patterns matched:
 *   @RequestMapping("/api")     → /api
 *   @RequestMapping(value="/api")→ /api
 *
 * @param classContent - The full class source content
 * @returns The class-level path prefix, or null if none found
 */
export function parseClassLevelPrefix(classContent: string): string | null {
  if (!classContent) return null;

  // Match @RequestMapping before class/interface keyword, allowing other annotations in between
  const match = classContent.match(
    /@RequestMapping\s*\(\s*["']([^"']+)["']\s*\)\s*(?:\n\s*)*(?:@\w+\s*(?:\([^)]*\)\s*)?\s*)*(?:public\s+)?(?:class|interface)/i
  ) || classContent.match(
    /@RequestMapping\s*\(\s*[^)]*value\s*=\s*["']([^"']+)["'][^)]*\)\s*(?:\n\s*)*(?:@\w+\s*(?:\([^)]*\)\s*)?\s*)*(?:public\s+)?(?:class|interface)/i
  );

  return match?.[1] ?? null;
}

/**
 * Combine class-level prefix with method-level path.
 * Ensures proper slash handling.
 *
 * @param classPrefix - The @RequestMapping prefix (e.g. '/api') or empty string
 * @param methodPath - The method-level path (e.g. '/users' or 'users')
 * @returns Combined path (e.g. '/api/users')
 */
export function combinePaths(classPrefix: string | undefined, methodPath: string): string {
  const normalizedClassPath = classPrefix ? classPrefix.replace(/\/$/, '') : '';
  const normalizedMethodPath = methodPath.startsWith('/') ? methodPath : '/' + methodPath;
  return normalizedClassPath + normalizedMethodPath;
}

/**
 * Mapping from HTTP method name to Spring annotation suffixes used in
 * findHandlerByPathPattern for search queries.
 */
export const METHOD_TO_ANNOTATIONS: Record<string, string[]> = {
  'GET': ['GetMapping', 'RequestMapping'],
  'POST': ['PostMapping', 'RequestMapping'],
  'PUT': ['PutMapping', 'RequestMapping'],
  'DELETE': ['DeleteMapping', 'RequestMapping'],
  'PATCH': ['PatchMapping', 'RequestMapping'],
};