// ══════════════════════════════════════════════════════════════════════
// cron-manager.ts — Lifecycle for run-scoped polling jobs
// ══════════════════════════════════════════════════════════════════════
//
// One polling job per (runId, agentId). Identity:
//   formiga-${workflowId}-${runId}-${agentId}
//
// Responsibilities:
//   - `createAgentCronJob` registers in-memory metadata, optionally
//     stagger-starts the first interval timer.
//   - `setupAgentCrons` iterates a workflow's agents and registers each.
//   - `removeRunCrons` tears down all timers + in-flight pi children for
//     a runId (SIGTERM → SIGKILL the process group after 5s).
//   - `removeAgentCrons` is a workflow-wide variant; `shutdownAllCrons`
//     is the global teardown invoked on daemon SIGTERM and in tests.
//   - `nudgeScheduledRuns` triggers immediate polling for a set of runs,
//     skipping jobs whose pi process is still in flight, and resetting
//     interval timers so the next tick is one interval from now.
//
// All polling rounds delegate to `executePollingRound` (polling-round.ts).
// Cross-module shared state (timers, in-flight maps, metadata) lives in
// shared.ts so this module can remain focused on lifecycle policy.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { logger } from "../../lib/logger.js";
import { getRoleTimeoutSeconds, inferRole } from "../install.js";
import { resolveWorkflowDir } from "../paths.js";
import type { HarnessType, WorkflowSpec } from "../types.js";
import { executePollingRound } from "./polling-round.js";
import {
  activeTimers,
  inFlightChildren,
  inFlightJobs,
  jobMetadata,
  pendingStartTimers,
  safeKillPgid,
  setActiveTimer,
  setJobMetadata,
  setPendingStartTimer,
  teardownRunJobs,
  type CreateCronJobParams,
  type CronJobInfo,
  type NudgeResult,
  type SetupAgentCronsOptions,
} from "./shared.js";

// ── Identity ──────────────────────────────────────────────────────────

function buildJobId(workflowId: string, runId: string, agentId: string): string {
  // The agent id may already be `${workflowId}_${rawAgentId}` if it was
  // resolved through claimStep paths. Strip the workflow prefix for a clean
  // job id; the full prefixed id is still what we use for DB queries.
  const shortAgent = agentId.startsWith(`${workflowId}_`)
    ? agentId.slice(workflowId.length + 1)
    : agentId;
  return `formiga-${workflowId}-${runId}-${shortAgent}`;
}

// ── Job creation ──────────────────────────────────────────────────────

/**
 * Create a single run-scoped polling job (one per (runId, agentId)).
 */
export async function createAgentCronJob(
  params: CreateCronJobParams,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const {
    workflowId,
    runId,
    agent,
    workflow,
    workingDirectoryForHarness,
  } = params;
  const intervalMinutes = params.intervalMinutes ?? 5;
  const staggerMs = params.staggerOffsetMs ?? 0;

  const id = buildJobId(workflowId, runId, agent.id);

  if (jobMetadata.has(id) || activeTimers.has(id) || pendingStartTimers.has(id)) {
    return { ok: true, id };
  }

  const role = agent.role ?? inferRole(agent.id);
  const timeoutSeconds = agent.timeoutSeconds ?? getRoleTimeoutSeconds(role);

  const fullAgentId = agent.id.startsWith(`${workflowId}_`) ? agent.id : `${workflowId}_${agent.id}`;

  // Read harness_type from run context; default to "pi" if not set.
  let harnessType: HarnessType = "pi";
  try {
    const { getPrisma } = await import("../../db.js");
    const prisma = getPrisma();
    const runRow = await prisma.run.findUnique({
      where: { id: runId },
      select: { context: true },
    });
    if (runRow?.context) {
      const ctx = JSON.parse(runRow.context) as Record<string, unknown>;
      if (ctx.harness_type === "hermes") {
        harnessType = "hermes";
      }
    }
  } catch {
    // If we can't read the context, default to "pi"
  }

  const jobInfo: CronJobInfo = {
    id,
    workflowId,
    runId,
    agentId: fullAgentId,
    intervalMinutes,
    sessionLabel: `${agent.id}-cron`,
    timeoutSeconds,
    workingDirectoryForHarness,
    harnessType,
    createdAt: new Date().toISOString(),
  };

  setJobMetadata(id, jobInfo);

  const startPolling = () => {
    pendingStartTimers.delete(id);
    if (!jobMetadata.has(id)) return;
    if (activeTimers.has(id)) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      executePollingRound(jobInfo, agent, workflow).catch((err) => {
        logger.error("Unhandled polling error", { jobId: id, runId, error: String(err) });
      });
    }, intervalMs);

    setActiveTimer(id, timer);

    logger.info("Cron job created", {
      id,
      runId,
      agentId: agent.id,
      intervalMinutes,
      staggerMs,
      workingDirectoryForHarness,
    });
  };

  if (staggerMs > 0) {
    const pending = setTimeout(startPolling, staggerMs);
    setPendingStartTimer(id, pending);
    logger.info("Cron job scheduled with stagger", { id, runId, staggerMs });
  } else {
    startPolling();
  }

  return { ok: true, id };
}

