import crypto from "node:crypto";
import path from "node:path";
import { getDb, nextRunNumber } from "../db.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { setupAgentCrons } from "./agent-scheduler.js";
import { emitEvent } from "./events.js";
import { advancePipeline } from "./step-ops.js";

export interface RunWorkflowParams {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  /** Optional initial context for template resolution */
  context?: Record<string, string>;
}

export interface RunWorkflowResult {
  runId: string;
  runNumber: number;
  workflowId: string;
  taskTitle: string;
  status: string;
  stepCount: number;
}

/**
 * Start a new workflow run.
 *
 * 1. Loads the workflow spec
 * 2. Creates a run record in the DB
 * 3. Creates step records for each step
 * 4. Starts agent cron jobs for polling
 * 5. Emits a run.started event
 */
export async function runWorkflow(
  params: RunWorkflowParams,
): Promise<RunWorkflowResult> {
  const { workflowId, taskTitle, notifyUrl, context = {} } = params;

  // Load the workflow spec from the installed workflow directory
  const workflowDir = resolveWorkflowDir(workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);

  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  // Seed the run context with the task description so step input templates can
  // reference {{task}} from the very first step. Without this, the planner step
  // (which always references {{task}}) fails immediately on claim with a missing
  // template key error, aborting the whole run.
  const seededContext = { task: taskTitle, ...context };
  const contextJson = JSON.stringify(seededContext);

  // Insert the run record
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 0, ?, ?, ?)`,
  ).run(runId, runNumber, workflowId, taskTitle, contextJson, notifyUrl ?? null, now, now);

  // Insert step records for each workflow step
  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepDbId = crypto.randomUUID();
    const maxRetries = step.max_retries ?? 4;
    const stepType = step.type ?? "single";
    const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
    const scopedAgentId = step.agent.startsWith(`${workflow.id}_`)
      ? step.agent
      : `${workflow.id}_${step.agent}`;

    insertStep.run(
      stepDbId,
      runId,
      step.id,
      scopedAgentId,
      i,
      step.input,
      step.expects,
      maxRetries,
      stepType,
      loopConfig,
      now,
      now,
    );
  }

  // Start agent cron jobs for polling
  try {
    await setupAgentCrons(workflow);
  } catch (err) {
    // Cron setup is best-effort; the workflow can still run if agents are
    // triggered manually or via other means.
    // Log but don't fail the run.
  }

  // Emit run.started event
  emitEvent({
    ts: now,
    event: "run.started",
    runId,
    workflowId,
    detail: `Run #${runNumber}: ${taskTitle}`,
  });

  // Promote the first step from 'waiting' to 'pending' so an agent can claim it.
  // Without this kickoff, claimStep (which only matches 'pending') would never find
  // the first step and the run would loop forever on peek=HAS_WORK / claim=NO_WORK.
  advancePipeline(runId);

  return {
    runId,
    runNumber,
    workflowId,
    taskTitle,
    status: "running",
    stepCount: workflow.steps.length,
  };
}

export interface ResumeResult {
  status: "not_found" | "resumed";
  runId?: string;
  workflowId?: string;
  stepId?: string;
}

export async function resumeWorkflow(runId: string): Promise<ResumeResult> {
  const db = getDb();
  const run = db.prepare(
    "SELECT id, workflow_id, status FROM runs WHERE id = ? AND status = 'failed'",
  ).get(runId) as { id: string; workflow_id: string; status: string } | undefined;

  if (!run) return { status: "not_found" };

  // Reset the run to running
  db.prepare("UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(run.id);

  // Find the first failed step and reset it + subsequent steps
  const failedStep = db.prepare(
    "SELECT id, step_id, step_index FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1",
  ).get(run.id) as { id: string; step_id: string; step_index: number } | undefined;

  if (failedStep) {
    // Reset this step and all subsequent steps back to waiting
    db.prepare(
      "UPDATE steps SET status = 'waiting', retry_count = 0, output = NULL, updated_at = datetime('now') WHERE run_id = ? AND step_index >= ?",
    ).run(run.id, failedStep.step_index);
  }

  // Promote the next eligible waiting step to 'pending' so polling agents can claim it.
  advancePipeline(run.id);

  return { status: "resumed", runId: run.id, workflowId: run.workflow_id, stepId: failedStep?.step_id };
}
