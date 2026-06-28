import { getPrisma } from "../../db.js";
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
export async function setRunContextKey(runId: string, key: string, value: string): Promise<void> {
  const prisma = getPrisma();
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { context: true },
  });
  if (!run) return;
  const context: Record<string, string> = JSON.parse(run.context);
  context[key] = value;
  await prisma.run.update({
    where: { id: runId },
    data: { context: JSON.stringify(context), updated_at: new Date() },
  });
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
export async function cleanupAbandonedSteps(): Promise<void> {
  const prisma = getPrisma();
  const thresholdMs = ABANDONED_THRESHOLD_MS;
  const thresholdTime = new Date(Date.now() - thresholdMs);

  // Find running steps with outdated timestamps
  const abandonedSteps = await prisma.step.findMany({
    where: {
      status: "running",
      updated_at: { lt: thresholdTime },
    },
  });

  for (const step of abandonedSteps) {
    // Skip loop steps waiting on verify_each (verify step still pending/running)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = await prisma.step.findFirst({
            where: { run_id: step.run_id, step_id: lcVerifyStep },
            select: { status: true },
          });
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
      const story = await prisma.story.findUnique({
        where: { id: step.current_story_id },
        select: { id: true, retry_count: true, max_retries: true, story_id: true, title: true },
      });

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = await getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          await prisma.story.update({
            where: { id: story.id },
            data: { status: "failed", retry_count: newRetry, updated_at: new Date() },
          });
          await prisma.step.update({
            where: { id: step.id },
            data: { status: "failed", output: "Story abandoned and retries exhausted", current_story_id: null, updated_at: new Date() },
          });
          await prisma.run.update({
            where: { id: step.run_id },
            data: { status: "failed", updated_at: new Date() },
          });
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Abandoned — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Story abandoned and retries exhausted" });
          await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story abandoned and retries exhausted" });
          await scheduleRunCronTeardown(step.run_id);
        } else {
          await prisma.story.update({
            where: { id: story.id },
            data: { status: "pending", retry_count: newRetry, updated_at: new Date() },
          });
          await prisma.step.update({
            where: { id: step.id },
            data: { status: "pending", current_story_id: null, updated_at: new Date() },
          });
          emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story ${story.story_id} abandoned — reset to pending (story retry ${newRetry})` });
          logger.info(`Abandoned step reset to pending (story retry ${newRetry})`, { runId: step.run_id, stepId: step.step_id });
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use abandoned_count, not retry_count
    const newAbandonCount = (step.abandoned_count ?? 0) + 1;
    if (newAbandonCount >= MAX_ABANDON_RESETS) {
      await prisma.step.update({
        where: { id: step.id },
        data: { status: "failed", output: `Agent abandoned step without completing (${newAbandonCount} times)`, abandoned_count: newAbandonCount, updated_at: new Date() },
      });
      await prisma.run.update({
        where: { id: step.run_id },
        data: { status: "failed", updated_at: new Date() },
      });
      const wfId = await getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Retries exhausted — step failed` });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent abandoned step without completing" });
      await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step abandoned and retries exhausted" });
      await scheduleRunCronTeardown(step.run_id);
    } else {
      await prisma.step.update({
        where: { id: step.id },
        data: { status: "pending", abandoned_count: newAbandonCount, updated_at: new Date() },
      });
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: await getWorkflowId(step.run_id), stepId: step.step_id, detail: `Reset to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})` });
    }
  }

  // Reset running stories that are abandoned — don't touch "done" stories
  const abandonedStories = await prisma.story.findMany({
    where: {
      status: "running",
      updated_at: { lt: thresholdTime },
    },
  });

  for (const story of abandonedStories) {
    await prisma.story.update({
      where: { id: story.id },
      data: { status: "pending", updated_at: new Date() },
    });
  }

  // Recover stuck pipelines: loop step done but no subsequent step pending/running
  const stuckLoops = await prisma.step.findMany({
    where: {
      type: "loop",
      status: "done",
      run: {
        status: "running",
      },
    },
    select: { id: true, run_id: true, step_index: true },
  });

  for (const stuck of stuckLoops) {
    // Check if there are any steps after this one in pending/running state
    const nextPendingOrRunning = await prisma.step.findFirst({
      where: {
        run_id: stuck.run_id,
        step_index: { gt: stuck.step_index },
        status: { in: ["pending", "running"] },
      },
    });

    // Check if there are any waiting steps after this one
    const nextWaiting = await prisma.step.findFirst({
      where: {
        run_id: stuck.run_id,
        step_index: { gt: stuck.step_index },
        status: "waiting",
      },
    });

    if (!nextPendingOrRunning && nextWaiting) {
      logger.info(`Recovering stuck pipeline after loop completion`, { runId: stuck.run_id, stepId: stuck.id });
      await advancePipeline(stuck.run_id);
    }
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
export async function recoverOrphanedStepsForAgent(
  agentId: string,
  runId: string,
  staleThresholdMs?: number,
  timeoutRetryReason?: string,
  failureReason?: string,
  workerJobId?: string,
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const prisma = getPrisma();

  // Build query filters
  const whereClause: any = {
    agent_id: agentId,
    status: "running",
    run_id: runId,
  };

  if (staleThresholdMs !== undefined) {
    const staleTime = new Date(Date.now() - staleThresholdMs);
    whereClause.updated_at = { lt: staleTime };
  }

  if (workerJobId !== undefined) {
    whereClause.OR = [
      { claim_job_id: null },
      { claim_job_id: workerJobId },
    ];
  }

  // Run-scoped query for orphaned steps
  const steps = await prisma.step.findMany({
    where: whereClause,
  });

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
          const verifyStatus = await prisma.step.findFirst({
            where: { run_id: step.run_id, step_id: lcVerifyStep },
            select: { status: true },
          });
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
      const story = await prisma.story.findUnique({
        where: { id: step.current_story_id },
        select: { id: true, retry_count: true, max_retries: true, story_id: true, title: true },
      });

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = await getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          await prisma.story.update({
            where: { id: story.id },
            data: { status: "failed", retry_count: newRetry, updated_at: new Date() },
          });
          await prisma.step.update({
            where: { id: step.id },
            data: { status: "failed", output: "Agent terminated without completing story; retries exhausted", current_story_id: null, updated_at: new Date() },
          });
          await prisma.run.update({
            where: { id: step.run_id },
            data: { status: "failed", updated_at: new Date() },
          });
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Agent terminated — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing story; retries exhausted" });
          await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Agent terminated without completing story; retries exhausted" });
          await scheduleRunCronTeardown(step.run_id);
          failed++;
        } else {
          await prisma.story.update({
            where: { id: story.id },
            data: { status: "pending", retry_count: newRetry, updated_at: new Date() },
          });
          await prisma.step.update({
            where: { id: step.id },
            data: { status: "pending", current_story_id: null, updated_at: new Date() },
          });
          const storyRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
          const storyRecoveryDetail = workerJobId !== undefined
            ? `Worker ${workerJobId} exited without completing story ${story.story_id}; reset to pending (story retry ${newRetry}/${story.max_retries})`
            : `Agent terminated; story ${story.story_id} reset to pending (story retry ${newRetry}/${story.max_retries})`;
          emitEvent({ ts: new Date().toISOString(), event: storyRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: storyRecoveryDetail });
          logger.info(`Orphaned step recovery: story ${story.story_id} reset to pending (retry ${newRetry}/${story.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
          if (timeoutRetryReason) {
            await setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
          }
          recovered++;
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use step retry_count
    const newRetry = step.retry_count + 1;
    const wfId = await getWorkflowId(step.run_id);
    if (newRetry > step.max_retries) {
      await prisma.step.update({
        where: { id: step.id },
        data: { status: "failed", retry_count: newRetry, output: "Agent terminated without completing step; retries exhausted", updated_at: new Date() },
      });
      await prisma.run.update({
        where: { id: step.run_id },
        data: { status: "failed", updated_at: new Date() },
      });
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step terminated and retries exhausted" });
      await scheduleRunCronTeardown(step.run_id);
      logger.warn(`Orphaned step retries exhausted`, { runId: step.run_id, stepId: step.step_id, agentId, retryCount: newRetry, maxRetries: step.max_retries });
      failed++;
    } else {
      // Persist failureReason into step.output so the next claimStep surfaces
      // it as `retry_feedback` to the retried agent. claimStep populates
      // context.retry_feedback from step.output when retry_count>0.
      await prisma.step.update({
        where: { id: step.id },
        data: {
          status: "pending",
          retry_count: newRetry,
          output: failureReason ?? undefined,
          updated_at: new Date(),
        },
      });
      const stepRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
      const stepRecoveryDetail = workerJobId !== undefined
        ? `Worker ${workerJobId} exited without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`
        : `Agent terminated without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`;
      emitEvent({ ts: new Date().toISOString(), event: stepRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: stepRecoveryDetail });
      logger.info(`Orphaned step reset to pending (retry ${newRetry}/${step.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
      if (timeoutRetryReason) {
        await setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
      }
      recovered++;
    }
  }

  return { recovered, failed, skipped };
}
