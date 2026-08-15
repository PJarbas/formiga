// ══════════════════════════════════════════════════════════════════════
// audit.test.ts — Tests for the pre-write auditor: Nadeau-Bengio + gates.
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditExperiment,
  nadeauBengio,
  twoSidedTsf,
  overfitGapThreshold,
  significanceThresholds,
  classifyAdversarialAuc,
  nelderMeadEnsembleWeights,
  dedupSignature,
  type AuditInput,
  type ComplexityTier,
} from "./audit.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    metric: 0.82,
    trainScore: 0.84, // gap 0.02, comfortably under MEDIUM threshold 0.03
    foldScores: [0.81, 0.82, 0.83, 0.80, 0.84],
    bestFoldScores: [0.78, 0.79, 0.77, 0.76, 0.78],
    bestMetric: 0.776,
    contentHash: "abc123",
    sessionContentHash: "abc123",
    oofUniqueProbs: 500,
    eceCalibrated: 0.03,
    maxUnivariateAuc: null,
    teamExperimentCount: 0,
    maxIterationsPerTeam: 5,
    problemType: "classification",
    tier: "MEDIUM",
    direction: "higher",
    dedupSignature: "sig-1",
    existingDedupSignatures: new Set<string>(),
    ...overrides,
  };
}

// ── t-Student survival function ──────────────────────────────────────────

describe("twoSidedTsf", () => {
  it("returns ~0.0734 for t=2.0, df=10", () => {
    const p = twoSidedTsf(2.0, 10);
    assert.ok(Math.abs(p - 0.0734) < 0.002, `expected ~0.0734, got ${p}`);
  });

  it("returns ~0.001 for t=4.0, df=20 (significant)", () => {
    const p = twoSidedTsf(4.0, 20);
    assert.ok(p < 0.005, `expected <0.005, got ${p}`);
  });

  it("returns 1 for t=0", () => {
    assert.ok(Math.abs(twoSidedTsf(0, 10) - 1) < 1e-9);
  });

  it("returns 1 for non-finite / invalid df", () => {
    assert.equal(twoSidedTsf(NaN, 10), 1);
    assert.equal(twoSidedTsf(2, 0), 1);
  });
});

// ── Nadeau-Bengio ────────────────────────────────────────────────────────

describe("nadeauBengio", () => {
  it("returns null when fewer than 2 paired folds", () => {
    assert.equal(nadeauBengio([0.8], [0.7], "higher"), null);
    assert.equal(nadeauBengio([], [], "higher"), null);
  });

  it("flags a clearly significant improvement", () => {
    // candidate consistently beats best by ~0.03 every fold
    const result = nadeauBengio(
      [0.82, 0.83, 0.81, 0.84, 0.82],
      [0.78, 0.79, 0.77, 0.80, 0.78],
      "higher",
    );
    assert.ok(result);
    assert.ok(result!.significant, "should be significant");
    assert.ok(result!.pValue < 0.05);
    assert.ok(result!.deltaPp >= 0.5);
  });

  it("rejects noise (no real improvement) as non-significant", () => {
    // candidate wobbles around best — mean diff ~0
    const result = nadeauBengio(
      [0.80, 0.79, 0.81, 0.78, 0.82],
      [0.79, 0.80, 0.80, 0.79, 0.81],
      "higher",
    );
    assert.ok(result);
    assert.equal(result!.significant, false);
  });

  it("respects direction=lower (lower is better)", () => {
    // candidate RMSE lower than best every fold → significant
    const result = nadeauBengio(
      [0.10, 0.11, 0.09, 0.12, 0.10],
      [0.14, 0.15, 0.13, 0.16, 0.14],
      "lower",
    );
    assert.ok(result!.significant);
  });
});

// ── Gates ────────────────────────────────────────────────────────────────

