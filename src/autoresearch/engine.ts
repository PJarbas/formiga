// ══════════════════════════════════════════════════════════════════════
// engine.ts — ML pipeline entry point — wires agents + orchestrator + leaderboard
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";
import { LeaderboardRepositoryImpl } from "../leaderboard/repository.js";
import type { LeaderboardRepository } from "../leaderboard/repository.js";
import { LocalArtifactStore } from "../artifacts/local-store.js";
import { RoundManager, type RoundConfig } from "../orchestrator/round-manager.js";
import type { FanOutExecutor } from "../orchestrator/fan-out.js";
import { buildConfig } from "./config.js";
import type { FormigaConfig, PipelineResult } from "./types.js";

export class FormigaEngine {
  private repository: LeaderboardRepository;
  private store: LocalArtifactStore;
  private roundManager: RoundManager;
  private config: FormigaConfig;
  private executor: FanOutExecutor;

  constructor(
    db: DatabaseSync,
    executor: FanOutExecutor,
    configOverrides?: Partial<FormigaConfig>,
  ) {
    this.config = buildConfig(configOverrides);
    this.repository = new LeaderboardRepositoryImpl(db);
    this.store = new LocalArtifactStore(this.config.workspaceRoot);
    this.roundManager = new RoundManager(this.repository);
    this.executor = executor;
  }

  /** Execute the full ML pipeline for a given run. */
  async run(runId: string): Promise<PipelineResult> {
    const errors: string[] = [];

    // Ensure workspace tree exists
    await this.store.ensureWorkspace(runId);

    let roundsCompleted = 0;

    for (let round = 1; round <= this.config.maxRounds; round++) {
      const roundConfig: RoundConfig = {
        runId,
        roundNumber: round,
        workspacePath: this.store.resolveWorkspace(runId),
        timeoutMs: this.config.timeouts.modelerClassic, // longest timeout as default
        maxConcurrency: this.config.maxConcurrency,
        executor: this.executor,
      };

      try {
        const result = await this.roundManager.executeRound(roundConfig);
        roundsCompleted++;

        if (result.phaseResults.some((p) => p.status !== "completed")) {
          const failed = result.phaseResults.filter((p) => p.status !== "completed");
          for (const f of failed) {
            errors.push(`Round ${round}: ${f.agentName} ${f.status}${f.error ? ` — ${f.error}` : ""}`);
          }
          // Don't continue if analyst or engineer failed
          const criticalFailures = failed.filter(
            (f) => f.agentName === "data-analyst" || f.agentName === "feature-engineer",
          );
          if (criticalFailures.length > 0) {
            break;
          }
        }
      } catch (err) {
        errors.push(`Round ${round}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }

    // Collect best result
    const best = await this.repository.getBestByMetric(runId, 1);
    const bestModel = best[0] ?? null;

    return {
      runId,
      roundsCompleted,
      totalExperiments: best.length, // total validated experiments
      bestModelId: bestModel ? `${bestModel.agent_name}_${bestModel.experiment_id}` : null,
      bestMetric: bestModel?.val_metric ?? null,
      errors,
    };
  }

  getRepository(): LeaderboardRepository {
    return this.repository;
  }

  getStore(): LocalArtifactStore {
    return this.store;
  }

  getConfig(): FormigaConfig {
    return { ...this.config };
  }
}
