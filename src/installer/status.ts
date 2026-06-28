import { getPrisma } from "../db.js";
import { scheduleRunCronTeardown } from "./step-ops.js";
import { removeRunCrons } from "./agent-scheduler.js";
import { terminateRunWithDaemon } from "../server/control-client.js";
import { emitEvent } from "./events.js";

export interface RunInfo {
  id: string;
  workflowId: string;
  task: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stepSummary?: string;
  tokensSpent: number;
}

export interface RunDetail extends RunInfo {
  steps: StepInfo[];
  stories?: StoryInfo[];
  workspace_mode?: string;
  worktree_path?: string;
  worktree_origin_repository?: string;
  worktree_origin_ref?: string;
  worktree_origin_sha?: string;
}

export interface StepInfo {
  stepId: string;
  agentId: string;
  status: string;
  type: string;
  retryCount: number;
  output?: string;
}

export interface StoryInfo {
  storyId: string;
  title: string;
  status: string;
  retryCount: number;
}

/**
 * Find a run by id prefix or task substring match.
 * Returns the run detail if exactly one match is found.
 * Throws if zero or multiple matches.
 */
export async function getWorkflowStatus(query: string): Promise<RunDetail> {
  const prisma = getPrisma();

  // Try exact id match first
  let run = await prisma.run.findUnique({ where: { id: query } });

  // Try id prefix match
  if (!run) {
    const prefixRuns = await prisma.run.findMany({
      where: { id: { startsWith: query } },
    });
    if (prefixRuns.length === 1) {
      run = prefixRuns[0];
    } else if (prefixRuns.length > 1) {
      throw new Error(
        `Multiple runs match prefix "${query}": ${prefixRuns.map((r) => r.id.slice(0, 12)).join(", ")}. Use a longer prefix to disambiguate.`,
      );
    }
  }

  // Try task substring match
  if (!run) {
    const taskRuns = await prisma.run.findMany({
      where: { task: { contains: query } },
    });
    if (taskRuns.length === 1) {
      run = taskRuns[0];
    } else if (taskRuns.length > 1) {
      throw new Error(
        `Multiple runs match task "${query}": ${taskRuns.map((r) => `${r.id.slice(0, 8)} (${r.task.slice(0, 30)})`).join(", ")}. Use a more specific query.`,
      );
    }
  }

  if (!run) {
    throw new Error(`No run found matching "${query}"`);
  }

  return buildRunDetail(run);
}

/**
 * List all runs, most recent first.
 */
export async function listRuns(limit = 50): Promise<RunInfo[]> {
  const prisma = getPrisma();
  const rows = await prisma.run.findMany({
    orderBy: { created_at: "desc" },
    take: limit,
  });

  return Promise.all(
    rows.map(async (r) => {
      const stepSummary = await getStepSummary(r.id);
      return {
        id: r.id,
        workflowId: r.workflow_id,
        task: r.task,
        status: r.status,
        createdAt: dateToIso(r.created_at),
        updatedAt: dateToIso(r.updated_at),
        stepSummary,
        tokensSpent: r.tokens_spent,
      };
    }),
  );
}

/**
 * Delete a workflow run and all associated data (steps, stories, worktree).
 * Running or paused runs are canceled first.
 * If --force is not provided and the run is running/paused, the deletion is refused.
 */
export async function deleteWorkflow(
  runId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; runId: string; status: string }> {
  const prisma = getPrisma();

  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const isActive = run.status === "running" || run.status === "paused";
  if (isActive && !opts.force) {
    throw new Error(
      `Run ${runId.slice(0, 8)} is ${run.status}. Use --force to delete an active run (it will be canceled first).`,
    );
  }

  // Cancel any active run first
  if (isActive) {
    const now = new Date();
    await prisma.step.updateMany({
      where: {
        run_id: runId,
        status: { in: ["waiting", "pending", "running"] },
      },
      data: { status: "canceled", updated_at: now },
    });

    await prisma.run.update({
      where: { id: runId },
      data: { status: "canceled", scheduling_status: null, updated_at: now },
    });

    // Tear down cron jobs and notify daemon
    await Promise.allSettled([
      removeRunCrons(runId),
      terminateRunWithDaemon(runId),
    ]);
    scheduleRunCronTeardown(runId);
  }

  // Delete associated records in dependency order
  await prisma.story.deleteMany({ where: { run_id: runId } });
  await prisma.step.deleteMany({ where: { run_id: runId } });
  await prisma.runWorktree.deleteMany({ where: { run_id: runId } });
  await prisma.run.delete({ where: { id: runId } });

  // Emit deletion event to logs tail and recent events
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.deleted",
    runId,
    detail: isActive ? "Force-deleted while active" : "Deleted by user",
  });

  return { ok: true, runId, status: "deleted" };
}

