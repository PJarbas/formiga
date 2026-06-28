import { getPrisma } from "../../db.js";
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
import { LeaderboardRepositoryImpl } from "../../leaderboard/repository.js";
import { processCriticOutput } from "../../leaderboard/critic-processor.js";

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
export async function completeStep(stepId: string, output: string): Promise<{ status: string; detail?: string }> {
  const prisma = getPrisma();
  let now = new Date();

  const step = await prisma.step.findUnique({
    where: { id: stepId },
  });

  if (!step) throw new Error(`Step not found: ${stepId}`);

  // Guard: don't process completions for failed runs
  const runId = step.run_id;
  const runCheck = await prisma.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (runCheck?.status === "failed" || runCheck?.status === "canceled") {
    return { status: "blocked" };
  }

  // Validate output against the expects column before accepting the step
  const validationError = validateExpects(output, step.expects ?? "");
  if (validationError) {
    const meta = await prisma.step.findUnique({
      where: { id: stepId },
      select: { retry_count: true, max_retries: true },
    });
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const wfId = await getWorkflowId(step.run_id);

    if (newRetry > maxRetries) {
      const now = new Date();
      await prisma.step.update({
        where: { id: stepId },
        data: {
          status: "failed",
          output: validationError,
          retry_count: newRetry,
          updated_at: now,
        },
      });
      await prisma.run.update({
        where: { id: step.run_id },
        data: {
          status: "failed",
          updated_at: now,
        },
      });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: validationError });
      await emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Expects validation failed and retries exhausted" });
      await scheduleRunCronTeardown(runId);
      await finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    const now = new Date();
    await prisma.step.update({
      where: { id: stepId },
      data: {
        status: "pending",
        output: validationError,
        retry_count: newRetry,
        updated_at: now,
      },
    });
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId, workflowId: wfId, stepId: step.step_id, detail: validationError });
    logger.warn(validationError, { runId, stepId: step.step_id });
    await finalizeDrainingPause(runId);
    return { status: "retrying", detail: validationError };
  }

  // Merge KEY: value lines into run context
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { context: true },
  });
  const context: Record<string, string> = run?.context ? JSON.parse(run.context as string) : {};

  const parsed = parseOutputKeyValues(output);
  for (const [key, value] of Object.entries(parsed)) {
    if (!RESERVED_CONTEXT_KEYS.has(key)) {
      context[key] = value;
    }
  }

  now = new Date();
  await prisma.run.update({
    where: { id: runId },
    data: {
      context: JSON.stringify(context),
      updated_at: now,
    },
  });

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

  // After leaderboard ingest, if this is the critic step, parse audit verdicts
  if (step.agent_id === "ml-critic") {
    // Fire-and-forget async audit since the outer orchestration path is async now
    (async () => {
      try {
        const repo = new LeaderboardRepositoryImpl();
        const result = await processCriticOutput(output, repo);
        const successRows = await getPrisma().experiment.findMany({
          where: { run_id: runId, status: "SUCCESS" },
          select: { experiment_id: true },
        });
        for (const row of successRows) {
          await repo.autoAudit(row.experiment_id);
        }
        logger.info("Critic audit processed", {
          runId,
          rejected: result.rejected,
          audited: successRows.length,
        });
      } catch (err) {
        logger.warn("Critic audit processing failed", {
          runId,
          error: (err as Error).message,
        });
      }
    })();
  }

  // Parse STORIES_JSON from output (any step, typically the planner)
  await parseAndInsertStories(output, runId);

  // Write story plan to progress log after STORIES_JSON is parsed
  await writeStoryPlanToProgress(runId);

  // Robustness: if a downstream loop-over-stories exists but no stories were
  // produced, force a retry. Story-producers (template mentions STORIES_JSON)
  // search the entire downstream pipeline; others only check the next step
  // to avoid blaming non-producing steps. Honor max_retries so a permanently
  // broken planner still escalates.
  if (step.type !== "loop") {
    const stepMentionsStories = step.input_template?.includes("STORIES_JSON");
    let downstreamLoopExpectingStories = await prisma.step.findFirst({
      where: {
        run_id: step.run_id,
        step_index: step.step_index + 1,
        type: "loop",
      },
      select: { id: true, step_id: true, loop_config: true },
    });
    if (!downstreamLoopExpectingStories && stepMentionsStories) {
      downstreamLoopExpectingStories = await prisma.step.findFirst({
        where: {
          run_id: step.run_id,
          step_index: { gt: step.step_index },
          type: "loop",
        },
        orderBy: { step_index: "asc" },
        select: { id: true, step_id: true, loop_config: true },
      });
    }
    if (downstreamLoopExpectingStories?.loop_config) {
      try {
        const lc = JSON.parse(downstreamLoopExpectingStories.loop_config) as LoopConfig;
        const storiesCount = await prisma.story.count({
          where: { run_id: step.run_id },
        });
        if (lc.over === "stories" && storiesCount === 0) {
          const meta = await prisma.step.findUnique({
            where: { id: step.id },
            select: { retry_count: true, max_retries: true },
          });
          const newRetry = (meta?.retry_count ?? 0) + 1;
          const maxRetries = meta?.max_retries ?? 0;
          const errorDetail =
            `Step output had no STORIES_JSON block, but the next step (${downstreamLoopExpectingStories.step_id}) is a loop over stories. ` +
            `The agent must emit a literal "STORIES_JSON: [ ... ]" line with at least one story. Resetting to pending for retry ${newRetry}/${maxRetries}.`;
          const wfId = await getWorkflowId(step.run_id);
          if (newRetry > maxRetries) {
            const now = new Date();
            await prisma.step.update({
              where: { id: step.id },
              data: {
                status: "failed",
                output: errorDetail,
                retry_count: newRetry,
                updated_at: now,
              },
            });
            await prisma.run.update({
              where: { id: step.run_id },
              data: {
                status: "failed",
                updated_at: now,
              },
            });
            emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
            await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Plan step never produced STORIES_JSON" });
            await scheduleRunCronTeardown(step.run_id);
            await finalizeDrainingPause(step.run_id);
            return { status: "failed" };
          }
          const now = new Date();
          await prisma.step.update({
            where: { id: step.id },
            data: {
              status: "pending",
              output: errorDetail,
              retry_count: newRetry,
              updated_at: now,
            },
          });
          logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
          await finalizeDrainingPause(step.run_id);
          return { status: "retrying", detail: errorDetail };
        }
      } catch {
        // best-effort: if loop_config can't be parsed, don't block completion
      }
    }
  }

  // Loop step completion
  if (step.type === "loop" && step.current_story_id) {
    const storyRow = await prisma.story.findUnique({
      where: { id: step.current_story_id },
      select: { story_id: true, title: true },
    });

    // Mark current story done
    const now = new Date();
    await prisma.story.update({
      where: { id: step.current_story_id },
      data: {
        status: "done",
        output,
        updated_at: now,
      },
    });
    emitEvent({ ts: new Date().toISOString(), event: "story.done", runId: step.run_id, workflowId: await getWorkflowId(step.run_id), stepId: step.step_id, storyId: storyRow?.story_id, storyTitle: storyRow?.title });
    logger.info(`Story done: ${storyRow?.story_id} — ${storyRow?.title}`, { runId: step.run_id, stepId: step.step_id });

    // Clear current_story_id, save output
    await prisma.step.update({
      where: { id: step.id },
      data: {
        current_story_id: null,
        output,
        updated_at: now,
      },
    });

    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;

    // verify_each flow — set verify step to pending. YAML uses snake_case;
    // accept both casings for back-compat with the camelCase types.
    const verifyEachOn = loopConfig?.verifyEach ?? loopConfig?.verify_each;
    const verifyStepId = loopConfig?.verifyStep ?? loopConfig?.verify_step;
    if (verifyEachOn && verifyStepId) {
      const verifyStep = await prisma.step.findFirst({
        where: {
          run_id: step.run_id,
          step_id: verifyStepId,
        },
        select: { id: true },
      });

      if (verifyStep) {
        const now = new Date();
        await prisma.step.update({
          where: { id: verifyStep.id },
          data: {
            status: "pending",
            updated_at: now,
          },
        });
        // Loop step stays 'running'
        await prisma.step.update({
          where: { id: step.id },
          data: {
            status: "running",
            updated_at: now,
          },
        });
        return { status: "advanced" };
      }
    }

    // No verify_each: check for more stories
    const loopResult = await checkLoopContinuation(step.run_id, step.id);
    return { status: loopResult.runCompleted ? "completed" : "advanced" };
  }

  // Check if this is a verify step triggered by verify-each
  const loopStepRow = await prisma.step.findFirst({
    where: {
      run_id: step.run_id,
      type: "loop",
    },
    select: { id: true, loop_config: true, run_id: true },
  });

  if (loopStepRow?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStepRow.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep === step.step_id) {
      const verifyResult = await handleVerifyEachCompletion(step, loopStepRow.id, output, context);
      return { status: verifyResult.runCompleted ? "completed" : "advanced" };
    }
  }

  // Single step: mark done and advance
  now = new Date();
  await prisma.step.update({
    where: { id: stepId },
    data: {
      status: "done",
      output,
      updated_at: now,
    },
  });
  emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: await getWorkflowId(step.run_id), stepId: step.step_id });
  logger.info(`Step completed: ${step.step_id}`, { runId: step.run_id, stepId: step.step_id });

  const pipelineResult = await advancePipeline(step.run_id);
  await finalizeDrainingPause(step.run_id);
  if (pipelineResult.advanced) {
    postAdvanceNudge(step.run_id);
  }
  return { status: pipelineResult.runCompleted ? "completed" : "advanced" };
}

