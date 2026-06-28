// ══════════════════════════════════════════════════════════════════════
// repository.ts — Repository pattern for the experiments leaderboard
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import type { PrismaClient } from "@prisma/client";

// ── Row types ────────────────────────────────────────────────────

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

// ── Repository interfaces (ISP) ──────────────────────────────────────────────

export interface LeaderboardReadonly {
  getBestByMetric(runId: string, limit?: number): Promise<ExperimentRow[]>;
  getByRound(runId: string, round: number): Promise<ExperimentRow[]>;
  getByAgent(agentName: string, runId: string): Promise<ExperimentRow[]>;
  getValidated(runId: string): Promise<ExperimentRow[]>;
  getFailedConfigs(agentName: string): Promise<ExperimentRow[]>;
  getBestByDatasetSignature(signature: string, limit?: number): Promise<ExperimentRow[]>;
  getBestInRun(runId: string): Promise<ExperimentRow | null>;
}

export interface LeaderboardRepository extends LeaderboardReadonly {
  register(entry: NewExperiment): Promise<number>;
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

function toExperimentRow(model: {
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
}): ExperimentRow {
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
  };
}

function fromNewExperiment(entry: NewExperiment) {
  return {
    run_id: entry.run_id,
    round_number: entry.round_number,
    agent_name: entry.agent_name,
    model_type: entry.model_type,
    hyperparameters: JSON.stringify(entry.hyperparameters),
    train_metric: entry.train_metric,
    val_metric: entry.val_metric,
    metric_name: entry.metric_name,
    artifact_path: entry.artifact_path,
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