/**
 * Set up polling jobs for every agent in a workflow, scoped to a single run.
 */
export async function setupAgentCrons(
  workflow: WorkflowSpec,
  runId: string,
  options: SetupAgentCronsOptions = {},
): Promise<void> {
  const staggerBaseMs = 60_000; // 1 minute per agent

  for (let i = 0; i < workflow.agents.length; i++) {
    const agent = workflow.agents[i];
    const staggerMs = i * staggerBaseMs;

    const jobId = buildJobId(workflow.id, runId, agent.id);
    if (jobMetadata.has(jobId)) {
      logger.info("Run-scoped cron job already exists; skipping", {
        jobId,
        runId,
        agentId: agent.id,
      });
      continue;
    }

    const intervalMinutes = options.noHurrySaveTokensMode
      ? (workflow.polling?.timeoutSeconds
        ? Math.max(15, Math.ceil(workflow.polling.timeoutSeconds / 60))
        : 15)
      : (workflow.polling?.timeoutSeconds
        ? Math.max(1, Math.ceil(workflow.polling.timeoutSeconds / 60))
        : 5);

    const result = await createAgentCronJob({
      workflowId: workflow.id,
      runId,
      agent,
      workflow,
      intervalMinutes,
      staggerOffsetMs: staggerMs,
      workingDirectoryForHarness: options.workingDirectoryForHarness,
    });

    if (!result.ok) {
      logger.warn("Failed to set up cron for agent", {
        agentId: agent.id,
        runId,
        error: result.error,
      });
    }
  }
}

// ── Teardown ──────────────────────────────────────────────────────────

/**
 * Remove all polling jobs for a given runId. Terminates any in-flight
 * pi process group for the run as well.
 */
export async function removeRunCrons(runId: string): Promise<void> {
  const removed = teardownRunJobs(runId);
  if (removed.length > 0) {
    logger.info("Removed run-scoped crons", { runId, count: removed.length, jobIds: removed });
  }
}

/**
 * Workflow-wide teardown: remove all jobs for any run of this workflow.
 * Used by tests / shutdown paths. Run-scoped removal is preferred.
 */
export async function removeAgentCrons(workflowId: string): Promise<void> {
  const seenRunIds = new Set<string>();
  for (const info of jobMetadata.values()) {
    if (info.workflowId === workflowId) seenRunIds.add(info.runId);
  }
  for (const runId of seenRunIds) {
    await removeRunCrons(runId);
  }
}

