// ══════════════════════════════════════════════════════════════════════
// FeatureEngineerInsights.test.tsx — renders real arena artifact schemas
// The component must handle the actual artifacts the feature engineer
// persists: features_metadata as a quality-gate report, lowercase
// baseline_submission keys, and the rich features_report. Regression for
// issue #127 (empty insights panel due to schema mismatch).
// ══════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FeatureEngineerInsights } from "./FeatureEngineerInsights.js";

// Mirrors the real artifacts persisted by the arena for run 6757779f.
const REAL_FEATURES_METADATA = {
  date: "2026-08-18T09:41:49.712505",
  verdict: "PASS",
  blocking_failed: [],
  n_warnings: 1,
  gates: [
    { gate: "G1", name: "colinearidade", blocking: true, status: "PASS", value: 0.9217, detail: "max |Spearman| entre features numericas" },
    { gate: "G3", name: "adversarial validation", blocking: true, status: "WARN", value: 0.9624, detail: "drift temporal documentado na EDA" },
    { gate: "G7", name: "dimensionalidade N/p", blocking: true, status: "PASS", value: 611.3, detail: "N=25062, p=41 (limite N/p>=10)" },
  ],
  notes: "G3 interpretado com sanity check de labels aleatorios.",
};

const REAL_BASELINE_SUBMISSION = {
  model_type: "logistic-regression",
  metric: "auc",
  cv_mean: 0.6892969228624771,
  cv_std: 0.028029930918324557,
  cv_folds: [0.704, 0.703, 0.637, 0.684, 0.718],
  train_auc_mean: 0.8099182646909304,
  brier_mean: 0.12833429644795508,
  hyperparameters: { C: 1, max_iter: 2000, solver: "liblinear" },
  validation_strategy: "TimeSeriesSplit(n_splits=5, gap=0, sort_by=dt)",
  n_samples: 25062,
  n_features: 41,
  base_rate: 0.11930412576809513,
};

const REAL_FEATURES_REPORT = {
  summary: "Matriz canonica de 41 features a partir de 27525 merchants.",
  feature_count_final: 41,
  n_rows_cv: 25062,
  n_rows_oot: 2463,
  dropped_columns: ["merchant_id", "dt", "merchant_tier", "tier"],
  created_features: ["merchant_subsidy_per_gmv", "ifood_subsidy_per_gmv", "online_time_share_7d", "status_combo"],
  hypotheses_addressed: ["razoes de subsidio por R$ de GMV capturam intensidade de campanha", "ordinal merchant_tier"],
  quality_gate: { passed: 10, failed: 0, warnings: 1, verdict: "PASS" },
  baseline: { model_type: "logistic-regression", cv_mean: 0.6893, cv_std: 0.028, train_mean: 0.8099, brier: 0.1283 },
  baseline_is_competitive: true,
};

const REAL_BENCHMARK_CONFIG = {
  type: "binary_classification",
  metric: { name: "auc", direction: "higher" },
  validation: { strategy: "timeseries", nSplits: 5, gap: 0, sortColumn: "dt", randomState: 42 },
  target_column: "opt_in",
  id_column: "merchant_id",
  baseline: { cv_auc_mean: 0.6892969228624771, cv_auc_std: 0.028029930918324557, model_type: "logistic-regression" },
  oot_holdout: { enabled: true, split_description: "ultimas 3 datas: periodo censurado/futuro, 2463 linhas (~9%)" },
  compute_budget: { tier: "small", max_fit_seconds: 120, max_trials: 30 },
  dropped_columns: ["merchant_id", "dt", "merchant_tier", "tier"],
};

function renderWithDefaults(overrides: Partial<Parameters<typeof FeatureEngineerInsights>[0]> = {}) {
  return render(
    <FeatureEngineerInsights
      featuresMetadata={REAL_FEATURES_METADATA}
      splitConfig={null}
      baselineSubmission={REAL_BASELINE_SUBMISSION}
      benchmarkConfig={REAL_BENCHMARK_CONFIG}
      featuresReport={REAL_FEATURES_REPORT}
      hypothesis={null}
      figures={[]}
      decisions={[]}
      isLoading={false}
      {...overrides}
    />,
  );
}

describe("FeatureEngineerInsights", () => {
  it("renders the quality-gate verdict and gate statuses from features_metadata", () => {
    renderWithDefaults();
    expect(screen.getByText("Quality Gates")).toBeTruthy();
    // Verdict badge plus the G1/G7 status chips all read "PASS"; G3 reads "WARN".
    expect(screen.getAllByText("PASS").length).toBeGreaterThan(0);
    expect(screen.getByText("G1 · colinearidade")).toBeTruthy();
    expect(screen.getByText("WARN")).toBeTruthy();
  });

  it("renders the baseline model with lowercase keys", () => {
    renderWithDefaults();
    expect(screen.getByText("logistic-regression")).toBeTruthy();
    expect(screen.getByText("0.6893")).toBeTruthy(); // cv_mean toFixed(4)
    expect(screen.getByText("auc")).toBeTruthy();
  });

  it("renders created features and dropped columns from features_report", () => {
    renderWithDefaults();
    expect(screen.getByText("merchant_subsidy_per_gmv")).toBeTruthy();
    expect(screen.getByText("online_time_share_7d")).toBeTruthy();
    expect(screen.getByText("merchant_tier")).toBeTruthy(); // dropped column
  });

  it("renders the target column from benchmark_config", () => {
    renderWithDefaults();
    expect(screen.getByText("opt_in")).toBeTruthy();
  });

  it("shows an empty insight when no artifacts are present", () => {
    renderWithDefaults({ featuresMetadata: null, baselineSubmission: null, featuresReport: null, benchmarkConfig: null });
    expect(screen.getByText(/not complete yet/i)).toBeTruthy();
  });
});
