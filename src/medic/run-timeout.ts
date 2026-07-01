/**
 * Run Timeout Detection
 *
 * Detects runs that have exceeded their maximum allowed duration
 * without making progress. Fills the gap where zombie-run detection
 * only catches runs with ALL steps terminal — this catches runs with
 * steps stuck in pending/waiting.
 */
import { getPrisma } from "../db.js";

// ── Types ──────────────────────────────────────────────────────────

export interface TimedOutRun {
  runId: string;
  workflowId: string;
  createdAt: string;
  lastProgressAt: string | null;
  runningDurationMinutes: number;
  noProgressMinutes: number;
  maxDurationMinutes: number;
  stalePendingCount: number;
  waitingCount: number;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_DURATION_MINUTES = 120;

function getDefaultMaxDuration(): number {
  const raw = process.env.FORMIGA_RUN_MAX_DURATION_MINUTES;
  if (!raw) return DEFAULT_MAX_DURATION_MINUTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DURATION_MINUTES;
}

// ── Detection ──────────────────────────────────────────────────────

export async function detectTimedOutRuns(
  defaultMaxMinutes = getDefaultMaxDuration(),
): Promise<TimedOutRun[]> {
  const prisma = getPrisma();
  const now = Date.now();

  const runs = await prisma.run.findMany({
    where: { status: "running" },
    select: {
      id: true,
      workflow_id: true,
      max_duration_minutes: true,
      last_progress_at: true,
      created_at: true,
      updated_at: true,
      steps: {
        select: { status: true, claim_pid: true, updated_at: true },
      },
    },
  });

  const results: TimedOutRun[] = [];

  for (const run of runs) {
    const maxDuration = run.max_duration_minutes ?? defaultMaxMinutes;
    if (maxDuration === 0) continue; // 0 = disabled

    const lastProgress = run.last_progress_at ?? run.created_at;
    const noProgressMs = now - lastProgress.getTime();
    const noProgressMinutes = Math.floor(noProgressMs / 60_000);

    if (noProgressMinutes <= maxDuration) continue;

    const stalePendingCutoff = new Date(now - 60 * 60_000);
    const stalePendingCount = run.steps.filter(
      (s) =>
        s.status === "pending" &&
        s.claim_pid === null &&
        s.updated_at < stalePendingCutoff,
    ).length;

    const waitingCount = run.steps.filter(
      (s) => s.status === "waiting",
    ).length;

    const runningDurationMinutes = Math.floor(
      (now - run.created_at.getTime()) / 60_000,
    );

    results.push({
      runId: run.id,
      workflowId: run.workflow_id,
      createdAt: run.created_at.toISOString(),
      lastProgressAt: run.last_progress_at?.toISOString() ?? null,
      runningDurationMinutes,
      noProgressMinutes,
      maxDurationMinutes: maxDuration,
      stalePendingCount,
      waitingCount,
    });
  }

  return results.sort((a, b) => b.noProgressMinutes - a.noProgressMinutes);
}
