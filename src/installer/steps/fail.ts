import { getDb } from "../../db.js";
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
    const db = getDb();
    const run = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
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
  const db = getDb();

  const step = db.prepare(
    "SELECT run_id, step_id, retry_count, max_retries, type, current_story_id FROM steps WHERE id = ?"
  ).get(stepId) as {
    run_id: string;
    step_id: string;
    retry_count: number;
    max_retries: number;
    type: string;
    current_story_id: string | null;
  } | undefined;

  if (!step) throw new Error(`Step not found: ${stepId}`);

  // Loop step failure — per-story retry
  if (step.type === "loop" && step.current_story_id) {
    const story = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE id = ?"
    ).get(step.current_story_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (story) {
      const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id!) as { story_id: string; title: string } | undefined;
      const newRetry = story.retry_count + 1;
      if (newRetry > story.max_retries) {
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
        db.prepare("UPDATE steps SET status = 'failed', output = ?, current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(error, stepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId, storyId: storyRow?.story_id, storyTitle: storyRow?.title, detail: error });
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId, detail: error });
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
      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
      db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(stepId);
      finalizeDrainingPause(step.run_id);
      return { status: "retrying" };
    }
  }

  // Single step: existing logic
  const newRetryCount = step.retry_count + 1;

  if (newRetryCount > step.max_retries) {
    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(error, newRetryCount, stepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).run(step.run_id);
    const wfId2 = getWorkflowId(step.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId2, stepId, detail: error });
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
    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(error, newRetryCount, stepId);
    finalizeDrainingPause(step.run_id);
    return { status: "retrying" };
  }
}
