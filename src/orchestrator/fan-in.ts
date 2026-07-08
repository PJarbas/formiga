// ══════════════════════════════════════════════════════════════════════
// fan-in.ts — Collect agent results and register in leaderboard
// MIGRATED TO PRISMA — repository.register() is now async
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import type { AgentResult } from "../agents/interfaces.js";
import type { LeaderboardRepository, NewExperiment } from "../leaderboard/repository.js";
import type { FanOutResult } from "./fan-out.js";
import { logger } from "../lib/logger.js";

export interface FanInResult {
  registered: number;
  failed: number;
  errors: string[];
}

/** Collect agent results from fan-out, validate, and register in leaderboard. */
export async function collectAndRegister(
  fanOutResults: FanOutResult[],
  repository: LeaderboardRepository,
  runId: string,
  roundNumber: number,
  workspacePath?: string,
): Promise<FanInResult> {
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
      const entry = toNewExperiment(fr.result, runId, roundNumber, workspacePath);
      await repository.register(entry);
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
  workspacePath?: string,
): NewExperiment {
  // Validate artifact existence when workspace is provided
  if (workspacePath && result.artifactPath) {
    const fullPath = path.join(workspacePath, result.artifactPath);
    if (!fs.existsSync(fullPath)) {
      logger.warn("Artifact not found at reported path", {
        agentName: result.agentName,
        artifactPath: result.artifactPath,
      });
    }
  }

  return {
    run_id: runId,
    round_number: roundNumber,
    agent_name: result.agentName,
    model_type: result.modelType ?? "unknown",
    hyperparameters: result.hyperparameters ?? {},
    train_metric: result.trainMean ?? 0,
    val_metric: result.cvMean ?? 0,
    metric_name: result.metricName ?? result.outputs?.metricName ?? "cv_mean",
    artifact_path: result.artifactPath ?? "",
  };
}
