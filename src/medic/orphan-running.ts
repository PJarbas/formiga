// ══════════════════════════════════════════════════════════════════════
// orphan-running.ts — Detect & remediate steps stuck in "running" whose
//                    owning process is dead (claim_pid no longer alive).
// ══════════════════════════════════════════════════════════════════════
//
// Fills the gap exposed by run 367d0f4e: a step claimed by an agent that
// then died in a heartbeat loop stays "running" with a stale claim_pid.
// Existing recovery (recovery.ts cleanupAbandonedSteps) only looks at
// updated_at staleness with a very high threshold (role timeout + 5m),
// and does NOT check whether the claim_pid is actually alive. When
// heartbeats keep renewing runs.updated_at, the orphan is masked.
//
// This check uses claim_updated_at (set once at claim time, never renewed
// by heartbeats) plus a direct claim_pid liveness probe.
//
// This check runs on the lightweight reconciler tick (every 30s) and
// validates claim_pid liveness directly via process.kill(pid, 0) — an
// O(1) syscall that works on macOS and Linux. Dead owners are reverted
// to "pending" so the step can be re-claimed.
//
// Spec: docs/plans/resilience-harness-hardening-spec.md (RF-3)
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../db.js";
import { emitEvent } from "../installer/events.js";
import { logger } from "../lib/logger.js";
import { getWorkflowId, emitRunTerminalEvent, scheduleRunCronTeardown } from "../installer/steps/pipeline-control.js";

/** Max times a single step may be abandoned (reclaimed) before failing. Mirrors recovery.ts. */
const MAX_ABANDON_RESETS = 5;

export interface OrphanedRunningStep {
  id: string;
  step_id: string;
  run_id: string;
  agent_id: string;
  claim_pid: number;
  claim_updated_at: Date | null;
}

function getOrphanThresholdMs(): number {
  const raw = process.env.FORMIGA_ORPHAN_RUNNING_THRESHOLD_S;
  if (!raw) return 90_000;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 90_000;
}

/**
 * Returns true if a process with the given pid is currently alive.
 * `process.kill(pid, 0)` sends no signal — it only checks liveness.
 * Throws (→ false) on ESRCH (no such process) or EPERM (exists, but
 * not ours — treat as alive-ish by returning true on EPERM).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM: process exists but is owned by another user — assume alive.
    if (code === "EPERM") return true;
    // ESRCH or anything else: treat as dead.
    return false;
  }
}

/**
 * Find steps in "running" status whose claim_pid points to a dead process.
 * Uses claim_updated_at (set at claim time, not renewed by heartbeats) for
 * the freshness threshold, so a heartbeat loop that keeps renewing
 * runs.updated_at cannot mask the orphan. Only considers steps claimed
 * longer ago than the threshold (avoids racing a freshly spawned agent).
 */
export async function findOrphanedRunningSteps(): Promise<OrphanedRunningStep[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - getOrphanThresholdMs());

  const steps = await prisma.step.findMany({
    where: {
      status: "running",
      claim_pid: { not: null },
      claim_updated_at: { lt: cutoff },
      run: {
        status: "running",
        // AL-1: never reclaim a step whose run the user is pausing (drain
        // in progress) or already paused. Reverting a dead step to pending
        // would re-activate a run that was explicitly asked to wind down.
        // `{ not: "draining_pause" }` alone would also drop NULL
        // scheduling_status rows (SQL: NOT (NULL = x) is NULL), so include
        // the explicit null branch to keep normal runs reclaimable.
        OR: [
          { scheduling_status: { not: "draining_pause" } },
          { scheduling_status: null },
        ],
      },
    },
    select: {
      id: true,
      step_id: true,
      run_id: true,
      agent_id: true,
      claim_pid: true,
      claim_updated_at: true,
    },
  });

  const orphans: OrphanedRunningStep[] = [];
  for (const step of steps) {
    if (step.claim_pid == null) continue;
    if (!isProcessAlive(step.claim_pid)) {
      orphans.push({
        id: step.id,
        step_id: step.step_id,
        run_id: step.run_id,
        agent_id: step.agent_id,
        claim_pid: step.claim_pid,
        claim_updated_at: step.claim_updated_at,
      });
    }
  }

  if (orphans.length > 0) {
    logger.info("orphan-running: found steps with dead claim_pid", {
      count: orphans.length,
      runIds: orphans.map((s) => s.run_id.slice(0, 8)),
    });
  }

  return orphans;
}

