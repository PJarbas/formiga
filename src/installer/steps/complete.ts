import { getDb } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import type { LoopConfig } from "../types.js";
import {
  parseOutputKeyValues,
  RESERVED_CONTEXT_KEYS,
} from "./template-resolver.js";
import {
  writeStoryPlanToProgress,
  parseAndInsertStories,
} from "./story-manager.js";
import {
  scheduleRunCronTeardown,
  getWorkflowId,
  emitRunTerminalEvent,
  finalizeDrainingPause,
  advancePipeline,
} from "./pipeline-control.js";
import { ingestStepOutput } from "../../leaderboard/ingest.js";

// ══════════════════════════════════════════════════════════════════════
// Expects Validation
// ══════════════════════════════════════════════════════════════════════

/**
 * Validate step output against the `expects` specification.
 *
 * Supports two kinds of lines:
 *   - Literal lines: the exact text must appear as a substring in the output.
 *   - Regex lines: prefixed with `regex:`, the rest is a pattern tested
 *     against the output (flags: m for multiline).
 *
 * Returns null if output satisfies all expects lines, or an error message
 * describing the first failing line.
 */
export function validateExpects(output: string, expects: string): string | null {
  if (!expects || expects.trim() === "") return null;

  const lines = expects.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("regex:")) {
      const pattern = trimmed.slice("regex:".length);
      try {
        const re = new RegExp(pattern, "m");
        if (!re.test(output)) {
          return `Output does not match expects regex: ${pattern}`;
        }
      } catch {
        return `Invalid expects regex pattern: ${pattern}`;
      }
    } else {
      if (!output.includes(trimmed)) {
        return `Output missing expects string: "${trimmed}"`;
      }
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Post-advance nudge
// ══════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget in-process nudge of the run's scheduled jobs so the
 * next pending step is claimed within ~1s instead of waiting up to one
 * cron interval (1-15 min). Safe to call from any process: if the
 * daemon isn't running in this process, the nudge is a no-op because
 * jobMetadata is empty.
 */
function postAdvanceNudge(runId: string): void {
  import("../scheduler/cron-manager.js")
    .then((m) => m.nudgeScheduledRuns([runId]))
    .catch((err) => {
      logger.warn("post-advance nudge failed", { runId, error: String(err) });
    });
}

// ══════════════════════════════════════════════════════════════════════
// Complete Step
// ══════════════════════════════════════════════════════════════════════

/**
 * Complete a step: validate expects, save output, merge context, advance pipeline.
 */
export function completeStep(stepId: string, output: string): { status: string; detail?: string } {
  const db = getDb();

  const step = db.prepare(
    "SELECT id, run_id, step_id, agent_id, step_index, type, loop_config, current_story_id, expects, input_template FROM steps WHERE id = ?"
  ).get(stepId) as {
    id: string; run_id: string; step_id: string; agent_id: string; step_index: number; type: string;
    loop_config: string | null; current_story_id: string | null; expects: string;
    input_template: string | null;
  } | undefined;

  if (!step) throw new Error(`Step not found: ${stepId}`);

  // Guard: don't process completions for failed runs
  const runId = step.run_id;
  const runCheck = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runCheck?.status === "failed" || runCheck?.status === "canceled") {
    return { status: "blocked" };
  }

  // Validate output against the expects column before accepting the step
  const validationError = validateExpects(output, step.expects);
  if (validationError) {
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?"
    ).get(stepId) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const wfId = getWorkflowId(step.run_id);

    if (newRetry > maxRetries) {
      db.prepare(
        "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(validationError, newRetry, stepId);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: validationError });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Expects validation failed and retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(validationError, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId, workflowId: wfId, stepId: step.step_id, detail: validationError });
    logger.warn(validationError, { runId, stepId: step.step_id });
    finalizeDrainingPause(runId);
    return { status: "retrying", detail: validationError };
  }

  // Merge KEY: value lines into run context
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const context: Record<string, string> = JSON.parse(run.context);

  const parsed = parseOutputKeyValues(output);
  for (const [key, value] of Object.entries(parsed)) {
    if (!RESERVED_CONTEXT_KEYS.has(key)) {
      context[key] = value;
    }
  }

  db.prepare(
    "UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(context), runId);

  // Leaderboard ingest hook — for ML modeler/baseline agents only.
  // Gated by agent suffix inside ingestStepOutput so non-ML steps no-op.
  // The `workspace` context key (seeded at run creation) is required for the
  // sidecar JSON fallback path that survives pi's report-tool stdout
  // normalization.
  try {
    ingestStepOutput({
      agentId: step.agent_id,
      runId,
      parsedKv: parsed,
      workspace: context["workspace"],
    });
  } catch (err) {
    logger.warn("Leaderboard ingest threw", {
      runId,
      stepId: step.step_id,
      error: (err as Error).message,
    });
  }

  // Parse STORIES_JSON from output (any step, typically the planner)
  parseAndInsertStories(output, runId);

  // Write story plan to progress log after STORIES_JSON is parsed
  writeStoryPlanToProgress(runId);

  // Robustness: if a downstream loop-over-stories exists but no stories were
  // produced, force a retry. Story-producers (template mentions STORIES_JSON)
  // search the entire downstream pipeline; others only check the next step
  // to avoid blaming non-producing steps. Honor max_retries so a permanently
  // broken planner still escalates.
  if (step.type !== "loop") {
    const stepMentionsStories = step.input_template?.includes("STORIES_JSON");
    let downstreamLoopExpectingStories = db.prepare(
      "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index = ? AND type = 'loop'"
    ).get(step.run_id, step.step_index + 1) as { id: string; step_id: string; loop_config: string | null } | undefined;
    if (!downstreamLoopExpectingStories && stepMentionsStories) {
      downstreamLoopExpectingStories = db.prepare(
        "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index > ? AND type = 'loop' ORDER BY step_index ASC LIMIT 1"
      ).get(step.run_id, step.step_index) as { id: string; step_id: string; loop_config: string | null } | undefined;
    }
    if (downstreamLoopExpectingStories?.loop_config) {
      try {
        const lc = JSON.parse(downstreamLoopExpectingStories.loop_config) as LoopConfig;
        const storiesCount = (db.prepare("SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?").get(step.run_id) as { cnt: number } | undefined)?.cnt ?? 0;
        if (lc.over === "stories" && storiesCount === 0) {
          const meta = db.prepare(
            "SELECT retry_count, max_retries FROM steps WHERE id = ?"
          ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
          const newRetry = (meta?.retry_count ?? 0) + 1;
          const maxRetries = meta?.max_retries ?? 0;
          const errorDetail =
            `Step output had no STORIES_JSON block, but the next step (${downstreamLoopExpectingStories.step_id}) is a loop over stories. ` +
            `The agent must emit a literal "STORIES_JSON: [ ... ]" line with at least one story. Resetting to pending for retry ${newRetry}/${maxRetries}.`;
          const wfId = getWorkflowId(step.run_id);
          if (newRetry > maxRetries) {
            db.prepare(
              "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(errorDetail, newRetry, step.id);
            db.prepare(
              "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
            ).run(step.run_id);
            emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
            emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Plan step never produced STORIES_JSON" });
            scheduleRunCronTeardown(step.run_id);
            finalizeDrainingPause(step.run_id);
            return { status: "failed" };
          }
          db.prepare(
            "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(errorDetail, newRetry, step.id);
          logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
          finalizeDrainingPause(step.run_id);
          return { status: "retrying", detail: errorDetail };
        }
      } catch {
        // best-effort: if loop_config can't be parsed, don't block completion
      }
    }
  }

  // Loop step completion
  if (step.type === "loop" && step.current_story_id) {
    const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id) as { story_id: string; title: string } | undefined;

    // Mark current story done
    db.prepare(
      "UPDATE stories SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, step.current_story_id);
    emitEvent({ ts: new Date().toISOString(), event: "story.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, storyId: storyRow?.story_id, storyTitle: storyRow?.title });
    logger.info(`Story done: ${storyRow?.story_id} — ${storyRow?.title}`, { runId: step.run_id, stepId: step.step_id });

    // Clear current_story_id, save output
    db.prepare(
      "UPDATE steps SET current_story_id = NULL, output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, step.id);

    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;

    // verify_each flow — set verify step to pending. YAML uses snake_case;
    // accept both casings for back-compat with the camelCase types.
    const verifyEachOn = loopConfig?.verifyEach ?? loopConfig?.verify_each;
    const verifyStepId = loopConfig?.verifyStep ?? loopConfig?.verify_step;
    if (verifyEachOn && verifyStepId) {
      const verifyStep = db.prepare(
        "SELECT id FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
      ).get(step.run_id, verifyStepId) as { id: string } | undefined;

      if (verifyStep) {
        db.prepare(
          "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
        ).run(verifyStep.id);
        // Loop step stays 'running'
        db.prepare(
          "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        return { status: "advanced" };
      }
    }

    // No verify_each: check for more stories
    const loopResult = checkLoopContinuation(step.run_id, step.id);
    return { status: loopResult.runCompleted ? "completed" : "advanced" };
  }

  // Check if this is a verify step triggered by verify-each
  const loopStepRow = db.prepare(
    "SELECT id, loop_config, run_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(step.run_id) as { id: string; loop_config: string | null; run_id: string } | undefined;

  if (loopStepRow?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStepRow.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep === step.step_id) {
      const verifyResult = handleVerifyEachCompletion(step, loopStepRow.id, output, context);
      return { status: verifyResult.runCompleted ? "completed" : "advanced" };
    }
  }

  // Single step: mark done and advance
  db.prepare(
    "UPDATE steps SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(output, stepId);
  emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id });
  logger.info(`Step completed: ${step.step_id}`, { runId: step.run_id, stepId: step.step_id });

  const pipelineResult = advancePipeline(step.run_id);
  finalizeDrainingPause(step.run_id);
  if (pipelineResult.advanced) {
    postAdvanceNudge(step.run_id);
  }
  return { status: pipelineResult.runCompleted ? "completed" : "advanced" };
}

/**
 * Handle verify-each completion: pass or fail the story.
 */
function handleVerifyEachCompletion(
  verifyStep: { id: string; run_id: string; step_id: string; step_index: number },
  loopStepId: string,
  output: string,
  context: Record<string, string>
): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const status = context["status"]?.toLowerCase();

  // Reset verify step to waiting for next use
  db.prepare(
    "UPDATE steps SET status = 'waiting', output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(output, verifyStep.id);

  if (status !== "retry") {
    emitEvent({ ts: new Date().toISOString(), event: "story.verified", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id });
  }

  if (status === "retry") {
    const lastDoneStory = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE run_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1"
    ).get(verifyStep.run_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);
        db.prepare("UPDATE steps SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(verifyStep.run_id);
        const wfId = getWorkflowId(verifyStep.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id });
        emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verification retries exhausted" });
        scheduleRunCronTeardown(verifyStep.run_id);
        finalizeDrainingPause(verifyStep.run_id);
        return { advanced: false, runCompleted: false };
      }

      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);

      const issues = context["issues"] ?? output;
      context["verify_feedback"] = issues;
      emitEvent({ ts: new Date().toISOString(), event: "story.retry", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id, detail: issues });
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);
    }

    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  // Verify passed — clear feedback and continue
  delete context["verify_feedback"];
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);

  try {
    return checkLoopContinuation(verifyStep.run_id, loopStepId);
  } catch (err) {
    logger.error(`checkLoopContinuation failed, recovering: ${String(err)}`, { runId: verifyStep.run_id });
    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
    return { advanced: false, runCompleted: false };
  }
}

/**
 * Check if the loop has more stories; if so set loop step pending, otherwise done + advance.
 */
function checkLoopContinuation(runId: string, loopStepId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const pendingStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'pending' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  const loopStatus = db.prepare(
    "SELECT status FROM steps WHERE id = ?"
  ).get(loopStepId) as { status: string } | undefined;

  if (pendingStory) {
    if (loopStatus?.status === "failed") {
      return { advanced: false, runCompleted: false };
    }
    db.prepare(
      "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  const failedStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (failedStory) {
    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run("Loop cannot continue because one or more stories failed", loopStepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).run(runId);
    const wfId = getWorkflowId(runId);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId, workflowId: wfId, stepId: loopStepId, detail: "Loop has failed stories and no pending stories" });
    emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: false };
  }

  // All stories done — mark loop step done
  db.prepare(
    "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
  ).run(loopStepId);

  // Also mark verify step done if it exists
  const loopStep = db.prepare("SELECT loop_config, run_id FROM steps WHERE id = ?").get(loopStepId) as { loop_config: string | null; run_id: string } | undefined;
  if (loopStep?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStep.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep) {
      db.prepare(
        "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE run_id = ? AND step_id = ?"
      ).run(runId, lcVerifyStep);
    }
  }

  const result = advancePipeline(runId);
  if (result.advanced) {
    postAdvanceNudge(runId);
  }
  return result;
}
