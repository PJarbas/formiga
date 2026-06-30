import { getPrisma } from "../../db.js";
import { resolveWorkflowDir } from "../paths.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import { loadWorkflowSpec } from "../workflow-spec.js";
import type { WorkflowStepFailure } from "../types.js";
import {
  scheduleRunCronTeardown,
  getWorkflowId,
  emitRunTerminalEvent,
  finalizeDrainingPause,
} from "./pipeline-control.js";
import { recordProgress } from "./progress.js";

// ══════════════════════════════════════════════════════════════════════
// Rugpull detection stubs
// ══════════════════════════════════════════════════════════════════════

// rugpull detection/relaunch was removed as orphan code (was Pi/Hermes-
// specific base-branch race recovery). Stubs preserve the call sites.
function detectRugpull(_runId: string): { isRugpull: boolean; reason?: string } {
  return { isRugpull: false };
}
async function relaunchRunAfterRugpull(_runId: string): Promise<{ relaunched: boolean }> {
  return { relaunched: false };
}

// ══════════════════════════════════════════════════════════════════════
// Escalation policy helpers
// ══════════════════════════════════════════════════════════════════════

function resolveEscalationTarget(policy: WorkflowStepFailure | null): string | null {
  const escalateTo = policy?.on_exhausted?.escalate_to || policy?.escalate_to;
  if (!escalateTo) return null;

  const normalized = escalateTo.trim().toLowerCase();
  if (normalized === "human" || normalized === "main") return "agent:main:main";
  if (normalized.startsWith("agent:")) return escalateTo;
  return null;
}

async function getOnFailPolicy(runId: string, stepId: string): Promise<WorkflowStepFailure | null> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({ where: { id: runId }, select: { workflow_id: true } });
    if (!run) return null;

    const workflowDir = resolveWorkflowDir(run.workflow_id);
    const workflow = await loadWorkflowSpec(workflowDir);
    const step = workflow.steps.find((s) => s.id === stepId);
    return step?.on_fail ?? null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Fail Step
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail a step, with retry logic. For loop steps, applies per-story retry.
 * Handles escalate_on_failure by logging the escalation target.
 */
export async function failStep(stepId: string, error: string): Promise<{ status: string }> {
  const prisma = getPrisma();

  const step = await prisma.step.findUnique({
    where: { id: stepId },
  });

  if (!step) throw new Error(`Step not found: ${stepId}`);

  const now = new Date();

  // Loop step failure — per-story retry
  if (step.type === "loop" && step.current_story_id) {
    const story = await prisma.story.findUnique({
      where: { id: step.current_story_id },
    });

    if (story) {
      const newRetry = story.retry_count + 1;
      if (newRetry > story.max_retries) {
        await prisma.$transaction([
          prisma.story.update({
            where: { id: story.id },
            data: { status: "failed", retry_count: newRetry, updated_at: now },
          }),
          prisma.step.update({
            where: { id: stepId },
            data: { status: "failed", output: error, current_story_id: null, updated_at: now },
          }),
          prisma.run.update({
            where: { id: step.run_id },
            data: { status: "failed", updated_at: now },
          }),
        ]);
        const wfId = await getWorkflowId(step.run_id);
        emitEvent({ ts: now.toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId, storyId: story.story_id, storyTitle: story.title, detail: error });
        emitEvent({ ts: now.toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId, detail: error });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story retries exhausted" });
        scheduleRunCronTeardown(step.run_id);
        finalizeDrainingPause(step.run_id);

        // Escalation: log the target if configured
        try {
          const policy = await getOnFailPolicy(step.run_id, step.step_id);
          const target = resolveEscalationTarget(policy);
          if (target) {
            logger.warn(`Step failure exhausted — escalation target: ${target}`, { runId: step.run_id, stepId: step.step_id, error });
          }
        } catch {
          // escalation logging is best-effort
        }

        return { status: "failed" };
      }

      // Retry the story
      await prisma.$transaction([
        prisma.story.update({
          where: { id: story.id },
          data: { status: "pending", retry_count: newRetry, updated_at: now },
        }),
        prisma.step.update({
          where: { id: stepId },
          data: { status: "pending", current_story_id: null, updated_at: now },
        }),
      ]);
      finalizeDrainingPause(step.run_id);
      return { status: "retrying" };
    }
  }

  // Single step: existing logic
  await recordProgress(step.run_id);
  const newRetryCount = step.retry_count + 1;

  if (newRetryCount > step.max_retries) {
    await prisma.$transaction([
      prisma.step.update({
        where: { id: stepId },
        data: { status: "failed", output: error, retry_count: newRetryCount, updated_at: now },
      }),
      prisma.run.update({
        where: { id: step.run_id },
        data: { status: "failed", updated_at: now },
      }),
    ]);
    const wfId2 = await getWorkflowId(step.run_id);
    emitEvent({ ts: now.toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId2, stepId, detail: error });
    emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId2, detail: "Step retries exhausted" });
    scheduleRunCronTeardown(step.run_id);
    finalizeDrainingPause(step.run_id);

    // Escalation: log the target if configured
    try {
      const policy = await getOnFailPolicy(step.run_id, step.step_id);
      const target = resolveEscalationTarget(policy);
      if (target) {
        logger.warn(`Step failure exhausted — escalation target: ${target}`, { runId: step.run_id, stepId: step.step_id, error });
      }
    } catch {
      // escalation logging is best-effort
    }

    // Rugpull detection: for single step failures, check if the base branch
    // moved under the run and launch a replacement. Fire-and-forget via
    // setImmediate so errors never block step failure completion.
    if (step.type !== "loop") {
      setImmediate(async () => {
        try {
          const rugResult = detectRugpull(step.run_id);
          if (rugResult.isRugpull) {
            emitEvent({
              ts: new Date().toISOString(),
              event: "run.rugpull_detected",
              runId: step.run_id,
              workflowId: wfId2,
              detail: rugResult.reason,
            });
            const relaunchResult = await relaunchRunAfterRugpull(step.run_id);
            if (!relaunchResult.relaunched) {
              // The function itself emits events for all failure/suppression paths,
              // but log a warning so the failure is visible in system logs as well.
              logger.warn("Rugpull relaunch did not launch a replacement run", {
                runId: step.run_id,
                result: relaunchResult,
              });
            }
          }
        } catch (err) {
          // fire-and-forget — errors must not prevent step failure from completing
          logger.error("Rugpull detection/relaunch threw unexpectedly", {
            runId: step.run_id,
            error: String(err),
          });
        }
      });
    }

    return { status: "failed" };
  } else {
    await prisma.step.update({
      where: { id: stepId },
      data: { status: "pending", output: error, retry_count: newRetryCount, updated_at: now },
    });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying" };
  }
}
