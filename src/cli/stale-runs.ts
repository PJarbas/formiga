/**
 * Stale Run CLI Commands
 *
 * Provides list-stale and cancel-stale subcommands for managing
 * runs that are stuck without progress.
 */
import { getPrisma } from "../db.js";
import { stopWorkflow } from "../installer/status.js";
import { emitEvent } from "../installer/events.js";

// ── Types ──────────────────────────────────────────────────────────

interface StaleRun {
  id: string;
  workflowId: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  idleMinutes: number;
  stalePendingSteps: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseMinutesArg(args: string[], flag: string, defaultValue: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

async function findStaleRuns(minMinutes: number): Promise<StaleRun[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - minMinutes * 60_000);

  const runs = await prisma.run.findMany({
    where: {
      status: "running",
      updated_at: { lt: cutoff },
    },
    orderBy: { updated_at: "asc" },
    select: {
      id: true,
      workflow_id: true,
      task: true,
      created_at: true,
      updated_at: true,
      steps: {
        where: { status: "pending", claim_pid: null },
        select: { id: true },
      },
    },
  });

  return runs.map((run) => ({
    id: run.id,
    workflowId: run.workflow_id,
    task: run.task,
    createdAt: run.created_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
    idleMinutes: Math.floor((Date.now() - run.updated_at.getTime()) / 60_000),
    stalePendingSteps: run.steps.length,
  }));
}

// ── Commands ───────────────────────────────────────────────────────

export async function listStaleRuns(args: string[]): Promise<void> {
  const minMinutes = parseMinutesArg(args, "--min-minutes", 120);
  const json = args.includes("--json");

  const staleRuns = await findStaleRuns(minMinutes);

  if (staleRuns.length === 0) {
    console.log(json ? "[]" : "No stale runs found.");
    return;
  }

  if (json) {
    console.log(JSON.stringify(staleRuns, null, 2));
    return;
  }

  console.log(`Found ${staleRuns.length} stale run(s) (idle > ${minMinutes}m):\n`);
  for (const run of staleRuns) {
    const hours = Math.floor(run.idleMinutes / 60);
    const mins = run.idleMinutes % 60;
    console.log(
      `  ${run.id.slice(0, 12)}  idle ${hours}h${mins}m  pending_steps=${run.stalePendingSteps}  ${run.task.slice(0, 60)}`,
    );
  }
}

export async function cancelStaleRuns(args: string[]): Promise<void> {
  const minMinutes = parseMinutesArg(args, "--min-minutes", 120);
  const force = args.includes("--force");

  if (!force) {
    console.error("ERROR: Use --force to confirm bulk cancellation of stale runs.");
    console.error(`       This will cancel all runs idle for > ${minMinutes} minutes.`);
    process.exitCode = 1;
    return;
  }

  const staleRuns = await findStaleRuns(minMinutes);

  if (staleRuns.length === 0) {
    console.log("No stale runs to cancel.");
    return;
  }

  console.log(`Canceling ${staleRuns.length} stale run(s)...\n`);

  let canceled = 0;
  for (const run of staleRuns) {
    try {
      await stopWorkflow(run.id);
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.stale_canceled",
        runId: run.id,
        workflowId: run.workflowId,
        detail: `Auto-canceled: idle for ${run.idleMinutes}m`,
      });
      console.log(`  ✓ ${run.id.slice(0, 12)} canceled (idle ${run.idleMinutes}m)`);
      canceled++;
    } catch (err) {
      console.log(`  ✗ ${run.id.slice(0, 12)} error: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${canceled}/${staleRuns.length} runs canceled.`);
}
