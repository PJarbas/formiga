# Plan: Leaderboard Rich Metrics & Contextual Columns

**Date:** 2026-07-15
**Branch:** `feature/leaderboard-rich-metrics`
**Scope:** Backend schema, ingest pipeline, API serializers, and frontend table rendering
**Status:** Phase 1 in progress

---

## 1. Problem Statement

The current leaderboard has critical UX and architectural gaps:

1. **Single metric only**: The DB schema stores only one `val_metric` float. Classification problems cannot show `f1`, `precision`, `recall`, `roc_auc`. Regression problems cannot show `mae`, `rmse`, `r2`.
2. **Model column shows agent name**: The `modelType` field in the DB often stores the agent identity (e.g., `"modeler-classic"`) instead of the trained model algorithm (e.g., `"XGBClassifier"`).
3. **"Category" column is meaningless**: It always renders `"MODEL_SEL"` for valid rows — it is not a real categorization.
4. **"Best F1" tile repeats `cvMean`**: The F1 stat tile in `StatTiles.tsx` literally copies the accuracy value.
5. **No problem-type awareness**: The UI cannot adapt columns between classification, regression, or multilabel tasks.

---

## 2. Principles Applied

| Principle | Application |
|-----------|-------------|
| **Single Responsibility** | `Experiment` model handles storage; `MetricSet` normalizes access; frontend components adapt to `problemType` |
| **Open/Closed** | New metrics added without touching existing pipeline logic |
| **Don't Repeat Yourself** | Serializer helpers extracted for all new metric fields |
| **Interface Segregation** | Separate optional sub-interfaces for `ClassificationMetrics` and `RegressionMetrics` |
| **KISS** | No abstract metric aggregation layer; explicit fields in Prisma + JSON fallback for niche metrics |

---

## 3. Schema Design

### 3.1 Prisma Model (`prisma/schema.prisma`)

```prisma
model Experiment {
  // ... existing fields preserved ...
  
  // ── Rich metric support (nullable = not applicable for this problem type) ──
  f1_score      Float?
  precision     Float?
  recall        Float?
  roc_auc       Float?
  log_loss      Float?
  mae           Float?
  rmse          Float?
  r2_score      Float?
  
  // Generic JSON bag for future/niche metrics (confusion matrix, per-class, etc.)
  metrics_json  String?  @default("{}")
  
  // Problem type enables UI column adaptation
  problem_type  String?  // "classification" | "regression" | "multilabel"
  
  // Model algorithm (the actual sklearn/xgboost/etc. class name)
  model_algorithm String?
}
```

### 3.2 Database Migration Strategy

SQLite `ALTER TABLE ADD COLUMN` is applied idempotently in `leaderboard/schema.ts` (same pattern used for `promoted_at`, `rejected_at`). A new additive migration block iterates columns to add only those missing.

---

## 4. Ingestion Pipeline (`leaderboard/ingest.ts`)

### 4.1 Sidecar Schema Extension

The sidecar JSON (`artifacts/<agent>_submission.json`) accepts optional rich metric keys:

```ts
const RICH_METRIC_KEYS = [
  "f1_score", "precision", "recall", "roc_auc", "log_loss",
  "mae", "rmse", "r2_score",
] as const;
```

### 4.2 Ingest Logic

1. Parse sidecar for rich metrics (optional — missing = null).
2. Detect `problem_type` from sidecar or infer from metric set:
   - `f1_score/precision/recall/roc_auc` present → `"classification"`
   - `mae/rmse/r2_score` present → `"regression"`
   - Both present or none → keep existing or `"unknown"`
3. Detect `model_algorithm`:
   - Prefer `MODEL_ALGORITHM` key in sidecar
   - Fallback: parse `model_type` for known sklearn/xgboost/lightgbm class names
   - If still unknown, store `"unknown"` (never store agent name here)
4. Store `metrics_json` as serialized JSON for extensibility.

---

## 5. Serialization (`leaderboard/serializers.ts`)

`toExperimentRow()` maps all new Prisma columns to the `ExperimentRow` interface:

```ts
export interface ExperimentRow {
  // ... existing fields ...
  f1Score: number | null;
  precision: number | null;
  recall: number | null;
  rocAuc: number | null;
  logLoss: number | null;
  mae: number | null;
  rmse: number | null;
  r2Score: number | null;
  metricsJson: Record<string, unknown>;
  problemType: string | null;
  modelAlgorithm: string | null;
}
```

---

## 6. Shared Types (`shared/dashboard-types.ts`)

### 6.1 `LeaderboardEntry` Extension

