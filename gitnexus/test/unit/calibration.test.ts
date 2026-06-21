import { describe, it, expect } from 'vitest';
import {
  recommendHighTierSampleRate,
  CALIBRATION_RELIABLE_FC,
  CALIBRATION_MAX_SAMPLE,
} from '../../src/core/ingestion/calibration.js';

/**
 * Calibrate (Mode C → A loop): the import-scoped fc-rate Mode C measures drives
 * the recommended lever-12 spot-check rate. Monotone, clamped, reliable-floor.
 */
describe('recommendHighTierSampleRate (calibrate)', () => {
  it('reliable tier (fc-rate below floor) → recommend 0', () => {
    const r = recommendHighTierSampleRate(0.02);
    expect(r.recommendedSampleRate).toBe(0);
    expect(r.reason).toMatch(/reliable/);
  });

  it('exactly at the floor is treated as needing sampling', () => {
    const r = recommendHighTierSampleRate(CALIBRATION_RELIABLE_FC);
    expect(r.recommendedSampleRate).toBeGreaterThan(0);
  });

  it('moderate fc-rate → proportional sample rate', () => {
    const r = recommendHighTierSampleRate(0.2);
    expect(r.recommendedSampleRate).toBeCloseTo(0.2, 5);
  });

  it('high fc-rate is capped at the max sample rate', () => {
    const r = recommendHighTierSampleRate(0.95);
    expect(r.recommendedSampleRate).toBe(CALIBRATION_MAX_SAMPLE);
  });

  it('clamps out-of-range / non-finite input to [0,1] safely', () => {
    expect(recommendHighTierSampleRate(-1).recommendedSampleRate).toBe(0);
    expect(recommendHighTierSampleRate(2).recommendedSampleRate).toBe(CALIBRATION_MAX_SAMPLE);
    expect(recommendHighTierSampleRate(NaN).recommendedSampleRate).toBe(0);
  });

  it('is monotone non-decreasing in fc-rate', () => {
    let prev = -1;
    for (const fc of [0, 0.05, 0.1, 0.25, 0.4, 0.5, 0.8, 1]) {
      const rate = recommendHighTierSampleRate(fc).recommendedSampleRate;
      expect(rate).toBeGreaterThanOrEqual(prev);
      prev = rate;
    }
  });
});
