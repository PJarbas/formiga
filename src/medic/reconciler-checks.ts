/**
 * Reconciler Checks — lightweight detection run every 30s
 *
 * These checks are cheap enough to run on every reconciler tick.
 * They attempt to recover stale pending steps by re-triggering
 * scheduling for their parent run (nudge). Heavy remediation
 * (fail/reset) is left to the medic ticker (every 5 min).
 */
import { getPrisma } from "../db.js";
import { logger } from "../lib/logger.js";

const DEFAULT_STALE_PENDING_MS = 60 * 60_000;

function getStalePendingThresholdMs(): number {
  const raw = process.env.FORMIGA_STALE_PENDING_THRESHOLD_MIN;
  if (!raw) return DEFAULT_STALE_PENDING_MS;
  const minutes = parseInt(raw, 10);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_STALE_PENDING_MS;
}

/**
 * Finds runs with stale pending steps and returns their IDs
 * so the reconciler can nudge them back into scheduling.
 */
export async function findRunsWithStalePendingSteps(): Promise<string[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - getStalePendingThresholdMs());

  const steps = await prisma.step.findMany({
    where: {
      status: "pending",
      claim_pid: null,
      updated_at: { lt: cutoff },
      run: { status: "running" },
    },
    select: { run_id: true },
    distinct: ["run_id"],
  });

  if (steps.length > 0) {
    logger.info("reconciler-checks: found stale pending steps", {
      affectedRuns: steps.length,
      runIds: steps.map((s) => s.run_id.slice(0, 8)),
    });
  }

  return steps.map((s) => s.run_id);
}
