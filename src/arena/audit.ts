// ══════════════════════════════════════════════════════════════════════
// audit.ts — Pre-write synchronous auditor for arena experiments.
//
// Audits every experiment BEFORE it is written to the ledger: runs a series
// of blocking quality gates over a candidate experiment and returns a verdict
// (keep | warn | rejected) plus a structured rejection reason.
//
// Pure functions — zero side effects, fully unit-testable. The arena engine
// calls `auditExperiment()` before `registerArena()` and only persists entries
// that are not DUPLICATE.
// ══════════════════════════════════════════════════════════════════════

import type { MetricDirection } from "./arena-types.js";

// ── Runtime assertion ────────────────────────────────────────────────────────

/**
 * Assert that a value is non-null and non-undefined, narrowing its type.
 * Throws with a descriptive message if the invariant is violated.
 *
 * Use this instead of `as` type assertions at the boundary between
 * nullable and non-nullable code paths. Unlike `as`, this FAILS LOUDLY
 * at runtime with a clear message rather than producing a cryptic
 * "Cannot read properties of null" error 10 stack frames away.
 *
 * @example
 *   invariant(bench.metric, "bench.metric must be a number for audit");
 *   // bench.metric is narrowed to `number` from here on
 */
export function invariant<T>(
  value: T | null | undefined,
  message: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`Invariant violation: ${message}`);
  }
}

// ── Public types ─────────────────────────────────────────────────────────

export type AuditVerdict = "keep" | "warn" | "rejected";

export type RejectionTag =
  | "overfit"
  | "stale"
  | "no_folds"
  | "cal_leak"
  | "budget"
  | "too_good"
  | "significance";

export interface AuditWarning {
  tag: Exclude<RejectionTag, "budget" | "cal_leak" | "no_folds" | "stale" | "overfit">;
  message: string;
}

export interface AuditInput {
  /** Candidate primary CV metric (val_metric). Null means crash — caller handles. */
  metric: number;
  /** Explicit train score for the overfitting gate. Null = unknown. */
  trainScore: number | null;
  /** Per-fold scores of the candidate (for Nadeau-Bengio). Null = missing. */
  foldScores: number[] | null;
  /** Per-fold scores of the current best (paired for significance). Null = first/baseline. */
  bestFoldScores: number[] | null;
  /** Current best CV metric (null = first experiment / baseline). */
  bestMetric: number | null;
  /** content_hash of the candidate (MD5 of features ‖ split ‖ config). */
  contentHash: string | null;
  /** content_hash the session was bootstrapped with (integrity anchor). */
  sessionContentHash: string | null;
  /** Unique probabilities in the OOF array (calibration-leak detection). */
  oofUniqueProbs: number | null;
  /** Recomputed ECE with quantile bins (calibration-leak detection). */
  eceCalibrated: number | null;
  /** Best univariate AUC of a single feature (too-good gate). */
  maxUnivariateAuc: number | null;
  /** Already-registered experiments for this agent (for budget + dedup). */
  teamExperimentCount: number;
  /** Max iterations allowed per team. */
  maxIterationsPerTeam: number;
  /** Problem type: "classification" | "regression" | other. */
  problemType: string | null;
  /** Complexity tier (drives overfit threshold). */
  tier: ComplexityTier;
  /** Metric direction. */
  direction: MetricDirection;
  /** Candidate (team, model_type, hyperparams, metric) signature for dedup. */
  dedupSignature: string | null;
  /** Set of dedup signatures already in the ledger. */
  existingDedupSignatures: Set<string>;
}

export interface AuditResult {
  verdict: AuditVerdict;
  /** Structured rejection reason for the ledger (e.g. "[overfit] gap 0.045 > 0.03"). */
  rejectionReason: string | null;
  /** Rejection tag (machine-readable) or null. */
  rejectionTag: RejectionTag | null;
  /** Non-blocking warnings (verdict stays keep/warn). */
  warnings: AuditWarning[];
  /** Significance result, when fold scores are available. */
  significance: SignificanceResult | null;
  /** 1-based team iteration number assigned to this experiment. */
  iterationTeam: number;
}