describe("auditExperiment — G1 overfit", () => {
  it("rejects when relative train-val gap exceeds tier threshold", () => {
    const result = auditExperiment(baseInput({
      metric: 0.72,
      trainScore: 0.99, // relGap = 0.27/0.72 = 37.5% > 20% (MEDIUM)
      tier: "MEDIUM",
    }));
    assert.equal(result.verdict, "rejected");
    assert.equal(result.rejectionTag, "overfit");
    assert.match(result.rejectionReason!, /\[overfit\]/);
  });

  it("keeps when relative gap is within threshold", () => {
    const result = auditExperiment(baseInput({
      metric: 0.82,
      trainScore: 0.84, // relGap = 0.02/0.82 = 2.4% < 20% (MEDIUM)
      tier: "MEDIUM",
    }));
    assert.notEqual(result.verdict, "rejected");
  });

  it("uses a looser threshold for TINY tier (relative gap)", () => {
    // relGap = 1.5 (150%) — fails MEDIUM (20%) but passes TINY (200%)
    const result = auditExperiment(baseInput({
      metric: 1.0,
      trainScore: 2.5,
      tier: "TINY",
    }));
    assert.notEqual(result.verdict, "rejected");
  });
});

describe("auditExperiment — G2 content_hash", () => {
  it("rejects stale dataset (hash mismatch)", () => {
    const result = auditExperiment(baseInput({
      contentHash: "deadbeef",
      sessionContentHash: "abc123",
    }));
    assert.equal(result.verdict, "rejected");
    assert.equal(result.rejectionTag, "stale");
  });

  it("passes when no session hash is set (graceful degradation)", () => {
    const result = auditExperiment(baseInput({
      contentHash: "deadbeef",
      sessionContentHash: null,
    }));
    assert.notEqual(result.verdict, "rejected");
  });
});

describe("auditExperiment — G3 no_folds", () => {
  it("rejects when fold_scores missing", () => {
    const result = auditExperiment(baseInput({ foldScores: null }));
    assert.equal(result.verdict, "rejected");
    assert.equal(result.rejectionTag, "no_folds");
  });

  it("rejects when fold_scores has <2 entries", () => {
    const result = auditExperiment(baseInput({ foldScores: [0.8] }));
    assert.equal(result.rejectionTag, "no_folds");
  });
});

describe("auditExperiment — G4 cal_leak", () => {
  it("rejects OOF saturation (<50 unique probs)", () => {
    const result = auditExperiment(baseInput({ oofUniqueProbs: 10, trainScore: 0.83 }));
    assert.equal(result.rejectionTag, "cal_leak");
    assert.match(result.rejectionReason!, /saturation/);
  });

  it("rejects suspiciously perfect ECE", () => {
    const result = auditExperiment(baseInput({ eceCalibrated: 1e-9, trainScore: 0.83 }));
    assert.equal(result.rejectionTag, "cal_leak");
    assert.match(result.rejectionReason!, /perfect/);
  });
});

describe("auditExperiment — G5 too_good (warning, not rejection)", () => {
  it("warns but does not reject on univariate AUC >= 0.99", () => {
    const result = auditExperiment(baseInput({ maxUnivariateAuc: 0.995, trainScore: 0.83 }));
    assert.notEqual(result.verdict, "rejected");
    assert.ok(result.warnings.some((w) => w.tag === "too_good"));
  });
});

describe("auditExperiment — G6 budget", () => {
  it("rejects when team reached max iterations", () => {
    const result = auditExperiment(baseInput({
      teamExperimentCount: 5,
      maxIterationsPerTeam: 5,
    }));
    assert.equal(result.rejectionTag, "budget");
    assert.match(result.rejectionReason!, /\[budget\]/);
    assert.equal(result.iterationTeam, 6);
  });
});

describe("auditExperiment — G7 dedup", () => {
  it("rejects duplicates (same signature already in ledger)", () => {
    const sig = dedupSignature("modeler-classic", "lightgbm", { lr: 0.01 }, 0.82);
    const result = auditExperiment(baseInput({
      dedupSignature: sig,
      existingDedupSignatures: new Set([sig]),
    }));
    assert.equal(result.rejectionTag, "budget");
    assert.match(result.rejectionReason!, /\[dedup\]/);
  });
});

