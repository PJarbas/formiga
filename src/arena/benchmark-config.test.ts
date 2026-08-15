// ══════════════════════════════════════════════════════════════════════
// benchmark-config.test.ts — Tests for A5 structured benchmark_config parsing
// and the metric×problemType guard (G9 input).
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBenchmarkConfig,
  assertMetricProblemType,
  METRICS_BY_PROBLEM_TYPE,
} from "./benchmark-config.js";

// ── parseBenchmarkConfig ────────────────────────────────────────────────

describe("parseBenchmarkConfig", () => {
  it("parses a string metric + problemType (modern shape)", () => {
    const r = parseBenchmarkConfig({ problemType: "regression", metric: "rmse" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.problemType, "regression");
    assert.equal(r.value.metricName, "rmse");
    assert.equal(r.value.metricDirection, null);
  });

  it("accepts the legacy `type` spelling for problem type", () => {
    const r = parseBenchmarkConfig({ type: "classification", metric: "f1" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.problemType, "classification");
  });

  it("parses an object metric { name, direction }", () => {
    const r = parseBenchmarkConfig({
      type: "classification",
      metric: { name: "f1", direction: "higher" },
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.metricName, "f1");
    assert.equal(r.value.metricDirection, "higher");
  });

  it("normalizes minimize/maximize into lower/higher", () => {
    const r = parseBenchmarkConfig({ metric: { name: "rmse", direction: "minimize" } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.metricDirection, "lower");
  });

  it("rejects a non-object config", () => {
    const r = parseBenchmarkConfig(null);
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.match(r.error, /\[benchmark_config_invalid\]/);
  });

  it("rejects a config with no usable metric", () => {
    const r = parseBenchmarkConfig({ type: "classification" });
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.match(r.error, /\[benchmark_config_invalid\]/);
    assert.match(r.error, /métrica/);
  });

  it("rejects an object metric without a name", () => {
    const r = parseBenchmarkConfig({ metric: { direction: "higher" } });
    assert.ok(!r.ok);
  });
});

// ── assertMetricProblemType ─────────────────────────────────────────────

describe("assertMetricProblemType", () => {
  it("returns null for a known-good pairing", () => {
    assert.equal(assertMetricProblemType("classification", "roc_auc"), null);
    assert.equal(assertMetricProblemType("regression", "rmse"), null);
    assert.equal(assertMetricProblemType("regression", "r2_score"), null);
    assert.equal(assertMetricProblemType("classification", "log_loss"), null);
  });

  it("warns when a regression metric is configured on a classification problem", () => {
    const msg = assertMetricProblemType("classification", "rmse");
    assert.ok(msg, "expected a mismatch warning");
    assert.match(msg!, /\[metric_problem_mismatch\]/);
    assert.match(msg!, /regression/);
  });

  it("warns when a classification metric is configured on a regression problem", () => {
    const msg = assertMetricProblemType("regression", "accuracy");
    assert.ok(msg);
    assert.match(msg!, /\[metric_problem_mismatch\]/);
    assert.match(msg!, /classification/);
  });

  it("returns null when either value is missing (no claim)", () => {
    assert.equal(assertMetricProblemType(null, "rmse"), null);
    assert.equal(assertMetricProblemType("regression", null), null);
    assert.equal(assertMetricProblemType(undefined, undefined), null);
  });

  it("returns null for an unrecognized metric (don't guess on custom metrics)", () => {
    assert.equal(assertMetricProblemType("classification", "custom_score"), null);
  });

  it("returns null for an unknown problem type", () => {
    assert.equal(assertMetricProblemType("time_series", "accuracy"), null);
  });

  it("normalizes case and separators", () => {
    assert.equal(assertMetricProblemType("Classification", "ROC-AUC"), null);
    const msg = assertMetricProblemType("REGRESSION", "F1_SCORE");
    assert.ok(msg);
    assert.match(msg!, /\[metric_problem_mismatch\]/);
  });
});

// ── METRICS_BY_PROBLEM_TYPE sanity ──────────────────────────────────────

describe("METRICS_BY_PROBLEM_TYPE", () => {
  it("contains the canonical classification metrics", () => {
    for (const m of ["accuracy", "f1", "roc_auc", "log_loss", "precision", "recall"]) {
      assert.ok(METRICS_BY_PROBLEM_TYPE.classification.has(m), `missing ${m}`);
    }
  });

  it("contains the canonical regression metrics", () => {
    for (const m of ["rmse", "mse", "mae", "r2_score", "mape"]) {
      assert.ok(METRICS_BY_PROBLEM_TYPE.regression.has(m), `missing ${m}`);
    }
  });

  it("classification and regression sets are disjoint", () => {
    for (const m of METRICS_BY_PROBLEM_TYPE.classification) {
      assert.ok(!METRICS_BY_PROBLEM_TYPE.regression.has(m), `${m} in both sets`);
    }
  });
});
