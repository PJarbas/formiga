/**
 * Run Progress Tracker
 *
 * Records meaningful progress events on a run whenever a step
 * transitions state. Used by the run-timeout detector to distinguish
 * "actively working" from "stuck with no progress".
 *
 * Call `recordProgress(runId)` from any step transition point
 * (claim, complete, fail) to keep the run's last_progress_at fresh.
 */
import { getPrisma } from "../../db.js";

export async function recordProgress(runId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.run.update({
    where: { id: runId },
    data: { last_progress_at: new Date(), updated_at: new Date() },
  });
}
