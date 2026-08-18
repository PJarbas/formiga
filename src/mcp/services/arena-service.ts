// ══════════════════════════════════════════════════════════════════════
// arena-service.ts — Implementation of IArenaService
// ══════════════════════════════════════════════════════════════════════

import type {
  IArenaService,
  ArenaSessionView,
  ArenaRoundView,
  ConvergencePoint,
} from "../types.js";
import type { ArenaReadonly } from "../../arena/arena-repository.js";
import type { LeaderboardReadonly } from "../../leaderboard/repository.js";

/**
 * Read-only service for arena competition state.
 *
 * Backs the `query_arena` MCP tool, mirroring the three dashboard endpoints
 * (session / rounds / convergence) but at the service layer — no HTTP. Reads
 * through the injected ArenaReadonly (session) and LeaderboardReadonly
 * (experiments) repositories, mapping internal rows to stable read models.
 */
export class ArenaService implements IArenaService {
  constructor(
    private readonly arenaRepo: ArenaReadonly,
    private readonly leaderboardRepo: LeaderboardReadonly,
  ) {}

  async getSession(runId: string): Promise<ArenaSessionView | null> {
    const s = await this.arenaRepo.getByRunId(runId);
    if (!s) return null;
    return {
      metricName: s.metricName,
      metricDirection: s.metricDirection,
      targetMetric: s.targetMetric,
      currentRound: s.currentRound,
      maxRounds: s.maxRounds,
      bestMetric: s.bestMetric,
      bestAgent: s.bestAgent,
      baselineMetric: s.baselineMetric,
      status: s.status,
      totalKeep: s.totalKeep,
      totalDiscard: s.totalDiscard,
      totalCrash: s.totalCrash,
      consecutiveNoImprove: s.consecutiveNoImprove,
    };
  }

  async getRounds(runId: string): Promise<ArenaRoundView[]> {
    const rows = await this.leaderboardRepo.getArenaResults(runId);
    const byRound = new Map<number, ArenaRoundView>();
    for (const r of rows) {
      const round = byRound.get(r.round_number) ?? { round: r.round_number, experiments: [] };
      round.experiments.push({
        experimentId: r.experiment_id,
        agentName: r.agent_name,
        modelType: r.model_type,
        // Mirror the dashboard rounds endpoint: no val_metric fallback (crashed
        // runs carry a 0-filled val_metric that would look like a real score).
        metric: r.measured_metric,
        decision: r.decision,
        confidenceScore: r.confidence_score,
        confidenceBand: r.confidence_band,
        hypothesis: r.hypothesis,
        learned: r.learned,
        durationMs: r.duration_ms,
        status: r.status,
      });
      byRound.set(r.round_number, round);
    }
    return Array.from(byRound.values()).sort((a, b) => a.round - b.round);
  }

  async getConvergence(runId: string): Promise<ConvergencePoint[]> {
    const rows = await this.leaderboardRepo.getArenaResults(runId);
    return rows
      .filter((r) => r.measured_metric !== null)
      .map((r) => ({
        round: r.round_number,
        agent: r.agent_name,
        metric: r.measured_metric as number,
        decision: r.decision,
        timestamp: r.created_at,
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}
