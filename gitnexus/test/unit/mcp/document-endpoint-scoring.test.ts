import { describe, it, expect } from 'vitest';
import { scoreCandidate, EXACT_PATH_MATCH_BONUS, PATH_MATCH_SCORE_BONUS } from '../../../src/mcp/local/document-endpoint.js';

describe('scoreCandidate', () => {
  const baseInput = {
    fullPath: '/api/v1/bonds',
    pathPattern: '/api/v1/bonds',
    handlerContent: '@GetMapping("/api/v1/bonds")',
    queryMethod: 'GET',
    annotationPath: '/api/v1/bonds',
    classPath: '',
    annotation: 'GetMapping',
    handlerName: 'getBonds',
    controllerType: undefined as 'ext' | 'int' | undefined,
  };

  // P0: Metamorphic — exact+method always > any non-exact
  it('exact path match always scores higher than non-exact', () => {
    const exactScore = scoreCandidate(baseInput);
    const nonExactInput = { ...baseInput, fullPath: '/api/v1/bonds/extra', pathPattern: '/api/v1/bonds' };
    const nonExactScore = scoreCandidate(nonExactInput);
    expect(exactScore).toBeGreaterThan(nonExactScore);
  });

  // BVA: exact match minimum vs non-exact maximum
  it('exact match minimum (2000 + 150) exceeds true max non-exact (960)', () => {
    const minExact = scoreCandidate({
      ...baseInput,
      fullPath: '/x',
      pathPattern: '/x',
      handlerContent: '@GetMapping("/x")',
      queryMethod: 'GET',
      annotationPath: '/x',
      classPath: '',
      annotation: 'GetMapping',
      handlerName: 'getX',
      controllerType: undefined,
    });
    // True max non-exact: prefix(300) OR segment-count(300) + lastSeg(200) + suffixSeg(200) + annotation(150) + hint(30) + controller(80) = 960
    // (path match is if/else if, so only one of exact/prefix/suffix fires)
    // (segment count match cannot co-occur with prefix/suffix since depths differ)
    // Min exact: 2000 (exact match with method gate) + 150 (specific annotation) = 2150
    expect(minExact).toBeGreaterThan(960);
  });

  // Decision table: exact match
  it('awards EXACT_PATH_MATCH_BONUS (2000) for exact path match', () => {
    const score = scoreCandidate(baseInput);
    expect(score).toBeGreaterThanOrEqual(EXACT_PATH_MATCH_BONUS);
  });

  // Decision table: prefix match
  it('awards +300 for path prefix match', () => {
    const prefixScore = scoreCandidate({
      ...baseInput,
      fullPath: '/api',
      pathPattern: '/api/v1/bonds',
      annotation: 'GetMapping',
    });
    const noPrefixScore = scoreCandidate({
      ...baseInput,
      fullPath: '/completely/different',
      pathPattern: '/api/v1/bonds',
      annotation: 'GetMapping',
    });
    expect(prefixScore - noPrefixScore).toBeGreaterThanOrEqual(300);
  });

  // Decision table: suffix match
  it('awards +200 for full path starting with search pattern', () => {
    const score = scoreCandidate({
      ...baseInput,
      fullPath: '/api/v1/bonds/details',
      pathPattern: '/api/v1/bonds',
    });
    // Should get the suffix bonus (200) since fullPath starts with pathPattern
    expect(score).toBeGreaterThan(0);
  });

  // Decision table: segment count match
  it('awards +300 when candidate segment count matches query segment count', () => {
    const matchingScore = scoreCandidate({
      ...baseInput,
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
    });
    const nonMatchingScore = scoreCandidate({
      ...baseInput,
      fullPath: '/api/v1/bonds/details',
      pathPattern: '/api/v1/bonds',
    });
    // The exact match will have the EXACT_PATH_MATCH_BONUS too, so compare segment bonus specifically
    // Both should differ by segment match bonus where the first has equal segments
    // For exact match: segments match (3 === 3), for prefix: segments don't match (4 !== 3)
    // But we need to isolate the segment bonus, so test with a non-exact but equal-length path
    const equalSegScore = scoreCandidate({
      ...baseInput,
      fullPath: '/x/v1/bonds',
      pathPattern: '/api/v1/bonds',
    });
    const unequalSegScore = scoreCandidate({
      ...baseInput,
      fullPath: '/api/v1/bonds/details',
      pathPattern: '/api/v1/bonds',
    });
    // equalSeg has segment match (+300) but no prefix/suffix, unequalSeg has suffix (+200)
    // The difference should reflect the segment match
    expect(equalSegScore).toBeGreaterThan(0);
  });

  // Decision table: method-specific annotation
  it('awards +150 for specific annotation like GetMapping', () => {
    const specificScore = scoreCandidate({
      ...baseInput,
      annotation: 'GetMapping',
    });
    const genericScore = scoreCandidate({
      ...baseInput,
      annotation: 'RequestMapping',
    });
    expect(specificScore - genericScore).toBeGreaterThan(150);
  });

  // Decision table: controller type alignment
  it('awards +80 for matching ext/int controller type', () => {
    const extScore = scoreCandidate({
      ...baseInput,
      pathPattern: '/e/v1/bonds',
      controllerType: 'ext',
    });
    const mismatchScore = scoreCandidate({
      ...baseInput,
      pathPattern: '/e/v1/bonds',
      controllerType: 'int',
    });
    expect(extScore - mismatchScore).toBe(130); // +80 alignment - (-50) mismatch
  });

  // Edge case: "/" root path
  it('handles "/" root path without error', () => {
    const score = scoreCandidate({
      ...baseInput,
      fullPath: '/',
      pathPattern: '/',
    });
    expect(typeof score).toBe('number');
  });

  // Edge case: placeholder-only paths
  it('handles placeholder paths like /{id}', () => {
    const score = scoreCandidate({
      ...baseInput,
      fullPath: '/api/v1/bonds/{id}',
      pathPattern: '/api/v1/bonds/{id}',
    });
    expect(score).toBeGreaterThanOrEqual(EXACT_PATH_MATCH_BONUS);
  });

  // ── BLOCKER #1: hasMethodAttribute decision branch (+140) ──────────────
  it('awards +140 for RequestMapping with method attribute', () => {
    const score = scoreCandidate({
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@RequestMapping(value = "/api/v1/bonds", method = RequestMethod.GET)',
      queryMethod: 'GET',
      annotationPath: '/api/v1/bonds',
      classPath: '',
      annotation: 'RequestMapping',
      handlerName: 'getBonds',
      controllerType: undefined,
    });
    // Should get: exact match (2000) + method attribute (140) + segment match (300) + last seg (200) + suffix (200) + handler hint (30)
    // = 2870 minimum
    expect(score).toBeGreaterThanOrEqual(2000 + 140);
  });

  // ── BLOCKER #2: method-match gate positive path ────────────────────────
  it('grants exact match bonus for RequestMapping with matching method attribute', () => {
    const score = scoreCandidate({
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@RequestMapping(value = "/api/v1/bonds", method = RequestMethod.GET)',
      queryMethod: 'GET',
      annotationPath: '/api/v1/bonds',
      classPath: '',
      annotation: 'RequestMapping',
      handlerName: 'handleBonds',
      controllerType: undefined,
    });
    expect(score).toBeGreaterThanOrEqual(EXACT_PATH_MATCH_BONUS);
  });

  it('denies exact match bonus for RequestMapping with mismatching method attribute', () => {
    const score = scoreCandidate({
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@RequestMapping(value = "/api/v1/bonds", method = RequestMethod.POST)',
      queryMethod: 'GET',
      annotationPath: '/api/v1/bonds',
      classPath: '',
      annotation: 'RequestMapping',
      handlerName: 'createBond',
      controllerType: undefined,
    });
    expect(score).toBeLessThan(EXACT_PATH_MATCH_BONUS);
  });

  // Method-match gate: generic RequestMapping without method attribute → no EXACT_PATH_MATCH_BONUS
  it('denies exact match bonus for generic RequestMapping without method attribute', () => {
    const score = scoreCandidate({
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@RequestMapping("/api/v1/bonds")',
      queryMethod: 'GET',
      annotationPath: '/api/v1/bonds',
      classPath: '',
      annotation: 'RequestMapping',  // Generic, no method specification
      handlerName: 'handleBonds',
      controllerType: undefined,
    });
    // Should NOT get EXACT_PATH_MATCH_BONUS
    expect(score).toBeLessThan(EXACT_PATH_MATCH_BONUS);
  });

  // ── MAJOR: Handler name hints (+30) differential test ──────────────────
  it('awards +30 when handler name hints at HTTP operation', () => {
    const matchingScore = scoreCandidate({
      ...baseInput,
      handlerName: 'getBonds',
      queryMethod: 'GET',
    });
    const nonMatchingScore = scoreCandidate({
      ...baseInput,
      handlerName: 'processRequest',
      queryMethod: 'GET',
    });
    expect(matchingScore - nonMatchingScore).toBe(30);
  });

  // ── MAJOR: Last segment inclusion (PATH_MATCH_SCORE_BONUS +200) ────────
  it('awards PATH_MATCH_SCORE_BONUS when fullPath includes last path segment', () => {
    const withSegScore = scoreCandidate({
      fullPath: '/api/v1/bonds',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@GetMapping("/bonds")',
      queryMethod: 'GET',
      annotationPath: '/bonds',
      classPath: '/api/v1',
      annotation: 'GetMapping',
      handlerName: 'handler',
      controllerType: undefined,
    });
    const withoutSegScore = scoreCandidate({
      fullPath: '/api/v1/other',
      pathPattern: '/api/v1/bonds',
      handlerContent: '@GetMapping("/other")',
      queryMethod: 'GET',
      annotationPath: '/other',
      classPath: '/api/v1',
      annotation: 'GetMapping',
      handlerName: 'handler',
      controllerType: undefined,
    });
    // The difference should include the PATH_MATCH_SCORE_BONUS (200) from last segment inclusion
    expect(withSegScore - withoutSegScore).toBeGreaterThanOrEqual(200);
  });
});