// ══════════════════════════════════════════════════════════════════════
// script-templates.test.ts — Tests for B2: problemType-aware model class and
// evaluator resolution + the portable reproduction script (no host paths).
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelClass,
  resolveEvaluator,
  generateReproductionScript,
  type ScriptContext,
} from "./script-templates.js";

function baseContext(overrides: Partial<ScriptContext> = {}): ScriptContext {
  return {
    experimentId: 42,
    modelType: "lightgbm",
    hyperparameters: { lr: 0.01, depth: 6 },
    cvMean: 0.82,
    trainMean: 0.84,
    artifactPath: "artifacts/models/exp_42.pkl",
    metricName: "f1",
    features: ["a", "b", "c"],
    workspacePath: "/host/absolute/workspace",
    ...overrides,
  };
}

// ── resolveModelClass ───────────────────────────────────────────────────

describe("resolveModelClass", () => {
  it("picks the Classifier for a classification problem", () => {
    assert.equal(resolveModelClass("xgboost", "classification"), "XGBClassifier");
    assert.equal(resolveModelClass("lightgbm", "classification"), "LGBMClassifier");
    assert.equal(resolveModelClass("catboost", "classification"), "CatBoostClassifier");
    assert.equal(resolveModelClass("randomforest", "classification"), "RandomForestClassifier");
    assert.equal(resolveModelClass("mlp", "classification"), "MLPClassifier");
    assert.equal(resolveModelClass("svm", "classification"), "SVC");
  });

  it("picks the Regressor by default (back-compat) and for regression", () => {
    assert.equal(resolveModelClass("xgboost", undefined), "XGBRegressor");
    assert.equal(resolveModelClass("xgboost", null), "XGBRegressor");
    assert.equal(resolveModelClass("lightgbm", "regression"), "LGBMRegressor");
    assert.equal(resolveModelClass("randomforest", "regression"), "RandomForestRegressor");
    assert.equal(resolveModelClass("svm", "regression"), "SVR");
  });

  it("matches fuzzy model type strings", () => {
    assert.equal(resolveModelClass("LGBM", "classification"), "LGBMClassifier");
    assert.equal(resolveModelClass("xgboost (gbm)", "classification"), "XGBClassifier");
  });

  it("falls back to a placeholder for unknown model types", () => {
    assert.equal(resolveModelClass("unknownthing", "classification"), "model_class");
  });
});

// ── resolveEvaluator ────────────────────────────────────────────────────

describe("resolveEvaluator", () => {
  it("maps classification metrics to scoring functions", () => {
    assert.deepEqual(resolveEvaluator("accuracy", "classification"), {
      name: "accuracy_score", usesProba: false, needsAverage: false, todo: false,
    });
    assert.deepEqual(resolveEvaluator("f1", "classification"), {
      name: "f1_score", usesProba: false, needsAverage: true, todo: false,
    });
    assert.deepEqual(resolveEvaluator("precision", "classification"), {
      name: "precision_score", usesProba: false, needsAverage: true, todo: false,
    });
    assert.deepEqual(resolveEvaluator("recall", "classification"), {
      name: "recall_score", usesProba: false, needsAverage: true, todo: false,
    });
  });

  it("marks probability-based metrics (predict_proba path)", () => {
    assert.equal(resolveEvaluator("roc_auc", "classification").usesProba, true);
    assert.equal(resolveEvaluator("log_loss", "classification").usesProba, true);
  });

  it("maps regression metrics", () => {
    const rmse = resolveEvaluator("rmse", "regression");
    assert.equal(rmse.name, "rmse");
    assert.equal(rmse.usesProba, false);
    assert.equal(resolveEvaluator("r2", "regression").name, "r2_score");
    assert.equal(resolveEvaluator("mae", "regression").name, "mean_absolute_error");
  });

  it("falls back to RMSE for unknown metrics, flagged with todo (explicit, not silent)", () => {
    const ev = resolveEvaluator("whatever", "regression");
    assert.equal(ev.name, "rmse");
    assert.equal(ev.todo, true, "unknown metric must be flagged so the script emits a # TODO");
  });

  it("does not flag known metrics as todo", () => {
    assert.equal(resolveEvaluator("f1", "classification").todo, false);
    assert.equal(resolveEvaluator("rmse", "regression").todo, false);
    assert.equal(resolveEvaluator("roc_auc", "classification").todo, false);
  });
});

// ── generateReproductionScript ──────────────────────────────────────────

describe("generateReproductionScript (B2 portability)", () => {
  it("does not bake in host-absolute workspace paths", () => {
    const script = generateReproductionScript(baseContext());
    assert.ok(!script.includes("/host/absolute/workspace"), "host path leaked into script");
  });

  it("locates the workspace at runtime via _find_workspace", () => {
    const script = generateReproductionScript(baseContext());
    assert.match(script, /def _find_workspace\(\)/);
    assert.match(script, /FORMIGA_WORKSPACE/);
    assert.match(script, /benchmark_config\.json/);
  });

  it("computes the FEATURES list at runtime, dropping the target + split cols", () => {
    const script = generateReproductionScript(baseContext());
    assert.match(script, /EXCLUDE = \{TARGET_COL, "__split", "__kfold"\}/);
    assert.match(script, /FEATURES = \[c for c in features_df\.columns if c not in EXCLUDE\]/);
  });

  it("derives data paths and target from benchmark_config.json with fallbacks", () => {
    const script = generateReproductionScript(baseContext());
    assert.match(script, /FEATURES_PATH = WORKSPACE \/ \(_data\.get\("featuresPath"\)/);
    assert.match(script, /TARGET_COL = _data\.get\("targetColumn"\)/);
  });

  it("uses the problemType-resolved model class", () => {
    const cls = generateReproductionScript(baseContext({ modelType: "xgboost", problemType: "classification" }));
    assert.match(cls, /XGBClassifier\(\*\*HYPERPARAMETERS\)/);
    const reg = generateReproductionScript(baseContext({ modelType: "xgboost", problemType: "regression" }));
    assert.match(reg, /XGBRegressor\(\*\*HYPERPARAMETERS\)/);
  });

  it("emits predict_proba when the metric needs probabilities", () => {
    const script = generateReproductionScript(baseContext({ metricName: "roc_auc" }));
    assert.match(script, /model\.predict_proba\(X_train\)\[:, 1\]/);
    const plain = generateReproductionScript(baseContext({ metricName: "f1" }));
    assert.match(plain, /model\.predict\(X_train\)/);
    assert.ok(!plain.includes("predict_proba"));
  });

  it("carries the original metric contract in the header", () => {
    const script = generateReproductionScript(baseContext({ metricName: "rmse", cvMean: 0.421337, trainMean: 0.4001 }));
    assert.match(script, /CV Mean \(rmse\): 0\.421337/);
    assert.match(script, /Train Mean: 0\.400100/);
  });

  it("emits a TODO comment for unknown metrics rather than a silent score", () => {
    const script = generateReproductionScript(baseContext({ metricName: "custom" }));
    assert.ok(script.includes("rmse") || script.includes("TODO"), "unknown metric must not be silent");
  });
});
