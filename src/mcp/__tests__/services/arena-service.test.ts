// ══════════════════════════════════════════════════════════════════════
// arena-service.test.ts — Unit tests for ArenaService row→view mapping
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArenaService } from "../../services/arena-service.js";
import type { ArenaReadonly } from "../../../arena/arena-repository.js";
import type { LeaderboardReadonly, ExperimentRow } from "../../../leaderboard/repository.js";
import type { ArenaSession } from "../../../arena/arena-types.js";

function makeSession(overrides: Partial<ArenaSession> = {}): ArenaSession {
  return {
    id: "sess-1",
    runId: "run-1",
    metricName: "auc",
    metricDirection: "higher",
    benchmarkScript: null,
    checksScript: null,
    targetMetric: 0.85,
    maxRounds: 5,
    maxNoImprove: 3,
    currentRound: 3,
    bestMetric: 0.812,
    bestAgent: "modeler-classic",
    bestExperimentId: 7,
    baselineMetric: 0.7234,
    noiseFloorMad: null,
    status: "running",
    totalKeep: 4,
    totalDiscard: 2,
    totalCrash: 0,
    totalChecksFailed: 0,
    consecutiveNoImprove: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:10:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<ExperimentRow> = {}): ExperimentRow {
  return {
    experiment_id: 7,
    run_id: "run-1",
    round_number: 3,
    agent_name: "modeler-classic",
    model_type: "lightgbm",
    model_algorithm: null,
    hyperparameters: {},
    train_metric: 0.84,
    val_metric: 0.812,
    test_metric: null,
    metric_name: "auc",
    artifact_path: "artifacts/x.pkl",
    status: "AUDITED",
    error_message: null,
    dataset_signature: null,
    created_at: "2026-07-25T00:10:00.000Z",
    hypothesis: "L2 reg",
    learned: "early stopping",
    next_focus: null,
    measured_metric: 0.812,
    benchmark_stdout: null,
    benchmark_stderr: null,
    benchmark_exit_code: 0,
    confidence_score: 0.8,
    confidence_band: "high",
    decision: "keep",
    duration_ms: 47000,
    artifact_script: null,
    f1_score: null,
    precision: null,
    recall: null,
    roc_auc: null,
    log_loss: null,
    mae: null,
    rmse: null,
    r2_score: null,
    metrics_json: {},
    problem_type: "classification",
    fold_scores: null,
    train_score: null,
    content_hash: null,
    oof_artifact_key: null,
    prod_artifact_key: null,
    brier_raw: null,
    brier_calibrated: null,
    ece_calibrated: null,
    notes: null,
    verdict_locked_at: null,
    iteration_team: null,
    category: null,
    ...overrides,
  };
}

describe("ArenaService", () => {
  let arenaRepo: ArenaReadonly;
  let leaderboardRepo: LeaderboardReadonly;
  let service: ArenaService;

  beforeEach(() => {
    arenaRepo = { getByRunId: vi.fn(), getById: vi.fn() };
    leaderboardRepo = {
      getBestByMetric: vi.fn(),
      getByRound: vi.fn(),
      getByAgent: vi.fn(),
      getValidated: vi.fn(),
      getFailedConfigs: vi.fn(),
      getBestByDatasetSignature: vi.fn(),
      getBestInRun: vi.fn(),
      getArenaResults: vi.fn(),
    };
    service = new ArenaService(arenaRepo, leaderboardRepo);
  });

  describe("getSession", () => {
    it("maps ArenaSession to the read model", async () => {
      (arenaRepo.getByRunId as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
      const session = await service.getSession("run-1");
      expect(session).not.toBeNull();
      expect(session!.bestMetric).toBe(0.812);
      expect(session!.bestAgent).toBe("modeler-classic");
      expect(session!.totalKeep).toBe(4);
      expect(session!.metricDirection).toBe("higher");
    });

    it("returns null when no session exists", async () => {
      (arenaRepo.getByRunId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      expect(await service.getSession("missing")).toBeNull();
    });
  });

  describe("getRounds", () => {
    it("groups experiments by round and sorts ascending", async () => {
      (leaderboardRepo.getArenaResults as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeRow({ experiment_id: 7, round_number: 3, measured_metric: 0.812, val_metric: 0.812 }),
        makeRow({ experiment_id: 3, round_number: 1, measured_metric: 0.7234, val_metric: 0.7234, agent_name: "baseline" }),
        makeRow({ experiment_id: 5, round_number: 1, measured_metric: null, val_metric: 0.70, agent_name: "modeler-advanced", decision: "discard" }),
      ]);
      const rounds = await service.getRounds("run-1");
      expect(rounds.map((r) => r.round)).toEqual([1, 3]);
      expect(rounds[0].experiments).toHaveLength(2);
      expect(rounds[1].experiments[0].metric).toBe(0.812);
    });

    it("falls back to val_metric when measured_metric is null", async () => {
      (leaderboardRepo.getArenaResults as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeRow({ measured_metric: null, val_metric: 0.70 }),
      ]);
      const rounds = await service.getRounds("run-1");
      expect(rounds[0].experiments[0].metric).toBe(0.70);
    });
  });

  describe("getConvergence", () => {
    it("drops rows without a measured metric and sorts by time", async () => {
      (leaderboardRepo.getArenaResults as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeRow({ experiment_id: 7, round_number: 3, measured_metric: 0.812, created_at: "2026-07-25T00:10:00.000Z" }),
        makeRow({ experiment_id: 5, round_number: 2, measured_metric: null, created_at: "2026-07-25T00:05:00.000Z" }),
        makeRow({ experiment_id: 3, round_number: 1, measured_metric: 0.7234, created_at: "2026-07-25T00:00:00.000Z" }),
      ]);
      const points = await service.getConvergence("run-1");
      expect(points).toHaveLength(2); // the null-metric row is dropped
      expect(points.map((p) => p.round)).toEqual([1, 3]); // time-ordered
    });
  });
});
