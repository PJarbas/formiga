// ══════════════════════════════════════════════════════════════════════
// ingest.ts — Bridge from step output (KEY: value protocol) → leaderboard
// MIGRATED TO PRISMA — no raw SQL, no getDb() dependency
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { LeaderboardRepositoryImpl } from "./repository.js";
import type { NewExperiment } from "./repository.js";
import { logger } from "../lib/logger.js";
import { validateSubmissionSidecar } from "./sidecar-schema.js";

/**
 * Agent ids (suffix-matched against scoped agent_id `<workflow>_<id>`)
 * that produce leaderboard experiments. Audit/analysis agents are excluded.
 */
const LEADERBOARD_AGENT_SUFFIXES = [
  "feature-engineer",
  "modeler-classic",
  "modeler-advanced",
];

function isLeaderboardAgent(scopedAgentId: string): boolean {
  return LEADERBOARD_AGENT_SUFFIXES.some(
    (suffix) =>
      scopedAgentId === suffix || scopedAgentId.endsWith(`_${suffix}`),
  );
}

/**
 * Extract the bare agent suffix from a scoped id (`ml-pipeline_modeler-classic`
 * → `modeler-classic`). Used to locate the sidecar submission file.
 */
function bareAgentSuffix(scopedAgentId: string): string | null {
  for (const suffix of LEADERBOARD_AGENT_SUFFIXES) {
    if (scopedAgentId === suffix || scopedAgentId.endsWith(`_${suffix}`)) {
      return suffix;
    }
  }
  return null;
}

/**
 * Read `{workspace}/artifacts/<agent>_submission.json` if it exists and
 * return its fields as a lowercase-keyed string map, mirroring the shape
 * of `parsedKv`. Pi's built-in `report` tool normalizes the agent's final
 * summary into a fixed `status/changes/tests` schema, dropping the
 * canonical leaderboard protocol fields (MODEL_TYPE, CV_MEAN, etc). The
 * sidecar JSON is a deterministic out-of-band channel that survives that
 * normalization.
 */
function readSubmissionSidecar(
  agentId: string,
  workspace: string | undefined,
): Record<string, string> | null {
  if (!workspace) return null;
  const suffix = bareAgentSuffix(agentId);
  if (!suffix) return null;
  const candidate = path.join(workspace, "artifacts", `${suffix}_submission.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(candidate, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Leaderboard sidecar JSON is malformed", {
      agentId,
      path: candidate,
      error: (err as Error).message,
    });
    return null;
  }

  // Validate against sidecar schema — reject invalid submissions explicitly
  const validation = validateSubmissionSidecar(parsed);
  if (!validation.valid) {
    logger.error("Sidecar validation failed", {
      agentId,
      path: candidate,
      errors: validation.errors,
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key.toLowerCase()] = String(value);
    } else {
      // Objects / arrays (e.g. hyperparameters) round-trip via JSON so the
      // existing parser path can reconstruct them.
      out[key.toLowerCase()] = JSON.stringify(value);
    }
  }
  return out;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseHyperparams(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON values are stored as a single raw key for traceability.
  }
  return { raw };
}

export interface IngestResult {
  experimentId: number | null;
  reason?: string;
}

/**
 * Map a parsed KEY:value record to a NewExperiment and register it.
 * Returns the new experiment_id, or null with a reason if the entry was
 * skipped (e.g., wrong agent, missing required fields).
 *
 * NOTE: now async because it goes through Prisma. Callers should `.catch()`
 * if they cannot await (e.g. synchronous step-completion paths).
 */
export async function ingestStepOutput(params: {
  agentId: string;
  runId: string;
  parsedKv: Record<string, string>;
  roundNumber?: number;
  workspace?: string;
}): Promise<IngestResult> {
  const { agentId, runId } = params;
  const roundNumber = params.roundNumber ?? 1;

  if (!isLeaderboardAgent(agentId)) {
    return { experimentId: null, reason: "non-leaderboard agent" };
  }

  const LOG_SKIP = (reason: string) => {
    logger.info("Leaderboard ingest skipped", { runId, agentId, reason });
    return reason;
  };

  // Merge parsedKv (from STATUS:/KEY:value text) with the sidecar JSON the
  // agent writes to `artifacts/<agent>_submission.json`. parsedKv values take
  // precedence when both sources provide a key — the sidecar is a fallback
  // for fields that pi's `report` tool strips from stdout (MODEL_TYPE etc.).
  const sidecar = readSubmissionSidecar(agentId, params.workspace);
  const merged: Record<string, string> = sidecar
    ? { ...sidecar, ...params.parsedKv }
    : params.parsedKv;

  const modelType = merged["model_type"];
  if (!modelType) {
    return { experimentId: null, reason: LOG_SKIP("missing MODEL_TYPE") };
  }

  const cvMean = parseNumber(merged["cv_mean"]);
  const trainMean = parseNumber(merged["train_mean"]);
  if (cvMean === null) {
    return { experimentId: null, reason: LOG_SKIP("missing or non-numeric CV_MEAN") };
  }
  if (trainMean === null) {
    return { experimentId: null, reason: LOG_SKIP("missing or non-numeric TRAIN_MEAN") };
  }

  const artifactPath = merged["artifact_path"] ?? "";
  if (!artifactPath) {
    return { experimentId: null, reason: LOG_SKIP("missing ARTIFACT_PATH") };
  }

  const hyperparameters = parseHyperparams(merged["hyperparameters"]);
  const metricName = merged["metric_name"] || "cv_mean";

  const entry: NewExperiment = {
    run_id: runId,
    round_number: roundNumber,
    agent_name: agentId,
    model_type: modelType,
    hyperparameters,
    train_metric: trainMean,
    val_metric: cvMean,
    metric_name: metricName,
    artifact_path: artifactPath,
  };

  try {
    const repo = new LeaderboardRepositoryImpl();
    const experimentId = await repo.register(entry);
    logger.info("Leaderboard experiment registered", {
      runId,
      agentId,
      modelType,
      experimentId,
      cvMean,
    });
    return { experimentId };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    logger.warn("Leaderboard ingest failed", { runId, agentId, error: msg });
    return { experimentId: null, reason: `register failed: ${msg}` };
  }
}
