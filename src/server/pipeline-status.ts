// ══════════════════════════════════════════════════════════════════════
// pipeline-status.ts — Unified pipeline status helpers
//
// These helpers query the canonical source-of-truth (`steps` table) first,
// then enrich with `experiments` data.  This prevents the visual "idle"
// state when an agent is actually running but hasn't submitted an experiment
// to the leaderboard yet.
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";

/** Unified status label used by the dashboard. */
export type DashboardAgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed";

/** Result of resolving an agent's status across both tables. */
export interface UnifiedAgentStatus {
  /** Final resolved status for the dashboard. */
  status: DashboardAgentStatus;
  /** Raw status from the `steps` table (if any). */
  stepStatus: string | null;
  /** Raw status from the `experiments` table (if any). */
  experimentStatus: string | null;
  /** Whether there is at least one experiment row for this agent. */
  hasExperiment: boolean;
  /** Optional CV mean of the most recent completed experiment. */
  valMetric: number | null;
  /** Optional error message of the most recent failed experiment. */
  errorMessage: string | null;
}

/** Map from step_id to the agent_name that owns it. */
const STEP_AGENT_MAP: Record<string, string> = {
  eda: "data-analyst",
  features: "feature-engineer",
  "model-classic": "modeler-classic",
  "model-advanced": "modeler-advanced",
  audit: "ml-critic",
};

/** Reverse map: agent_name -> step_id (for exact matches). */
const AGENT_STEP_MAP: Record<string, string> = {
  "data-analyst": "eda",
  "feature-engineer": "features",
  "modeler-classic": "model-classic",
  "modeler-advanced": "model-advanced",
  "ml-critic": "audit",
};

// ── Low-level queries ─────────────────────────────────────────────────

function getStepStatus(
  db: DatabaseSync,
  runId: string,
  stepId: string,
): { status: string; updated_at: string } | null {
  const row = db
    .prepare(
      "SELECT status, updated_at FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1",
    )
    .get(runId, stepId) as {
      status: string;
      updated_at: string;
    } | undefined;
  return row ?? null;
}

