// ══════════════════════════════════════════════════════════════════════
// repository.ts — Repository pattern for the experiments leaderboard
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";

// ── Row types ────────────────────────────────────────────────────────

export interface ExperimentRow {
  experiment_id: number;
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  hyperparameters: Record<string, unknown>;
  train_metric: number;
  val_metric: number;
  test_metric: number | null;
  metric_name: string;
  artifact_path: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "AUDITED" | "OVERFITTED";
  error_message: string | null;
  dataset_signature: string | null;
  created_at: string;
}

export interface NewExperiment {
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  hyperparameters: Record<string, unknown>;
  train_metric: number;
  val_metric: number;
  metric_name: string;
  artifact_path: string;
}

// ── Repository interfaces (ISP) ──────────────────────────────────────

export interface LeaderboardReadonly {
  getBestByMetric(runId: string, limit?: number): ExperimentRow[];
  getByRound(runId: string, round: number): ExperimentRow[];
  getByAgent(agentName: string, runId: string): ExperimentRow[];
  getValidated(runId: string): ExperimentRow[];
  getFailedConfigs(agentName: string): ExperimentRow[];
  getBestByDatasetSignature(signature: string, limit?: number): ExperimentRow[];
  getBestInRun(runId: string): ExperimentRow | undefined;
}

export interface LeaderboardRepository extends LeaderboardReadonly {
  register(entry: NewExperiment): number;
  updateTestMetric(experimentId: number, testMetric: number, status: "AUDITED" | "OVERFITTED"): void;
  reject(experimentId: number, reason: string): void;
  autoAudit(experimentId: number): void;
  setDatasetSignature(experimentId: number, signature: string): void;
}

// ── Implementation ───────────────────────────────────────────────────

function deserializeRow(raw: Record<string, unknown>): ExperimentRow {
  return {
    experiment_id: Number(raw.experiment_id),
    run_id: raw.run_id as string,
    round_number: Number(raw.round_number),
    agent_name: raw.agent_name as string,
    model_type: raw.model_type as string,
    hyperparameters: safeJsonParse(raw.hyperparameters as string),
    train_metric: Number(raw.train_metric),
    val_metric: Number(raw.val_metric),
    test_metric: raw.test_metric != null ? Number(raw.test_metric) : null,
    metric_name: raw.metric_name as string,
    artifact_path: raw.artifact_path as string,
    status: raw.status as ExperimentRow["status"],
    error_message: raw.error_message != null ? (raw.error_message as string) : null,
    dataset_signature: raw.dataset_signature != null ? (raw.dataset_signature as string) : null,
    created_at: raw.created_at as string,
  };
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class LeaderboardRepositoryImpl implements LeaderboardRepository {
  constructor(private db: DatabaseSync) {}

  register(entry: NewExperiment): number {
    const result = this.db
      .prepare(
        `INSERT INTO experiments
         (run_id, round_number, agent_name, model_type, hyperparameters,
          train_metric, val_metric, metric_name, artifact_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.run_id,
        entry.round_number,
        entry.agent_name,
        entry.model_type,
        JSON.stringify(entry.hyperparameters),
        entry.train_metric,
        entry.val_metric,
        entry.metric_name,
        entry.artifact_path,
      );
    return Number(result.lastInsertRowid);
  }

  getBestByMetric(runId: string, limit = 10): ExperimentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM experiments
         WHERE run_id = ? AND status IN ('SUCCESS','AUDITED')
         ORDER BY val_metric DESC LIMIT ?`,
      )
      .all(runId, limit) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  getByRound(runId: string, round: number): ExperimentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments WHERE run_id = ? AND round_number = ? ORDER BY created_at ASC")
      .all(runId, round) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  getByAgent(agentName: string, runId: string): ExperimentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments WHERE agent_name = ? AND run_id = ? ORDER BY created_at DESC")
      .all(agentName, runId) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  getValidated(runId: string): ExperimentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments WHERE run_id = ? AND status IN ('SUCCESS','AUDITED') ORDER BY val_metric DESC")
      .all(runId) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  getFailedConfigs(agentName: string): ExperimentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments WHERE agent_name = ? AND status IN ('FAILED','OVERFITTED') ORDER BY created_at DESC")
      .all(agentName) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  updateTestMetric(experimentId: number, testMetric: number, status: "AUDITED" | "OVERFITTED"): void {
    this.db
      .prepare("UPDATE experiments SET test_metric = ?, status = ? WHERE experiment_id = ?")
      .run(testMetric, status, experimentId);
  }

  reject(experimentId: number, reason: string): void {
    this.db
      .prepare("UPDATE experiments SET status = 'FAILED', error_message = ? WHERE experiment_id = ?")
      .run(reason, experimentId);
  }

  autoAudit(experimentId: number): void {
    this.db
      .prepare("UPDATE experiments SET status = 'AUDITED' WHERE experiment_id = ? AND status = 'SUCCESS'")
      .run(experimentId);
  }

  setDatasetSignature(experimentId: number, signature: string): void {
    this.db
      .prepare("UPDATE experiments SET dataset_signature = ? WHERE experiment_id = ?")
      .run(signature, experimentId);
  }

  getBestByDatasetSignature(signature: string, limit = 5): ExperimentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM experiments
         WHERE dataset_signature = ? AND status IN ('SUCCESS','AUDITED')
         ORDER BY val_metric DESC LIMIT ?`,
      )
      .all(signature, limit) as Record<string, unknown>[];
    return rows.map(deserializeRow);
  }

  getBestInRun(runId: string): ExperimentRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM experiments
         WHERE run_id = ? AND status IN ('SUCCESS','AUDITED')
         ORDER BY val_metric DESC LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? deserializeRow(row) : undefined;
  }
}
