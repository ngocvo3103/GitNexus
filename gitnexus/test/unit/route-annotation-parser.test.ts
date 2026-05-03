/**
 * Unit Tests: route-annotation-parser
 *
 * Tests the shared annotation parsing utilities used by both
 * document-endpoint and impacted-endpoints for extracting route
 * information from Spring @XxxMapping annotations.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMethodLevelMapping,
  parseClassLevelPrefix,
  combinePaths,
  METHOD_TO_ANNOTATIONS,
  VALID_HTTP_METHODS,
} from '../../src/mcp/local/route-annotation-parser.js';

describe('route-annotation-parser', () => {

  // ─── parseMethodLevelMapping ──────────────────────────────────────────

  describe('parseMethodLevelMapping', () => {

    // @GetMapping
    it('parses @GetMapping("/api/users")', () => {
      const result = parseMethodLevelMapping('@GetMapping("/api/users")\npublic ResponseEntity<List<User>> getUsers() { ... }');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('GET');
      expect(result!.routePath).toBe('/api/users');
    });

    it('parses @GetMapping(value = "/api/users")', () => {
      const result = parseMethodLevelMapping('@GetMapping(value = "/api/users")\npublic void getUsers() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('GET');
      expect(result!.routePath).toBe('/api/users');
    });

    // @PostMapping
    it('parses @PostMapping("/api/orders")', () => {
      const result = parseMethodLevelMapping('@PostMapping("/api/orders")\npublic ResponseEntity<Order> create() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('POST');
      expect(result!.routePath).toBe('/api/orders');
    });

    // @PutMapping
    it('parses @PutMapping("/api/orders/{id}")', () => {
      const result = parseMethodLevelMapping('@PutMapping("/api/orders/{id}")\npublic ResponseEntity<Void> update() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('PUT');
      expect(result!.routePath).toBe('/api/orders/{id}');
    });

    // @DeleteMapping
    it('parses @DeleteMapping("/api/orders/{id}")', () => {
      const result = parseMethodLevelMapping('@DeleteMapping("/api/orders/{id}")\npublic void delete() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('DELETE');
      expect(result!.routePath).toBe('/api/orders/{id}');
    });

    // @PatchMapping
    it('parses @PatchMapping("/api/orders/{id}")', () => {
      const result = parseMethodLevelMapping('@PatchMapping("/api/orders/{id}")\npublic void patch() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('PATCH');
      expect(result!.routePath).toBe('/api/orders/{id}');
    });

    // @RequestMapping with method attribute
    it('parses @RequestMapping(value = "/api/users", method = RequestMethod.GET)', () => {
      const result = parseMethodLevelMapping('@RequestMapping(value = "/api/users", method = RequestMethod.GET)\npublic void getUsers() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('GET');
      expect(result!.routePath).toBe('/api/users');
    });

    it('parses @RequestMapping(method = RequestMethod.POST, value = "/api/orders")', () => {
      const result = parseMethodLevelMapping('@RequestMapping(method = RequestMethod.POST, value = "/api/orders")\npublic void create() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('POST');
      expect(result!.routePath).toBe('/api/orders');
    });

    // @RequestMapping without method attribute
    it('parses @RequestMapping("/api/any") with default method *', () => {
      const result = parseMethodLevelMapping('@RequestMapping("/api/any")\npublic void handle() {}');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('*');
      expect(result!.routePath).toBe('/api/any');
    });

    it('uses provided defaultMethod for @RequestMapping without method', () => {
      const result = parseMethodLevelMapping('@RequestMapping("/api/users")\npublic void handle() {}', 'GET');
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('GET');
    });

    // No annotation found
    it('returns null for content without mapping annotation', () => {
      const result = parseMethodLevelMapping('public void regularMethod() {}');
      expect(result).toBeNull();
    });

    it('returns null for empty content', () => {
      const result = parseMethodLevelMapping('');
      expect(result).toBeNull();
    });

    // Single quotes
    it("parses @GetMapping('/api/users') with single quotes", () => {
      const result = parseMethodLevelMapping("@GetMapping('/api/users')\npublic void getUsers() {}");
      expect(result).not.toBeNull();
      expect(result!.httpMethod).toBe('GET');
      expect(result!.routePath).toBe('/api/users');
    });
  });

  // ─── parseClassLevelPrefix ─────────────────────────────────────────────

  describe('parseClassLevelPrefix', () => {

    it('parses @RequestMapping("/api") before class keyword', () => {
      const content = '@RequestMapping("/api")\npublic class ApiController { ... }';
      const result = parseClassLevelPrefix(content);
      expect(result).toBe('/api');
    });

    it('parses @RequestMapping(value = "/api/v2") before class keyword', () => {
      const content = '@RequestMapping(value = "/api/v2")\npublic class V2Controller { ... }';
      const result = parseClassLevelPrefix(content);
      expect(result).toBe('/api/v2');
    });

    it('handles other annotations between @RequestMapping and class', () => {
      const content = '@RequestMapping("/api")\n@RestController\npublic class ApiController { ... }';
      const result = parseClassLevelPrefix(content);
      expect(result).toBe('/api');
    });

    it('returns null when no @RequestMapping is present', () => {
      const content = '@RestController\npublic class PlainController { ... }';
      const result = parseClassLevelPrefix(content);
      expect(result).toBeNull();
    });

    it('returns null for empty content', () => {
      const result = parseClassLevelPrefix('');
      expect(result).toBeNull();
    });

    it('ignores @RequestMapping that is NOT before class/interface keyword', () => {
      // A @RequestMapping on a method inside the class body should not match
      const content = 'public class SomeController {\n  @RequestMapping("/method-level")\n  public void handle() {}\n}';
      const result = parseClassLevelPrefix(content);
      expect(result).toBeNull();
    });
  });

  // ─── combinePaths ──────────────────────────────────────────────────────

  describe('combinePaths', () => {

    it('combines class prefix "/api" with method path "/users"', () => {
      expect(combinePaths('/api', '/users')).toBe('/api/users');
    });

    it('handles trailing slash on class prefix', () => {
      expect(combinePaths('/api/', '/users')).toBe('/api/users');
    });

    it('handles method path without leading slash', () => {
      expect(combinePaths('/api', 'users')).toBe('/api/users');
    });

    it('returns method path when class prefix is undefined', () => {
      expect(combinePaths(undefined, '/users')).toBe('/users');
    });

    it('returns method path when class prefix is empty string', () => {
      expect(combinePaths('', '/users')).toBe('/users');
    });

    it('combines nested paths correctly', () => {
      expect(combinePaths('/api/v2', '/orders/{id}/items')).toBe('/api/v2/orders/{id}/items');
    });
  });

  // ─── METHOD_TO_ANNOTATIONS ──────────────────────────────────────────────

  describe('METHOD_TO_ANNOTATIONS', () => {

    it('maps GET to GetMapping and RequestMapping', () => {
      expect(METHOD_TO_ANNOTATIONS['GET']).toEqual(['GetMapping', 'RequestMapping']);
    });

    it('maps POST to PostMapping and RequestMapping', () => {
      expect(METHOD_TO_ANNOTATIONS['POST']).toEqual(['PostMapping', 'RequestMapping']);
    });

    it('maps PUT to PutMapping and RequestMapping', () => {
      expect(METHOD_TO_ANNOTATIONS['PUT']).toEqual(['PutMapping', 'RequestMapping']);
    });

    it('maps DELETE to DeleteMapping and RequestMapping', () => {
      expect(METHOD_TO_ANNOTATIONS['DELETE']).toEqual(['DeleteMapping', 'RequestMapping']);
    });

    it('maps PATCH to PatchMapping and RequestMapping', () => {
      expect(METHOD_TO_ANNOTATIONS['PATCH']).toEqual(['PatchMapping', 'RequestMapping']);
    });
  });

  // ─── VALID_HTTP_METHODS ────────────────────────────────────────────────

  describe('VALID_HTTP_METHODS', () => {

    it('contains standard HTTP methods', () => {
      expect(VALID_HTTP_METHODS.has('GET')).toBe(true);
      expect(VALID_HTTP_METHODS.has('POST')).toBe(true);
      expect(VALID_HTTP_METHODS.has('PUT')).toBe(true);
      expect(VALID_HTTP_METHODS.has('DELETE')).toBe(true);
      expect(VALID_HTTP_METHODS.has('PATCH')).toBe(true);
      expect(VALID_HTTP_METHODS.has('HEAD')).toBe(true);
      expect(VALID_HTTP_METHODS.has('OPTIONS')).toBe(true);
    });

    it('does not contain non-standard methods', () => {
      expect(VALID_HTTP_METHODS.has('TRACE')).toBe(false);
      expect(VALID_HTTP_METHODS.has('CONNECT')).toBe(false);
    });
  });
});