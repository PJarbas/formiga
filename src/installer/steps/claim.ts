import { getPrisma } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import type { LoopConfig, Story } from "../types.js";
import {
  resolveTemplate,
  findMissingTemplateKeys,
  computeHasFrontendChanges,
} from "./template-resolver.js";
import {
  readProgressFile,
  getStories,
  formatStoryForTemplate,
  formatCompletedStories,
} from "./story-manager.js";
import {
  scheduleRunCronTeardown,
  getWorkflowId,
  emitRunTerminalEvent,
  advancePipeline,
} from "./pipeline-control.js";
import { setRunContextKey, cleanupAbandonedSteps } from "./recovery.js";
import { resolveStepContext } from "./context.js";

// ══════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════

async function runHasStories(runId: string): Promise<boolean> {
  const prisma = getPrisma();
  const total = await prisma.story.count({
    where: { run_id: runId },
  });
  return total > 0;
}

// ══════════════════════════════════════════════════════════════════════
// Peek (Lightweight Work Check)
// ══════════════════════════════════════════════════════════════════════

export type PeekResult = "HAS_WORK" | "NO_WORK";

/**
 * Lightweight check: does this agent have any pending/waiting steps in active runs?
 * Unlike claimStep(), this runs a single cheap COUNT query — no cleanup, no context resolution.
 * Returns "HAS_WORK" if any pending/waiting steps exist, "NO_WORK" otherwise.
 */
export async function peekStep(agentId: string, runId: string): Promise<PeekResult> {
  const prisma = getPrisma();
  // Match 'pending' only — 'waiting' steps are still upstream-blocked, so
  // reporting them as work would cause spurious claim attempts.
  const count = await prisma.step.count({
    where: {
      agent_id: agentId,
      run_id: runId,
      status: "pending",
      run: {
        status: "running",
      },
    },
  });
  return count > 0 ? "HAS_WORK" : "NO_WORK";
}

// ══════════════════════════════════════════════════════════════════════
// Claim
// ══════════════════════════════════════════════════════════════════════

export interface WorkerOwnership {
  jobId: string;
  pid: number;
  pgid?: number;
}

export interface ClaimResult {
  found: boolean;
  stepId?: string;
  runId?: string;
  resolvedInput?: string;
}

/**
 * Throttle cleanupAbandonedSteps: run at most once every 5 minutes.
 */
let lastCleanupTime = 0;
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Find and claim a pending step for an agent, returning the resolved input.
 */
