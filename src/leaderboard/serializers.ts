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
  };
}
