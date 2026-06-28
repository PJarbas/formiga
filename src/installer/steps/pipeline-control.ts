import fs from "node:fs";
import path from "node:path";

import { getPrisma } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import type { LoopConfig } from "../types.js";
import { getAgentWorkspacePath } from "./story-manager.js";

// ════════════════════════════════════════════════════════════════════════════════
// Run-terminal helpers
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Look up the workflow_id for a given run.
 */
export async function getWorkflowId(runId: string): Promise<string | undefined> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { workflow_id: true },
    });
    return run?.workflow_id;
  } catch {
    return undefined;
  }
}

async function getRunTokenSpend(runId: string): Promise<number | undefined> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { tokens_spent: true },
    });
    return run?.tokens_spent;
  } catch {
    return undefined;
  }
}

/**
 * Emit a run.completed or run.failed event, attaching the current token spend
 * snapshot pulled from the runs table.
 */
export async function emitRunTerminalEvent(params: {
  event: "run.completed" | "run.failed";
  runId: string;
  workflowId?: string;
  detail?: string;
}): Promise<void> {
  const tokensSpent = await getRunTokenSpend(params.runId);
  emitEvent({
    ts: new Date().toISOString(),
    event: params.event,
    runId: params.runId,
    workflowId: params.workflowId,
    detail: params.detail,
    tokensSpent,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// Cron teardown
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget cron teardown when a run ends.
 * Looks up the workflow_id for the run and tears down crons if no other active runs.
 */
export async function scheduleRunCronTeardown(runId: string): Promise<void> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { workflow_id: true, status: true },
    });
    if (!run) return;

    // Terminal runs never carry a scheduling_status. Any path that lands a
    // run in completed/failed/canceled should also wipe the scheduling
    // fields so the daemon reconciler stops considering it.
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      try {
        await prisma.run.update({
          where: { id: runId },
          data: { scheduling_status: null, updated_at: new Date() },
        });
      } catch {
        // best-effort
      }
    }

    const schedulerModule = import("../agent-scheduler.js");
    schedulerModule
      .then((m) => m.removeRunCrons(runId))
      .catch(() => {});
    import("../../server/control-client.js")
      .then((m) => m.terminateRunWithDaemon(runId))
      .catch(() => {});
    schedulerModule
      .then((m) => m.teardownWorkflowCronsIfIdle(run.workflow_id))
      .catch(() => {});
  } catch {
    // best-effort
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Draining pause finalization
// ════════════════════════════════════════════════════════════════════════════════

/**
 * When a run's scheduling_status is 'draining_pause', check whether all
 * running steps have completed; if so, finalize the pause by clearing
 * scheduler timers and setting status to 'paused'.
 */
export async function finalizeDrainingPause(runId: string): Promise<void> {
  const prisma = getPrisma();
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { scheduling_status: true, workflow_id: true },
  });
  if (!run || run.scheduling_status !== "draining_pause") return;

  const runningSteps = await prisma.step.findMany({
    where: { run_id: runId, status: "running" },
    select: { type: true, current_story_id: true, loop_config: true },
  });
  const hasInFlightStep = runningSteps.some((step) => {
    if (step.type !== "loop" || step.current_story_id || !step.loop_config) return true;
    try {
      const loopConfig = JSON.parse(step.loop_config) as LoopConfig;
      return !(loopConfig.verifyEach ?? loopConfig.verify_each);
    } catch {
      return true;
    }
  });
  if (hasInFlightStep) return;

  // Finalize the pause: clear timers and set status to paused.
  import("../agent-scheduler.js")
    .then((m) => m.removeRunCrons(runId))
    .catch((err) => {
      logger.warn("finalizeDrainingPause: removeRunCrons failed", { runId, error: String(err) });
    });

  await prisma.run.update({
    where: { id: runId },
    data: { status: "paused", scheduling_status: "paused", updated_at: new Date() },
  });

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.paused",
    runId,
    workflowId: run.workflow_id,
  });

  logger.info("Drain-before-pause completed — run now paused", { runId });
}

