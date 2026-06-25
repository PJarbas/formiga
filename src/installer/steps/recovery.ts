import { getDb } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import { getMaxRoleTimeoutSeconds } from "../install.js";
import type { LoopConfig } from "../types.js";
import {
  scheduleRunCronTeardown,
  getWorkflowId,
  emitRunTerminalEvent,
  advancePipeline,
} from "./pipeline-control.js";

// ══════════════════════════════════════════════════════════════════════
// Run-context helper (shared with claim/complete state-machine paths)
// ══════════════════════════════════════════════════════════════════════

/**
 * Set a key-value pair in a run's context JSON field.
 * Reads existing context, sets the key, and writes back.
 */
export function setRunContextKey(runId: string, key: string, value: string): void {
  const db = getDb();
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!run) return;
  const context: Record<string, string> = JSON.parse(run.context);
  context[key] = value;
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), runId);
}

// ══════════════════════════════════════════════════════════════════════
// Abandoned Step Cleanup
// ══════════════════════════════════════════════════════════════════════

const ABANDONED_THRESHOLD_MS = (getMaxRoleTimeoutSeconds() + 5 * 60) * 1000;
const MAX_ABANDON_RESETS = 5;

/**
 * Find steps that have been "running" for too long and reset them to pending.
 * This catches cases where an agent claimed a step but never completed/failed it.
 * Exported so it can be called from medic/health-check crons independently of claimStep.
 */
