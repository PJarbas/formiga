// ════════════════════════════════════════════════════════════════════════════
// serializers.ts — Single source of truth for DB → ExperimentRow mapping
// DRY: shared by repository.ts and queries.ts (BUG-8 fix)
// ════════════════════════════════════════════════════════════════════════════

import type { Experiment } from "@prisma/client";
import type { ExperimentRow } from "./repository.js";

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function toExperimentRow(model: Experiment): ExperimentRow {
  return {
    experiment_id:     model.experiment_id,
    run_id:            model.run_id,
    round_number:      model.round_number,
    agent_name:        model.agent_name,
    model_type:        model.model_type,
    model_algorithm:   model.model_algorithm ?? null,
    hyperparameters:   safeJsonParse(model.hyperparameters),
    train_metric:      model.train_metric,
    val_metric:        model.val_metric,
    test_metric:       model.test_metric,
    metric_name:       model.metric_name,
    artifact_path:     model.artifact_path,
    status:            model.status as ExperimentRow["status"],
    error_message:     model.error_message,
    dataset_signature: model.dataset_signature,
    created_at:        model.created_at.toISOString(),
    hypothesis:        model.hypothesis,
    learned:           model.learned,
    next_focus:        model.next_focus,
    measured_metric:   model.measured_metric,
    benchmark_stdout:  model.benchmark_stdout,
    benchmark_stderr:  model.benchmark_stderr,
    benchmark_exit_code: model.benchmark_exit_code,
    confidence_score:  model.confidence_score,
    confidence_band:   model.confidence_band,
    decision:          model.decision,
    duration_ms:       model.duration_ms,
    artifact_script:   model.artifact_script,
    f1_score:          model.f1_score ?? null,
    precision:         model.precision ?? null,
    recall:            model.recall ?? null,
    roc_auc:           model.roc_auc ?? null,
    log_loss:          model.log_loss ?? null,
    mae:               model.mae ?? null,
    rmse:              model.rmse ?? null,
    r2_score:          model.r2_score ?? null,
    metrics_json:      safeJsonParse(model.metrics_json ?? "{}"),
    problem_type:      model.problem_type ?? null,
    // ── Journal/ledger fields ──
    fold_scores:       parseFoldScores(model.fold_scores),
    train_score:       model.train_score ?? null,
    content_hash:      model.content_hash ?? null,
    oof_artifact_key:  model.oof_artifact_key ?? null,
    prod_artifact_key: model.prod_artifact_key ?? null,
    brier_raw:         model.brier_raw ?? null,
    brier_calibrated:  model.brier_calibrated ?? null,
    ece_calibrated:    model.ece_calibrated ?? null,
    notes:             model.notes ?? null,
    verdict_locked_at: model.verdict_locked_at instanceof Date
      ? model.verdict_locked_at.toISOString()
      : (model.verdict_locked_at ?? null),
    iteration_team:    model.iteration_team ?? null,
    category:          model.category ?? null,
  };
}

/** Parse the JSON-encoded fold_scores column back into a number array. */
function parseFoldScores(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v)))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  } catch {
    return null;
  }
}