// ════════════════════════════════════════════════════════════════════════════════
// Advance pipeline
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Advance the pipeline: find the next waiting step and make it pending, or complete the run.
 * Respects terminal run states — a failed run cannot be advanced or completed.
 */
export async function advancePipeline(runId: string): Promise<{ advanced: boolean; runCompleted: boolean }> {
  const prisma = getPrisma();

  // Guard: don't advance or complete a run that's already failed/cancelled
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status === "failed" || run?.status === "canceled") {
    return { advanced: false, runCompleted: false };
  }

  const runningStep = await prisma.step.findFirst({
    where: { run_id: runId, status: "running" },
    select: { id: true },
  });
  if (runningStep) {
    return { advanced: false, runCompleted: false };
  }

  const next = await prisma.step.findFirst({
    where: { run_id: runId, status: "waiting" },
    orderBy: { step_index: "asc" },
    select: { id: true, step_id: true, step_index: true, parallel_group: true },
  });

  // If next exists, also block advance when any earlier step is still
  // non-terminal (pending/running/failed). This matters for parallel_group:
  // a sibling still pending or running must not let the post-group step
  // race ahead.
  if (next) {
    const blockingPrior = await prisma.step.findFirst({
      where: {
        run_id: runId,
        step_index: { lt: next.step_index },
        status: { in: ["failed", "pending", "running"] },
      },
      select: { id: true },
    });
    if (blockingPrior) {
      return { advanced: false, runCompleted: false };
    }
  } else {
    const incomplete = await prisma.step.findFirst({
      where: {
        run_id: runId,
        status: { in: ["failed", "pending", "running"] },
      },
      select: { id: true },
    });
    if (incomplete) {
      return { advanced: false, runCompleted: false };
    }
  }

  const wfId = await getWorkflowId(runId);
  if (next) {
    // Promote next from 'waiting' to 'pending'. If it belongs to a
    // parallel_group, also promote every contiguous waiting sibling that
    // shares the same group so the scheduler can claim them in parallel.
    const promoted: Array<{ id: string; step_id: string }> = [];
    if (next.parallel_group) {
      const groupSiblings = await prisma.step.findMany({
        where: {
          run_id: runId,
          status: "waiting",
          parallel_group: next.parallel_group,
          step_index: { gte: next.step_index },
        },
        orderBy: { step_index: "asc" },
        select: { id: true, step_id: true },
      });
      const now = new Date();
      for (const sibling of groupSiblings) {
        await prisma.step.update({
          where: { id: sibling.id },
          data: { status: "pending", updated_at: now },
        });
        promoted.push(sibling);
      }
    } else {
      await prisma.step.update({
        where: { id: next.id },
        data: { status: "pending", updated_at: new Date() },
      });
      promoted.push({ id: next.id, step_id: next.step_id });
    }
    for (const p of promoted) {
      emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId, workflowId: wfId, stepId: p.step_id });
      emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId, workflowId: wfId, stepId: p.step_id });
    }
    return { advanced: true, runCompleted: false };
  } else {
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", updated_at: new Date() },
    });
    await emitRunTerminalEvent({ event: "run.completed", runId, workflowId: wfId });
    logger.info("Run completed", { runId, workflowId: wfId });
    await archiveRunProgress(runId);
    await scheduleRunCronTeardown(runId);
    await finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: true };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Progress archiving
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Archive the run's progress file to the agent workspace archive directory.
 */
export async function archiveRunProgress(runId: string): Promise<void> {
  const prisma = getPrisma();
  const loopStep = await prisma.step.findFirst({
    where: { run_id: runId, type: "loop" },
    select: { agent_id: true },
  });
  if (!loopStep) return;

  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return;

  const scopedPath = path.join(workspace, `progress-${runId}.txt`);
  const legacyPath = path.join(workspace, "progress.txt");
  const progressPath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
  if (!fs.existsSync(progressPath)) return;

  const archiveDir = path.join(workspace, "archive", runId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(progressPath, path.join(archiveDir, "progress.txt"));
  fs.unlinkSync(progressPath);
}
