// ══════════════════════════════════════════════════════════════════════
// script-templates.ts — Python reproduction script generator
//
// B2: the generated script is now *portable* — no host-absolute paths are
// baked in. It locates the workspace at runtime by searching for
// benchmark_config.json (FORMIGA_WORKSPACE env → cwd → parents), derives the
// data paths (features/split) and target column from that config, and
// computes the FEATURES list at runtime by dropping the target + split helper
// columns — the legacy `FEATURES` sidecar does not exist on real runs.
// Model class and evaluator are resolved against problemType.
// ══════════════════════════════════════════════════════════════════════

export interface ScriptContext {
  experimentId: string;
  modelType: string;
  hyperparameters: Record<string, unknown>;
  cvMean: number;
  trainMean: number;
  artifactPath: string;
  metricName: string;
  features: string[];
  workspacePath: string;
  /** "classification" | "regression" | null — default regression (back-compat). */
  problemType?: string | null;
}

const MODEL_IMPORTS: Record<string, string> = {
  xgboost: "from xgboost import XGBRegressor, XGBClassifier",
  lightgbm: "from lightgbm import LGBMRegressor, LGBMClassifier",
  catboost: "from catboost import CatBoostRegressor, CatBoostClassifier",
  ridge: "from sklearn.linear_model import Ridge",
  lasso: "from sklearn.linear_model import Lasso",
  elasticnet: "from sklearn.linear_model import ElasticNet",
  randomforest: "from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier",
  gradientboosting: "from sklearn.ensemble import GradientBoostingRegressor, GradientBoostingClassifier",
  mlp: "from sklearn.neural_network import MLPRegressor, MLPClassifier",
  svm: "from sklearn.svm import SVR, SVC",
};

function resolveModelImport(modelType: string): string {
  const key = modelType.toLowerCase().replace(/[^a-z]/g, "");
  for (const [k, v] of Object.entries(MODEL_IMPORTS)) {
    if (key.includes(k)) return v;
  }
  return `# TODO: add import for "${modelType}"`;
}

/**
 * Resolve the model *class* name for the given model type and problem type.
 * The arena modelers produce scripts whose model_type is often a bare
 * "xgboost"/"lightgbm"/... — a classification dataset must not be fit with a
 * Regressor. Defaults to the Regressor branch for unknown problem types
 * (back-compat with the pre-B2 behavior).
 */
function resolveModelClass(modelType: string, problemType?: string | null): string {
  const key = modelType.toLowerCase().replace(/[^a-z]/g, "");
  const isClassification = problemType?.toLowerCase() === "classification";
  if (key.includes("xgboost") || key.includes("xgb")) return isClassification ? "XGBClassifier" : "XGBRegressor";
  if (key.includes("lightgbm") || key.includes("lgbm")) return isClassification ? "LGBMClassifier" : "LGBMRegressor";
  if (key.includes("catboost")) return isClassification ? "CatBoostClassifier" : "CatBoostRegressor";
  if (key.includes("ridge")) return "Ridge";
  if (key.includes("lasso")) return "Lasso";
  if (key.includes("elasticnet")) return "ElasticNet";
  if (key.includes("randomforest")) return isClassification ? "RandomForestClassifier" : "RandomForestRegressor";
  if (key.includes("gradientboosting")) return isClassification ? "GradientBoostingClassifier" : "GradientBoostingRegressor";
  if (key.includes("mlp")) return isClassification ? "MLPClassifier" : "MLPRegressor";
  if (key.includes("svm") || key.includes("svc") || key.includes("svr")) return isClassification ? "SVC" : "SVR";
  return "model_class";
}

/**
 * Resolve the sklearn evaluator for the configured metric.
 *
 * Returns `{ name, usesProba, needsAverage }`:
 * - `usesProba` — roc_auc/log_loss score class probabilities, so the
 *   reproduction script must call `predict_proba(...)[:, 1]` instead of
 *   `predict(...)`.
 * - `needsAverage` — multiclass-safe scoring with `average="macro"`.
 */