/**
 * Cancel a running workflow.
 * Sets the run status to 'canceled' and tears down cron jobs.
 */
export async function stopWorkflow(runId: string): Promise<{ ok: boolean; runId: string }> {
  const prisma = getPrisma();

  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.status !== "running" && run.status !== "paused") {
    throw new Error(
      `Run ${runId} is already ${run.status} — cannot cancel`,
    );
  }

  const now = new Date();

  // Cancel any pending/running steps
  await prisma.step.updateMany({
    where: {
      run_id: runId,
      status: { in: ["waiting", "pending", "running"] },
    },
    data: { status: "canceled", updated_at: now },
  });

  // Mark the run as canceled and clear scheduling status (terminal runs
  // never carry a scheduling_status).
  await prisma.run.update({
    where: { id: runId },
    data: { status: "canceled", scheduling_status: null, updated_at: now },
  });

  // Tear down run-scoped cron jobs in this process (best-effort), and
  // notify the daemon so it tears down its own timers too. The daemon
  // reconciler will catch any drift on the next tick if either fails.
  await Promise.allSettled([
    removeRunCrons(runId),
    terminateRunWithDaemon(runId),
  ]);

  // Workflow-wide idle teardown for back-compat (legacy callers).
  scheduleRunCronTeardown(runId);

  return { ok: true, runId };
}

// ── Internal helpers ────────────────────────────────────────────────

function dateToIso(d: Date | string | null | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d;
  return d.toISOString();
}

async function getStepSummary(runId: string): Promise<string> {
  const prisma = getPrisma();
  const steps = await prisma.step.findMany({
    where: { run_id: runId },
    select: { status: true },
  });

  if (steps.length === 0) return "no steps";
  const counts: Record<string, number> = {};
  for (const s of steps) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([status, cnt]) => `${status}:${cnt}`);
  return parts.join(" ");
}

async function buildRunDetail(run: {
  id: string;
  workflow_id: string;
  task: string;
  status: string;
  context: string;
  created_at: Date;
  updated_at: Date;
  tokens_spent: number;
}): Promise<RunDetail> {
  const prisma = getPrisma();

  const steps = await prisma.step.findMany({
    where: { run_id: run.id },
    orderBy: { step_index: "asc" },
  });

  const stepInfos: StepInfo[] = steps.map((s) => ({
    stepId: s.step_id,
    agentId: s.agent_id,
    status: s.status,
    type: s.type,
    retryCount: s.retry_count,
    output: s.output ?? undefined,
  }));

  const stories = await prisma.story.findMany({
    where: { run_id: run.id },
    orderBy: { story_index: "asc" },
  });

  const storyInfos: StoryInfo[] = stories.map((s) => ({
    storyId: s.story_id,
    title: s.title,
    status: s.status,
    retryCount: s.retry_count,
  }));

  const stepSummary = await getStepSummary(run.id);

  // Enrich with worktree information when workspace_mode is 'worktree'
  let workspaceMode: string | undefined;
  let wtPath: string | undefined;
  let wtOriginRepo: string | undefined;
  let wtOriginRef: string | undefined;
  let wtOriginSha: string | undefined;
  try {
    const ctx = JSON.parse(run.context || "{}") as Record<string, string>;
    if (ctx.workspace_mode === "worktree") {
      workspaceMode = ctx.workspace_mode;
      const wtRow = await prisma.runWorktree.findUnique({
        where: { run_id: run.id },
      });
      if (wtRow) {
        wtPath = wtRow.worktree_path;
        wtOriginRepo = wtRow.worktree_origin_repository;
        wtOriginRef = wtRow.worktree_origin_ref ?? undefined;
        wtOriginSha = wtRow.worktree_origin_sha ?? undefined;
      }
    }
  } catch {
    // context may be malformed; leave worktree fields unset
  }

  return {
    id: run.id,
    workflowId: run.workflow_id,
    task: run.task,
    status: run.status,
    createdAt: dateToIso(run.created_at),
    updatedAt: dateToIso(run.updated_at),
    stepSummary,
    tokensSpent: run.tokens_spent,
    steps: stepInfos,
    stories: storyInfos.length > 0 ? storyInfos : undefined,
    workspace_mode: workspaceMode,
    worktree_path: wtPath,
    worktree_origin_repository: wtOriginRepo,
    worktree_origin_ref: wtOriginRef,
    worktree_origin_sha: wtOriginSha,
  };
}
