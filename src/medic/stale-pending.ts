/**
 * Stale Pending Step Detection
 *
 * Detects steps stuck in "pending" status with no worker claiming them.
 * This fills the gap where the reconciler only catches orphaned "running"
 * steps with dead claim_pid, but misses "pending" steps never claimed.
 */
import { getPrisma } from "../db.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StalePendingStep {
  id: string;
  stepId: string;
  agentId: string;
  runId: string;
  workflowId: string;
  pendingMinutes: number;
  retryCount: number;
  maxRetries: number;
  canRetry: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_MINUTES = 60;

function getThresholdMinutes(): number {
  const raw = process.env.FORMIGA_STALE_PENDING_THRESHOLD_MIN;
  if (!raw) return DEFAULT_THRESHOLD_MINUTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_MINUTES;
}

// ── Detection ──────────────────────────────────────────────────────

export async function detectStalePendingSteps(
  thresholdMinutes = getThresholdMinutes(),
): Promise<StalePendingStep[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);

  const steps = await prisma.step.findMany({
    where: {
      status: "pending",
      claim_pid: null,
      updated_at: { lt: cutoff },
      run: { status: "running" },
    },
    include: {
      run: { select: { workflow_id: true } },
    },
    orderBy: { updated_at: "asc" },
  });

  return steps.map((step) => {
    const pendingMinutes = Math.floor(
      (Date.now() - step.updated_at.getTime()) / 60_000,
    );
    return {
      id: step.id,
      stepId: step.step_id,
      agentId: step.agent_id,
      runId: step.run_id,
      workflowId: step.run.workflow_id,
      pendingMinutes,
      retryCount: step.retry_count,
      maxRetries: step.max_retries,
      canRetry: step.retry_count < step.max_retries,
    };
  });
}