export function cleanupAbandonedSteps(): void {
  const db = getDb();
  const thresholdMs = ABANDONED_THRESHOLD_MS;

  const abandonedSteps = db.prepare(
    "SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config, abandoned_count FROM steps WHERE status = 'running' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null; abandoned_count: number;
  }[];

  for (const step of abandonedSteps) {
    // Skip loop steps waiting on verify_each (verify step still pending/running)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to abandonment handling.
      }
    }

    // Loop steps: apply per-story retry, not per-step retry
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Story abandoned and retries exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Abandoned — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Story abandoned and retries exhausted" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story abandoned and retries exhausted" });
          scheduleRunCronTeardown(step.run_id);
        } else {
          db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story ${story.story_id} abandoned — reset to pending (story retry ${newRetry})` });
          logger.info(`Abandoned step reset to pending (story retry ${newRetry})`, { runId: step.run_id, stepId: step.step_id });
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use abandoned_count, not retry_count
    const newAbandonCount = (step.abandoned_count ?? 0) + 1;
    if (newAbandonCount >= MAX_ABANDON_RESETS) {
      db.prepare(
        "UPDATE steps SET status = 'failed', output = 'Agent abandoned step without completing (' || ? || ' times)', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, newAbandonCount, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Retries exhausted — step failed` });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent abandoned step without completing" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step abandoned and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
    } else {
      db.prepare(
        "UPDATE steps SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, step.id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, detail: `Reset to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})` });
    }
  }

  // Reset running stories that are abandoned — don't touch "done" stories
  const abandonedStories = db.prepare(
    "SELECT id, retry_count, max_retries, run_id FROM stories WHERE status = 'running' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as { id: string; retry_count: number; max_retries: number; run_id: string }[];

  for (const story of abandonedStories) {
    db.prepare("UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(story.id);
  }

  // Recover stuck pipelines: loop step done but no subsequent step pending/running
  const stuckLoops = db.prepare(`
    SELECT s.id, s.run_id, s.step_index FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.type = 'loop' AND s.status = 'done' AND r.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM steps s2 WHERE s2.run_id = s.run_id
      AND s2.step_index > s.step_index
      AND s2.status IN ('pending', 'running')
    )
    AND EXISTS (
      SELECT 1 FROM steps s3 WHERE s3.run_id = s.run_id
      AND s3.step_index > s.step_index
      AND s3.status = 'waiting'
    )
  `).all() as { id: string; run_id: string; step_index: number }[];

  for (const stuck of stuckLoops) {
    logger.info(`Recovering stuck pipeline after loop completion`, { runId: stuck.run_id, stepId: stuck.id });
    advancePipeline(stuck.run_id);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Orphaned Step Recovery (post-SIGKILL)
// ══════════════════════════════════════════════════════════════════════

/**
 * Recover orphaned running steps for a specific agent.
 * Called when pi exits abnormally (SIGKILL, non-zero exit) to prevent
 * steps from being permanently stuck at status='running' — peekStep only
 * matches pending/waiting, so an orphaned running step is invisible to
 * the polling cron and the run wedges silently.
 *
 * @param agentId - The agent ID whose running steps to recover
 * @param staleThresholdMs - Optional: only recover steps whose updated_at
 *   is older than this many milliseconds. When omitted, all running steps
 *   for the agent are recovered (use in post-exit handlers where we KNOW
 *   the agent just died).
 * @param timeoutRetryReason - Optional: human-readable reason for the
 *   timeout (e.g. "pi timed out after 1800000ms"). When provided, each
 *   recovered step's run context is augmented with `timeout_retry` so the
 *   retry prompt includes a signal that the prior attempt was interrupted
 *   and uncommitted work may exist on disk.
 */
export function recoverOrphanedStepsForAgent(
  agentId: string,
  runId: string,
  staleThresholdMs?: number,
  timeoutRetryReason?: string,
  failureReason?: string,
  workerJobId?: string,
): { recovered: number; failed: number; skipped: number } {
  const db = getDb();

  // Run-scoped query. Every caller (polling round, control plane,
  // shutdown paths) supplies a runId so concurrent runs of the same
  // workflow + agent are isolated.
  const clauses: string[] = ["agent_id = ?", "status = 'running'", "run_id = ?"];
  const params: (string | number)[] = [agentId, runId];
  if (staleThresholdMs !== undefined) {
    clauses.push("(julianday('now') - julianday(updated_at)) * 86400000 > ?");
    params.push(staleThresholdMs);
  }
  // Ownership-aware filter: when workerJobId is provided, skip steps
  // claimed by a different worker (claim_job_id mismatch). Steps with
  // NULL claim_job_id (legacy, pre-ownership) are always recovered.
  if (workerJobId !== undefined) {
    clauses.push("(claim_job_id IS NULL OR claim_job_id = ?)");
    params.push(workerJobId);
  }
  const query = `SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config
       FROM steps
       WHERE ${clauses.join(" AND ")}`;

  const steps = db.prepare(query).all(...params) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null;
  }[];

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const step of steps) {
    // Skip loop steps waiting on verify_each (mid-iteration pause, not orphaned)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            skipped++;
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to recovery.
      }
    }

    // Loop steps with current_story_id: handle story-level retry
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Agent terminated without completing story; retries exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Agent terminated — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing story; retries exhausted" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Agent terminated without completing story; retries exhausted" });
          scheduleRunCronTeardown(step.run_id);
          failed++;
        } else {
          db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          const storyRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
          const storyRecoveryDetail = workerJobId !== undefined
            ? `Worker ${workerJobId} exited without completing story ${story.story_id}; reset to pending (story retry ${newRetry}/${story.max_retries})`
            : `Agent terminated; story ${story.story_id} reset to pending (story retry ${newRetry}/${story.max_retries})`;
          emitEvent({ ts: new Date().toISOString(), event: storyRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: storyRecoveryDetail });
          logger.info(`Orphaned step recovery: story ${story.story_id} reset to pending (retry ${newRetry}/${story.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
          if (timeoutRetryReason) {
            setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
          }
          recovered++;
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use step retry_count
    const newRetry = step.retry_count + 1;
    const wfId = getWorkflowId(step.run_id);
    if (newRetry > step.max_retries) {
      db.prepare(
        "UPDATE steps SET status = 'failed', retry_count = ?, output = 'Agent terminated without completing step; retries exhausted', updated_at = datetime('now') WHERE id = ?"
      ).run(newRetry, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step terminated and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      logger.warn(`Orphaned step retries exhausted`, { runId: step.run_id, stepId: step.step_id, agentId, retryCount: newRetry, maxRetries: step.max_retries });
      failed++;
    } else {
      // Persist failureReason into step.output so the next claimStep surfaces
      // it as `retry_feedback` to the retried agent. claimStep populates
      // context.retry_feedback from step.output when retry_count>0.
      if (failureReason) {
        db.prepare(
          "UPDATE steps SET status = 'pending', retry_count = ?, output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, failureReason, step.id);
      } else {
        db.prepare(
          "UPDATE steps SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, step.id);
      }
      const stepRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
      const stepRecoveryDetail = workerJobId !== undefined
        ? `Worker ${workerJobId} exited without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`
        : `Agent terminated without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`;
      emitEvent({ ts: new Date().toISOString(), event: stepRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: stepRecoveryDetail });
      logger.info(`Orphaned step reset to pending (retry ${newRetry}/${step.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
      if (timeoutRetryReason) {
        setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
      }
      recovered++;
    }
  }

  return { recovered, failed, skipped };
}