/**
 * @deprecated The new run-scoped scheduler tears down via removeRunCrons.
 * This thin wrapper exists for back-compat with step-ops fire-and-forget calls.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  try {
    const { getPrisma } = await import("../../db.js");
    const prisma = getPrisma();
    const count = await prisma.run.count({
      where: {
        workflow_id: workflowId,
        status: { in: ["running", "paused"] },
      },
    });

    if (count === 0) {
      logger.info("Workflow idle — tearing down crons", { workflowId });
      await removeAgentCrons(workflowId);
    }
  } catch (err) {
    logger.warn("Failed to check idle status for teardown", {
      workflowId,
      error: String(err),
    });
  }
}

// ── Listing + shutdown ────────────────────────────────────────────────

/**
 * List all active cron jobs.
 */
export async function listCronJobs(): Promise<{
  ok: boolean;
  jobs?: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }>;
}> {
  const jobs: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }> = [];
  for (const [id, info] of jobMetadata) {
    jobs.push({
      id,
      runId: info.runId,
      agentId: info.agentId,
      workingDirectoryForHarness: info.workingDirectoryForHarness,
    });
  }
  return { ok: true, jobs };
}

/**
 * Gracefully shut down all cron jobs (and terminate any in-flight pi
 * process groups). Used by tests and daemon SIGTERM.
 */
export function shutdownAllCrons(): void {
  let count = 0;
  for (const [id, timer] of activeTimers) {
    clearInterval(timer);
    activeTimers.delete(id);
    count++;
  }
  for (const [id, timer] of pendingStartTimers) {
    clearTimeout(timer);
    pendingStartTimers.delete(id);
    count++;
  }
  for (const [, child] of inFlightChildren) {
    if (!child.killed && child.pgid) {
      child.killed = true;
      safeKillPgid(child.pgid, "SIGTERM");
      setTimeout(() => safeKillPgid(child.pgid, "SIGKILL"), 5000).unref();
    }
  }
  inFlightChildren.clear();
  inFlightJobs.clear();
  jobMetadata.clear();
  if (count > 0) {
    logger.info("Shut down all cron jobs", { count });
  }
}

// ── Nudge ─────────────────────────────────────────────────────────────

/**
 * Trigger immediate polling for all scheduled jobs in the given runs.
 *
 * Jobs currently in flight are skipped. Pending-start timers are
 * converted to active interval timers after launch. Active timers are
 * cleared and recreated from now after a launched polling round.
 *
 * The function loads workflow specs from disk via
 * `loadWorkflowSpec(resolveWorkflowDir(…))` to find matching agents.
 */
