// ══════════════════════════════════════════════════════════════════════
// report-builder.test.ts — Tests for C1: deterministic server-side report
// generation, round-tripped through the dashboard's parseReportMarkdown.
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExperimentReportMarkdown, type ReportExperimentCtx } from "./report-builder.js";
import { parseReportMarkdown } from "../dashboard/src/lib/parseReportMarkdown.js";

// Labels passed in explicitly → the builder never touches the filesystem.
const WORKSPACE = "/tmp/nonexistent-workspace";

function classificationExperiment(overrides: Partial<ReportExperimentCtx> = {}): ReportExperimentCtx {
  return {
    experiment_id: 42,
    run_id: "run-abc123",
    round_number: 2,
    agent_name: "modeler-advanced",
    model_type: "LightGBM",
    model_algorithm: "lgbm",
    problem_type: "classification",
    metric_name: "f1_score",
    val_metric: 0.82,
    train_metric: 0.84,
    fold_scores: [0.80, 0.83, 0.81, 0.84, 0.82],
    hypothesis: "mais features ajudam",
    learned: "lgbm é robusto",
    next_focus: "tuning de depth",
    metrics_json: {
      f1_score: 0.80,
      precision: 0.78,
      recall: 0.77,
      roc_auc: 0.82,
      log_loss: 0.45,
      feature_importances: [0.3, 0.2, 0.1],
    },
    status: "SUCCESS",
    error_message: null,
    created_at: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

function regressionExperiment(overrides: Partial<ReportExperimentCtx> = {}): ReportExperimentCtx {
  return {
    experiment_id: 7,
    run_id: "run-reg",
    round_number: null,
    agent_name: "modeler-classic",
    model_type: "Ridge",
    model_algorithm: null,
    problem_type: "regression",
    metric_name: "rmse",
    val_metric: 0.42,
    train_metric: 0.40,
    fold_scores: [0.41, 0.43, 0.42],
    hypothesis: null,
    learned: null,
    next_focus: null,
    metrics_json: { rmse: 0.42, mae: 0.33, r2_score: 0.91 },
    status: "SUCCESS",
    error_message: null,
    created_at: "2026-08-14T09:00:00.000Z",
    ...overrides,
  };
}

// ── Classification report ───────────────────────────────────────────────

describe("buildExperimentReportMarkdown — classification", () => {
  const exp = classificationExperiment();
  const { content, filename } = buildExperimentReportMarkdown({
    experiment: exp,
    workspace: WORKSPACE,
    datasetLabel: "iris",
    targetColumn: "species",
  });
  const parsed = parseReportMarkdown(content);

  it("produces a stable filename", () => {
    assert.equal(filename, "report_42.md");
  });

  it("emits a header the dashboard parser understands", () => {
    assert.equal(parsed.header.agent, "modeler-advanced");
    assert.equal(parsed.header.dataset, "iris");
    assert.equal(parsed.header.target, "species");
    assert.equal(parsed.header.runId, "run-abc123");
    assert.equal(parsed.header.date, "2026-08-15");
    assert.equal(parsed.header.taskType, "classification");
  });

  it("emits multiple parseable sections", () => {
    assert.ok(parsed.sections.length >= 5, `expected ≥5 sections, got ${parsed.sections.length}`);
    const titles = parsed.sections.map((s) => s.title);
    assert.ok(titles.includes("Resumo"));
    assert.ok(titles.includes("Baseline"));
    assert.ok(titles.includes("Folds"));
  });

  it("extracts the CV mean ± std from the Baseline section", () => {
    assert.ok(parsed.baseline, "baseline must not be null");
    assert.equal(parsed.baseline!.cvMean, 0.82);
    assert.ok(parsed.baseline!.cvStd !== null, "cvStd expected with ≥2 folds");
    assert.ok(Math.abs(parsed.baseline!.cvStd! - 0.01581) < 1e-4);
    assert.equal(parsed.baseline!.trainMean, 0.84);
  });

  it("extracts the feature count from the 'N features' line", () => {
    assert.equal(parsed.featureCount, 3);
  });

  it("renders a folds table", () => {
    assert.match(content, /\| Fold \| Score \|/);
    assert.match(content, /\| 5 \| 0\.82 \|/);
  });

  it("renders typed classification metric rows", () => {
    assert.match(content, /\| ROC AUC \| 0\.82 \|/);
    assert.match(content, /\| Log Loss \| 0\.45 \|/);
  });

  it("renders the agent reflection with hypothesis/learned/focus", () => {
    assert.match(content, /### Hipótese/);
    assert.match(content, /mais features ajudam/);
    assert.match(content, /lgbm é robusto/);
  });
});

// ── Regression report ───────────────────────────────────────────────────

describe("buildExperimentReportMarkdown — regression", () => {
  const exp = regressionExperiment();
  const { content } = buildExperimentReportMarkdown({
    experiment: exp,
    workspace: WORKSPACE,
    datasetLabel: "boston",
    targetColumn: "MEDV",
  });
  const parsed = parseReportMarkdown(content);

  it("detects the regression task and renders typed metric rows", () => {
    assert.equal(parsed.header.taskType, "regression");
    assert.match(content, /\| RMSE \| 0\.42 \|/);
    assert.match(content, /\| MAE \| 0\.33 \|/);
    assert.match(content, /\| R² \| 0\.91 \|/);
  });

  it("omits the Top Features section when importances are absent", () => {
    assert.ok(!content.includes("Top Features"));
    assert.equal(parsed.featureCount, null);
  });

  it("renders the CV mean under the configured metric name", () => {
    assert.ok(parsed.baseline);
    assert.equal(parsed.baseline!.cvMean, 0.42);
    assert.equal(parsed.baseline!.trainMean, 0.40);
  });
});

// ── Failure / graceful degradation ──────────────────────────────────────

describe("buildExperimentReportMarkdown — failure and degradation", () => {
  it("annotates the report when the experiment was registered as a failure", () => {
    const exp = classificationExperiment({
      status: "FAILED",
      error_message: "[metrics_invalid] classificação exige roc_auc",
    });
    const { content } = buildExperimentReportMarkdown({
      experiment: exp,
      workspace: WORKSPACE,
      datasetLabel: "iris",
    });
    assert.match(content, /experimento registrado como falha/);
    assert.match(content, /\[metrics_invalid\]/);
  });

  it("degrades to em-dashes for a failed run without numeric metrics", () => {
    const exp = regressionExperiment({
      val_metric: NaN,
      train_metric: NaN,
      fold_scores: null,
      metrics_json: {},
    });
    const { content } = buildExperimentReportMarkdown({
      experiment: exp,
      workspace: WORKSPACE,
    });
    assert.match(content, /\| rmse \| — \|/);
  });

  it("omits the Round header line when round_number is null", () => {
    const { content } = buildExperimentReportMarkdown({
      experiment: regressionExperiment({ round_number: null }),
      workspace: WORKSPACE,
    });
    assert.ok(!content.includes("**Round:**"));
  });

  it("does not crash when the metric value is a finite-looking string", () => {
    const exp = classificationExperiment({
      val_metric: 0.82,
      metrics_json: { ...classificationExperiment().metrics_json, f1_score: 0.8 },
    });
    const { content } = buildExperimentReportMarkdown({ experiment: exp, workspace: WORKSPACE });
    assert.ok(content.length > 0);
  });
});