describe("auditExperiment — G8 significance", () => {
  it("downgrades a non-significant improvement to warn (not keep)", () => {
    // candidate barely beats best — within CV noise
    const result = auditExperiment(baseInput({
      metric: 0.777,
      trainScore: 0.78, // gap 0.003, under threshold
      bestMetric: 0.776,
      foldScores: [0.777, 0.776, 0.778, 0.776, 0.777],
      bestFoldScores: [0.776, 0.776, 0.776, 0.776, 0.776],
    }));
    assert.equal(result.verdict, "warn");
    assert.ok(result.warnings.some((w) => w.tag === "significance"));
  });

  it("keeps a statistically significant, non-trivial improvement", () => {
    const result = auditExperiment(baseInput({
      metric: 0.82,
      trainScore: 0.84, // gap 0.02, under threshold
      bestMetric: 0.776,
      foldScores: [0.82, 0.83, 0.81, 0.84, 0.82],
      bestFoldScores: [0.78, 0.79, 0.77, 0.80, 0.78],
    }));
    assert.equal(result.verdict, "keep");
    assert.ok(result.significance?.significant);
  });

  it("auto-keeps the first experiment (no best to compare)", () => {
    const result = auditExperiment(baseInput({
      metric: 0.82,
      trainScore: 0.84,
      bestMetric: null,
      bestFoldScores: null,
    }));
    assert.equal(result.verdict, "keep");
    assert.equal(result.significance, null);
  });

  it("keeps modest improvement on TINY tier that MEDIUM would reject", () => {
    // Fold differences give p ≈ 0.10 — fails standard p<0.05 but passes TINY p<0.20.
    // deltaPp ≈ 3.0pp passes both thresholds.
    // On MEDIUM tier this same data should be "warn".
    const tinyInput = baseInput({
      metric: 0.826,
      trainScore: 0.83,
      bestMetric: 0.796,
      foldScores: [0.82, 0.84, 0.79, 0.85, 0.83],
      bestFoldScores: [0.79, 0.81, 0.78, 0.80, 0.80],
      tier: "TINY",
    });
    const tinyResult = auditExperiment(tinyInput);
    assert.equal(tinyResult.verdict, "keep",
      `TINY tier should keep modest improvement, got verdict=${tinyResult.verdict} p=${tinyResult.significance?.pValue?.toFixed(4)}`);

    // Same data under MEDIUM tier → should downgrade to "warn"
    const mediumResult = auditExperiment(baseInput({
      ...tinyInput,
      tier: "MEDIUM",
    }));
    assert.equal(mediumResult.verdict, "warn",
      `MEDIUM tier should warn on same data, got verdict=${mediumResult.verdict}`);
    assert.ok(mediumResult.warnings.some((w) => w.tag === "significance"));
  });
});

// ── significanceThresholds ─────────────────────────────────────────────

describe("significanceThresholds", () => {
  it("returns relaxed thresholds for TINY tier", () => {
    const t = significanceThresholds("TINY");
    assert.equal(t.pMax, 0.20);
    assert.equal(t.deltaPpMin, 0.1);
  });

  it("returns moderately relaxed thresholds for SMALL tier", () => {
    const t = significanceThresholds("SMALL");
    assert.equal(t.pMax, 0.10);
    assert.equal(t.deltaPpMin, 0.3);
  });

  it("returns standard thresholds for MEDIUM and above", () => {
    for (const tier of ["MEDIUM", "LARGE", "UNKNOWN"] as ComplexityTier[]) {
      const t = significanceThresholds(tier);
      assert.equal(t.pMax, 0.05, `pMax for ${tier}`);
      assert.equal(t.deltaPpMin, 0.5, `deltaPpMin for ${tier}`);
    }
  });
});

// ── dedupSignature determinism ───────────────────────────────────────────

describe("dedupSignature", () => {
  it("is order-independent for hyperparameter keys", () => {
    const a = dedupSignature("x", "lgbm", { lr: 0.01, depth: 6 }, 0.8);
    const b = dedupSignature("x", "lgbm", { depth: 6, lr: 0.01 }, 0.8);
    assert.equal(a, b);
  });

  it("differs on metric", () => {
    const a = dedupSignature("x", "lgbm", { lr: 0.01 }, 0.8);
    const b = dedupSignature("x", "lgbm", { lr: 0.01 }, 0.81);
    assert.notEqual(a, b);
  });

  it("handles null metric without throwing", () => {
    const a = dedupSignature("x", "lgbm", { lr: 0.01 }, null);
    assert.ok(a.includes("N/A"), "null metric should produce 'N/A' in signature");
  });

  it("null metric produces different signature than zero", () => {
    const nullSig = dedupSignature("x", "lgbm", {}, null);
    const zeroSig = dedupSignature("x", "lgbm", {}, 0.0);
    assert.notEqual(nullSig, zeroSig);
  });

  it("null metric is deterministic", () => {
    const a = dedupSignature("x", "lgbm", {}, null);
    const b = dedupSignature("x", "lgbm", {}, null);
    assert.equal(a, b);
  });
});

