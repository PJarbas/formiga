import { getDb } from "../../db.js";
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

function runHasStories(runId: string): boolean {
  const db = getDb();
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
  ).get(runId) as { cnt: number } | undefined;
  return (total?.cnt ?? 0) > 0;
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
export function peekStep(agentId: string, runId: string): PeekResult {
  const db = getDb();
  // Match 'pending' only — 'waiting' steps are still upstream-blocked, so
  // reporting them as work would cause spurious claim attempts.
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ?
       AND s.status = 'pending'
       AND r.status = 'running'`,
  ).get(agentId, runId) as { cnt: number };
  return row.cnt > 0 ? "HAS_WORK" : "NO_WORK";
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
export function claimStep(agentId: string, runId: string, workerOwnership?: WorkerOwnership): ClaimResult {
  // Throttle cleanup: run at most once every 5 minutes across all agents
  const now = Date.now();
  if (now - lastCleanupTime >= CLEANUP_THROTTLE_MS) {
    cleanupAbandonedSteps();
    lastCleanupTime = now;
  }
  const db = getDb();

  // Notes on the prev-step filter:
  //  - `prev.status NOT IN ('done', 'skipped')` enforces serial pipeline progression.
  //  - The extra exception lets verify_each work: while the loop step is "paused"
  //    waiting for verify (status = 'running' but current_story_id IS NULL), the
  //    verify step needs to be claimable. Without this exception, completeStep's
  //    verify_each branch sets verify=pending while the loop stays running, but
  //    claimStep refuses to claim verify because the loop isn't done — deadlock.
  // Run-scoped claim: concurrent runs of the same workflow + agent never
  // cross-claim because the WHERE clause pins to a specific run_id.
  const step = db.prepare(
    `SELECT s.id, s.step_id, s.run_id, s.input_template, s.type, s.loop_config, s.step_index, s.retry_count, s.output
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ? AND s.status = 'pending'
       AND r.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM steps prev
         WHERE prev.run_id = s.run_id
           AND prev.step_index < s.step_index
           AND prev.status NOT IN ('done', 'skipped')
           AND NOT (prev.type = 'loop'
                    AND prev.status = 'running'
                    AND prev.current_story_id IS NULL)
       )
    ORDER BY s.step_index ASC, s.step_id ASC
     LIMIT 1`,
  ).get(agentId, runId) as {
    id: string; step_id: string; run_id: string; input_template: string; type: string;
    loop_config: string | null;
    step_index: number;
    retry_count: number;
    output: string | null;
  } | undefined;

  if (!step) return { found: false };

  // Guard: don't claim work for a terminal/paused run
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(step.run_id) as { status: string } | undefined;
  if (runStatus?.status !== "running") return { found: false };

  // Build context via resolveStepContext
  const context = resolveStepContext(step.run_id, step.step_index);

  // If this is a retry, surface the previous failure detail to the agent so
  // the second attempt can be more targeted than the first. The retry path
  // (e.g. the no-STORIES_JSON guard in completeStep) writes a human-readable
  // explanation into step.output before resetting the step to pending; pull
  // it into context as `retry_feedback` so workflow prompts can include it.
  context["retry_feedback"] =
    step.retry_count > 0 && step.output ? step.output : "";

  // Compute has_frontend_changes from git diff when repo and branch are available
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  } else {
    context["has_frontend_changes"] = "false";
  }

  // Loop step claim logic
  if (step.type === "loop") {
    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;
    if (loopConfig?.over === "stories") {
      const claim = db.prepare(
        workerOwnership
          ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
          : "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(
        ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
      );
      if ((claim.changes ?? 0) <= 0) return { found: false };

      if (!runHasStories(step.run_id)) {
        const message = "Loop cannot run because planning did not produce STORIES_JSON.";
        db.prepare(
          "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(message, step.id);
        db.prepare(
          "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
        ).run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, detail: message });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: message });
        scheduleRunCronTeardown(step.run_id);
        return { found: false };
      }

      // Find next pending story
      const nextStory = db.prepare(
        "SELECT * FROM stories WHERE run_id = ? AND status = 'pending' ORDER BY story_index ASC LIMIT 1"
      ).get(step.run_id) as any | undefined;

      if (!nextStory) {
        const failedStory = db.prepare(
          "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
        ).get(step.run_id) as { id: string } | undefined;

        if (failedStory) {
          db.prepare(
            "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
          ).run("Loop cannot continue because one or more stories failed", step.id);
          db.prepare(
            "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
          ).run(step.run_id);
          const wfId = getWorkflowId(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.id, agentId, detail: "Loop has failed stories and no pending stories" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
          scheduleRunCronTeardown(step.run_id);
          return { found: false };
        }

        // No pending or failed stories — mark step done and advance
        db.prepare(
          "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
        advancePipeline(step.run_id);
        return { found: false };
      }

      // Claim the story. If another duplicate poller won it first, undo this
      // loop claim and let the next polling round inspect current state.
      const storyClaim = db.prepare(
        "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(nextStory.id);
      if ((storyClaim.changes ?? 0) <= 0) {
        db.prepare(
          "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        return { found: false };
      }
      db.prepare(
        workerOwnership
          ? "UPDATE steps SET status = 'running', current_story_id = ?, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          : "UPDATE steps SET status = 'running', current_story_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(
        ...(workerOwnership ? [nextStory.id, workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [nextStory.id, step.id])
      );

      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId });
      emitEvent({ ts: new Date().toISOString(), event: "story.started", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, storyId: nextStory.story_id, storyTitle: nextStory.title });
      logger.info(`Story started: ${nextStory.story_id} — ${nextStory.title}`, { runId: step.run_id, stepId: step.step_id });

      // Build story template vars
      const story: Story = {
        id: nextStory.id,
        runId: nextStory.run_id,
        storyIndex: nextStory.story_index,
        storyId: nextStory.story_id,
        title: nextStory.title,
        description: nextStory.description,
        acceptanceCriteria: JSON.parse(nextStory.acceptance_criteria),
        status: nextStory.status,
        output: nextStory.output ?? undefined,
        retryCount: nextStory.retry_count,
        maxRetries: nextStory.max_retries,
      };

      const allStories = getStories(step.run_id);
      const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;

      context["current_story"] = formatStoryForTemplate(story);
      context["current_story_id"] = story.storyId;
      context["current_story_title"] = story.title;
      context["completed_stories"] = formatCompletedStories(allStories);
      context["stories_remaining"] = String(pendingCount);
      context["progress"] = readProgressFile(step.run_id);

      if (!context["verify_feedback"]) {
        context["verify_feedback"] = "";
      }

      const missingKeys = findMissingTemplateKeys(step.input_template, context);
      if (missingKeys.length > 0) {
        logger.warn(
          `Step ${step.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
          { runId: step.run_id, stepId: step.step_id, missingKeys },
        );
      }

      // Clear one-shot timeout_retry so it doesn't leak into subsequent stories.
      // The resolved template must capture it first; delete only after resolution.
      const hasTimeoutRetryLoop = Boolean(context["timeout_retry"]);

      // Persist story context vars to DB so verify_each steps can access them
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);

      const resolvedInput = resolveTemplate(step.input_template, context);

      if (hasTimeoutRetryLoop) {
        delete context["timeout_retry"];
        db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);
      }

      return { found: true, stepId: step.id, runId: step.run_id, resolvedInput };
    }
  }

  // Single step: existing logic
  const claim = db.prepare(
    workerOwnership
      ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      : "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(
    ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
  );
  if ((claim.changes ?? 0) <= 0) return { found: false };
  emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
  logger.info(`Step claimed by ${agentId}`, { runId: step.run_id, stepId: step.step_id });

  // Inject progress for any step in a run that has stories
  const hasStories = db.prepare(
    "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
  ).get(step.run_id) as { cnt: number };
  if (hasStories.cnt > 0) {
    context["progress"] = readProgressFile(step.run_id);
  }

  // Clear one-shot timeout_retry after the template has captured it.
  // For single (non-loop) steps the context isn't persisted here, so
  // remove the key from the DB explicitly to prevent it from leaking
  // into downstream steps.
  const hasTimeoutRetry = Boolean(context["timeout_retry"]);

  const missingKeys = findMissingTemplateKeys(step.input_template, context);
  if (missingKeys.length > 0) {
    logger.warn(
      `Step ${step.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
      { runId: step.run_id, stepId: step.step_id, missingKeys },
    );
  }

  const resolvedInput = resolveTemplate(step.input_template, context);

  if (hasTimeoutRetry) {
    delete context["timeout_retry"];
    setRunContextKey(step.run_id, "timeout_retry", "");
  }

  return {
    found: true,
    stepId: step.id,
    runId: step.run_id,
    resolvedInput,
  };
}