function getLatestExperiment(
  db: DatabaseSync,
  runId: string,
  agentName: string,
  roundNumber?: number,
) {
  let sql =
    "SELECT status, val_metric, error_message FROM experiments WHERE run_id = ? AND agent_name = ?";
  const params: (string | number)[] = [runId, agentName];
  if (typeof roundNumber === "number") {
    sql += " AND round_number = ?";
    params.push(roundNumber);
  }
  sql += " ORDER BY experiment_id DESC LIMIT 1";
  return db.prepare(sql).get(...params) as
    | { status: string; val_metric: number; error_message: string | null }
    | undefined;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Resolve the dashboard-visible status for a single agent in a run.
 *
 * Logic:
 *   1. Look at the `experiments` table first (leaderboard entries).
 *   2. If no experiment exists, fall back to the `steps` table.
 *
 * This guarantees "idle" is never returned while a step is `running`.
 */
export function getAgentUnifiedStatus(
  db: DatabaseSync,
  runId: string,
  agentName: string,
  roundNumber?: number,
): UnifiedAgentStatus {
  const stepId = AGENT_STEP_MAP[agentName];
  const step = stepId ? getStepStatus(db, runId, stepId) : null;

  const exp = getLatestExperiment(db, runId, agentName, roundNumber);

  if (exp) {
    const s = exp.status;
    const status: DashboardAgentStatus =
      s === "SUCCESS" || s === "AUDITED"
        ? "completed"
        : s === "FAILED" || s === "OVERFITTED"
          ? "failed"
          : s === "PENDING"
            ? "running"
            : "idle";
    return {
      status,
      stepStatus: step?.status ?? null,
      experimentStatus: s,
      hasExperiment: true,
      valMetric: exp.val_metric ?? null,
      errorMessage: exp.error_message ?? null,
    };
  }

  // No experiment yet — derive from step status
  if (step) {
    const s = step.status;
    const status: DashboardAgentStatus =
      s === "done" || s === "completed"
        ? "completed"
        : s === "running"
          ? "running"
          : s === "failed" || s === "canceled"
            ? "failed"
            : "idle";
    return {
      status,
      stepStatus: s,
      experimentStatus: null,
      hasExperiment: false,
      valMetric: null,
      errorMessage: null,
    };
  }

  return {
    status: "idle",
    stepStatus: null,
    experimentStatus: null,
    hasExperiment: false,
    valMetric: null,
    errorMessage: null,
  };
}

/**
 * Resolve the current phase of the ML pipeline for a run.
 *
 * Priority:
 *   1. Look at `experiments` (leaderboard records) — agents that have
 *      submitted experiments tell us the highest phase.
 *   2. Fallback to the `steps` table for early stages before any
 *      experiment exists.
 */
export function getCurrentPhase(
  db: DatabaseSync,
  runId: string,
): string {
  // Step 1: experiments are the preferred source when they exist
  const maxRoundRow = db
    .prepare("SELECT MAX(round_number) AS max_round FROM experiments WHERE run_id = ?")
    .get(runId) as { max_round: number | null } | undefined;

  const currentRound = maxRoundRow?.max_round ?? 0;

  const agentNames = new Set<string>();
  const expAgents = db
    .prepare(
      "SELECT DISTINCT agent_name FROM experiments WHERE run_id = ? AND round_number = ?",
    )
    .all(runId, currentRound) as Array<{ agent_name: string }>;
  for (const a of expAgents) agentNames.add(a.agent_name);

  if (agentNames.has("ml-critic")) return "audit";
  if (agentNames.has("modeler-classic") || agentNames.has("modeler-advanced")) return "modeling";
  if (agentNames.has("feature-engineer")) return "feature_engineering";
  if (agentNames.has("data-analyst")) return "data_analysis";
  if (agentNames.size > 0) return "complete";

  // Step 2: no experiments yet — read from steps
  const steps = db
    .prepare("SELECT step_id, status FROM steps WHERE run_id = ?")
    .all(runId) as Array<{ step_id: string; status: string }>;
  const stepStatus: Record<string, string> = {};
  for (const s of steps) stepStatus[s.step_id] = s.status;

  if (
    stepStatus["audit"] === "running" ||
    stepStatus["audit"] === "done"
  ) return "audit";
  if (
    stepStatus["model-classic"] === "running" ||
    stepStatus["model-classic"] === "done" ||
    stepStatus["model-advanced"] === "running" ||
    stepStatus["model-advanced"] === "done"
  ) return "modeling";
  if (
    stepStatus["features"] === "running" ||
    stepStatus["features"] === "done"
  ) return "feature_engineering";
  if (
    stepStatus["eda"] === "running" ||
    stepStatus["eda"] === "done"
  ) return "data_analysis";

  return "idle";
}

/**
 * Return the most-recently-started run that is still `running` or `paused`.
 * Uses the `runs` table directly (the canonical source of truth).
 */
export function findActivePipelineRunId(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare(
        "SELECT id FROM runs WHERE status IN ('running', 'paused') ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Get a list of round summaries for a single agent in a run.
 * Each row from `experiments` becomes one round entry.
 * Falls back to an empty list when the agent hasn't produced experiments yet.
 */
export function getAgentRoundSummaries(
  db: DatabaseSync,
  runId: string,
  agentName: string,
): Array<{
  roundNumber: number;
  status: string;
  cvMean: number | null;
  modelType: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT round_number, status, val_metric, model_type
       FROM experiments WHERE run_id = ? AND agent_name = ?
       ORDER BY round_number ASC`,
    )
    .all(runId, agentName) as Array<{
      round_number: number;
      status: string;
      val_metric: number;
      model_type: string;
    }>;

  return rows.map((r) => ({
    roundNumber: r.round_number,
    status: r.status,
    cvMean: r.val_metric ?? null,
    modelType: r.model_type ?? null,
  }));
}
