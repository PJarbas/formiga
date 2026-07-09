// ══════════════════════════════════════════════════════════════════════
// polling-round.ts — One pass of the polling loop for a (run, agent)
// ══════════════════════════════════════════════════════════════════════
//
// `executePollingRound` is the orchestration entry point invoked by both
// `setInterval` timers and `nudgeScheduledRuns`. It:
//   1. Holds an in-flight guard so duplicate ticks no-op.
//   2. Bails if the run is no longer running / is paused / is draining.
//   3. Sweeps stale claims for this agent (orphan recovery).
//   4. Loads the agent persona, builds the polling prompt.
//   5. Spawns pi or hermes (depending on harnessType).
//   6. Parses output, classifies outcome, attributes token usage, and
//      either auto-completes a `STATUS: done` step or runs orphan
//      recovery for `other_output` / pi failure paths.
//
// Token-attribution helpers (`resolveRunIdForAttribution`,
// `incrementRunTokenSpend`, `attributePollingRoundTokenUsage`,
// `autoCompleteStepIfRunning`) live here so they can lazy-import
// `../db.js` and `./step-ops.js`, avoiding cycles.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { getPrisma, incrementSystemTokenSpend } from "../../db.js";
import { logger } from "../../lib/logger.js";
import { emitEvent } from "../events.js";
import { getRoleTimeoutSeconds, inferRole } from "../install.js";
import { resolvePiOutputDir, resolveWorkflowWorkspaceDir } from "../paths.js";
import { completeStep, recoverOrphanedStepsForAgent } from "../step-ops.js";
import type { WorkflowAgent, WorkflowSpec } from "../types.js";
import { findHermesBinary } from "./binary-discovery.js";
import { runHermes } from "./hermes-runner.js";
import { runPi } from "./pi-runner.js";
import {
  parsePollingRoundMetadata,
  summarizePollingRoundOutput,
  type PollingRoundMetadata,
  type PollingRoundOutputSummary,
} from "./polling-parser.js";
import { buildAgentPersonaInstructions, buildPollingPrompt } from "./prompts.js";
import {
  buildBoundedPreview,
  inFlightChildren,
  inFlightJobs,
  setInFlightChild,
  teardownRunJobs,
  tryMarkJobInFlight,
  type CronJobInfo,
} from "./shared.js";

/** Generate a temporary file path for PI/hermes stdout streaming. */
function makePiOutputFilePath(jobId: string): string {
  const outputDir = resolvePiOutputDir();
  return path.join(outputDir, `pi-output-${jobId}-${Date.now()}.log`);
}

/** Clean up the temporary PI output file unless user opted to keep it. */
async function cleanupPiOutputFile(filePath: string): Promise<void> {
  if (process.env.FORMIGA_KEEP_PI_OUTPUT === "1" || process.env.FORMIGA_KEEP_PI_OUTPUT?.toLowerCase() === "true") {
    logger.debug("Keeping PI output file", { filePath, keep: true });
    return;
  }
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn("Failed to clean up PI output file", { filePath, error: String(err) });
    }
  }
}

export type { PollingRoundMetadata } from "./polling-parser.js";

const MAX_POLLING_ERROR_PREVIEW = 240;

// ── Token attribution ─────────────────────────────────────────────────

type RunIdSource = "metadata_run_id" | "step_lookup" | "none";

interface ResolvedRunId {
  runId: string | null;
  source: RunIdSource;
}

async function resolveRunIdForAttribution(metadata: PollingRoundMetadata): Promise<ResolvedRunId> {
  if (metadata.runId) {
    return { runId: metadata.runId, source: "metadata_run_id" };
  }

  if (!metadata.stepId) {
    return { runId: null, source: "none" };
  }

  try {
    const prisma = getPrisma();
    const step = await prisma.step.findUnique({
      where: { id: metadata.stepId },
      select: { run_id: true },
    });
    if (!step?.run_id) return { runId: null, source: "none" };
    return { runId: step.run_id, source: "step_lookup" };
  } catch {
    return { runId: null, source: "none" };
  }
}

interface TokenSpendUpdate {
  workflowId?: string;
  tokensSpent: number;
}

