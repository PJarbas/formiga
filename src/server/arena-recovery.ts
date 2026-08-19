// ══════════════════════════════════════════════════════════════════════
// arena-recovery.ts — Reconciler arena-step stuck detection & re-admission
// ══════════════════════════════════════════════════════════════════════
//
// Arena steps don't use claim_pid (the engine runs in a detached host, see
// src/arena/arena-process.ts). If an arena step is "running" with no
// claim_pid and hasn't updated in ARENA_STUCK_THRESHOLD_MINUTES, the engine
// is presumed dead — most commonly because the host process was killed or the
// daemon restarted mid-run (the step and session survive in the DB).
//
// The threshold is a LIVENESS detector, not a runtime cap: while the engine
// is alive its session heartbeat (arena-engine.ts, updateRound every
// heartbeatIntervalMs during the round) keeps arena_sessions.updated_at fresh,
// so a healthy arena that runs for hours is never touched. The detector only
// fires once the session goes genuinely silent for the threshold window.
//
// Re-admission (AL-4): a session still "running" is re-launched so runArena
// either restores the last checkpoint (state_json) and continues from the last
// completed round, or — with no checkpoint, i.e. a crash before round 1
// completed — restarts the loop from round 1 (the engine's resume path handles
// both). The no-checkpoint restarts make no forward progress, so they are
// capped at the step's max_retries; a session that exhausts the budget fails
// fast instead of looping forever. Checkpointed re-admissions are forward-
// progressing and are not capped.
//
// The relauncher is fire-and-forget: the launch can run for hours and must not
// block the reconciler tick. launchArenaFromStep's activeArenaRuns guard makes
// concurrent re-admission of the same run a no-op.

