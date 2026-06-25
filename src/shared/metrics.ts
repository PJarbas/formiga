// ══════════════════════════════════════════════════════════════════════
// metrics.ts — Standardized metric comparison, gap, and ranking helpers
// ══════════════════════════════════════════════════════════════════════

export interface MetricResult {
  modelId: string;
  cvMean: number;
  cvStd: number;
  trainMean: number;
}

/** Absolute gap between train and validation metrics. */
export function trainValGap(trainMetric: number, valMetric: number): number {
  return Math.abs(trainMetric - valMetric);
}

/** Coefficient of variation — cv_std / cv_mean. >0.2 flags instability. */
export function cvStabilityRatio(cvMean: number, cvStd: number): number {
  if (cvMean === 0) return 0;
  return cvStd / Math.abs(cvMean);
}

/**
 * True when candidate beats baseline by at least minImprovement fraction.
 * direction: "higher" (e.g. accuracy) or "lower" (e.g. rmse).
 */
export function isSignificantImprovement(
  baseline: number,
  candidate: number,
  direction: "higher" | "lower" = "higher",
  minImprovement: number = 0.01,
): boolean {
  if (direction === "higher") {
    return candidate > baseline * (1 + minImprovement);
  }
  return candidate < baseline * (1 - minImprovement);
}

/** Rank results by cvMean descending (highest first). */
export function rankByMetric(results: MetricResult[]): Array<MetricResult & { rank: number }> {
  const sorted = [...results].sort((a, b) => b.cvMean - a.cvMean);
  return sorted.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

/** Classify gain magnitude over baseline. */
export function classifyGain(
  baseline: number,
  candidate: number,
  direction: "higher" | "lower" = "higher",
): "none" | "marginal" | "moderate" | "strong" | "suspicious" {
  const gain = direction === "higher"
    ? (candidate - baseline) / Math.abs(baseline)
    : (baseline - candidate) / Math.abs(baseline);

  if (gain < 0.01) return "none";
  if (gain < 0.05) return "marginal";
  if (gain < 0.10) return "moderate";
  if (gain < 0.15) return "strong";
  return "suspicious";
}
