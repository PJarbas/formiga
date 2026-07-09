// ══════════════════════════════════════════════════════════════════════
// direct-spawn.ts — Event-driven agent wakeup (no cron wait)
// ══════════════════════════════════════════════════════════════════════
//
// When a step completes and the pipeline advances to the next step(s),
// this module directly spawns the responsible agent(s) instead of
// waiting for a cron timer to fire.
//
// This eliminates the latency between step completion and the next
// agent pickup (previously up to 5–15 min cron interval).
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../../db.js";
import { logger } from "../../lib/logger.js";
import { resolveWorkflowDir } from "../paths.js";
import type { WorkflowAgent, WorkflowSpec } from "../types.js";
import { executePollingRound } from "./polling-round.js";
import { createAgentCronJob } from "./cron-manager.js";
import { jobMetadata, type CronJobInfo } from "./shared.js";

/**
 * Directly spawn the agent(s) responsible for the next pending step(s)
 * in a run. Called after `advancePipeline()` promotes steps to "pending".
 *
 * This is the core of the sequential scheduling model:
 * - Previous agent completes step
 * - Pipeline advances next step(s) to "pending"
 * - This function immediately spawns the agent(s) for those steps
 *
 * If the agent already has a cron job registered, it triggers an immediate
 * polling round. Otherwise, it creates a new cron job and fires it.
 */
export async function spawnAgentsForPendingSteps(runId: string): Promise<void> {
  const prisma = getPrisma();

  // Find all pending steps for this run
  const pendingSteps = await prisma.step.findMany({
    where: { run_id: runId, status: "pending" },
    select: { id: true, step_id: true, agent_id: true, run_id: true },
  });

  if (pendingSteps.length === 0) {
    logger.debug("direct-spawn: no pending steps to spawn agents for", { runId });
    return;
  }

  // Handle arena steps inline, before launching any PI cron jobs.
  for (const step of pendingSteps) {
    if (step.step_id === "arena") {
      try {
        const { launchArenaFromStep } = await import("../../arena/arena-workflow.js");
        await launchArenaFromStep(runId, step.id);
      } catch (err) {
        logger.error("direct-spawn: arena launch failed", {
          runId,
          stepId: step.id,
          error: String(err),
        });
      }
      return; // Arena step fully owns this pipeline segment; nothing else to spawn.
    }
  }

  // Get run info for workflow resolution
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { workflow_id: true, context: true },
  });

  if (!run) {
    logger.warn("direct-spawn: run not found", { runId });
    return;
  }

  const workflowId = run.workflow_id;

  // Load workflow spec
  let workflow: WorkflowSpec;
  try {
    const { loadWorkflowSpec } = await import("../workflow-spec.js");
    const flowDir = resolveWorkflowDir(workflowId);
    workflow = await loadWorkflowSpec(flowDir);
  } catch (err) {
    logger.warn("direct-spawn: failed to load workflow spec", {
      runId,
      workflowId,
      error: String(err),
    });
    return;
  }

  // Resolve workspace directory from run context
  let workingDirectoryForHarness: string | undefined;
  if (run.context) {
    try {
      const ctx = JSON.parse(run.context) as Record<string, unknown>;
      workingDirectoryForHarness = ctx.workspace as string | undefined;
    } catch { /* best-effort */ }
  }

  // Deduplicate by agent (multiple steps might map to the same agent)
  const agentIds = new Set<string>();
  for (const step of pendingSteps) {
    agentIds.add(step.agent_id);
  }

  for (const agentId of agentIds) {
    // Strip workflow prefix to find the agent in the spec
    const shortAgentId = agentId.startsWith(`${workflowId}_`)
      ? agentId.slice(workflowId.length + 1)
      : agentId;

    const agent = workflow.agents.find(
      (a) => a.id === shortAgentId || `${workflowId}_${a.id}` === agentId,
    );

    if (!agent) {
      logger.warn("direct-spawn: agent not found in workflow spec", {
        runId,
        agentId,
        workflowId,
      });
      continue;
    }

    // Check if there's already a registered cron job for this agent+run
    const existingJob = findExistingJob(workflowId, runId, agentId);

    if (existingJob) {
      // Job exists — trigger immediate polling round (fire-and-forget)
      logger.info("direct-spawn: triggering existing job", {
        runId,
        agentId: shortAgentId,
        jobId: existingJob.id,
      });
      executePollingRound(existingJob, agent, workflow).catch((err) => {
        logger.error("direct-spawn: immediate polling round failed", {
          runId,
          agentId: shortAgentId,
          error: String(err),
        });
      });
    } else {
      // No job exists — create one and it will fire immediately (stagger=0)
      logger.info("direct-spawn: creating new job for agent", {
        runId,
        agentId: shortAgentId,
      });
      const result = await createAgentCronJob({
        workflowId,
        runId,
        agent,
        workflow,
        intervalMinutes: getSupervisorInterval(workflow),
        staggerOffsetMs: 0,
        workingDirectoryForHarness,
      });

      // createAgentCronJob now executes immediately on creation,
      // so no need to trigger again here
      if (!result.ok) {
        logger.error("direct-spawn: failed to create job", {
          runId,
          agentId: shortAgentId,
          error: result.error,
        });
      }
    }
  }
}

/**
 * Find an existing registered cron job for a (workflow, run, agent) tuple.
 */
function findExistingJob(
  workflowId: string,
  runId: string,
  agentId: string,
): CronJobInfo | undefined {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId && info.agentId === agentId) return info;
    // Also check with workflow prefix
    if (
      info.runId === runId &&
      info.agentId === `${workflowId}_${agentId}`
    ) {
      return info;
    }
  }
  return undefined;
}

/**
 * Get the supervisor interval: a slow fallback cron that catches orphans.
 * This is the interval used for jobs created by direct-spawn — they fire
 * immediately on creation, then act as a fallback every N minutes.
 */
function getSupervisorInterval(_workflow: WorkflowSpec): number {
  // Fast fallback: 2 minutes. Event-driven spawning handles most cases,
  // but this catches orphaned steps quickly if events are missed.
  return 2;
}
