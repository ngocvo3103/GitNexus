/**
 * Calibration: the Mode C → Mode A feedback the RFC asked for, as a
 * deterministic, auditable RECOMMENDATION rather than a silent online loop.
 *
 * Mode C measures, per tier, how often a confidently-resolved heuristic edge is
 * actually wrong (`falseConfidentRate`). The import-scoped (0.90) tier is the
 * one Mode A does NOT re-check by default — lever 12 (`--lsp-high-tier-sample`)
 * exists exactly to spot-check it. This module maps the measured import-scoped
 * fc-rate to a suggested sample rate for the next `analyze`: the worse the
 * heuristic does on that tier, the more of it lever 12 should send to LSP.
 *
 * The operator applies the recommendation (it is printed by `verify --calibrate`,
 * never auto-applied) so the loop stays explicit and reviewable — no graph state
 * changes behind the operator's back.
 */
export interface CalibrationRecommendation {
  /** The measured import-scoped false-confident rate, clamped to [0,1]. */
  importScopedFcRate: number;
  /** Suggested `--lsp-high-tier-sample` value, in [0, 0.5]. */
  recommendedSampleRate: number;
  /** Human-readable rationale. */
  reason: string;
}

/** Below this fc-rate the import-scoped tier is treated as reliable (no sampling). */
export const CALIBRATION_RELIABLE_FC = 0.05;
/** Re-checking more than half a tier rarely beats trusting LSP wholesale. */
export const CALIBRATION_MAX_SAMPLE = 0.5;

/**
 * Map an import-scoped false-confident rate to a recommended spot-check rate.
 * Non-finite input is treated as 0 (no data → no recommendation).
 */
export function recommendHighTierSampleRate(importScopedFcRate: number): CalibrationRecommendation {
  const fc = Number.isFinite(importScopedFcRate)
    ? Math.max(0, Math.min(1, importScopedFcRate))
    : 0;

  if (fc < CALIBRATION_RELIABLE_FC) {
    return {
      importScopedFcRate: fc,
      recommendedSampleRate: 0,
      reason: `import-scoped tier reliable (fc-rate ${(fc * 100).toFixed(1)}% < ${(CALIBRATION_RELIABLE_FC * 100).toFixed(0)}%); no spot-check needed`,
    };
  }

  // Sample proportionally to the measured error, capped, rounded to whole %.
  const rate = Math.min(CALIBRATION_MAX_SAMPLE, Math.round(fc * 100) / 100);
  return {
    importScopedFcRate: fc,
    recommendedSampleRate: rate,
    reason: `import-scoped fc-rate ${(fc * 100).toFixed(1)}% → spot-check ~${(rate * 100).toFixed(0)}% of that tier (--lsp-high-tier-sample ${rate})`,
  };
}
