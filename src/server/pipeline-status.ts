// ══════════════════════════════════════════════════════════════════════
// pipeline-status.ts — Unified pipeline status helpers
// MIGRATED TO PRISMA — no raw SQL
// STATUS REGISTRY — all normalization via resolveDashboardStatus()
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import { AGENT_INFO_REGISTRY } from "../shared/dashboard-types.js";
import {
  resolveDashboardStatus,
  type DashboardAgentStatus,
  type ResolutionContext,
  type VisualStatus,
  STEP_TO_VISUAL,
  type StepStatus,
} from "../shared/status-registry.js";

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
export function getAgentNameForStepId(stepId: string): string | undefined {
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

export interface AgentHealth {
  consecutiveHeartbeats: number;
  spawnCount: number;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
}

/**
 * Observability health for an agent's current step (RF-7): how many
 * consecutive heartbeats, total spawns, and the last polling-round
 * outcome. Used by the dashboard to show an honest "running in loop"
 * signal instead of a frozen "running" status.
 */
export async function getAgentHealth(
  runId: string,
  agentName: string,
): Promise<AgentHealth> {
  const stepId = getStepIdForAgent(agentName);
  if (!stepId) {
    return { consecutiveHeartbeats: 0, spawnCount: 0, lastOutcome: null, lastOutcomeAt: null };
  }
  const prisma = getPrisma();
  const row = await prisma.step.findFirst({
    where: { run_id: runId, step_id: stepId },
    select: {
      consecutive_heartbeats: true,
      spawn_count: true,
      last_outcome: true,
      last_outcome_at: true,
    },
  });
  return {
    consecutiveHeartbeats: row?.consecutive_heartbeats ?? 0,
    spawnCount: row?.spawn_count ?? 0,
    lastOutcome: row?.last_outcome ?? null,
    lastOutcomeAt: row?.last_outcome_at?.toISOString() ?? null,
  };
}

function bareAgentName(agentName: string): string {
  return agentName.replace(/^arena-/, "");
}

async function getLatestExperiment(
  runId: string,
  agentName: string,
  roundNumber?: number,
) {
  const prisma = getPrisma();
  const baseName = bareAgentName(agentName);
  const where: {
    run_id: string;
    agent_name: { in: string[] };
    round_number?: number;
  } = { run_id: runId, agent_name: { in: [agentName, baseName] } };
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
 * Uses the status-registry for all normalization — no scattered if/else.
 * Experiment status takes priority; Step status is the fallback.
 * Unknown values are logged with context.
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

  const ctx: ResolutionContext = {
    entityType: exp ? "Experiment" : step ? "Step" : "Agent",
    entityId: `${runId}/${agentName}`,
    fieldName: "status",
  };

  if (exp) {
    const rawStatus = exp.status.toString();
    const status = resolveDashboardStatus(rawStatus, ctx);
    return {
      status,
      stepStatus: step?.status ?? null,
      experimentStatus: rawStatus,
      hasExperiment: true,
      valMetric: exp.val_metric ?? null,
      errorMessage: exp.error_message ?? null,
    };
  }

  if (step) {
    const rawStatus = step.status;
    const status = resolveDashboardStatus(rawStatus, ctx);
    return {
      status,
      stepStatus: rawStatus,
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
 * Single-run convenience wrapper over `getCurrentPhases`.
 */
export async function getCurrentPhase(runId: string): Promise<string> {
  const phases = await getCurrentPhases([runId]);
  return phases.get(runId) ?? "idle";
}

/**
 * Resolve the current phase of the ML pipeline for many runs in a single
 * batch (M-5). Replaces the per-run N+1 in `/api/runs`: the experiments
 * max-round, current-round agents, arena-session and steps fallback queries
 * each run once for all runs instead of 3-4 queries per run.
 *
 * Result maps `runId` → phase; a run with no rows at all gets "idle".
 *
 * Priority (same as the original single-run logic):
 *   1. Experiments tell us the highest phase reached.
 *   2. Arena session takes precedence over agent-derived phases.
 *   3. Fallback to the `steps` table before any experiment exists.
 */
export async function getCurrentPhases(runIds: string[]): Promise<Map<string, string>> {
  const phases = new Map<string, string>();
  if (runIds.length === 0) return phases;
  const prisma = getPrisma();

  // Step 1: max round per run — one grouped query instead of one aggregate/run.
  const roundRows = await prisma.experiment.groupBy({
    by: ["run_id"],
    where: { run_id: { in: runIds } },
    _max: { round_number: true },
  });
  const currentRoundByRun = new Map<string, number>();
  for (const row of roundRows) {
    currentRoundByRun.set(row.run_id, row._max.round_number ?? 0);
  }

  // Step 2: agents present at each run's current round — one query, filtered
  // in memory (the original filtered by round_number in SQL per run).
  const agentRows = await prisma.experiment.findMany({
    where: { run_id: { in: runIds } },
    distinct: ["run_id", "agent_name", "round_number"],
    select: { run_id: true, agent_name: true, round_number: true },
  });
  const agentsByRun = new Map<string, Set<string>>();
  for (const row of agentRows) {
    if (row.round_number !== currentRoundByRun.get(row.run_id)) continue;
    let set = agentsByRun.get(row.run_id);
    if (!set) {
      set = new Set<string>();
      agentsByRun.set(row.run_id, set);
    }
    set.add(row.agent_name);
  }

  // Step 3: arena sessions per run — one grouped count instead of one count/run.
  const arenaRows = await prisma.arenaSession.groupBy({
    by: ["run_id"],
    where: { run_id: { in: runIds } },
    _count: { _all: true },
  });
  const arenaRuns = new Set(arenaRows.map((r) => r.run_id));

  for (const runId of runIds) {
    const agentNames = agentsByRun.get(runId) ?? new Set<string>();
    if (arenaRuns.has(runId)) {
      phases.set(runId, "arena");
      continue;
    }
    const phase = derivePhaseFromAgents(agentNames);
    if (phase) phases.set(runId, phase);
  }

  // Step 4: no experiments yet for the remaining runs — read from steps.
  const idleRunIds = runIds.filter((id) => !phases.has(id));
  if (idleRunIds.length > 0) {
    const steps = await prisma.step.findMany({
      where: { run_id: { in: idleRunIds } },
      select: { run_id: true, step_id: true, status: true },
    });
    const stepStatusByRun = new Map<string, Record<string, VisualStatus>>();
    for (const s of steps) {
      let map = stepStatusByRun.get(s.run_id);
      if (!map) {
        map = {};
        stepStatusByRun.set(s.run_id, map);
      }
      map[s.step_id] = STEP_TO_VISUAL[s.status as StepStatus] ?? "todo";
    }
    for (const runId of idleRunIds) {
      phases.set(runId, derivePhaseFromSteps(stepStatusByRun.get(runId) ?? {}));
    }
  }

  return phases;
}

/** Map the agent set present at a run's current round to a phase label. */
function derivePhaseFromAgents(agentNames: Set<string>): string {
  if (agentNames.has("ml-critic")) return "audit";
  if (agentNames.has("modeler-classic") || agentNames.has("modeler-advanced")) return "modeling";
  if (agentNames.has("feature-engineer")) return "feature_engineering";
  if (agentNames.has("data-analyst")) return "data_analysis";
  if (agentNames.size > 0) return "complete";
  return "";
}

/** Fallback phase derivation from step visual statuses (no experiments yet). */
function derivePhaseFromSteps(stepStatus: Record<string, VisualStatus>): string {
  if (stepStatus["audit"] === "running" || stepStatus["audit"] === "done") return "audit";
  if (stepStatus["model-classic"] === "running" || stepStatus["model-classic"] === "done" || stepStatus["model-advanced"] === "running" || stepStatus["model-advanced"] === "done") return "modeling";
  if (stepStatus["features"] === "running" || stepStatus["features"] === "done") return "feature_engineering";
  if (stepStatus["eda"] === "running" || stepStatus["eda"] === "done") return "data_analysis";
  return "idle";
}

/**
 * Return the most-recently-started run that is still `running` or `paused`.
 * Falls back to the most recent run of any status so that completed runs
 * remain visible in the dashboard (leaderboard, logs, reasoning).
 * Uses the `runs` table directly (the canonical source of truth).
 */
export async function findActivePipelineRunId(): Promise<string | null> {
  try {
    const prisma = getPrisma();
    const active = await prisma.run.findFirst({
      where: {
        status: { in: ["running", "paused"] },
      },
      orderBy: { created_at: "desc" },
      select: { id: true },
    });
    if (active) return active.id;

    const latest = await prisma.run.findFirst({
      where: {
        status: { not: "canceled" },
      },
      orderBy: { created_at: "desc" },
      select: { id: true },
    });
    return latest?.id ?? null;
  } catch (err) {
    // Distinguish DB failures from "no active run" — log the error
    const { logger } = await import("../lib/logger.js");
    logger.warn("findActivePipelineRunId: DB query failed", {
      error: (err as Error).message,
    });
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
  const baseName = bareAgentName(agentName);
  const rows = await prisma.experiment.findMany({
    where: { run_id: runId, agent_name: { in: [agentName, baseName] } },
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