/**
 * Revert an orphaned "running" step to "pending" so it can be re-claimed,
 * or fail it if abandon retries are exhausted. Mirrors the single-step
 * remediation in recovery.ts:125-147 (uses abandoned_count, not retry_count).
 *
 * Returns the runId if the step was reset (so the caller can re-nudge
 * scheduling), or null if it was failed (run is terminal).
 */
export async function remediateOrphanedStep(step: OrphanedRunningStep): Promise<string | null> {
  const prisma = getPrisma();
  const wfId = await getWorkflowId(step.run_id);
  const newAbandonCount = (await prisma.step
    .findUnique({ where: { id: step.id }, select: { abandoned_count: true } })
    .then((s) => s?.abandoned_count ?? 0)) + 1;

  // Re-verify the step is still running before touching it (race: another
  // path may have already recovered it). Guarded update ensures we only
  // act on a running step with the same dead claim_pid.
  if (newAbandonCount >= MAX_ABANDON_RESETS) {
    const updated = await prisma.step.updateMany({
      where: { id: step.id, status: "running", claim_pid: step.claim_pid },
      data: {
        status: "failed",
        output: `Agent process (PID ${step.claim_pid}) died without completing (${newAbandonCount} abandons)`,
        abandoned_count: newAbandonCount,
        claim_pid: null,
        updated_at: new Date(),
      },
    });
    if (updated.count === 0) return null; // already changed by another path

    await prisma.run.update({
      where: { id: step.run_id },
      data: { status: "failed", updated_at: new Date() },
    });
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.orphan_reclaimed",
      runId: step.run_id,
      workflowId: wfId,
      stepId: step.step_id,
      agentId: step.agent_id,
      detail: `claim_pid ${step.claim_pid} dead; retries exhausted — step failed`,
    });
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.failed",
      runId: step.run_id,
      workflowId: wfId,
      stepId: step.step_id,
      agentId: step.agent_id,
      detail: "Agent process died without completing (orphans exhausted)",
    });
    await emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step orphaned and retries exhausted" });
    await scheduleRunCronTeardown(step.run_id);
    return null;
  }

  const updated = await prisma.step.updateMany({
    where: { id: step.id, status: "running", claim_pid: step.claim_pid },
    data: {
      status: "pending",
      abandoned_count: newAbandonCount,
      claim_pid: null,
      updated_at: new Date(),
    },
  });
  if (updated.count === 0) return null; // already changed by another path

  emitEvent({
    ts: new Date().toISOString(),
    event: "step.orphan_reclaimed",
    runId: step.run_id,
    workflowId: wfId,
    stepId: step.step_id,
    agentId: step.agent_id,
    detail: `claim_pid ${step.claim_pid} dead; reverted to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})`,
  });
  logger.info("orphan-running: reclaimed step", {
    runId: step.run_id.slice(0, 8),
    stepId: step.step_id,
    deadPid: step.claim_pid,
    abandonCount: newAbandonCount,
  });
  return step.run_id;
}

/**
 * Detect and remediate all orphaned running steps. Returns the runIds
 * whose steps were reset to pending (so the caller can re-nudge scheduling).
 */
export async function reclaimOrphanedRunningSteps(): Promise<string[]> {
  const orphans = await findOrphanedRunningSteps();
  const reNudge: string[] = [];
  for (const step of orphans) {
    try {
      const runId = await remediateOrphanedStep(step);
      if (runId) reNudge.push(runId);
    } catch (err) {
      logger.warn("orphan-running: remediation failed", {
        runId: step.run_id.slice(0, 8),
        stepId: step.step_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return [...new Set(reNudge)];
}