async function incrementRunTokenSpend(runId: string, tokenUsage: number): Promise<TokenSpendUpdate | null> {
  const prisma = getPrisma();
  try {
    const updated = await prisma.run.update({
      where: { id: runId },
      data: {
        tokens_spent: { increment: tokenUsage },
        updated_at: new Date(),
      },
      select: { workflow_id: true, tokens_spent: true },
    });
    return {
      workflowId: updated.workflow_id,
      tokensSpent: updated.tokens_spent,
    };
  } catch {
    return null;
  }
}

// ── Auto-complete + orphan recovery ───────────────────────────────────

/**
 * Auto-complete fallback (safety net). Invoked when output classifies as
 * `work_done` but the agent never explicitly called `step complete`.
 *
 * The proper flow is: agent calls `formiga step complete` during execution,
 * which sets step.status = "done" via the API. This fallback only fires when
 * the agent didn't self-report — e.g. the output contains STATUS: done markers
 * but the agent forgot to call the CLI.
 *
 * By checking step.status first, we avoid double-completion and make the
 * full stdout content unnecessary when the agent behaved correctly.
 */
export async function autoCompleteStepIfRunning(
  context: Record<string, unknown>,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (!metadata.stepId) {
    logger.warn("Auto-complete fallback skipped — no stepId in output", { ...context });
    return;
  }

  const prisma = getPrisma();
  const row = await prisma.step.findUnique({
    where: { id: metadata.stepId },
    select: { status: true, type: true, current_story_id: true, run_id: true },
  });

  if (!row) {
    logger.warn("Auto-complete fallback skipped — step not found", {
      ...context,
      stepId: metadata.stepId,
    });
    return;
  }

  if (row.type === "loop" && row.current_story_id === null) {
    logger.debug("Auto-complete fallback skipped — loop step mid-iteration (agent already advanced via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  // Primary check: if the agent already reported via `formiga step complete`,
  // the step won't be "running" anymore. This is the happy path — no need
  // to parse or use the stdout content at all.
  if (row.status !== "running") {
    logger.debug("Auto-complete fallback skipped — step not running (agent reported via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  const recoveryRunId =
    typeof context.runId === "string" && context.runId
      ? (context.runId as string)
      : row.run_id;

  try {
    const result = await completeStep(metadata.stepId, metadata.assistantOutput);
    logger.info("Auto-complete fallback invoked completeStep on work_done output", {
      ...context,
      stepId: metadata.stepId,
      result: result.status,
      outputBytes: Buffer.byteLength(metadata.assistantOutput, "utf-8"),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Auto-complete fallback completeStep threw", {
      ...context,
      stepId: metadata.stepId,
      error: errorMessage,
    });

    const failureReason =
      `Previous attempt produced output that could not be auto-completed: ${errorMessage}. ` +
      `If this involved STORIES_JSON, ensure the STORIES_JSON line ends with a literal "]" and ` +
      `is followed by no trailing prose, comments, or markdown — only blank lines or another KEY: line.`;
    try {

      const workerJobId = typeof context.jobId === "string" ? context.jobId : undefined;
      const recoveryResult = await recoverOrphanedStepsForAgent(
        context.agentId as string,
        recoveryRunId,
        undefined,
        undefined,
        failureReason,
        workerJobId,
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after auto-complete throw", {
          ...context,
          stepId: metadata.stepId,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          autoCompleteError: errorMessage,
        });
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery after auto-complete throw failed", {
        ...context,
        stepId: metadata.stepId,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  }
}

async function attributePollingRoundTokenUsage(
  context: Record<string, unknown>,
  outputSummary: PollingRoundOutputSummary,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (metadata.tokenUsage === null) {
    if (metadata.jsonMetadataDetected) {
      logger.debug("Polling round token usage unavailable — usage metadata missing", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "usage_metadata_missing",
      });
    } else {
      logger.warn("Polling round token usage unavailable — --mode json may be off", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "non_json_output",
      });
    }
    return;
  }

  if (metadata.tokenUsage <= 0) {
    logger.debug("Polling round token usage not attributed", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "non_positive_usage",
      tokenUsage: metadata.tokenUsage,
    });
    return;
  }

  if (outputSummary.outcome === "heartbeat") {
    try {

      const newSystemTotal = await incrementSystemTokenSpend(metadata.tokenUsage);
      emitEvent({
        ts: new Date().toISOString(),
        event: "system.tokens.updated",
        runId: "system",
        tokenDelta: metadata.tokenUsage,
        tokensSpent: newSystemTotal,
      });
      logger.info("Heartbeat polling round token usage attributed to system spend", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "heartbeat_system_overhead",
        tokenUsage: metadata.tokenUsage,
        systemTokensSpent: newSystemTotal,
      });
    } catch (err) {
      logger.warn("Heartbeat polling round system token attribution failed", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        error: String(err),
      });
    }
    return;
  }

  const resolved = await resolveRunIdForAttribution(metadata);
  if (!resolved.runId) {
    logger.warn("Polling round token usage not attributed to run — run id unresolved", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
    });

    // Attribute to system spend instead of silently discarding.
    try {

      const newSystemTotal = await incrementSystemTokenSpend(metadata.tokenUsage);

      emitEvent({
        ts: new Date().toISOString(),
        event: "system.tokens.updated",
        runId: "system",
        tokenDelta: metadata.tokenUsage,
        tokensSpent: newSystemTotal,
      });

      logger.info("Polling round token usage attributed to system spend", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        systemTokensSpent: newSystemTotal,
      });
    } catch (err) {
      logger.warn("Polling round system token attribution failed", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        error: String(err),
      });
    }
    return;
  }

  try {
    const updated = await incrementRunTokenSpend(resolved.runId, metadata.tokenUsage);

    if (!updated) {
      logger.warn("Polling round token usage not attributed — run missing", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        runId: resolved.runId,
        runIdSource: resolved.source,
      });
      return;
    }

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId: resolved.runId,
      workflowId: updated.workflowId,
      tokenDelta: metadata.tokenUsage,
      tokensSpent: updated.tokensSpent,
    });

    logger.debug("Polling round token usage attributed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      runId: resolved.runId,
      runIdSource: resolved.source,
      tokensSpent: updated.tokensSpent,
    });
  } catch (err) {
    logger.warn("Polling round token attribution failed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      error: String(err),
    });
  }
}

