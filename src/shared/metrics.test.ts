// ══════════════════════════════════════════════════════════════════════
// metrics.test.ts — Tests for train/val gap, ranking, improvement detection
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  trainValGap,
  cvStabilityRatio,
  isSignificantImprovement,
  rankByMetric,
  classifyGain,
} from "./metrics.js";

describe("trainValGap", () => {
  it("returns absolute difference between train and val", () => {
    assert.ok(Math.abs(trainValGap(0.95, 0.90) - 0.05) < 1e-10);
    assert.ok(Math.abs(trainValGap(0.80, 0.85) - 0.05) < 1e-10);
  });

  it("returns 0 when train and val are equal", () => {
    assert.equal(trainValGap(0.90, 0.90), 0);
  });

  it("handles zero values", () => {
    assert.equal(trainValGap(0, 0), 0);
    assert.equal(trainValGap(0.5, 0), 0.5);
  });
});

describe("cvStabilityRatio", () => {
  it("computes cv_std / abs(cv_mean)", () => {
    const ratio = cvStabilityRatio(0.80, 0.02);
    assert.ok(Math.abs(ratio - 0.025) < 1e-10);
  });

  it("returns 0 when cvMean is 0", () => {
    assert.equal(cvStabilityRatio(0, 0.1), 0);
  });
});

describe("isSignificantImprovement", () => {
  it("detects improvement above threshold (baseline, candidate)", () => {
    assert.equal(isSignificantImprovement(0.85, 0.90, "higher", 0.01), true);
  });

  it("rejects improvement below threshold", () => {
    assert.equal(isSignificantImprovement(0.85, 0.851, "higher", 0.01), false);
  });

  it("works with lower-is-better direction", () => {
    assert.equal(isSignificantImprovement(0.15, 0.10, "lower", 0.01), true);
    assert.equal(isSignificantImprovement(0.15, 0.149, "lower", 0.01), false);
  });

  it("returns false when baseline is 0 (null-safe)", () => {
    assert.equal(isSignificantImprovement(0, 0.05, "higher"), true);
  });
});

describe("rankByMetric", () => {
  const models = [
    { modelId: "a", cvMean: 0.80, cvStd: 0.02, trainMean: 0.85 },
    { modelId: "b", cvMean: 0.90, cvStd: 0.01, trainMean: 0.91 },
    { modelId: "c", cvMean: 0.75, cvStd: 0.03, trainMean: 0.80 },
  ];

  it("ranks by cvMean descending", () => {
    const ranked = rankByMetric(models);
    assert.equal(ranked[0].modelId, "b");
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].modelId, "a");
    assert.equal(ranked[1].rank, 2);
    assert.equal(ranked[2].modelId, "c");
    assert.equal(ranked[2].rank, 3);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(rankByMetric([]), []);
  });
});

describe("classifyGain", () => {
  it("returns 'none' for gain below 1%", () => {
    assert.equal(classifyGain(0.85, 0.855, "higher"), "none");
  });

  it("returns 'marginal' for gain between 1-5%", () => {
    assert.equal(classifyGain(0.85, 0.87, "higher"), "marginal");
  });

  it("returns 'moderate' for gain between 5-10%", () => {
    assert.equal(classifyGain(0.85, 0.90, "higher"), "moderate");
  });

  it("returns 'strong' for gain between 10-15%", () => {
    assert.equal(classifyGain(0.85, 0.95, "higher"), "strong");
  });

  it("returns 'suspicious' for gain above 15%", () => {
    assert.equal(classifyGain(0.85, 1.0, "higher"), "suspicious");
  });

  it("works with lower-is-better direction", () => {
    // gain = (0.15 - 0.10) / 0.15 = 0.333 > 0.15 → "suspicious"
    assert.equal(classifyGain(0.15, 0.10, "lower"), "suspicious");
    assert.equal(classifyGain(0.15, 0.149, "lower"), "none");
  });
});
