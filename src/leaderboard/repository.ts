// ══════════════════════════════════════════════════════════════════════
// repository.ts — Repository pattern for the experiments leaderboard
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import type { PrismaClient } from "@prisma/client";
import type { ConfidenceBand, ArenaDecision } from "../arena/arena-types.js";
export { toExperimentRow } from "./serializers.js";
import { toExperimentRow } from "./serializers.js";

// ── Row types ────────────────────────────────────────────────────

export interface ExperimentRow {
  experiment_id: number;
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  model_algorithm: string | null;
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

  // ── Arena fields (optional until legacy pipelines are removed) ──
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

  // ── Rich metrics ──
  f1_score: number | null;
  precision: number | null;
  recall: number | null;
  roc_auc: number | null;
  log_loss: number | null;
  mae: number | null;
  rmse: number | null;
  r2_score: number | null;
  metrics_json: Record<string, unknown>;
  problem_type: string | null;
}

export interface MetricBag {
  f1_score?: number;
  precision?: number;
  recall?: number;
  roc_auc?: number;
  log_loss?: number;
  mae?: number;
  rmse?: number;
  r2_score?: number;
  [key: string]: unknown;
}

export interface NewExperiment {
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  model_algorithm: string | null;
  hyperparameters: Record<string, unknown>;
  train_metric: number;
  val_metric: number;
  metric_name: string;
  artifact_path: string;
  metric_bag?: MetricBag;
  problem_type?: string | null;
}

export interface ArenaExperiment {
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  model_algorithm?: string | null;
  hyperparameters?: Record<string, unknown>;
  hypothesis?: string;
  learned?: string;
  next_focus?: string;
  measured_metric: number | null;
  train_metric?: number | null;
  benchmark_stdout?: string;
  benchmark_stderr?: string;
  benchmark_exit_code?: number | null;
  confidence_score?: number | null;
  confidence_band?: ConfidenceBand;
  decision?: ArenaDecision;
  duration_ms?: number;
  artifact_script?: string;
  metric_name: string;
  artifact_path: string;
  metric_bag?: MetricBag;
  problem_type?: string | null;
  status?: string;
}

// ── Repository interfaces (ISP) ──────────────────────────────────────────────

export interface LeaderboardReadonly {
  getBestByMetric(runId: string, limit?: number): Promise<ExperimentRow[]>;
  getByRound(runId: string, round: number): Promise<ExperimentRow[]>;
  getByAgent(agentName: string, runId: string): Promise<ExperimentRow[]>;
  getValidated(runId: string): Promise<ExperimentRow[]>;
  getFailedConfigs(agentName: string): Promise<ExperimentRow[]>;
  getBestByDatasetSignature(signature: string, limit?: number): Promise<ExperimentRow[]>;
  getBestInRun(runId: string): Promise<ExperimentRow | null>;
  getArenaResults(runId: string): Promise<ExperimentRow[]>;
}

export interface LeaderboardRepository extends LeaderboardReadonly {
  register(entry: NewExperiment): Promise<number>;
  registerArena(entry: ArenaExperiment): Promise<number>;
  updateTestMetric(experimentId: number, testMetric: number, status: "AUDITED" | "OVERFITTED"): Promise<void>;
  reject(experimentId: number, reason: string): Promise<void>;
  autoAudit(experimentId: number): Promise<void>;
  setDatasetSignature(experimentId: number, signature: string): Promise<void>;
}

// ── Serialization helpers ──────────────────────────────────────────────────

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fromNewExperiment(entry: NewExperiment) {
  const bag = entry.metric_bag ?? {};
  return {
    run_id: entry.run_id,
    round_number: entry.round_number,
    agent_name: entry.agent_name,
    model_type: entry.model_type,
    model_algorithm: entry.model_algorithm,
    hyperparameters: JSON.stringify(entry.hyperparameters),
    train_metric: entry.train_metric,
    val_metric: entry.val_metric,
    metric_name: entry.metric_name,
    artifact_path: entry.artifact_path,
    f1_score: bag.f1_score ?? null,
    precision: bag.precision ?? null,
    recall: bag.recall ?? null,
    roc_auc: bag.roc_auc ?? null,
    log_loss: bag.log_loss ?? null,
    mae: bag.mae ?? null,
    rmse: bag.rmse ?? null,
    r2_score: bag.r2_score ?? null,
    metrics_json: JSON.stringify({}),
    problem_type: entry.problem_type ?? null,
  };
}

