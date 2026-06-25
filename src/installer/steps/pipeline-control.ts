import fs from "node:fs";
import path from "node:path";

import { getDb } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import type { LoopConfig } from "../types.js";
import { getAgentWorkspacePath } from "./story-manager.js";

// ══════════════════════════════════════════════════════════════════════
// Run-terminal helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Look up the workflow_id for a given run.
 */
export function getWorkflowId(runId: string): string | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    return row?.workflow_id;
  } catch {
    return undefined;
  }
}

function getRunTokenSpend(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent;
  } catch {
    return undefined;
  }
}

/**
 * Emit a run.completed or run.failed event, attaching the current token spend
 * snapshot pulled from the runs table.
 */
export function emitRunTerminalEvent(params: {
  event: "run.completed" | "run.failed";
  runId: string;
  workflowId?: string;
  detail?: string;
}): void {
  emitEvent({
    ts: new Date().toISOString(),
    event: params.event,
    runId: params.runId,
    workflowId: params.workflowId,
    detail: params.detail,
    tokensSpent: getRunTokenSpend(params.runId),
  });
}

// ══════════════════════════════════════════════════════════════════════
// Cron teardown
// ══════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget cron teardown when a run ends.
 * Looks up the workflow_id for the run and tears down crons if no other active runs.
 */
export function scheduleRunCronTeardown(runId: string): void {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id, status FROM runs WHERE id = ?").get(runId) as { workflow_id: string; status: string } | undefined;
    if (!run) return;

    // Terminal runs never carry a scheduling_status. Any path that lands a
    // run in completed/failed/canceled should also wipe the scheduling
    // fields so the daemon reconciler stops considering it.
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      try {
        db.prepare(
          "UPDATE runs SET scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
        ).run(runId);
      } catch {
        // best-effort
      }
    }

    // Run-scoped teardown is preferred (daemon-owned timers are
    // run-scoped). The workflow-wide idle check remains as a back-compat
    // safety net for legacy callers / tests that still rely on it.
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

// ══════════════════════════════════════════════════════════════════════
// Draining pause finalization
// ══════════════════════════════════════════════════════════════════════

/**
 * When a run's scheduling_status is 'draining_pause', check whether all
 * running steps have completed; if so, finalize the pause by clearing
 * scheduler timers and setting status to 'paused'.
 */
export function finalizeDrainingPause(runId: string): void {
  const db = getDb();
  const run = db
    .prepare("SELECT scheduling_status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { scheduling_status: string; workflow_id: string } | undefined;
  if (!run || run.scheduling_status !== "draining_pause") return;

  const runningSteps = db
    .prepare("SELECT type, current_story_id, loop_config FROM steps WHERE run_id = ? AND status = 'running'")
    .all(runId) as Array<{ type: string; current_story_id: string | null; loop_config: string | null }>;
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

  db.prepare(
    "UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.paused",
    runId,
    workflowId: run.workflow_id,
  });

  logger.info("Drain-before-pause completed — run now paused", { runId });
}

// ══════════════════════════════════════════════════════════════════════
// Advance pipeline
// ══════════════════════════════════════════════════════════════════════

/**
 * Advance the pipeline: find the next waiting step and make it pending, or complete the run.
 * Respects terminal run states — a failed run cannot be advanced or completed.
 */
export function advancePipeline(runId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();

  // Guard: don't advance or complete a run that's already failed/cancelled
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runStatus?.status === "failed" || runStatus?.status === "canceled") {
    return { advanced: false, runCompleted: false };
  }

  const runningStep = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status = 'running' LIMIT 1"
  ).get(runId) as { id: string } | undefined;
  if (runningStep) {
    return { advanced: false, runCompleted: false };
  }

  const next = db.prepare(
    "SELECT id, step_id, step_index, parallel_group FROM steps WHERE run_id = ? AND status = 'waiting' ORDER BY step_index ASC LIMIT 1"
  ).get(runId) as { id: string; step_id: string; step_index: number; parallel_group: string | null } | undefined;

  // If next exists, also block advance when any earlier step is still
  // non-terminal (pending/running/failed). This matters for parallel_group:
  // a sibling still pending or running must not let the post-group step
  // race ahead.
  if (next) {
    const blockingPrior = db.prepare(
      "SELECT id FROM steps WHERE run_id = ? AND step_index < ? AND status IN ('failed', 'pending', 'running') LIMIT 1"
    ).get(runId, next.step_index) as { id: string } | undefined;
    if (blockingPrior) {
      return { advanced: false, runCompleted: false };
    }
  } else {
    const incomplete = db.prepare(
      "SELECT id FROM steps WHERE run_id = ? AND status IN ('failed', 'pending', 'running') LIMIT 1"
    ).get(runId) as { id: string } | undefined;
    if (incomplete) {
      return { advanced: false, runCompleted: false };
    }
  }

  const wfId = getWorkflowId(runId);
  if (next) {
    // Promote next from 'waiting' to 'pending'. If it belongs to a
    // parallel_group, also promote every contiguous waiting sibling that
    // shares the same group so the scheduler can claim them in parallel.
    const promoted: Array<{ id: string; step_id: string }> = [];
    if (next.parallel_group) {
      const groupSiblings = db.prepare(
        "SELECT id, step_id FROM steps WHERE run_id = ? AND status = 'waiting' AND parallel_group = ? AND step_index >= ? ORDER BY step_index ASC"
      ).all(runId, next.parallel_group, next.step_index) as Array<{ id: string; step_id: string }>;
      const promoteStmt = db.prepare(
        "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      );
      for (const sibling of groupSiblings) {
        promoteStmt.run(sibling.id);
        promoted.push(sibling);
      }
    } else {
      db.prepare(
        "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      ).run(next.id);
      promoted.push({ id: next.id, step_id: next.step_id });
    }
    for (const p of promoted) {
      emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId, workflowId: wfId, stepId: p.step_id });
      emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId, workflowId: wfId, stepId: p.step_id });
    }
    return { advanced: true, runCompleted: false };
  } else {
    db.prepare(
      "UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
    ).run(runId);
    emitRunTerminalEvent({ event: "run.completed", runId, workflowId: wfId });
    logger.info("Run completed", { runId, workflowId: wfId });
    archiveRunProgress(runId);
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: true };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress archiving
// ══════════════════════════════════════════════════════════════════════

/**
 * Archive the run's progress file to the agent workspace archive directory.
 */
export function archiveRunProgress(runId: string): void {
  const db = getDb();
  const loopStep = db.prepare(
    "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(runId) as { agent_id: string } | undefined;
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
