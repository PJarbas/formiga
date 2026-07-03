// ══════════════════════════════════════════════════════════════════════
// arena-decision.ts — Keep / discard / crash logic for arena experiments.
// Pure functions with zero side effects.
// ══════════════════════════════════════════════════════════════════════

import type { ArenaDecision, MetricDirection } from "./arena-types.js";

/** Direction-aware comparison. */
export function isImprovement(candidate: number, current: number, direction: MetricDirection): boolean {
  return direction === "lower" ? candidate < current : candidate > current;
}

/**
 * Decide whether a benchmark result should be kept or discarded.
 *
 * @param metric        — measured metric (null → crash)
 * @param bestMetric    — current best metric in the arena
 * @param direction     — "lower" or "higher"
 * @param baselineMetric — first accepted measurement (for baseline detection)
 * @returns decision string
 */
export function makeDecision(
  metric: number | null,
  bestMetric: number | null,
  direction: MetricDirection,
  baselineMetric: number | null = null,
): ArenaDecision {
  if (metric === null) return "crash";
  if (bestMetric === null && baselineMetric === null) return "baseline";
  if (bestMetric === null) return "keep";
  return isImprovement(metric, bestMetric, direction) ? "keep" : "discard";
}