// ── Polling round context + entry point ───────────────────────────────

export function buildPollingRoundContext(
  job: CronJobInfo,
  agent: WorkflowAgent,
  timeoutSeconds: number,
  workingDirectoryForHarness: string | undefined,
  workflow?: WorkflowSpec,
): Record<string, unknown> {
  const model = agent.pollingModel ?? workflow?.polling?.model ?? agent.model ?? job.workModel ?? job.model;

  return {
    jobId: job.id,
    runId: job.runId,
    workflowId: job.workflowId,
    agentId: job.agentId,
    role: agent.role ?? inferRole(agent.id),
    timeoutSeconds,
    workdir: workingDirectoryForHarness,
    workingDirectoryForHarness,
    model,
    harnessType: job.harnessType ?? "pi",
  };
}

export async function executePollingRound(
  job: CronJobInfo,
  agent: WorkflowAgent,
  workflow?: WorkflowSpec,
): Promise<void> {
  const role = agent.role ?? inferRole(agent.id);
  const timeout = agent.timeoutSeconds ?? job.timeoutSeconds ?? getRoleTimeoutSeconds(role);
  const legacyJobWorkdir = (job as CronJobInfo & { workdir?: string }).workdir;
  const workingDirectoryForHarness = job.workingDirectoryForHarness ?? legacyJobWorkdir;
  const context = buildPollingRoundContext(job, agent, timeout, workingDirectoryForHarness, workflow);

  if (!workingDirectoryForHarness) {
    logger.error("Polling round refused — missing harness workdir", {
      ...context,
      reason: "missing_working_directory_for_harness",
    });
    const removed = teardownRunJobs(job.runId);
    if (removed.length > 0) {
      logger.info("Removed run-scoped crons (missing harness workdir)", {
        ...context,
        runId: job.runId,
        count: removed.length,
        jobIds: removed,
      });
    }
    return;
  }

  // ── Race-safe in-flight guard ───────────────────────────────────
  // Must happen synchronously *before* any awaited async work so
  // concurrent nudge + timer tick invocations cannot launch duplicate
  // harness processes.
  if (!tryMarkJobInFlight(job.id)) {
    logger.info("Polling round skipped — previous harness still in flight", {
      ...context,
      reason: "previous_round_in_flight",
    });
    return;
  }

  // ── Run-scoped status check ──────────────────────────────────────
  // If this run is no longer 'running' (terminal/paused) tear down the
  // job and skip. Without this check, timers leaked from previous CLI
  // processes would keep polling pi for completed runs.
  try {
    const prisma = getPrisma();
    const row = await prisma.run.findUnique({
      where: { id: job.runId },
      select: { status: true, scheduling_status: true },
    });
    if (!row || (row.status !== "running" && row.status !== "paused")) {
      logger.info("Polling round skipped — run no longer running; tearing down job", {
        ...context,
        runStatus: row?.status ?? "missing",
        reason: "run_not_running",
      });
      const removed = teardownRunJobs(job.runId);
      if (removed.length > 0) {
        logger.info("Removed run-scoped crons", {
          ...context,
          runId: job.runId,
          count: removed.length,
          jobIds: removed,
        });
      }
      return;
    }
    if (row.status === "paused") {
      logger.debug("Polling round skipped — run paused", { ...context });
      return;
    }
    if (row.scheduling_status === "draining_pause") {
      logger.debug("Polling round skipped — run draining before pause (in-flight work can complete)", { ...context });
      return;
    }
  } catch (err) {
    logger.warn("Run status check failed; continuing polling round", {
      ...context,
      error: String(err),
    });
  }

  // ── Stale-claim sweeper (run-scoped) ─────────────────────────────
  try {
    const staleThresholdMs = timeout * 1.5 * 1000;
    const { recoverOrphanedStepsForAgent } = await import("../step-ops.js");
    const staleResult = await recoverOrphanedStepsForAgent(
      job.agentId,
      job.runId,
      staleThresholdMs,
    );
    if (staleResult.recovered > 0 || staleResult.failed > 0) {
      logger.info("Stale-claim sweeper ran", {
        ...context,
        recovered: staleResult.recovered,
        failed: staleResult.failed,
        skipped: staleResult.skipped,
        staleThresholdMs,
      });
    }
  } catch (sweepErr) {
    logger.warn("Stale-claim sweeper failed", {
      ...context,
      error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
    });
  }

  try {
    let agentPersonaInstructions = "";
    try {
      agentPersonaInstructions = await buildAgentPersonaInstructions(job.agentId);
    } catch (err) {
      logger.warn("Agent persona instructions unavailable", {
        ...context,
        workspaceDir: resolveWorkflowWorkspaceDir(job.agentId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pollingPrompt = buildPollingPrompt(
      job.workflowId,
      job.agentId,
      job.runId,
      agentPersonaInstructions,
    );

    const harnessType = job.harnessType ?? "pi";

    logger.info("Polling round start", context);

    const onSpawn = ({ pid, pgid }: { pid: number; pgid: number }) => {
      setInFlightChild(job.id, { pid, pgid, killed: false });
      emitEvent({
        ts: new Date().toISOString(),
        event: "agent.spawned",
        runId: job.runId,
        workflowId: job.workflowId,
        agentId: job.agentId,
        detail: `PID ${pid} (pgid ${pgid})`,
      });
    };

    // Use disk streaming for stdout to prevent OOM on large PI outputs.
    const outputFile = makePiOutputFilePath(job.id);
    let output: string;
      let extractedMetadata: import("./streaming-metadata-extractor.js").ExtractedMetadata | undefined;
    let cleanupFile: string | undefined;

    // Resolve current step for activity recording (best-effort)
    let activityStepId: string | undefined;
    try {
      const db = getPrisma();
      const activeStep = await db.step.findFirst({
        where: {
          run_id: job.runId,
          agent_id: job.agentId,
          status: { in: ["running", "pending"] },
        },
        select: { id: true },
        orderBy: { step_index: "asc" },
      });
      activityStepId = activeStep?.id;
    } catch {
      // Activity recording is best-effort
    }

    const activityContext = activityStepId
      ? { runId: job.runId, stepId: activityStepId, agentId: job.agentId }
      : undefined;

    try {
      if (harnessType === "hermes") {
        const hermesPath = findHermesBinary();
        output = await runHermes(pollingPrompt, {
          timeout,
          workdir: workingDirectoryForHarness,
          env: {
            FORMIGA_WORKER_JOB_ID: job.id,
            FORMIGA_WORKER_PID: String(process.pid),
            FORMIGA_HERMES_BINARY: hermesPath,
          },
          onSpawn,
          outputFile,
        });
      } else {
        const piResult = await runPi(
          ["--print", "--mode", "json", "--no-session", pollingPrompt],
          {
            timeout,
            workdir: workingDirectoryForHarness,
            env: {
              FORMIGA_WORKER_JOB_ID: job.id,
              FORMIGA_WORKER_PID: String(process.pid),
            },
            onSpawn,
            outputFile,
            activityContext,
          },
        );
        output = piResult.assistantText;
        extractedMetadata = piResult.metadata;
      }
      cleanupFile = outputFile;
    } finally {
      if (cleanupFile) {
        cleanupPiOutputFile(cleanupFile).catch(() => { /* best effort */ });
      }
    }

    const metadata = extractedMetadata
      ? {
          assistantOutput: extractedMetadata.assistantTextTail,
          tokenUsage: extractedMetadata.tokenUsage,
          runId: extractedMetadata.runId,
          stepId: extractedMetadata.stepId,
          jsonMetadataDetected: extractedMetadata.jsonMetadataDetected,
        }
      : parsePollingRoundMetadata(output);
    const outputSummary = summarizePollingRoundOutput(metadata.assistantOutput || output);

    emitEvent({
      ts: new Date().toISOString(),
      event: "agent.completed",
      runId: job.runId,
      workflowId: job.workflowId,
      agentId: job.agentId,
      detail: `outcome=${outputSummary.outcome}`,
    });

    logger.info("Polling round complete", {
      ...context,
      outcome: outputSummary.outcome,
      outputBytes: outputSummary.bytes,
      outputLines: outputSummary.lines,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
      tokenUsage: metadata.tokenUsage,
      metadataFormat: metadata.jsonMetadataDetected ? "json" : "text",
    });

    await attributePollingRoundTokenUsage(context, outputSummary, metadata);

    if (outputSummary.outcome === "work_done") {
      await autoCompleteStepIfRunning(context, metadata);
    } else if (outputSummary.outcome === "other_output") {
      try {

        const recoveryResult = await recoverOrphanedStepsForAgent(
          job.agentId,
          job.runId,
          undefined,
          undefined,
          undefined,
          job.id,
        );
        if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
          logger.info("Orphaned step recovery after clean pi exit (other_output)", {
            ...context,
            recovered: recoveryResult.recovered,
            failed: recoveryResult.failed,
            skipped: recoveryResult.skipped,
          });
        }
      } catch (recoveryErr) {
        logger.error("Orphaned step recovery after clean pi exit failed", {
          ...context,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = buildBoundedPreview(errorMessage, MAX_POLLING_ERROR_PREVIEW);

    emitEvent({
      ts: new Date().toISOString(),
      event: "agent.failed",
      runId: job.runId,
      workflowId: job.workflowId,
      agentId: job.agentId,
      detail: errorSummary.preview,
    });

    logger.error("Polling round failed", {
      ...context,
      errorBytes: errorSummary.bytes,
      errorPreview: errorSummary.preview,
      errorTruncated: errorSummary.truncated,
    });

    try {
      const isTimeout = errorMessage.includes("timed out");
      const timeoutRetryReason = isTimeout ? errorMessage : undefined;


      const recoveryResult = await recoverOrphanedStepsForAgent(
        job.agentId,
        job.runId,
        undefined,
        timeoutRetryReason,
        undefined,
        job.id,
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after pi failure", {
          ...context,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          piExitError: errorMessage,
          isTimeout,
        });
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery failed", {
        ...context,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  } finally {
    inFlightJobs.delete(job.id);
    inFlightChildren.delete(job.id);
  }
}