export async function claimStep(agentId: string, runId: string, workerOwnership?: WorkerOwnership): Promise<ClaimResult> {
  // Throttle cleanup: run at most once every 5 minutes across all agents
  const nowMs = Date.now();
  if (nowMs - lastCleanupTime >= CLEANUP_THROTTLE_MS) {
    await cleanupAbandonedSteps();
    lastCleanupTime = nowMs;
  }
  const prisma = getPrisma();

  // Notes on the prev-step filter:
  //  - `prev.status NOT IN ('done', 'skipped')` enforces serial pipeline progression.
  //  - The verify_each exception lets verify work: while the loop step is "paused"
  //    waiting for verify (status = 'running' but current_story_id IS NULL), the
  //    verify step needs to be claimable. Without this exception, completeStep's
  //    verify_each branch sets verify=pending while the loop stays running, but
  //    claimStep refuses to claim verify because the loop isn't done — deadlock.
  //  - The parallel_group exception lets sibling steps inside the same group
  //    claim concurrently: a sibling that is still pending/running does not
  //    block another sibling in the same group. The post-group step still
  //    waits because its `parallel_group` is NULL (or different), so siblings
  //    inside the group remain in its prev set.
  // Run-scoped claim: concurrent runs of the same workflow + agent never
  // cross-claim because the WHERE clause pins to a specific run_id.
  //
  // Prisma's relation API can't express this complex self-join, so use raw SQL.
  const stepRaw = await prisma.$queryRaw<
    Array<{
      id: string;
      step_id: string;
      run_id: string;
      input_template: string;
      type: string;
      loop_config: string | null;
      step_index: number;
      retry_count: number;
      output: string | null;
      parallel_group: string | null;
    }>
  >`
    SELECT s.id, s.step_id, s.run_id, s.input_template, s.type, s.loop_config, s.step_index, s.retry_count, s.output, s.parallel_group
    FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.agent_id = ${agentId} AND s.run_id = ${runId} AND s.status = 'pending'
      AND r.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM steps prev
        WHERE prev.run_id = s.run_id
          AND prev.step_index < s.step_index
          AND prev.status NOT IN ('done', 'skipped')
          AND NOT (prev.type = 'loop'
                   AND prev.status = 'running'
                   AND prev.current_story_id IS NULL)
          AND NOT (s.parallel_group IS NOT NULL
                   AND prev.parallel_group IS NOT NULL
                   AND prev.parallel_group = s.parallel_group)
      )
    ORDER BY s.step_index ASC, s.step_id ASC
    LIMIT 1
  `;

  const stepRecord = stepRaw.length > 0 ? stepRaw[0] : undefined;

  if (!stepRecord) return { found: false };

  // Guard: don't claim work for a terminal/paused run
  const runStatus = await prisma.run.findUnique({
    where: { id: stepRecord.run_id },
    select: { status: true },
  });
  if (runStatus?.status !== "running") return { found: false };

  // Build context via resolveStepContext
  const context = await resolveStepContext(stepRecord.run_id, stepRecord.step_index);

  // If this is a retry, surface the previous failure detail to the agent so
  // the second attempt can be more targeted than the first. The retry path
  // (e.g. the no-STORIES_JSON guard in completeStep) writes a human-readable
  // explanation into step.output before resetting the step to pending; pull
  // it into context as `retry_feedback` so workflow prompts can include it.
  context["retry_feedback"] =
    stepRecord.retry_count > 0 && stepRecord.output ? stepRecord.output : "";

  // Compute has_frontend_changes from git diff when repo and branch are available
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  } else {
    context["has_frontend_changes"] = "false";
  }

  // Loop step claim logic
  if (stepRecord.type === "loop") {
    const loopConfig: LoopConfig | null = stepRecord.loop_config ? JSON.parse(stepRecord.loop_config) : null;
    if (loopConfig?.over === "stories") {
      const now = new Date();
      const updateResult = await prisma.step.updateMany({
        where: { id: stepRecord.id, status: "pending" },
        data: workerOwnership
          ? {
              status: "running",
              claim_job_id: workerOwnership.jobId,
              claim_pid: workerOwnership.pid,
              claim_pgid: workerOwnership.pgid ?? null,
              claim_updated_at: now,
              updated_at: now,
            }
          : {
              status: "running",
              updated_at: now,
            },
      });
      if (updateResult.count <= 0) return { found: false };

      if (!(await runHasStories(stepRecord.run_id))) {
        const message = "Loop cannot run because planning did not produce STORIES_JSON.";
        await prisma.step.update({
          where: { id: stepRecord.id },
          data: {
            status: "failed",
            output: message,
            updated_at: now,
          },
        });
        await prisma.run.update({
          where: { id: stepRecord.run_id },
          data: {
            status: "failed",
            updated_at: now,
          },
        });
        const wfId = await getWorkflowId(stepRecord.run_id);
        emitEvent({ ts: now.toISOString(), event: "step.failed", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.step_id, agentId, detail: message });
        await emitRunTerminalEvent({ event: "run.failed", runId: stepRecord.run_id, workflowId: wfId, detail: message });
        await scheduleRunCronTeardown(stepRecord.run_id);
        return { found: false };
      }

      // Find next pending story
      const nextStory = await prisma.story.findFirst({
        where: { run_id: stepRecord.run_id, status: "pending" },
        orderBy: { story_index: "asc" },
      });

      if (!nextStory) {
        const failedStory = await prisma.story.findFirst({
          where: { run_id: stepRecord.run_id, status: "failed" },
          select: { id: true },
        });

        if (failedStory) {
          await prisma.step.update({
            where: { id: stepRecord.id },
            data: {
              status: "failed",
              output: "Loop cannot continue because one or more stories failed",
              updated_at: now,
            },
          });
          await prisma.run.update({
            where: { id: stepRecord.run_id },
            data: {
              status: "failed",
              updated_at: now,
            },
          });
          const wfId = await getWorkflowId(stepRecord.run_id);
          emitEvent({ ts: now.toISOString(), event: "step.failed", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.id, agentId, detail: "Loop has failed stories and no pending stories" });
          await emitRunTerminalEvent({ event: "run.failed", runId: stepRecord.run_id, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
          await scheduleRunCronTeardown(stepRecord.run_id);
          return { found: false };
        }

        // No pending or failed stories — mark step done and advance
        await prisma.step.update({
          where: { id: stepRecord.id },
          data: {
            status: "done",
            updated_at: now,
          },
        });
        const wfId = await getWorkflowId(stepRecord.run_id);
        emitEvent({ ts: now.toISOString(), event: "step.done", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.step_id, agentId });
        await advancePipeline(stepRecord.run_id);
        return { found: false };
      }

      // Claim the story. If another duplicate poller won it first, undo this
      // loop claim and let the next polling round inspect current state.
      const storyUpdateResult = await prisma.story.updateMany({
        where: { id: nextStory.id, status: "pending" },
        data: {
          status: "running",
          updated_at: now,
        },
      });
      if (storyUpdateResult.count <= 0) {
        await prisma.step.update({
          where: { id: stepRecord.id },
          data: {
            status: "pending",
            current_story_id: null,
            updated_at: now,
          },
        });
        return { found: false };
      }
      await prisma.step.update({
        where: { id: stepRecord.id },
        data: workerOwnership
          ? {
              status: "running",
              current_story_id: nextStory.id,
              claim_job_id: workerOwnership.jobId,
              claim_pid: workerOwnership.pid,
              claim_pgid: workerOwnership.pgid ?? null,
              claim_updated_at: now,
              updated_at: now,
            }
          : {
              status: "running",
              current_story_id: nextStory.id,
              updated_at: now,
            },
      });

      const wfId = await getWorkflowId(stepRecord.run_id);
      emitEvent({ ts: now.toISOString(), event: "step.running", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.step_id, agentId });
      emitEvent({ ts: now.toISOString(), event: "story.started", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.step_id, agentId, storyId: nextStory.story_id, storyTitle: nextStory.title });
      logger.info(`Story started: ${nextStory.story_id} — ${nextStory.title}`, { runId: stepRecord.run_id, stepId: stepRecord.step_id });

      // Build story template vars
      const story: Story = {
        id: nextStory.id,
        runId: nextStory.run_id,
        storyIndex: nextStory.story_index,
        storyId: nextStory.story_id,
        title: nextStory.title,
        description: nextStory.description,
        acceptanceCriteria: JSON.parse(nextStory.acceptance_criteria),
        status: nextStory.status as any,
        output: nextStory.output ?? undefined,
        retryCount: nextStory.retry_count,
        maxRetries: nextStory.max_retries,
      };

      const allStories = await getStories(stepRecord.run_id);
      const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;

      context["current_story"] = formatStoryForTemplate(story);
      context["current_story_id"] = story.storyId;
      context["current_story_title"] = story.title;
      context["completed_stories"] = formatCompletedStories(allStories);
      context["stories_remaining"] = String(pendingCount);
      context["progress"] = await readProgressFile(stepRecord.run_id);

      if (!context["verify_feedback"]) {
        context["verify_feedback"] = "";
      }

      const missingKeys = findMissingTemplateKeys(stepRecord.input_template, context);
      if (missingKeys.length > 0) {
        logger.warn(
          `Step ${stepRecord.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
          { runId: stepRecord.run_id, stepId: stepRecord.step_id, missingKeys },
        );
      }

      // Clear one-shot timeout_retry so it doesn't leak into subsequent stories.
      // The resolved template must capture it first; delete only after resolution.
      const hasTimeoutRetryLoop = Boolean(context["timeout_retry"]);

      // Persist story context vars to DB so verify_each steps can access them
      await prisma.run.update({
        where: { id: stepRecord.run_id },
        data: {
          context: JSON.stringify(context),
          updated_at: now,
        },
      });

      const resolvedInput = resolveTemplate(stepRecord.input_template, context);

      if (hasTimeoutRetryLoop) {
        delete context["timeout_retry"];
        await prisma.run.update({
          where: { id: stepRecord.run_id },
          data: {
            context: JSON.stringify(context),
            updated_at: now,
          },
        });
      }

      return { found: true, stepId: stepRecord.id, runId: stepRecord.run_id, resolvedInput };
    }
  }

  // Single step: existing logic
  const now = new Date();
  const updateResult = await prisma.step.updateMany({
    where: { id: stepRecord.id, status: "pending" },
    data: workerOwnership
      ? {
          status: "running",
          claim_job_id: workerOwnership.jobId,
          claim_pid: workerOwnership.pid,
          claim_pgid: workerOwnership.pgid ?? null,
          claim_updated_at: now,
          updated_at: now,
        }
      : {
          status: "running",
          updated_at: now,
        },
  });
  if (updateResult.count <= 0) return { found: false };
  const wfId = await getWorkflowId(stepRecord.run_id);
  emitEvent({ ts: now.toISOString(), event: "step.running", runId: stepRecord.run_id, workflowId: wfId, stepId: stepRecord.step_id, agentId });
  logger.info(`Step claimed by ${agentId}`, { runId: stepRecord.run_id, stepId: stepRecord.step_id });

  // Inject progress for any step in a run that has stories
  const hasStories = await prisma.story.count({
    where: { run_id: stepRecord.run_id },
  });
  if (hasStories > 0) {
    context["progress"] = await readProgressFile(stepRecord.run_id);
  }

  // Clear one-shot timeout_retry after the template has captured it.
  // For single (non-loop) steps the context isn't persisted here, so
  // remove the key from the DB explicitly to prevent it from leaking
  // into downstream steps.
  const hasTimeoutRetry = Boolean(context["timeout_retry"]);

  const missingKeys = findMissingTemplateKeys(stepRecord.input_template, context);
  if (missingKeys.length > 0) {
    logger.warn(
      `Step ${stepRecord.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
      { runId: stepRecord.run_id, stepId: stepRecord.step_id, missingKeys },
    );
  }

  const resolvedInput = resolveTemplate(stepRecord.input_template, context);

  if (hasTimeoutRetry) {
    delete context["timeout_retry"];
    await setRunContextKey(stepRecord.run_id, "timeout_retry", "");
  }

  return {
    found: true,
    stepId: stepRecord.id,
    runId: stepRecord.run_id,
    resolvedInput,
  };
}