export interface SignificanceResult {
  /** Mean per-fold difference (candidate − best), direction-aware (positive = better). */
  deltaMean: number;
  /** Std of per-fold differences. */
  deltaStd: number;
  /** Nadeau-Bengio corrected t-statistic. */
  tStat: number;
  /** Two-sided p-value (t-Student, df = nFolds − 1). */
  pValue: number;
  /** Absolute metric difference in percentage points. */
  deltaPp: number;
  /** True if the improvement is statistically significant AND non-trivial. */
  significant: boolean;
}

export type ComplexityTier = "TINY" | "SMALL" | "MEDIUM" | "LARGE" | "UNKNOWN";

// ── Overfit gate thresholds (by complexity tier) ─────────────────────────

/** Max allowed relative |train − val| / |val| gap before the overfit gate rejects.
 *  Ratios are relative to the metric magnitude (works for RMSE, MAE, R², etc.).
 *  Tiny datasets get generous thresholds because CV variance is enormous with
 *  few samples per fold (e.g. 10 rows × 5 folds = 2 samples/fold). */
export function overfitGapThreshold(tier: ComplexityTier): number {
  switch (tier) {
    case "TINY": return 2.0;   // 200% gap — 10 rows, CV noise dominates
    case "SMALL": return 0.50;  // 50%
    case "MEDIUM":
    case "LARGE": return 0.20;  // 20%
    default: return 0.50;
  }
}

// ── Adversarial validation (feature-engineer gate G3) ────────────────────

export type AdversarialVerdict = "iid" | "drift" | "warn" | "fail";

/**
 * Classify an adversarial-validation AUC (a LightGBM trained to distinguish
 * train vs holdout). Used by the feature-engineer's quality gate to decide
 * whether the train/holdout split is defensible or leaking temporal/ID signal.
 *
 * Thresholds:
 *   ≤ 0.55      iid   — train and holdout are indistinguishable (good)
 *   0.55–0.70   drift — mild covariate drift (record, proceed)
 *   0.70–0.80   warn  — drop leaked columns and re-run
 *   > 0.80      fail  — severe drift / leakage, abort the features step
 */
export function classifyAdversarialAuc(auc: number): AdversarialVerdict {
  if (!Number.isFinite(auc)) return "fail";
  if (auc <= 0.55) return "iid";
  if (auc <= 0.70) return "drift";
  if (auc <= 0.80) return "warn";
  return "fail";
}

// ── Nadeau-Bengio corrected resampled t-test (Nadeau & Bengio, 2003) ──────

/**
 * Two-sided survival function of the t-Student distribution.
 * Minimal implementation — no external stats dependency. Accurate enough for
 * gate decisions (we only care about thresholds p < 0.05 / 0.5pp, not 6-sig-fig precision).
 */
export function twoSidedTsf(absT: number, df: number): number {
  if (!Number.isFinite(absT) || df <= 0) return 1;
  // Regularized incomplete beta function I_{x}(a, b) with x = df/(df+t²).
  const x = df / (df + absT * absT);
  const ib = incompleteBeta(0.5 * df, 0.5, x);
  return Math.min(1, Math.max(0, ib));
}

/**
 * Nadeau-Bengio significance for cross-validated paired comparison.
 *
 * Given per-fold differences between candidate and best, returns the corrected
 * t-statistic and two-sided p-value. The correction factor accounts for the
 * overlap between resampled training sets in k-fold CV:
 *   correction = 1/k + (k−1)/k
 *
 * @returns null if there are no paired folds to compare.
 */