function resolveEvaluator(
  metricName: string,
  problemType?: string | null,
): { name: string; usesProba: boolean; needsAverage: boolean } {
  const mn = metricName.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const isClassification = problemType?.toLowerCase() === "classification";

  if (mn === "accuracy") return { name: "accuracy_score", usesProba: false, needsAverage: false };
  if (["f1", "f1_score", "f1_macro"].includes(mn)) return { name: "f1_score", usesProba: false, needsAverage: true };
  if (mn === "precision") return { name: "precision_score", usesProba: false, needsAverage: true };
  if (mn === "recall") return { name: "recall_score", usesProba: false, needsAverage: true };
  if (["roc_auc", "auc"].includes(mn)) return { name: "roc_auc_score", usesProba: true, needsAverage: false };
  if (["log_loss", "logloss"].includes(mn)) return { name: "log_loss", usesProba: true, needsAverage: false };

  // Regression metrics — used regardless of problemType for regression
  // datasets, but also as the default fallback when the metric is unknown.
  if (mn === "rmse") return { name: "rmse", usesProba: false, needsAverage: false };
  if (!isClassification && (mn === "mse" || mn === "mean_squared_error")) {
    return { name: "mean_squared_error", usesProba: false, needsAverage: false };
  }
  if (["mae", "mean_absolute_error"].includes(mn)) {
    return { name: "mean_absolute_error", usesProba: false, needsAverage: false };
  }
  if (["r2", "r2_score"].includes(mn)) return { name: "r2_score", usesProba: false, needsAverage: false };

  // Unknown metric — fall back to RMSE/R² with an explicit TODO so the user
  // can see the metric was not mapped, rather than silently scoring wrong.
  return { name: "rmse", usesProba: false, needsAverage: false };
}

/** Python fragment computing the configured metric on (y_true, preds). */
function evaluatorExpr(metricName: string, problemType?: string | null): string {
  const ev = resolveEvaluator(metricName, problemType);
  if (ev.name === "rmse") return `float(np.sqrt(mean_squared_error(y_true, preds)))`;
  const avg = ev.needsAverage ? ', average="macro", zero_division=0' : "";
  return `${ev.name}(y_true, preds${avg})`;
}

const SKLEARN_METRICS_IMPORT =
  "from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score, log_loss, mean_squared_error, mean_absolute_error, r2_score";

export function generateReproductionScript(ctx: ScriptContext): string {
  const hpJson = JSON.stringify(ctx.hyperparameters, null, 2);
  const modelImport = resolveModelImport(ctx.modelType);
  const modelClass = resolveModelClass(ctx.modelType, ctx.problemType);
  const usesProba = resolveEvaluator(ctx.metricName, ctx.problemType).usesProba;
  const metricExpr = evaluatorExpr(ctx.metricName, ctx.problemType);

  const predictionLine = usesProba
    ? `pred_train = model.predict_proba(X_train)[:, 1]\npred_val = model.predict_proba(X_val)[:, 1]`
    : `pred_train = model.predict(X_train)\npred_val = model.predict(X_val)`;

  return `"""
Reproduction script for ${ctx.modelType} (Experiment #${ctx.experimentId})
Generated by Formiga ML Pipeline

Original metrics:
  CV Mean (${ctx.metricName}): ${ctx.cvMean.toFixed(6)}
  Train Mean: ${ctx.trainMean.toFixed(6)}
"""

import json
import os
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
${modelImport}
${SKLEARN_METRICS_IMPORT}

# ── Configuration ─────────────────────────────────────────────────────
def _find_workspace():
    """Locate the workspace by searching for benchmark_config.json."""
    candidates = [os.environ.get("FORMIGA_WORKSPACE"), str(Path.cwd())]
    for start in candidates:
        if not start:
            continue
        p = Path(start)
        for d in [p, *p.parents]:
            if (d / "benchmark_config.json").exists():
                return d
    return Path(os.environ.get("FORMIGA_WORKSPACE") or Path.cwd())

WORKSPACE = _find_workspace()

with open(WORKSPACE / "benchmark_config.json", encoding="utf-8") as f:
    CONFIG = json.load(f)

MODEL_ARTIFACT = WORKSPACE / "${ctx.artifactPath}"

# Data paths and target come from benchmark_config.json, with conventional
# fallbacks — no host-absolute paths baked in.
_data = CONFIG.get("data", {}) or {}
_data_paths = CONFIG.get("data_paths", {}) or {}
FEATURES_PATH = WORKSPACE / (_data.get("featuresPath") or _data_paths.get("features") or "artifacts/features.parquet")
SPLIT_PATH = WORKSPACE / (_data.get("splitPath") or _data_paths.get("split") or "artifacts/split.pkl")
TARGET_COL = _data.get("targetColumn") or CONFIG.get("target_column") or _data.get("target_column") or "target"

HYPERPARAMETERS = ${hpJson}

METRIC = "${ctx.metricName}"

# ── Load data ─────────────────────────────────────────────────────────
features_df = pd.read_parquet(FEATURES_PATH)

with open(SPLIT_PATH, "rb") as f:
    split = pickle.load(f)

train_idx = split["train_idx"] if "train_idx" in split else split.get("train", [])
val_idx = split["val_idx"] if "val_idx" in split else split.get("val", [])

# FEATURES are computed at runtime by dropping the target + split helper
# columns — the legacy FEATURES sidecar does not exist on real runs.
EXCLUDE = {TARGET_COL, "__split", "__kfold"}
FEATURES = [c for c in features_df.columns if c not in EXCLUDE]
X = features_df[FEATURES]
y = features_df[TARGET_COL]

X_train, y_train = X.iloc[train_idx], y.iloc[train_idx]
X_val, y_val = X.iloc[val_idx], y.iloc[val_idx]

# ── Option A: Load pre-trained model ──────────────────────────────────
if MODEL_ARTIFACT.exists():
    with open(MODEL_ARTIFACT, "rb") as f:
        model = pickle.load(f)
    print(f"Loaded model from {MODEL_ARTIFACT}")
else:
    print(f"Artifact not found at {MODEL_ARTIFACT}, training from scratch...")
    # ── Option B: Train from scratch ──────────────────────────────────
    model = ${modelClass}(**HYPERPARAMETERS)
    model.fit(X_train, y_train)

# ── Evaluate ──────────────────────────────────────────────────────────
def _score(y_true, preds):
    return ${metricExpr}

${predictionLine}

train_metric = _score(y_train, pred_train)
val_metric = _score(y_val, pred_val)

print(f"\\nResults:")
print(f"  Train {METRIC}: {train_metric:.6f}")
print(f"  Val {METRIC}:   {val_metric:.6f}")
print(f"\\nExpected CV Mean (${ctx.metricName}): ${ctx.cvMean.toFixed(6)}")
`;
}