/**
 * Handle verify-each completion: pass or fail the story.
 */
async function handleVerifyEachCompletion(
  verifyStep: { id: string; run_id: string; step_id: string; step_index: number },
  loopStepId: string,
  output: string,
  context: Record<string, string>
): Promise<{ advanced: boolean; runCompleted: boolean }> {
  const prisma = getPrisma();
  const status = context["status"]?.toLowerCase();

  // Reset verify step to waiting for next use
  let now = new Date();
  await prisma.step.update({
    where: { id: verifyStep.id },
    data: {
      status: "waiting",
      output,
      updated_at: now,
    },
  });

  if (status !== "retry") {
    emitEvent({ ts: new Date().toISOString(), event: "story.verified", runId: verifyStep.run_id, workflowId: await getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id });
  }

  if (status === "retry") {
    const lastDoneStory = await prisma.story.findFirst({
      where: {
        run_id: verifyStep.run_id,
        status: "done",
      },
      orderBy: { updated_at: "desc" },
      select: { id: true, retry_count: true, max_retries: true },
    });

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        const now = new Date();
        await prisma.story.update({
          where: { id: lastDoneStory.id },
          data: {
            status: "failed",
            retry_count: newRetry,
            updated_at: now,
          },
        });
        await prisma.step.update({
          where: { id: loopStepId },
          data: {
            status: "failed",
            updated_at: now,
          },
        });
        await prisma.run.update({
          where: { id: verifyStep.run_id },
          data: {
            status: "failed",
            updated_at: now,
          },
        });
        const wfId = await getWorkflowId(verifyStep.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id });
        await emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verification retries exhausted" });
        await scheduleRunCronTeardown(verifyStep.run_id);
        await finalizeDrainingPause(verifyStep.run_id);
        return { advanced: false, runCompleted: false };
      }

      const now = new Date();
      await prisma.story.update({
        where: { id: lastDoneStory.id },
        data: {
          status: "pending",
          retry_count: newRetry,
          updated_at: now,
        },
      });

      const issues = context["issues"] ?? output;
      context["verify_feedback"] = issues;
      emitEvent({ ts: new Date().toISOString(), event: "story.retry", runId: verifyStep.run_id, workflowId: await getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id, detail: issues });
      await prisma.run.update({
        where: { id: verifyStep.run_id },
        data: {
          context: JSON.stringify(context),
          updated_at: now,
        },
      });
    }

    const now = new Date();
    await prisma.step.update({
      where: { id: loopStepId },
      data: {
        status: "pending",
        updated_at: now,
      },
    });
    return { advanced: false, runCompleted: false };
  }

  // Verify passed — clear feedback and continue
  delete context["verify_feedback"];
  now = new Date();
  await prisma.run.update({
    where: { id: verifyStep.run_id },
    data: {
      context: JSON.stringify(context),
      updated_at: now,
    },
  });

  try {
    return await checkLoopContinuation(verifyStep.run_id, loopStepId);
  } catch (err) {
    logger.error(`checkLoopContinuation failed, recovering: ${String(err)}`, { runId: verifyStep.run_id });
    now = new Date();
    await prisma.step.update({
      where: { id: loopStepId },
      data: {
        status: "pending",
        updated_at: now,
      },
    });
    return { advanced: false, runCompleted: false };
  }
}