export function nadeauBengio(
  candidateFolds: number[],
  bestFolds: number[],
  direction: MetricDirection,
): SignificanceResult | null {
  const n = Math.min(candidateFolds.length, bestFolds.length);
  if (n < 2) return null;

  // Per-fold differences. For "higher is better", positive delta = candidate better.
  // For "lower is better", invert so positive still means candidate better.
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const raw = candidateFolds[i] - bestFolds[i];
    diffs.push(direction === "lower" ? -raw : raw);
  }

  const deltaMean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance =
    diffs.reduce((sum, d) => sum + (d - deltaMean) ** 2, 0) / (n - 1);
  const deltaStd = Math.sqrt(variance);

  const correction = 1 / n + (n - 1) / n;
  const tStat = deltaStd > 0 ? deltaMean / (deltaStd * Math.sqrt(correction)) : 0;
  const pValue = twoSidedTsf(Math.abs(tStat), n - 1);

  // deltaPp uses the scalar metric difference, direction-aware magnitude.
  const candidateMean = candidateFolds.reduce((a, b) => a + b, 0) / candidateFolds.length;
  const bestMean = bestFolds.reduce((a, b) => a + b, 0) / bestFolds.length;
  const deltaPp = Math.abs(candidateMean - bestMean) * 100;

  // "Statistically just" criterion:
  //   p < 0.05  AND  delta >= 0.5pp  → significant
  const significant = pValue < 0.05 && deltaPp >= 0.5;

  return { deltaMean, deltaStd, tStat, pValue, deltaPp, significant };
}

// ── Main auditor ─────────────────────────────────────────────────────────

/**
 * Audit a candidate experiment before it is written to the ledger.
 *
 * Gates run in order; the first REJECTED gate stops the audit. Warnings
 * accumulate but do not block. The "statistically just" significance gate
 * (G8) downgrades a would-be `keep` to `warn` when the improvement is not
 * statistically significant — it does NOT reject (noise is still a valid
 * leaderboard entry, just not a "win").
 *
 * Budget-exceeded experiments are REJECTED with `[budget]` for transparency
 * (they still consume a slot), matching the arena's budget contract.
 */
