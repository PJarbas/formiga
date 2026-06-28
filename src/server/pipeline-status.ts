// ══════════════════════════════════════════════════════════════════════
// pipeline-status.ts — Unified pipeline status helpers
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import { AGENT_INFO_REGISTRY } from "../shared/dashboard-types.js";

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

/** Derive stepId for an agent from AGENT_INFO_REGISTRY */
function getStepIdForAgent(agentName: string): string | undefined {
  return AGENT_INFO_REGISTRY[agentName]?.stepId;
}

/** Derive agentName from stepId by searching AGENT_INFO_REGISTRY */
function getAgentNameForStepId(stepId: string): string | undefined {
  for (const [name, info] of Object.entries(AGENT_INFO_REGISTRY)) {
    if (info.stepId === stepId) return name;
  }
  return undefined;
}

// ── Low-level queries ───────────────────────────────────────────────────────

async function getStepStatus(
  runId: string,
  stepId: string,
): Promise<{ status: string; updated_at: Date | null } | null> {
  const prisma = getPrisma();
  const row = await prisma.step.findFirst({
    where: { run_id: runId, step_id: stepId },
    select: { status: true, updated_at: true },
  });
  return row
    ? { status: row.status.toString(), updated_at: row.updated_at }
    : null;
}

async function getLatestExperiment(
  runId: string,
  agentName: string,
  roundNumber?: number,
) {
  const prisma = getPrisma();
  const where: {
    run_id: string;
    agent_name: string;
    round_number?: number;
  } = { run_id: runId, agent_name: agentName };
  if (typeof roundNumber === "number") {
    where.round_number = roundNumber;
  }
  return prisma.experiment.findFirst({
    where,
    orderBy: { experiment_id: "desc" },
    select: {
      status: true,
      val_metric: true,
      error_message: true,
    },
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve the dashboard-visible status for a single agent in a run.
 *
 * Logic:
 *   1. Look at the `experiments` table first (leaderboard entries).
 *   2. If no experiment exists, fall back to the `steps` table.
 *
 * This guarantees "idle" is never returned while a step is `running`.
 */
export async function getAgentUnifiedStatus(
  runId: string,
  agentName: string,
  roundNumber?: number,
): Promise<UnifiedAgentStatus> {
  const stepId = getStepIdForAgent(agentName);
  const [step, exp] = await Promise.all([
    stepId ? getStepStatus(runId, stepId) : Promise.resolve(null),
    getLatestExperiment(runId, agentName, roundNumber),
  ]);

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
      experimentStatus: s.toString(),
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
export async function getCurrentPhase(runId: string): Promise<string> {
  const prisma = getPrisma();

  // Step 1: experiments are the preferred source when they exist
  const maxAgg = await prisma.experiment.aggregate({
    where: { run_id: runId },
    _max: { round_number: true },
  });
  const currentRound = maxAgg._max.round_number ?? 0;

  const expAgents = await prisma.experiment.findMany({
    where: {
      run_id: runId,
      round_number: currentRound,
    },
    distinct: ["agent_name"],
    select: { agent_name: true },
  });
  const agentNames = new Set(expAgents.map((a) => a.agent_name));

  if (agentNames.has("ml-critic")) return "audit";
  if (agentNames.has("modeler-classic") || agentNames.has("modeler-advanced")) return "modeling";
  if (agentNames.has("feature-engineer")) return "feature_engineering";
  if (agentNames.has("data-analyst")) return "data_analysis";
  if (agentNames.size > 0) return "complete";

  // Step 2: no experiments yet — read from steps
  const steps = await prisma.step.findMany({
    where: { run_id: runId },
    select: { step_id: true, status: true },
  });
  const stepStatus: Record<string, string> = {};
  for (const s of steps) stepStatus[s.step_id] = s.status.toString();

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
export async function findActivePipelineRunId(): Promise<string | null> {
  try {
    const prisma = getPrisma();
    const row = await prisma.run.findFirst({
      where: {
        status: { in: ["running", "paused"] },
      },
      orderBy: { created_at: "desc" },
      select: { id: true },
    });
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
export async function getAgentRoundSummaries(
  runId: string,
  agentName: string,
): Promise<
  Array<{
    roundNumber: number;
    status: string;
    cvMean: number | null;
    modelType: string | null;
  }>
> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: { run_id: runId, agent_name: agentName },
    orderBy: { round_number: "asc" },
    select: {
      round_number: true,
      status: true,
      val_metric: true,
      model_type: true,
    },
  });

  return rows.map((r) => ({
    roundNumber: r.round_number,
    status: r.status.toString(),
    cvMean: r.val_metric ?? null,
    modelType: r.model_type ?? null,
  }));
}
