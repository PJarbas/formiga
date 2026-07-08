// ══════════════════════════════════════════════════════════════════════
// serializers.ts — Single source of truth for DB → ExperimentRow mapping
// DRY: shared by repository.ts and queries.ts (BUG-8 fix)
// ══════════════════════════════════════════════════════════════════════

import type { ExperimentRow } from "./repository.js";

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Shape of a Prisma Experiment model — keeps serializer decoupled from Prisma types. */
export interface PrismaExperimentModel {
  experiment_id: number;
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  hyperparameters: string;
  train_metric: number;
  val_metric: number;
  test_metric: number | null;
  metric_name: string;
  artifact_path: string;
  status: string;
  error_message: string | null;
  dataset_signature: string | null;
  created_at: Date;
  hypothesis: string | null;
  learned: string | null;
  next_focus: string | null;
  measured_metric: number | null;
  benchmark_stdout: string | null;
  benchmark_stderr: string | null;
  benchmark_exit_code: number | null;
  confidence_score: number | null;
  confidence_band: string | null;
  decision: string | null;
  duration_ms: number | null;
  artifact_script: string | null;
}

export function toExperimentRow(model: PrismaExperimentModel): ExperimentRow {
  return {
    experiment_id: model.experiment_id,
    run_id: model.run_id,
    round_number: model.round_number,
    agent_name: model.agent_name,
    model_type: model.model_type,
    hyperparameters: safeJsonParse(model.hyperparameters),
    train_metric: model.train_metric,
    val_metric: model.val_metric,
    test_metric: model.test_metric,
    metric_name: model.metric_name,
    artifact_path: model.artifact_path,
    status: model.status as ExperimentRow["status"],
    error_message: model.error_message,
    dataset_signature: model.dataset_signature,
    created_at: model.created_at.toISOString(),
    hypothesis: model.hypothesis,
    learned: model.learned,
    next_focus: model.next_focus,
    measured_metric: model.measured_metric,
    benchmark_stdout: model.benchmark_stdout,
    benchmark_stderr: model.benchmark_stderr,
    benchmark_exit_code: model.benchmark_exit_code,
    confidence_score: model.confidence_score,
    confidence_band: model.confidence_band,
    decision: model.decision,
    duration_ms: model.duration_ms,
    artifact_script: model.artifact_script,
  };
}