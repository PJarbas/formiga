// ══════════════════════════════════════════════════════════════════════
// leaderboard-service.ts — Implementation of ILeaderboardService
// ══════════════════════════════════════════════════════════════════════

import type { ILeaderboardService, LeaderboardEntry } from "../types.js";
import {
  LeaderboardRepositoryImpl,
  type LeaderboardReadonly,
} from "../../leaderboard/repository.js";

/**
 * Service for querying leaderboard data.
 * Returns top experiments ordered by validation metric.
 */
export class LeaderboardService implements ILeaderboardService {
  private readonly repo: LeaderboardReadonly;

  constructor(repo?: LeaderboardReadonly) {
    this.repo = repo ?? new LeaderboardRepositoryImpl();
  }

  async getTop(runId: string, limit: number): Promise<LeaderboardEntry[]> {
    const experiments = await this.repo.getBestByMetric(runId, limit);

    return experiments.map((exp) => ({
      modelType: exp.model_type,
      agentName: exp.agent_name,
      cvMean: exp.val_metric,
      trainMean: exp.train_metric,
      roundNumber: exp.round_number,
    }));
  }
}