export function auditExperiment(input: AuditInput): AuditResult {
  const warnings: AuditWarning[] = [];

  // G7 — dedup (does not write, but returns rejected so caller can skip persist).
  if (input.dedupSignature && input.existingDedupSignatures.has(input.dedupSignature)) {
    return reject("budget", "[dedup] experiment identical to a prior ledger entry", input, warnings);
  }

  // G6 — budget. Count this experiment as the next team iteration.
  const iterationTeam = input.teamExperimentCount + 1;
  if (input.teamExperimentCount >= input.maxIterationsPerTeam) {
    return reject(
      "budget",
      `[budget] team reached ${input.maxIterationsPerTeam} iterations (this would be #${iterationTeam})`,
      input,
      warnings,
      iterationTeam,
    );
  }

  // G2 — content_hash integrity (intra-run dataset consistency).
  if (input.sessionContentHash && input.contentHash && input.contentHash !== input.sessionContentHash) {
    return reject(
      "stale",
      `[stale] content_hash mismatch: experiment=${input.contentHash.slice(0, 8)} session=${input.sessionContentHash.slice(0, 8)}`,
      input,
      warnings,
      iterationTeam,
    );
  }

  // G3 — folds present (Nadeau-Bengio input). Without folds we cannot judge
  // significance; the rule is to reject rather than fall back to a raw
  // comparison (which would let CV noise through).
  if (!input.foldScores || input.foldScores.length < 2) {
    return reject(
      "no_folds",
      "[no_folds] fold_scores missing or has <2 entries — cannot assess significance",
      input,
      warnings,
      iterationTeam,
    );
  }

  // G1 — overfitting (train-val gap, relative to metric magnitude).
  // Relative gap works for any metric scale (RMSE in thousands, R² in [0,1], etc.)
  // without requiring per-metric threshold calibration.
  if (input.trainScore !== null) {
    const absGap = Math.abs(input.trainScore - input.metric);
    const relGap = Math.abs(input.metric) > 1e-9 ? absGap / Math.abs(input.metric) : absGap;
    const threshold = overfitGapThreshold(input.tier);
    if (relGap > threshold) {
      return reject(
        "overfit",
        `[overfit] rel(train-val) ${(relGap * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% (tier=${input.tier})`,
        input,
        warnings,
        iterationTeam,
      );
    }
  }

  // G4 — calibration leak (OOF saturation / suspiciously perfect ECE).
  if (input.oofUniqueProbs !== null && input.oofUniqueProbs < 50) {
    return reject(
      "cal_leak",
      `[cal_leak] OOF has only ${input.oofUniqueProbs} unique probabilities (saturation)`,
      input,
      warnings,
      iterationTeam,
    );
  }
  if (input.eceCalibrated !== null && input.eceCalibrated < 1e-6) {
    return reject(
      "cal_leak",
      `[cal_leak] ECE ${input.eceCalibrated.toExponential(2)} suspiciously perfect — likely calibrator fit on OOF`,
      input,
      warnings,
      iterationTeam,
    );
  }

  // G5 — too good (single feature dominates → likely proxy/leakage).
  if (input.maxUnivariateAuc !== null && input.maxUnivariateAuc >= 0.99) {
    warnings.push({
      tag: "too_good",
      message: `[too_good] univariate AUC ${input.maxUnivariateAuc.toFixed(4)} >= 0.99 — verify no target proxy`,
    });
  }

  // G8 — significance (Nadeau-Bengio). Only meaningful when there is a current
  // best to compare against. The first/baseline experiment auto-keeps.
  let significance: SignificanceResult | null = null;
  let verdict: AuditVerdict = "keep";

  if (input.bestMetric !== null && input.bestFoldScores && input.bestFoldScores.length >= 2) {
    significance = nadeauBengio(input.foldScores, input.bestFoldScores, input.direction);
    if (significance && !significance.significant) {
      // Not a statistically significant win — keep on the ledger but flag as
      // a non-improvement (warn) so the arena does not treat it as a new best.
      verdict = "warn";
      warnings.push({
        tag: "significance",
        message: `[significance] p=${significance.pValue.toFixed(4)} delta=${significance.deltaPp.toFixed(3)}pp — not a significant improvement`,
      });
    }
  }

  return {
    verdict,
    rejectionReason: null,
    rejectionTag: null,
    warnings,
    significance,
    iterationTeam,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function reject(
  tag: RejectionTag,
  reason: string,
  input: AuditInput,
  warnings: AuditWarning[],
  iterationTeam?: number,
): AuditResult {
  return {
    verdict: "rejected",
    rejectionReason: reason,
    rejectionTag: tag,
    warnings,
    significance: null,
    iterationTeam: iterationTeam ?? input.teamExperimentCount + 1,
  };
}

/**
 * Build a deterministic dedup signature for an experiment.
 * Two experiments with the same team, model type, hyperparameters, and
 * primary metric are considered duplicates.
 */
export function dedupSignature(
  agentName: string,
  modelType: string,
  hyperparameters: Record<string, unknown>,
  metric: number | null,
): string {
  const hp = canonicalJson(hyperparameters);
  const metricStr = metric !== null && Number.isFinite(metric) ? metric.toFixed(8) : "N/A";
  return `${agentName}|${modelType}|${hp}|${metricStr}`;
}

/** Canonical (sorted-key) JSON for stable hashing. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// ── Ensemble weight optimization (Nelder-Mead over the simplex) ──────────

/**
 * Optimize ensemble weights over the probability simplex Δⁿ (weights ≥ 0,
 * sum to 1) via Nelder-Mead. The caller supplies a `score` callback that
 * evaluates a weight vector — typically "blend the OOF arrays with these
 * weights and return the primary metric".
 *
 * The simplex is initialized as the barycenter plus one vertex per model
 * nudged toward that model. After each step, vertices are projected back to
 * the simplex (clip negatives, renormalize) so weights stay valid.
 *
 * Pure optimizer — does NOT touch OOF files. The reporter/audit step loads
 * the `_oof.npy` arrays and supplies the score callback.
 *
 * @param nModels  number of base models in the ensemble
 * @param score    returns the metric for a weight vector (higher = better)
 * @param maxIter  Nelder-Mead iteration cap (default 200)
 * @returns        best weight vector found (length nModels, sums to ~1)
 */
export function nelderMeadEnsembleWeights(
  nModels: number,
  score: (weights: number[]) => number,
  maxIter = 200,
): number[] {
  if (nModels <= 0) return [];
  if (nModels === 1) return [1];

  const alpha = 1;   // reflection
  const gamma = 2;   // expansion
  const rho = 0.5;   // contraction
  const sigma = 0.5; // shrink

  // Initialize simplex: barycenter + one vertex per model biased toward it.
  const barycenter = Array(nModels).fill(1 / nModels);
  const simplex: number[][] = [barycenter];
  for (let i = 0; i < nModels; i++) {
    const v = barycenter.slice();
    v[i] = 0.6;
    simplex.push(projectToSimplex(v));
  }
  const scores = simplex.map((v) => score(v));

  for (let iter = 0; iter < maxIter; iter++) {
    // Sort vertices by score descending (best first).
    const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    const bestIdx = order[0][1];
    const best = simplex[bestIdx];
    const bestScore = scores[bestIdx];
    const worstIdx = order[nModels][1];
    const worst = simplex[worstIdx];
    const worstScore = scores[worstIdx];

    // Centroid of all but the worst.
    const centroid = Array(nModels).fill(0);
    for (let k = 0; k < nModels; k++) {
      const idx = order[k][1];
      for (let d = 0; d < nModels; d++) centroid[d] += simplex[idx][d];
    }
    for (let d = 0; d < nModels; d++) centroid[d] /= nModels;

    // Reflection
    const reflected = projectToSimplex(centroid.map((c, d) => c + alpha * (c - worst[d])));
    const reflectedScore = score(reflected);
    if (reflectedScore > bestScore && reflectedScore <= scores[order[nModels - 1][1]]) {
      simplex[worstIdx] = reflected;
      scores[worstIdx] = reflectedScore;
      continue;
    }
    // Expansion
    if (reflectedScore > bestScore) {
      const expanded = projectToSimplex(centroid.map((c, d) => c + gamma * (c - worst[d])));
      const expandedScore = score(expanded);
      simplex[worstIdx] = expandedScore > reflectedScore ? expanded : reflected;
      scores[worstIdx] = expandedScore > reflectedScore ? expandedScore : reflectedScore;
      continue;
    }
    // Contraction
    const contracted = projectToSimplex(centroid.map((c, d) => c + rho * (c - worst[d])));
    const contractedScore = score(contracted);
    if (contractedScore > worstScore) {
      simplex[worstIdx] = contracted;
      scores[worstIdx] = contractedScore;
      continue;
    }
    // Shrink toward the best
    for (let k = 1; k <= nModels; k++) {
      const idx = order[k][1];
      simplex[idx] = projectToSimplex(best.map((b, d) => b + sigma * (simplex[idx][d] - b)));
      scores[idx] = score(simplex[idx]);
    }
  }

  // Return the best vertex.
  let bestIdx = 0;
  let bestS = scores[0];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > bestS) { bestS = scores[i]; bestIdx = i; }
  }
  return projectToSimplex(simplex[bestIdx]);
}

/** Project an arbitrary vector onto the probability simplex (clip negatives, renormalize). */
function projectToSimplex(v: number[]): number[] {
  const clamped = v.map((x) => Math.max(0, x));
  const sum = clamped.reduce((a, b) => a + b, 0);
  if (sum === 0) return clamped.map(() => 1 / v.length);
  return clamped.map((x) => x / sum);
}

// ── Numerics: regularized incomplete beta function ───────────────────────
// Continued-fraction expansion (Lentz). Source: Numerical Recipes §6.4.
// Used by twoSidedTsf to compute the t-Student survival function.

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front =
    Math.exp(Math.log(x) * a + Math.log1p(-x) * b - lbeta) / a;
  // Use continued fraction for x > (a+1)/(a+b+2), else symmetry.
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaContinuedFraction(a, b, x);
  }
  return 1 - (Math.exp(Math.log1p(-x) * b + Math.log(x) * a - lbeta) / b) * betaContinuedFraction(b, a, 1 - x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const tiny = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}

/** Log-gamma via the Lanczos approximation. */
function lgamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
