// ══════════════════════════════════════════════════════════════════════
// arena-confidence.ts — MAD-based noise floor and confidence bands.
// Pure functions — no side effects, no DB access.
// Extracted and refactored from src/autoresearch/autoresearch.ts
// ══════════════════════════════════════════════════════════════════════

import type { MetricDirection, ConfidenceBand, ConfidenceResult } from "./arena-types.js";

/** Median of a numeric array. Returns 0 for empty input — caller should guard. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function unknownConfidence(sampleCount: number, noiseFloor: number | null = null): ConfidenceResult {
  return {
    band: "unknown",
    score: null,
    noiseFloor,
    sampleCount,
    improvementAbs: null,
    improvementPct: null,
  };
}

function classifyBand(score: number): ConfidenceBand {
  if (score >= 2.0) return "high";
  if (score >= 1.0) return "medium";
  return "low";
}

/**
 * Compute confidence for a set of measured metrics.
 *
 * @param measuredMetrics — finite numeric values from successful benchmark runs
 * @param baselineMetric  — the first accepted (baseline) measurement
 * @param bestMetric      — current best accepted measurement
 * @param direction       — "lower" means smaller is better
 */
export function computeConfidence(
  measuredMetrics: number[],
  baselineMetric: number | null,
  bestMetric: number | null,
  direction: MetricDirection,
): ConfidenceResult {
  const measured = measuredMetrics.filter((m) => Number.isFinite(m));
  if (measured.length < 3) {
    return unknownConfidence(measured.length);
  }

  if (baselineMetric === null || bestMetric === null) {
    return unknownConfidence(measured.length);
  }

  const valueMedian = median(measured);
  const mad = median(measured.map((v) => Math.abs(v - valueMedian)));
  const normalizedMad = mad * 1.4826;

  if (normalizedMad === 0) {
    return unknownConfidence(measured.length, 0);
  }

  const improvement = Math.abs(
    direction === "lower" ? baselineMetric - bestMetric : bestMetric - baselineMetric,
  );

  const score = improvement / normalizedMad;

  return {
    band: classifyBand(score),
    score: Math.round(score * 100) / 100,
    noiseFloor: Math.round(normalizedMad * 1_000_000) / 1_000_000,
    sampleCount: measured.length,
    improvementAbs: Math.round(improvement * 1_000_000) / 1_000_000,
    improvementPct:
      baselineMetric !== 0
        ? Math.round((improvement / Math.abs(baselineMetric)) * 100 * 10) / 10
        : null,
  };
}
