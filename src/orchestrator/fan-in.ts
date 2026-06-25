// ══════════════════════════════════════════════════════════════════════
// fan-in.ts — Collect agent results and register in leaderboard
// ══════════════════════════════════════════════════════════════════════

import type { AgentResult } from "../agents/interfaces.js";
import type { LeaderboardRepository, NewExperiment } from "../leaderboard/repository.js";
import type { FanOutResult } from "./fan-out.js";

export interface FanInResult {
  registered: number;
  failed: number;
  errors: string[];
}

/** Collect agent results from fan-out, validate, and register in leaderboard. */
export function collectAndRegister(
  fanOutResults: FanOutResult[],
  repository: LeaderboardRepository,
  runId: string,
  roundNumber: number,
): FanInResult {
  const collected: FanInResult = { registered: 0, failed: 0, errors: [] };

  for (const fr of fanOutResults) {
    if (fr.error) {
      collected.failed++;
      collected.errors.push(`[${fr.agentName}] ${fr.error}`);
      continue;
    }

    if (!fr.result || fr.result.status !== "SUCCESS") {
      collected.failed++;
      collected.errors.push(`[${fr.agentName}] ${fr.result?.errorMessage ?? "unknown error"}`);
      continue;
    }

    try {
      const entry = toNewExperiment(fr.result, runId, roundNumber);
      repository.register(entry);
      collected.registered++;
    } catch (err) {
      collected.failed++;
      collected.errors.push(
        `[${fr.agentName}] registration error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return collected;
}

function toNewExperiment(
  result: AgentResult,
  runId: string,
  roundNumber: number,
): NewExperiment {
  return {
    run_id: runId,
    round_number: roundNumber,
    agent_name: result.agentName,
    model_type: result.modelType ?? "unknown",
    hyperparameters: result.hyperparameters ?? {},
    train_metric: result.trainMean ?? 0,
    val_metric: result.cvMean ?? 0,
    metric_name: "primary",
    artifact_path: result.artifactPath ?? "",
  };
}
