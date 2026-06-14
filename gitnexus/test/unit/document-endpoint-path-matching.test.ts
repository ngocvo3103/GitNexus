/**
 * Unit Tests: Document Endpoint Path Matching
 *
 * Tests the pathsMatchStructurally function for suffix-based path matching.
 */

import { describe, it, expect } from 'vitest';
import { pathsMatchStructurally } from '../../src/mcp/local/document-endpoint.js';

describe('pathsMatchStructurally', () => {
  describe('equal segment count (regression)', () => {
    it('equal_segments_exact_match', () => {
      expect(pathsMatchStructurally('/e/v1/bookings/{id}', '/e/v1/bookings/{id}')).toBe(true);
    });

    it('equal_segments_no_match', () => {
      expect(pathsMatchStructurally('/e/v1/bookings/{id}', '/e/v1/users/{id}')).toBe(false);
    });

    it('regression_equal_length', () => {
      // Core regression case: same length, should still work
      expect(pathsMatchStructurally('/e/v1/bookings/{id}/suggest', '/e/v1/bookings/{id}/suggest')).toBe(true);
      expect(pathsMatchStructurally('/e/v1/bookings/{id}/suggest', '/e/v1/users/{id}/suggest')).toBe(false);
    });
  });

  describe('input shorter than annotation (suffix matching from annotation end)', () => {
    it('input_shorter_suffix_matches', () => {
      // Partial input matches end of annotation
      expect(pathsMatchStructurally('bookings/{id}/suggest', '/e/v1/bookings/{id}/suggest')).toBe(true);
    });

    it('input_shorter_no_match', () => {
      // Partial input does NOT match annotation end
      expect(pathsMatchStructurally('users/{id}/suggest', '/e/v1/bookings/{id}/suggest')).toBe(false);
    });
  });

  describe('input longer than annotation (suffix matching from input end)', () => {
    it('input_longer_suffix_matches', () => {
      // Input longer with annotation as true suffix (annotation segments at end of input)
      // input: /a/b/c/e/v1/bookings/{id}/suggest (7 segments)
      // annotation: /e/v1/bookings/{id}/suggest (5 segments) - suffix of input
      expect(pathsMatchStructurally('/a/b/c/e/v1/bookings/{id}/suggest', '/e/v1/bookings/{id}/suggest')).toBe(true);
    });

    it('input_longer_partial_suffix_matches', () => {
      // Input has extra segments at start, annotation matches end of input
      expect(pathsMatchStructurally('/a/b/c/bookings/{id}', '/c/bookings/{id}')).toBe(true);
    });
  });

  describe('single segment', () => {
    it('single_segment_suffix', () => {
      expect(pathsMatchStructurally('bookings', 'bookings')).toBe(true);
      expect(pathsMatchStructurally('bookings', '/e/v1/bookings')).toBe(true);
      expect(pathsMatchStructurally('bookings/{id}', '/e/v1/bookings/{id}')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('empty_input_false', () => {
      expect(pathsMatchStructurally('', '/e/v1/bookings')).toBe(false);
    });

    it('empty_annotation_false', () => {
      expect(pathsMatchStructurally('/e/v1/bookings', '')).toBe(false);
    });

    it('both_empty_false', () => {
      expect(pathsMatchStructurally('', '')).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('case_insensitive_suffix', () => {
      expect(pathsMatchStructurally('BOOKINGS/{id}/SUGGEST', '/e/v1/bookings/{id}/suggest')).toBe(true);
      expect(pathsMatchStructurally('bookings/{id}/suggest', '/E/V1/BOOKINGS/{ID}/SUGGEST')).toBe(true);
    });
  });

  describe('placeholder segments', () => {
    it('all_placeholders_suffix', () => {
      expect(pathsMatchStructurally('{}', '/e/v1/anything')).toBe(true);
      expect(pathsMatchStructurally('{}', '/a/b/c')).toBe(true);
    });

    it('mixed_placeholder_and_literal', () => {
      expect(pathsMatchStructurally('{id}/suggest', '/e/v1/bookings/{id}/suggest')).toBe(true);
      expect(pathsMatchStructurally('bookings/{id}', '/BOOKINGS/{id}')).toBe(true);
    });
  });
});