/**
 * B1 — preamble prepended to the real arena modeler script when reproducing
 * from `artifact_script`. It locates the workspace portably, injects
 * FORMIGA_WORKSPACE, and defines a metric-aware `formiga_repro_score` helper —
 * nothing that would clobber the modeler script's own bindings (the modeler
 * script trains/evaluates against the workspace itself).
 */
export function buildReproductionPreamble(ctx: ScriptContext): string {
  return `"""
Reproduction of ${ctx.modelType} (Experiment #${ctx.experimentId}) — arena script.
Generated by Formiga ML Pipeline

Original metrics:
  CV Mean (${ctx.metricName}): ${ctx.cvMean.toFixed(6)}
  Train Mean: ${ctx.trainMean.toFixed(6)}
"""

import json
import os
from pathlib import Path

import numpy as np
${SKLEARN_METRICS_IMPORT}

def _find_workspace():
    """Locate the workspace by searching for benchmark_config.json."""
    candidates = [os.environ.get("FORMIGA_WORKSPACE"), str(Path.cwd())]
    for start in candidates:
        if not start:
            continue
        p = Path(start)
        for d in [p, *p.parents]:
            if (d / "benchmark_config.json").exists():
                return d
    return Path(os.environ.get("FORMIGA_WORKSPACE") or Path.cwd())

os.environ.setdefault("FORMIGA_WORKSPACE", str(_find_workspace()))
WORKSPACE = Path(os.environ["FORMIGA_WORKSPACE"])

# Metric-aware evaluator mirroring the benchmark contract. The modeler script
# below was authored to run inside this workspace; reuse this helper to score
# the trained model against the configured metric.
def formiga_repro_score(y_true, preds, metric="${ctx.metricName}"):
    m = str(metric).lower().replace("-", "_").replace(" ", "_")
    if m in ("accuracy",):
        return accuracy_score(y_true, preds)
    if m in ("f1", "f1_score", "f1_macro"):
        return f1_score(y_true, preds, average="macro", zero_division=0)
    if m in ("precision",):
        return precision_score(y_true, preds, average="macro", zero_division=0)
    if m in ("recall",):
        return recall_score(y_true, preds, average="macro", zero_division=0)
    if m in ("roc_auc", "auc"):
        return roc_auc_score(y_true, preds)
    if m in ("log_loss", "logloss"):
        return log_loss(y_true, preds)
    if m in ("rmse",):
        return float(np.sqrt(mean_squared_error(y_true, preds)))
    if m in ("mse", "mean_squared_error"):
        return float(mean_squared_error(y_true, preds))
    if m in ("mae", "mean_absolute_error"):
        return float(mean_absolute_error(y_true, preds))
    if m in ("r2", "r2_score"):
        return float(r2_score(y_true, preds))
    # Unknown metric — explicit TODO rather than a silent wrong score.
    return float(np.sqrt(mean_squared_error(y_true, preds)))

# ── Arena modeler script (original, verbatim) ─────────────────────────
`;
}