/**
 * Check if the loop has more stories; if so set loop step pending, otherwise done + advance.
 */
async function checkLoopContinuation(runId: string, loopStepId: string): Promise<{ advanced: boolean; runCompleted: boolean }> {
  const prisma = getPrisma();
  const pendingStory = await prisma.story.findFirst({
    where: {
      run_id: runId,
      status: "pending",
    },
    select: { id: true },
  });

  const loopStatus = await prisma.step.findUnique({
    where: { id: loopStepId },
    select: { status: true },
  });

  if (pendingStory) {
    if (loopStatus?.status === "failed") {
      return { advanced: false, runCompleted: false };
    }
    const now = new Date();
    await prisma.step.update({
      where: { id: loopStepId },
      data: {
        status: "pending",
        updated_at: now,
      },
    });
    return { advanced: false, runCompleted: false };
  }

  const failedStory = await prisma.story.findFirst({
    where: {
      run_id: runId,
      status: "failed",
    },
    select: { id: true },
  });

  if (failedStory) {
    const now = new Date();
    await prisma.step.update({
      where: { id: loopStepId },
      data: {
        status: "failed",
        output: "Loop cannot continue because one or more stories failed",
        updated_at: now,
      },
    });
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "failed",
        updated_at: now,
      },
    });
    const wfId = await getWorkflowId(runId);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId, workflowId: wfId, stepId: loopStepId, detail: "Loop has failed stories and no pending stories" });
    await emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
    await scheduleRunCronTeardown(runId);
    await finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: false };
  }

  // All stories done — mark loop step done
  const now = new Date();
  await prisma.step.update({
    where: { id: loopStepId },
    data: {
      status: "done",
      updated_at: now,
    },
  });

  // Also mark verify step done if it exists
  const loopStep = await prisma.step.findUnique({
    where: { id: loopStepId },
    select: { loop_config: true, run_id: true },
  });
  if (loopStep?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStep.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep) {
      const now = new Date();
      await prisma.step.updateMany({
        where: {
          run_id: runId,
          step_id: lcVerifyStep,
        },
        data: {
          status: "done",
          updated_at: now,
        },
      });
    }
  }

  const result = await advancePipeline(runId);
  if (result.advanced) {
    postAdvanceNudge(runId);
  }
  return result;
}
