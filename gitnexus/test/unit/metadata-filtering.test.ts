/**
 * Unit Tests: Line-Range Filtering for httpCallDetails (Issue #27)
 *
 * Tests that extractMetadata filters HTTP call details by line range,
 * preventing sibling methods in the same class file from polluting
 * the handler's downstream API list.
 *
 * Test Design Techniques:
 * - Equivalence Partitioning: within range, outside range, no range
 * - Boundary Value Analysis: exact startLine, exact endLine
 * - Decision Table: filter vs no-filter paths
 *
 * Feature: document-endpoint line-range filtering
 *   As a developer
 *   I want httpCallDetails filtered to the handler's line range
 *   So that sibling method calls do not appear as downstream APIs
 */
import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../../src/mcp/local/trace-executor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 1-based line content. Keys are line numbers. */
function linesFromMap(map: Record<number, string>): string {
  const max = Math.max(...Object.keys(map).map(Number));
  const result: string[] = [];
  for (let i = 1; i <= max; i++) {
    result.push(map[i] || '');
  }
  return result.join('\n');
}

// ─── TC-1: Handler line range filters sibling method calls ────────────────────

describe('extractMetadata line-range filtering', () => {
  it('TC-1: only includes httpCallDetails within the handler line range', () => {
    // Lines 5-9: getOrder handler calls restTemplate.getForEntity("/api/orders/{id}")
    // Lines 15-20: deleteOrder handler calls restTemplate.delete("/api/orders/{id}")
    const content = linesFromMap({
      1: 'public class OrderController {',
      2: '',
      3: '  @GetMapping("/api/orders/{id}")',
      4: '  public Order getOrder(Long id) {',
      5: '    return restTemplate.getForEntity("/api/orders/{id}", Order.class);',
      6: '  }',
      7: '',
      8: '  @DeleteMapping("/api/orders/{id}")',
      9: '  public void deleteOrder(Long id) {',
      10: '    restTemplate.delete("/api/orders/{id}");',
      11: '  }',
      12: '}',
    });

    // Handler spans lines 4-6 (getOrder)
    const metadata = extractMetadata(content, 4, 6);

    // Should only include the GET call, not the DELETE from sibling method
    expect(metadata.httpCallDetails).toHaveLength(1);
    expect(metadata.httpCallDetails[0].httpMethod).toBe('GET');
    expect(metadata.httpCallDetails[0].urlExpression).toBe('"/api/orders/{id}"');
    expect(metadata.httpCallDetails[0].lineNumber).toBe(5);
  });

  // ─── TC-2: All calls within range are included ────────────────────────────

  it('TC-2: includes all httpCallDetails when both calls are within the line range', () => {
    const content = linesFromMap({
      1: 'public class OrderController {',
      2: '',
      3: '  public void batchOperation() {',
      4: '    restTemplate.getForObject("/api/orders", List.class);',
      5: '    restTemplate.postForObject("/api/orders", request, Order.class);',
      6: '  }',
      7: '}',
    });

    // Handler spans lines 3-6
    const metadata = extractMetadata(content, 3, 6);

    expect(metadata.httpCallDetails).toHaveLength(2);
    expect(metadata.httpCallDetails.some(d => d.httpMethod === 'GET')).toBe(true);
    expect(metadata.httpCallDetails.some(d => d.httpMethod === 'POST')).toBe(true);
  });

  // ─── TC-3: No line range → all calls included (backward compat) ────────────

  it('TC-3: includes all httpCallDetails when no line range is provided', () => {
    const content = linesFromMap({
      1: 'public class OrderController {',
      2: '',
      3: '  public Order getOrder(Long id) {',
      4: '    return restTemplate.getForEntity("/api/orders/{id}", Order.class);',
      5: '  }',
      6: '',
      7: '  public void deleteOrder(Long id) {',
      8: '    restTemplate.delete("/api/orders/{id}");',
      9: '  }',
      10: '}',
    });

    // No line range — backward compat, all calls included
    const metadata = extractMetadata(content);

    expect(metadata.httpCallDetails).toHaveLength(2);
    expect(metadata.httpCallDetails.some(d => d.httpMethod === 'GET')).toBe(true);
    expect(metadata.httpCallDetails.some(d => d.httpMethod === 'DELETE')).toBe(true);
  });

  // ─── TC-4: Boundary lines (exactly startLine or endLine) are included ──────

  it('TC-4: includes httpCallDetails at exact startLine and endLine boundaries', () => {
    const content = linesFromMap({
      1: 'public class Controller {',
      2: '  public void handler() {',
      3: '    restTemplate.getForObject("/api/first", String.class);',
      4: '    restTemplate.postForObject("/api/second", body, String.class);',
      5: '    restTemplate.delete("/api/third");',
      6: '  }',
      7: '}',
    });

    // Range starts exactly at line 3 (first call) and ends at line 5 (third call)
    const metadata = extractMetadata(content, 3, 5);

    expect(metadata.httpCallDetails).toHaveLength(3);
    const methods = metadata.httpCallDetails.map(d => d.httpMethod);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  // ─── TC-5: Calls outside the range are excluded ────────────────────────────

  it('TC-5: excludes httpCallDetails outside the handler line range', () => {
    const content = linesFromMap({
      1: 'public class Controller {',
      2: '  public void other() {',
      3: '    restTemplate.put("/api/outside1");',
      4: '  }',
      5: '  public void handler() {',
      6: '    restTemplate.getForObject("/api/inside", String.class);',
      7: '  }',
      8: '  public void another() {',
      9: '    restTemplate.delete("/api/outside2");',
      10: '  }',
      11: '}',
    });

    // Handler spans lines 5-7
    const metadata = extractMetadata(content, 5, 7);

    expect(metadata.httpCallDetails).toHaveLength(1);
    expect(metadata.httpCallDetails[0].httpMethod).toBe('GET');
    expect(metadata.httpCallDetails[0].urlExpression).toBe('"/api/inside"');
  });

  // ─── TC-6: Feign annotations filtered by line range ─────────────────────────

  it('TC-6: filters Feign annotation httpCallDetails by line range', () => {
    const content = [
      '@FeignClient(name="order-service")',
      'public interface OrderClient {',
      '',
      '  @GetMapping("/api/orders/{id}")',
      '  Order getOrder(@PathVariable Long id);',
      '',
      '  @DeleteMapping("/api/orders/{id}")',
      '  void deleteOrder(@PathVariable Long id);',
      '}',
    ].join('\n');

    // Only the getOrder method spans lines 4-5
    const metadata = extractMetadata(content, 4, 5);

    expect(metadata.httpCallDetails).toHaveLength(1);
    expect(metadata.httpCallDetails[0].httpMethod).toBe('GET');
    expect(metadata.httpCallDetails[0].isFeignClient).toBe(true);
  });

  // ─── TC-7: exec-style calls filtered by line range ──────────────────────────

  it('TC-7: filters exec-style httpCallDetails by line range', () => {
    const content = [
      'public class Service {',
      '  public void handler() {',
      '    execGet("/api/inside");',
      '  }',
      '  public void other() {',
      '    execPost("/api/outside", body);',
      '  }',
      '}',
    ].join('\n');

    // Handler spans lines 2-4
    const metadata = extractMetadata(content, 2, 4);

    expect(metadata.httpCallDetails).toHaveLength(1);
    expect(metadata.httpCallDetails[0].httpMethod).toBe('GET');
    expect(metadata.httpCallDetails[0].urlExpression).toBe('"/api/inside"');
  });

  // ─── TC-8: lineNumber field is populated when content is provided ──────────

  it('TC-8: populates lineNumber on httpCallDetails', () => {
    const content = [
      'public class Controller {',
      '  public void handler() {',
      '    restTemplate.getForObject("/api/test", String.class);',
      '  }',
      '}',
    ].join('\n');

    const metadata = extractMetadata(content);

    expect(metadata.httpCallDetails).toHaveLength(1);
    expect(metadata.httpCallDetails[0].lineNumber).toBe(3);
  });

  // ─── TC-9: Empty content returns empty metadata ─────────────────────────────

  it('TC-9: returns empty metadata for undefined content', () => {
    const metadata = extractMetadata(undefined, 1, 10);

    expect(metadata.httpCallDetails).toHaveLength(0);
  });

  // ─── TC-10: Only startLine provided (no endLine) → no filtering ──────────────

  it('TC-10: does not filter when only startLine is provided', () => {
    const content = linesFromMap({
      1: 'public class C {',
      2: '  void a() { restTemplate.getForObject("/a"); }',
      3: '  void b() { restTemplate.postForObject("/b", x); }',
      4: '}',
    });

    // Only startLine, no endLine → should not filter (backward compat)
    const metadata = extractMetadata(content, 2);

    expect(metadata.httpCallDetails).toHaveLength(2);
  });

  // ─── TC-11: Only endLine provided (no startLine) → no filtering ─────────────

  it('TC-11: does not filter when only endLine is provided', () => {
    const content = linesFromMap({
      1: 'public class C {',
      2: '  void a() { restTemplate.getForObject("/a"); }',
      3: '  void b() { restTemplate.postForObject("/b", x); }',
      4: '}',
    });

    // Only endLine, no startLine → should not filter (backward compat)
    const metadata = extractMetadata(content, undefined, 2);

    expect(metadata.httpCallDetails).toHaveLength(2);
  });
});