```ts
export interface LeaderboardEntry {
  // ... existing fields ...
  metrics: {
    primary: { name: string; value: number };
    classification?: ClassificationMetrics;
    regression?: RegressionMetrics;
    raw: Record<string, unknown>; // from metrics_json
  };
  problemType: "classification" | "regression" | "multilabel" | "unknown";
  modelAlgorithm: string;
}

interface ClassificationMetrics {
  f1?: number;
  precision?: number;
  recall?: number;
  rocAuc?: number;
  logLoss?: number;
}

interface RegressionMetrics {
  mae?: number;
  rmse?: number;
  r2Score?: number;
}
```

---

## 7. API Layer (`server/dashboard.ts`)

No breaking changes. The `/leaderboard` endpoint already returns `LeaderboardResponse`. Expanded fields are additive. The existing `metricName` on `ArenaSession` still drives the primary sort and display metric.

---

## 8. Frontend Redesign

### 8.1 Column Structure (Dynamic by `problemType`)

| Column | Classification | Regression |
|--------|--------------|-----------|
| # | rank | rank |
| Experiment | modelId | modelId |
| Algorithm | modelAlgorithm | modelAlgorithm |
| Problem | problemType badge | problemType badge |
| Primary Metric | accuracy / f1 (from arena config) | rmse / mae |
| Metric 2 | F1 Score | R² Score |
| Metric 3 | Precision | MAE |
| Metric 4 | Recall | — |
| Metric 5 | ROC-AUC | — |
| ±Std | cvStd | cvStd |
| Overfit Δ | trainValGap | trainValGap |
| Folds | sparkline | sparkline |
| Notes | hypothesis | hypothesis |

### 8.2 `Leaderboard.tsx` Changes

- Replace hardcoded table headers with `getColumnsForProblemType(problemType)` helper.
- Replace `"Model"` column render to use `entry.modelAlgorithm`.
- Replace `"Category"` column with `problemType` badge (pill).
- Add `metricFormatter` per problem type (`.toFixed(4)` vs scientifc for regression).

### 8.3 `StatTiles.tsx` Changes

- Accept the full `LeaderboardEntry[]` instead of just `bestCvMean`.
- Compute tiles based on `problemType`:
  - **Classification**: Best Accuracy, Best F1 (real f1, not cvMean), Experiments, Min Overfit Δ
  - **Regression**: Best RMSE, Best R², Experiments, Min Overfit Δ
- Gap tile renamed from `"MIN GAP"` → `"MIN OVERFIT Δ"` with tooltip.

### 8.4 `AucBarChart.tsx` Renamed → `MetricBarChart.tsx`

- Generic name; still horizontal CSS bars.
- Color by model family using `modelAlgorithm`.

---

## 9. Acceptance Criteria

- [ ] DB schema migration additive and idempotent on SQLite.
- [ ] Sidecar JSON with `F1_SCORE=0.95` is stored in DB and serialized to frontend.
- [ ] `MODEL_ALGORITHM=XGBClassifier` in sidecar renders in Algorithm column, not agent name.
- [ ] Classification run shows: Accuracy, F1, Precision, Recall, ROC-AUC.
- [ ] Regression run shows: RMSE/MAE (primary), R², MAE.
- [ ] Stat tiles show distinct metrics (F1 ≠ Accuracy).
- [ ] Old `metricName` from `arenaSession` still drives sort default.
- [ ] All existing leaderboard tests pass without modification (backward compat).
- [ ] New tests added for ingest of rich metrics.

---

## 10. Files to Touch

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add new columns to `Experiment` |
| `src/leaderboard/schema.ts` | Additive migration block for new columns |
| `src/leaderboard/ingest.ts` | Parse rich metric keys + model_algorithm |
| `src/leaderboard/repository.ts` | Pass new fields through `register()` / `registerArena()` |
| `src/leaderboard/serializers.ts` | Map new Prisma columns to `ExperimentRow` |
| `src/shared/dashboard-types.ts` | Extend `LeaderboardEntry`, add metric sub-types |
| `src/dashboard/src/screens/Leaderboard.tsx` | Dynamic columns by problemType |
| `src/dashboard/src/components/StatTiles.tsx` | Contextual tiles, real F1 |
| `src/dashboard/src/components/AucBarChart.tsx` | Rename → MetricBarChart; use modelAlgorithm |
| `src/dashboard/src/components/ModelDetailPanel.tsx` | Show rich metrics in Overview tab |

---

## 11. Rollback Plan

- Migration is purely additive (nullable columns). No data loss on rollback.
- Frontend gracefully handles `null`/`undefined` new fields (TypeScript optional chaining).
- If critical bug found: revert frontend types to previous version; backend columns remain empty/null — no crash.