// ── overfitGapThreshold ──────────────────────────────────────────────────

describe("overfitGapThreshold", () => {
  it("returns tighter thresholds for larger tiers", () => {
    const tiny = overfitGapThreshold("TINY" as ComplexityTier);
    const medium = overfitGapThreshold("MEDIUM" as ComplexityTier);
    assert.ok(tiny > medium, "TINY should be more permissive than MEDIUM");
  });
});

describe("classifyAdversarialAuc", () => {
  it("classifies AUC <= 0.55 as iid", () => {
    assert.equal(classifyAdversarialAuc(0.50), "iid");
    assert.equal(classifyAdversarialAuc(0.55), "iid");
  });

  it("classifies 0.55–0.70 as drift", () => {
    assert.equal(classifyAdversarialAuc(0.60), "drift");
    assert.equal(classifyAdversarialAuc(0.70), "drift");
  });

  it("classifies 0.70–0.80 as warn (drop leaked columns)", () => {
    assert.equal(classifyAdversarialAuc(0.75), "warn");
    assert.equal(classifyAdversarialAuc(0.80), "warn");
  });

  it("classifies > 0.80 as fail (abort features step)", () => {
    assert.equal(classifyAdversarialAuc(0.81), "fail");
    assert.equal(classifyAdversarialAuc(0.99), "fail");
  });

  it("fails on non-finite AUC", () => {
    assert.equal(classifyAdversarialAuc(NaN), "fail");
    assert.equal(classifyAdversarialAuc(Infinity), "fail");
  });
});

describe("auditExperiment — G9 metric×problemType mismatch (warn only)", () => {
  it("warns when a regression metric is configured on a classification problem", () => {
    const result = auditExperiment(baseInput({
      metricName: "rmse",
    }));
    assert.notEqual(result.verdict, "rejected", "G9 must never reject");
    assert.ok(result.warnings.some((w) => w.tag === "metric_mismatch"));
  });

  it("warns when a classification metric is configured on a regression problem", () => {
    const result = auditExperiment(baseInput({
      problemType: "regression",
      metricName: "roc_auc",
      metric: 0.42,
      trainScore: 0.40,
    }));
    assert.ok(result.warnings.some((w) => w.tag === "metric_mismatch"));
  });

  it("does not warn on a known-good pairing", () => {
    const result = auditExperiment(baseInput({ metricName: "roc_auc" }));
    assert.ok(!result.warnings.some((w) => w.tag === "metric_mismatch"));
  });

  it("does not warn when metricName is absent", () => {
    const result = auditExperiment(baseInput({ metricName: undefined }));
    assert.ok(!result.warnings.some((w) => w.tag === "metric_mismatch"));
  });

  it("does not warn on an unrecognized metric", () => {
    const result = auditExperiment(baseInput({ metricName: "custom_score" }));
    assert.ok(!result.warnings.some((w) => w.tag === "metric_mismatch"));
  });
});

describe("nelderMeadEnsembleWeights", () => {
  it("returns [1] for a single model", () => {
    assert.deepEqual(nelderMeadEnsembleWeights(1, () => 0.5), [1]);
  });

  it("returns [] for zero models", () => {
    assert.deepEqual(nelderMeadEnsembleWeights(0, () => 0.5), []);
  });

  it("finds weights that favor the better model", () => {
    // Blend score = w[0] + 2*w[1] = 1 + w[1] (since w[0]=1-w[1]). Optimum: w[1]=1.
    const score = (w: number[]) => w[0] + 2 * w[1];
    const weights = nelderMeadEnsembleWeights(2, score, 100);
    assert.equal(weights.length, 2);
    assert.ok(Math.abs(weights[0] + weights[1] - 1) < 1e-6);
    assert.ok(weights[1] > weights[0], `expected w1>w0, got ${weights}`);
  });

  it("keeps weights non-negative and on the simplex", () => {
    const score = (w: number[]) => w.reduce((s, wi, i) => s + wi * (i + 1), 0);
    const weights = nelderMeadEnsembleWeights(4, score, 80);
    const sum = weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `weights must sum to 1, got ${sum}`);
    assert.ok(weights.every((w) => w >= -1e-9), `weights must be non-negative, got ${weights}`);
  });
});