export async function nudgeScheduledRuns(
  runIds: string[],
  opts?: {
    /** Override for tests — defaults to loadWorkflowSpec from workflow-spec.js. */
    loadWorkflowSpec?: (workflowDir: string) => Promise<WorkflowSpec>;
  },
): Promise<NudgeResult> {
  const runIdSet = new Set(runIds);
  const result: NudgeResult = {
    runIds: [...runIds],
    launched: 0,
    skippedInFlight: 0,
    errors: [],
    jobs: [],
  };

  // Resolve spec loader — lazy-import to avoid circular dep at module
  // init and to allow test overrides.
  const loadSpec: (workflowDir: string) => Promise<WorkflowSpec> =
    opts?.loadWorkflowSpec ??
    (await import("../workflow-spec.js")).loadWorkflowSpec;

  // Collect matching jobs from jobMetadata.
  const matchingJobs: Array<{ info: CronJobInfo; id: string }> = [];
  for (const [id, info] of jobMetadata) {
    if (runIdSet.has(info.runId)) {
      matchingJobs.push({ info, id });
    }
  }

  // Process each job.
  for (const { info, id: jobId } of matchingJobs) {
    // ── In-flight guard ──────────────────────────────────────────
    if (inFlightJobs.has(jobId)) {
      result.skippedInFlight++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "skipped_in_flight",
      });
      continue;
    }

    try {
      // Load workflow spec from disk.
      const flowDir = resolveWorkflowDir(info.workflowId);
      const workflow = await loadSpec(flowDir);

      // Find matching agent.
      // jobMetadata stores agentId as the full prefixed form
      //   e.g. "feature-dev-merge-worktree_developer"
      // Workflow agents use the short id (e.g. "developer").
      const shortAgentId = info.agentId.startsWith(`${info.workflowId}_`)
        ? info.agentId.slice(info.workflowId.length + 1)
        : info.agentId;

      const agent = workflow.agents.find(
        (a) =>
          a.id === shortAgentId ||
          `${info.workflowId}_${a.id}` === info.agentId,
      );

      if (!agent) {
        const errMsg = `Agent ${info.agentId} not found in workflow ${info.workflowId}`;
        result.errors.push({
          runId: info.runId,
          agentId: info.agentId,
          error: errMsg,
        });
        result.jobs.push({
          runId: info.runId,
          agentId: info.agentId,
          status: "error",
          error: errMsg,
        });
        continue;
      }

      // ── Launch polling round (fire-and-forget) ────────────────
      // tryMarkJobInFlight inside executePollingRound prevents
      // duplicate launches with near-simultaneous timer ticks.
      executePollingRound(info, agent, workflow).catch((err) => {
        logger.error("Nudge-launched polling round failed", {
          jobId,
          runId: info.runId,
          agentId: info.agentId,
          error: String(err),
        });
      });

      // ── Timer reset ───────────────────────────────────────────
      const activeTimer = activeTimers.get(jobId);
      const pendingTimer = pendingStartTimers.get(jobId);
      const intervalMs = info.intervalMinutes * 60 * 1000;

      if (activeTimer) {
        // Clear existing interval, recreate from now.
        clearInterval(activeTimer);
        activeTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executePollingRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled polling error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, intervalMs);
        setActiveTimer(jobId, newTimer);
      } else if (pendingTimer) {
        // Convert pending-start to active interval.
        clearTimeout(pendingTimer);
        pendingStartTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executePollingRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled polling error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, intervalMs);
        setActiveTimer(jobId, newTimer);
      }
      // If neither timer exists, the job's own startPolling() already
      // created a timer — we leave it alone.

      result.launched++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "launched",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        runId: info.runId,
        agentId: info.agentId,
        error: errorMsg,
      });
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "error",
        error: errorMsg,
      });
    }
  }

  return result;
}

// ── Internal helpers (exposed for daemon reconciler + tests) ─────────

/** @internal — exposed for daemon reconciler. */
export function _scheduledRunIds(): Set<string> {
  const ids = new Set<string>();
  for (const info of jobMetadata.values()) ids.add(info.runId);
  return ids;
}

/** @internal — exposed for daemon reconciler. */
export function _hasRunScheduled(runId: string): boolean {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) return true;
  }
  return false;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCount(): number {
  return jobMetadata.size;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCountForRun(runId: string): number {
  let count = 0;
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) count++;
  }
  return count;
}

/** @internal — exposed for test assertions on interval values. */
export function _getJobIntervalsForRun(runId: string): Array<{ agentId: string; intervalMinutes: number }> {
  const results: Array<{ agentId: string; intervalMinutes: number }> = [];
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) {
      results.push({ agentId: info.agentId, intervalMinutes: info.intervalMinutes });
    }
  }
  return results;
}

/** @internal — exposed for daemon admission safety checks. */
export function _runIdForScheduledHarnessWorkdir(
  workingDirectoryForHarness: string,
  excludingRunId?: string,
): string | null {
  let requested = path.resolve(workingDirectoryForHarness);
  try {
    requested = fs.realpathSync(requested);
  } catch {
    /* admission validates existence before calling this */
  }

  for (const info of jobMetadata.values()) {
    if (excludingRunId && info.runId === excludingRunId) continue;
    if (!info.workingDirectoryForHarness) continue;

    let scheduled = path.resolve(info.workingDirectoryForHarness);
    try {
      scheduled = fs.realpathSync(scheduled);
    } catch {
      /* stale job metadata should not block scheduling by itself */
    }

    if (scheduled === requested) return info.runId;
  }

  return null;
}