import type { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.js";

/** Default silence window before a running arena step is presumed dead. */
export const DEFAULT_ARENA_STUCK_THRESHOLD_MINUTES = 30;

export interface HandleStuckArenaStepsOptions {
  /**
   * Injectable relaunch used on re-admission. Defaults to the real
   * launchArenaFromStep. Test seam — unit tests pass a fake that records the
   * (runId, stepId) pairs instead of launching the engine.
   */
  relaunch?: (runId: string, stepId: string) => Promise<void> | void;
}

type StuckArenaStep = {
  id: string;
  step_id: string;
  run_id: string;
  updated_at: Date;
  retry_count: number;
  max_retries: number | null;
};

/**
 * Run the reconciler's arena-step stuck detection & re-admission pass.
 *
 * Must be called on the daemon's reconciler tick (it never blocks for the
 * re-launched arena). Throws are swallowed per-step and logged so one bad
 * update can't take down the tick.
 */
export async function handleStuckArenaSteps(
  prisma: PrismaClient,
  opts: HandleStuckArenaStepsOptions = {},
): Promise<void> {
  const relaunch = opts.relaunch ?? defaultRelaunchArena;

  const thresholdMinutes =
    parseInt(process.env.FORMIGA_ARENA_STUCK_THRESHOLD_MINUTES ?? String(DEFAULT_ARENA_STUCK_THRESHOLD_MINUTES), 10) ||
    DEFAULT_ARENA_STUCK_THRESHOLD_MINUTES;
  const arenaCutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  let stuckArenaSteps: StuckArenaStep[];
  try {
    stuckArenaSteps = await prisma.step.findMany({
      where: {
        status: "running",
        step_id: "arena",
        claim_pid: null,
        updated_at: { lt: arenaCutoff },
        run: { status: "running" },
      },
      select: { id: true, step_id: true, run_id: true, updated_at: true, retry_count: true, max_retries: true },
    });
  } catch (err) {
    logger.warn("arena-recovery: arena stuck-step query failed", { error: String(err) });
    return;
  }

  for (const step of stuckArenaSteps) {
    try {
      await reconcileOne(prisma, step, relaunch, thresholdMinutes, arenaCutoff);
    } catch (err) {
      logger.warn("arena-recovery: failed to reconcile stuck arena step", {
        stepId: step.id,
        runId: step.run_id.slice(0, 8),
        error: String(err),
      });
    }
  }
}

async function reconcileOne(
  prisma: PrismaClient,
  step: StuckArenaStep,
  relaunch: (runId: string, stepId: string) => Promise<void> | void,
  thresholdMinutes: number,
  arenaCutoff: Date,
): Promise<void> {
  const arenaSession = await prisma.arenaSession.findUnique({
    where: { run_id: step.run_id },
    select: { updated_at: true, status: true, state_json: true },
  });

  // The engine is alive and heartbeating — a slow-but-healthy arena. Never
  // touch it, no matter how long the round takes.
  if (arenaSession && arenaSession.status === "running" && arenaSession.updated_at > arenaCutoff) {
    logger.info(
      `arena-recovery: arena step ${step.id} (run ${step.run_id.slice(0, 8)}) has active session (last update: ${arenaSession.updated_at.toISOString()}) — skipping stuck detection`,
    );
    return;
  }

  // Session still "running" but silent past the threshold: the engine is dead.
  // Re-admit so runArena resumes the checkpoint or restarts from round 1.
  if (arenaSession && arenaSession.status === "running") {
    const resumable = !!arenaSession.state_json;
    const maxRetries = step.max_retries ?? 4;

    // A no-checkpoint restart makes no forward progress (it re-runs round 1
    // from scratch every time), so it must be capped — otherwise a
    // permanently-crashing engine would be re-admitted forever and the run
    // would never fail. Checkpointed re-admissions resume real work and are
    // not capped.
    if (!resumable && step.retry_count >= maxRetries) {
      logger.warn(
        `arena-recovery: arena step ${step.id} (run ${step.run_id.slice(0, 8)}) has no resumable checkpoint and re-admission budget exhausted (${step.retry_count}/${maxRetries}) — marking failed`,
      );
      await markArenaStepFailed(
        prisma,
        step,
        `Arena step stuck: no resumable checkpoint and re-admission retries exhausted (${step.retry_count}/${maxRetries}) after ${thresholdMinutes} minutes. Reconciler auto-recovery.`,
      );
      return;
    }

    if (!resumable) {
      await prisma.step.update({
        where: { id: step.id },
        data: { retry_count: step.retry_count + 1, updated_at: new Date() },
      });
      logger.warn(
        `arena-recovery: arena step ${step.id} (run ${step.run_id.slice(0, 8)}) has a restartable (no checkpoint) session — re-admitting (retry ${step.retry_count + 1}/${maxRetries})`,
      );
    } else {
      logger.warn(
        `arena-recovery: arena step ${step.id} (run ${step.run_id.slice(0, 8)}) has a resumable checkpoint — re-admitting via launchArenaFromStep`,
      );
    }

    // Fire-and-forget: the launch can run for hours and must not block the
    // reconciler tick. Rejections are logged, never thrown into the tick.
    fireAndForgetRelaunch(relaunch, step.run_id, step.id);
    return;
  }

  // No running session at all: nothing to resume, nothing to restart. The
  // engine never registered a session (or it was finalized) — this is a
  // genuine hang, not a restartable one.
  logger.warn(
    `arena-recovery: arena step ${step.id} (run ${step.run_id.slice(0, 8)}) stuck in 'running' with no claim_pid since ${step.updated_at.toISOString()} — marking failed`,
  );
  await markArenaStepFailed(
    prisma,
    step,
    `Arena step stuck: no claim_pid and no update for ${thresholdMinutes} minutes. Reconciler auto-recovery.`,
  );
}

function fireAndForgetRelaunch(
  relaunch: (runId: string, stepId: string) => Promise<void> | void,
  runId: string,
  stepId: string,
): void {
  try {
    const maybe = relaunch(runId, stepId);
    if (maybe && typeof (maybe as Promise<void>).catch === "function") {
      (maybe as Promise<void>).catch((err) => {
        logger.warn(`arena-recovery: arena re-admission for run ${runId.slice(0, 8)} failed`, { error: String(err) });
      });
    }
  } catch (err) {
    logger.warn(`arena-recovery: arena re-admission for run ${runId.slice(0, 8)} failed`, { error: String(err) });
  }
}

async function markArenaStepFailed(prisma: PrismaClient, step: StuckArenaStep, reason: string): Promise<void> {
  const now = new Date();
  await prisma.step.update({
    where: { id: step.id },
    data: { status: "failed", output: reason, updated_at: now },
  });
  await prisma.run.update({
    where: { id: step.run_id },
    data: { status: "failed", updated_at: now },
  });
}

async function defaultRelaunchArena(runId: string, stepId: string): Promise<void> {
  const { launchArenaFromStep } = await import("../arena/arena-workflow.js");
  await launchArenaFromStep(runId, stepId);
}
