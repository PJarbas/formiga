// ═══════════════════════════════════════════════════════════════════════
// arena-repository.ts — CRUD for ArenaSession + integration with Experiment
// Follows ISP (interface segregation) just like LeaderboardRepository.
// ═══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import type { PrismaClient } from "@prisma/client";
import type {
  ArenaSession,
  ArenaConfig,
  MetricDirection,
  ArenaStatus,
  ConfidenceBand,
  ArenaDecision,
} from "./arena-types.js";

// ── Row helpers ────────────────────────────────────────────────────────

function toModel(session: ArenaSession) {
  return {
    id: session.id,
    run_id: session.runId,
    metric_name: session.metricName,
    metric_direction: session.metricDirection,
    benchmark_script: session.benchmarkScript ?? "",
    checks_script: session.checksScript ?? null,
    target_metric: session.targetMetric,
    max_rounds: session.maxRounds,
    max_no_improve: session.maxNoImprove,
    current_round: session.currentRound,
    best_metric: session.bestMetric,
    best_agent: session.bestAgent,
    best_experiment_id: session.bestExperimentId,
    baseline_metric: session.baselineMetric,
    noise_floor_mad: session.noiseFloorMad,
    status: session.status,
    total_keep: session.totalKeep,
    total_discard: session.totalDiscard,
    total_crash: session.totalCrash,
    total_checks_failed: session.totalChecksFailed,
    consecutive_no_improve: session.consecutiveNoImprove,
    created_at: new Date(session.createdAt),
    updated_at: new Date(session.updatedAt),
  };
}

function fromModel(model: {
  id: string;
  run_id: string;
  metric_name: string;
  metric_direction: string;
  benchmark_script: string;
  checks_script: string | null;
  target_metric: number | null;
  max_rounds: number;
  max_no_improve: number;
  current_round: number;
  best_metric: number | null;
  best_agent: string | null;
  best_experiment_id: number | null;
  baseline_metric: number | null;
  noise_floor_mad: number | null;
  status: string;
  total_keep: number;
  total_discard: number;
  total_crash: number;
  total_checks_failed: number;
  consecutive_no_improve: number;
  created_at: Date;
  updated_at: Date;
}): ArenaSession {
  return {
    id: model.id,
    runId: model.run_id,
    metricName: model.metric_name,
    metricDirection: model.metric_direction as MetricDirection,
    benchmarkScript: model.benchmark_script || null,
    checksScript: model.checks_script,
    targetMetric: model.target_metric,
    maxRounds: model.max_rounds,
    maxNoImprove: model.max_no_improve,
    currentRound: model.current_round,
    bestMetric: model.best_metric,
    bestAgent: model.best_agent,
    bestExperimentId: model.best_experiment_id,
    baselineMetric: model.baseline_metric,
    noiseFloorMad: model.noise_floor_mad,
    status: model.status as ArenaStatus,
    totalKeep: model.total_keep,
    totalDiscard: model.total_discard,
    totalCrash: model.total_crash,
    totalChecksFailed: model.total_checks_failed,
    consecutiveNoImprove: model.consecutive_no_improve,
    createdAt: model.created_at.toISOString(),
    updatedAt: model.updated_at.toISOString(),
  };
}

// ── Repository interface (ISP) ──────────────────────────────────────────

export interface ArenaReadonly {
  getByRunId(runId: string): Promise<ArenaSession | null>;
  getById(id: string): Promise<ArenaSession | null>;
}

export interface ArenaRepository extends ArenaReadonly {
  createFromConfig(runId: string, config: ArenaConfig): Promise<ArenaSession>;
  update(session: ArenaSession): Promise<void>;
  updateRound(
    id: string,
    currentRound: number,
    bestMetric: number | null,
    bestAgent: string | null,
    bestExperimentId: number | null,
    consecutiveNoImprove: number,
  ): Promise<void>;
  updateStats(
    id: string,
    decision: ArenaDecision,
  ): Promise<void>;
  finalize(id: string, status: ArenaStatus): Promise<void>;
  setBaseline(id: string, baselineMetric: number): Promise<void>;
  setNoiseFloor(id: string, noiseFloorMad: number): Promise<void>;
}

// ── Prisma implementation ─────────────────────────────────────────────

export class ArenaRepositoryImpl implements ArenaRepository {
  private get prisma(): PrismaClient {
    return getPrisma();
  }

  async getByRunId(runId: string): Promise<ArenaSession | null> {
    const row = await this.prisma.arenaSession.findUnique({
      where: { run_id: runId },
    });
    return row ? fromModel(row) : null;
  }

  async getById(id: string): Promise<ArenaSession | null> {
    const row = await this.prisma.arenaSession.findUnique({
      where: { id },
    });
    return row ? fromModel(row) : null;
  }

  async createFromConfig(runId: string, config: ArenaConfig): Promise<ArenaSession> {
    const created = await this.prisma.arenaSession.create({
      data: {
        run_id: runId,
        metric_name: config.metricName,
        metric_direction: config.metricDirection,
        benchmark_script: config.benchmarkScript ?? "",
        checks_script: config.checksScript ?? null,
        target_metric: config.targetMetric ?? null,
        max_rounds: config.maxRounds,
        max_no_improve: config.maxNoImprove,
        status: "running",
        current_round: 0,
        total_keep: 0,
        total_discard: 0,
        total_crash: 0,
        total_checks_failed: 0,
        consecutive_no_improve: 0,
      },
    });
    return fromModel(created);
  }

  async update(session: ArenaSession): Promise<void> {
    await this.prisma.arenaSession.update({
      where: { id: session.id },
      data: toModel(session),
    });
  }

  async updateRound(
    id: string,
    currentRound: number,
    bestMetric: number | null,
    bestAgent: string | null,
    bestExperimentId: number | null,
    consecutiveNoImprove: number,
  ): Promise<void> {
    await this.prisma.arenaSession.update({
      where: { id },
      data: {
        current_round: currentRound,
        best_metric: bestMetric,
        best_agent: bestAgent,
        best_experiment_id: bestExperimentId,
        consecutive_no_improve: consecutiveNoImprove,
      },
    });
  }

  async updateStats(
    id: string,
    decision: ArenaDecision,
  ): Promise<void> {
    const row = await this.prisma.arenaSession.findUnique({ where: { id }, select: {
      total_keep: true, total_discard: true, total_crash: true, total_checks_failed: true,
    }});
    if (!row) return;
    const data: Record<string, number> = {};
    if (decision === "keep" || decision === "baseline") data.total_keep = row.total_keep + 1;
    else if (decision === "discard") data.total_discard = row.total_discard + 1;
    else if (decision === "crash") data.total_crash = row.total_crash + 1;
    else if (decision === "checks_failed") data.total_checks_failed = row.total_checks_failed + 1;

    await this.prisma.arenaSession.update({
      where: { id },
      data,
    });
  }

  async finalize(id: string, status: ArenaStatus): Promise<void> {
    await this.prisma.arenaSession.update({
      where: { id },
      data: { status },
    });
  }

  async setBaseline(id: string, baselineMetric: number): Promise<void> {
    await this.prisma.arenaSession.update({
      where: { id },
      data: {
        baseline_metric: baselineMetric,
        best_metric: baselineMetric,
      },
    });
  }

  async setNoiseFloor(id: string, noiseFloorMad: number): Promise<void> {
    await this.prisma.arenaSession.update({
      where: { id },
      data: { noise_floor_mad: noiseFloorMad },
    });
  }
}
