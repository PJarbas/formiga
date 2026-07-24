/**
 * Run Progress Tracker
 *
 * Records meaningful progress events on a run whenever a step
 * transitions state. Used by the run-timeout detector to distinguish
 * "actively working" from "stuck with no progress".
 *
 * Call `recordProgress(runId)` from any step transition point
 * (claim, complete, fail) to keep the run's last_progress_at fresh.
 *
 * IMPORTANT — do NOT call this from a heartbeat/no-work polling round.
 * run-timeout.ts uses last_progress_at to detect runs stuck in a loop.
 * Renewing it on every heartbeat (as run 367d0f4e did via runs.updated_at)
 * masks the loop and defeats the timeout. Heartbeats are observable via
 * the `agent.completed (outcome=heartbeat)` event instead. Orphaned steps
 * whose owning process died are reclaimed by the PID-liveness check in
 * medic/orphan-running.ts (claim_updated_at is NOT renewed by heartbeats).
 */
import { getPrisma } from "../../db.js";

export async function recordProgress(runId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.run.update({
    where: { id: runId },
    data: { last_progress_at: new Date(), updated_at: new Date() },
  });
}