function fromArenaExperiment(entry: ArenaExperiment) {
  return {
    run_id: entry.run_id,
    round_number: entry.round_number,
    agent_name: entry.agent_name,
    model_type: entry.model_type ?? "arena_script",
    hyperparameters: JSON.stringify(entry.hyperparameters ?? {}),
    hypothesis: entry.hypothesis ?? null,
    learned: entry.learned ?? null,
    next_focus: entry.next_focus ?? null,
    measured_metric: entry.measured_metric ?? null,
    benchmark_stdout: entry.benchmark_stdout ?? null,
    benchmark_stderr: entry.benchmark_stderr ?? null,
    benchmark_exit_code: entry.benchmark_exit_code ?? null,
    confidence_score: entry.confidence_score ?? null,
    confidence_band: entry.confidence_band ?? null,
    decision: entry.decision ?? null,
    duration_ms: entry.duration_ms ?? null,
    artifact_script: entry.artifact_script ?? null,
    // Map train/val metrics — train_metric is separate when available
    train_metric: entry.train_metric ?? entry.measured_metric ?? 0,
    val_metric: entry.measured_metric ?? 0,
    metric_name: entry.metric_name,
    artifact_path: entry.artifact_path,
    model_algorithm: entry.model_algorithm ?? null,
    f1_score: entry.metric_bag?.f1_score ?? null,
    precision: entry.metric_bag?.precision ?? null,
    recall: entry.metric_bag?.recall ?? null,
    roc_auc: entry.metric_bag?.roc_auc ?? null,
    log_loss: entry.metric_bag?.log_loss ?? null,
    mae: entry.metric_bag?.mae ?? null,
    rmse: entry.metric_bag?.rmse ?? null,
    r2_score: entry.metric_bag?.r2_score ?? null,
    metrics_json: JSON.stringify({}),
    problem_type: entry.problem_type ?? null,
    status: entry.status ?? (entry.benchmark_exit_code === 0 ? "SUCCESS" : (entry.benchmark_exit_code != null ? "FAILED" : "PENDING")),
  };
}

// ── Implementation ──────────────────────────────────────────────────────

export class LeaderboardRepositoryImpl implements LeaderboardRepository {
  private get prisma(): PrismaClient {
    return getPrisma();
  }

  async register(entry: NewExperiment): Promise<number> {
    const created = await this.prisma.experiment.create({
      data: fromNewExperiment(entry),
    });
    return created.experiment_id;
  }

  async registerArena(entry: ArenaExperiment): Promise<number> {
    const created = await this.prisma.experiment.create({
      data: fromArenaExperiment(entry),
    });
    return created.experiment_id;
  }

  async getBestByMetric(runId: string, limit = 10): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: {
        run_id: runId,
        status: { in: ["SUCCESS", "AUDITED"] },
      },
      orderBy: { val_metric: "desc" },
      take: limit,
    });
    return rows.map(toExperimentRow);
  }

  async getByRound(runId: string, round: number): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: { run_id: runId, round_number: round },
      orderBy: { created_at: "asc" },
    });
    return rows.map(toExperimentRow);
  }

  async getByAgent(agentName: string, runId: string): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: { agent_name: agentName, run_id: runId },
      orderBy: { created_at: "desc" },
    });
    return rows.map(toExperimentRow);
  }

  async getValidated(runId: string): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: {
        run_id: runId,
        status: { in: ["SUCCESS", "AUDITED"] },
      },
      orderBy: { val_metric: "desc" },
    });
    return rows.map(toExperimentRow);
  }

  async getFailedConfigs(agentName: string): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: {
        agent_name: agentName,
        status: { in: ["FAILED", "OVERFITTED"] },
      },
      orderBy: { created_at: "desc" },
    });
    return rows.map(toExperimentRow);
  }

  async getBestByDatasetSignature(
    signature: string,
    limit = 5,
  ): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: {
        dataset_signature: signature,
        status: { in: ["SUCCESS", "AUDITED"] },
      },
      orderBy: { val_metric: "desc" },
      take: limit,
    });
    return rows.map(toExperimentRow);
  }

  async getBestInRun(runId: string): Promise<ExperimentRow | null> {
    const row = await this.prisma.experiment.findFirst({
      where: {
        run_id: runId,
        status: { in: ["SUCCESS", "AUDITED"] },
      },
      orderBy: { val_metric: "desc" },
    });
    return row ? toExperimentRow(row) : null;
  }

  async getArenaResults(runId: string): Promise<ExperimentRow[]> {
    const rows = await this.prisma.experiment.findMany({
      where: { run_id: runId },
      orderBy: [
        { round_number: "asc" },
        { val_metric: "desc" },
      ],
    });
    return rows.map(toExperimentRow);
  }

  async updateTestMetric(
    experimentId: number,
    testMetric: number,
    status: "AUDITED" | "OVERFITTED",
  ): Promise<void> {
    await this.prisma.experiment.update({
      where: { experiment_id: experimentId },
      data: { test_metric: testMetric, status },
    });
  }

  async reject(experimentId: number, reason: string): Promise<void> {
    await this.prisma.experiment.update({
      where: { experiment_id: experimentId },
      data: { status: "FAILED", error_message: reason },
    });
  }

  async autoAudit(experimentId: number): Promise<void> {
    await this.prisma.experiment.updateMany({
      where: { experiment_id: experimentId, status: "SUCCESS" },
      data: { status: "AUDITED" },
    });
  }

  async setDatasetSignature(
    experimentId: number,
    signature: string,
  ): Promise<void> {
    await this.prisma.experiment.update({
      where: { experiment_id: experimentId },
      data: { dataset_signature: signature },
    });
  }
}
