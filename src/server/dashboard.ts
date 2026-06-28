/**
 * Formiga Dashboard HTTP Server
 *
 * Creates an HTTP server that serves the dashboard UI and API endpoints.
 *
 * Routes:
 *   GET /                        -> React SPA (ML dashboard)
 *   GET /runs/:id/kanban         -> redirect to /kanban (React SPA)
 *   GET /api/autoresearch/runs   -> list workflow runs with AutoResearch state
 *   GET /api/runs                -> list all workflow runs
 *   GET /api/runs/:id            -> detail for a specific run
 *   GET /api/runs/:id/autoresearch -> AutoResearch progress for a run's harness cwd
 *   GET /api/runs/:id/kanban     -> lane-grouped snapshot for the kanban view
 *   GET /api/events              -> recent events (global)
 *   DELETE /api/runs/:id         -> permanently delete a run and all associated data
 *   GET /api/logs-tail           -> logs-tail formatted event lines (cursor based)
 *   GET /* (non-API)              -> React SPA fallback
 *   GET /api/pipeline/status      -> active ML pipeline status
 *   GET /api/agents               -> list 5 ML agents
 *   GET /api/agents/:name         -> agent detail
 *   GET /api/agents/:name/logs    -> paginated agent logs
 *   GET /api/leaderboard          -> top models sorted by cvMean
 *   GET /api/leaderboard/:id      -> single experiment detail
 *   GET /api/leaderboard/compare  -> compare experiments
 *   GET /api/leaderboard/agent-history?agent=<name> -> failed/succeeded configs for agent
 *   GET /api/leaderboard/current-best?runId=<id>    -> single best experiment for a run
 *   GET /api/rounds               -> completed rounds for a run
 *   GET /api/cross-findings       -> cross-pollination findings
 *   POST /api/pipeline/pause      -> pause active pipeline
 *   POST /api/pipeline/resume     -> resume paused pipeline
 *   POST /api/pipeline/cancel     -> cancel active pipeline
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemTokenSpend, getAutoresearchSessions, getAutoresearchSessionById, upsertAutoresearchSession } from "../db.js";
import { getPrisma } from "../database/prisma.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { getKanbanSnapshot, getKanbanCardDetail } from "./kanban-data.js";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "./control-client.js";
import { runWorkflow } from "../installer/run.js";
import { stopWorkflow, deleteWorkflow, getWorkflowStatus } from "../installer/status.js";
import { getBuildVersion } from "../lib/version.js";
import {
  findAutoresearchSessionCwd,
  calculateAutoresearchConfidence,
  readAutoresearchLog,
  summarizeAutoresearch,
  type AutoresearchLogEntry,
  type AutoresearchRunEntry,
  type AutoresearchRunResultEntry,
} from "../autoresearch/autoresearch.js";
import { LeaderboardRepositoryImpl } from "../leaderboard/repository.js";
import { getExperimentStats, getCurrentBestForRun, getFailedConfigsForAgent, getSucceededConfigsForAgent } from "../leaderboard/queries.js";
import { AGENT_INFO_REGISTRY } from "../shared/dashboard-types.js";
import {
  findActivePipelineRunId,
  getAgentUnifiedStatus,
  getCurrentPhase,
  getAgentRoundSummaries,
} from "./pipeline-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = path.join(__dirname, "..", "dashboard");

// ── Helpers ─────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function htmlResponse(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function errorResponse(res: http.ServerResponse, message: string, status = 500): void {
  jsonResponse(res, { error: message }, status);
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      // Limit body size to 1MB
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

type RunContext = Record<string, unknown>;

function parseRunContext(context: unknown): RunContext {
  if (typeof context !== "string" || context.trim() === "") return {};
  try {
    const parsed = JSON.parse(context) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RunContext
      : {};
  } catch {
    return {};
  }
}

function stringFromContext(ctx: RunContext, key: string): string | undefined {
  const value = ctx[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveRunHarnessCwd(run: { context?: string | null }): string | undefined {
  const ctx = parseRunContext(run.context);
  return (
    stringFromContext(ctx, "working_directory_for_harness") ??
    stringFromContext(ctx, "worktree_path") ??
    stringFromContext(ctx, "cwd")
  );
}

function buildAutoresearchExperiments(entries: AutoresearchLogEntry[]) {
  const results = new Map<number, AutoresearchRunResultEntry>();
  for (const entry of entries) {
    if (entry.type === "run_result") results.set(entry.run, entry);
  }

  const cumulativeEntries: AutoresearchLogEntry[] = entries.filter((entry) => entry.type === "session");
  return entries
    .filter((entry): entry is AutoresearchRunEntry => entry.type === "run")
    .map((entry) => {
      const result = results.get(entry.run);
      cumulativeEntries.push(entry);
      const hasStoredConfidence = Object.prototype.hasOwnProperty.call(entry, "confidence_band");
      const confidence = !hasStoredConfidence
        ? calculateAutoresearchConfidence(cumulativeEntries, entry.direction)
        : {
            confidence_score: entry.confidence_score,
            confidence_band: entry.confidence_band,
            noise_floor_mad: entry.noise_floor_mad,
            confidence_sample_count: entry.confidence_sample_count,
          };
      return {
        run: entry.run,
        created_at: entry.created_at,
        status: entry.status,
        metric: entry.metric,
        best_metric: entry.best_metric,
        improvement_ratio: entry.improvement_ratio,
        confidence_score: confidence.confidence_score,
        confidence_band: confidence.confidence_band,
        noise_floor_mad: confidence.noise_floor_mad,
        confidence_sample_count: confidence.confidence_sample_count,
        duration_ms: entry.duration_ms ?? result?.duration_ms,
        description: entry.description,
        hypothesis: entry.asi?.hypothesis,
        learned: entry.asi?.learned,
        next_focus: entry.asi?.next_focus,
        command: entry.command ?? result?.command,
        commit_before: entry.commit_before ?? result?.commit_before,
        commit_after: entry.commit_after,
        measured_status: result?.status,
        exit_code: result?.exit_code,
        checks: result?.checks
          ? {
              command: result.checks.command,
              exit_code: result.checks.exit_code,
              duration_ms: result.checks.duration_ms,
            }
          : undefined,
      };
    });
}

// ── API Handlers ─────────────────────────────────────────────────────

function handleListRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const allRuns = await prisma.run.findMany({
      orderBy: { created_at: "desc" },
      take: 100,
      include: { steps: true },
    });

    const rawRuns = allRuns.map((run) => {
      const total_steps = run.steps.length;
      const completed_steps = run.steps.filter((s) => s.status === "done").length;
      const failed_steps = run.steps.filter((s) => s.status === "failed").length;
      const running_steps = run.steps.filter((s) => s.status === "running").length;
      const waiting_steps = run.steps.filter((s) => s.status === "waiting").length;

      return {
        id: run.id,
        workflow_id: run.workflow_id,
        task: run.task,
        status: run.status,
        context: run.context,
        created_at: run.created_at,
        updated_at: run.updated_at,
        run_number: run.run_number,
        tokens_spent: run.tokens_spent,
        total_steps,
        completed_steps,
        failed_steps,
        running_steps,
        waiting_steps,
      };
    });

    const runs = rawRuns.map((row) => {
      let no_hurry = false;
      try {
        const ctx = JSON.parse(String(row.context ?? "{}"));
        no_hurry = ctx.no_hurry_save_tokens_mode === "true";
      } catch {
        // malformed context → no_hurry stays false
      }
      return { ...row, no_hurry };
    });

    jsonResponse(res, { runs });
  })().catch((err) => errorResponse(res, `Failed to list runs: ${(err as Error).message}`));
}

function handleRunDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  (async () => {
    const prisma = getPrisma();

    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { steps: { orderBy: { step_index: "asc" } } },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const steps = run.steps;
    const events = getRunEvents(runId);

    // Derive failure_reason from existing data (no new DB column)
    let failure_reason: string | null = null;
    if (run.status === "failed") {
      const failedStep = steps.find((s) => s.status === "failed");
      failure_reason = failedStep?.output || "Run failed";
    } else if (run.status === "canceled") {
      failure_reason = "Canceled";
    }

    // Enrich with worktree information
    let worktree: unknown = null;
    try {
      const ctx = JSON.parse(run.context ?? "{}") as Record<string, string>;
      if (ctx.workspace_mode === "worktree") {
        worktree = await prisma.runWorktree.findUnique({
          where: { run_id: runId },
        });
      }
    } catch {
      // context may be malformed
    }

    jsonResponse(res, { run, steps, events, worktree, failure_reason, prompt: run.task });
  })().catch((err) => errorResponse(res, `Failed to get run detail: ${(err as Error).message}`));
}

function handleRunKanbanCardDetail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cardId = url.searchParams.get("cardId")?.trim();

    if (!cardId) {
      errorResponse(res, "Missing required query parameter: cardId", 400);
      return;
    }

    (async () => {
      const events = getRunEvents(runId);
      const detail = await getKanbanCardDetail(runId, cardId, events);

      if (!detail) {
        errorResponse(res, `Card not found: ${cardId} in run ${runId}`, 404);
        return;
      }

      jsonResponse(res, detail);
    })().catch((err) => errorResponse(res, `Failed to build card detail: ${(err as Error).message}`));
  } catch (err) {
    errorResponse(res, `Failed to build card detail: ${(err as Error).message}`);
  }
}

function handleRunKanban(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  (async () => {
    const snapshot = await getKanbanSnapshot(runId);
    if (!snapshot) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }
    jsonResponse(res, snapshot);
  })().catch((err) => errorResponse(res, `Failed to build kanban snapshot: ${(err as Error).message}`));
}

function handleRunAutoresearch(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  (async () => {
    const prisma = getPrisma();

    const run = await prisma.run.findUnique({
      where: { id: runId },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const cwd = resolveRunHarnessCwd(run);
    if (!cwd) {
      jsonResponse(res, {
        exists: false,
        run,
        reason: "Run has no working_directory_for_harness in its context.",
      });
      return;
    }

    const autoresearchCwd = findAutoresearchSessionCwd(cwd) ?? cwd;
    const summary = summarizeAutoresearch(autoresearchCwd);
    if (!summary.exists) {
      jsonResponse(res, {
        exists: false,
        run,
        cwd,
        reason: summary.nextPrompt,
      });
      return;
    }

    const entries = readAutoresearchLog(autoresearchCwd);
    const results = entries.filter((entry): entry is AutoresearchRunResultEntry => entry.type === "run_result");
    jsonResponse(res, {
      exists: true,
      run,
      cwd: autoresearchCwd,
      harnessCwd: cwd,
      summary,
      experiments: buildAutoresearchExperiments(entries),
      pendingResults: results.filter((result) => !entries.some((entry) => entry.type === "run" && entry.run === result.run)),
      entries: entries.slice(-100),
    });
  })().catch((err) => errorResponse(res, `Failed to get AutoResearch progress: ${(err as Error).message}`));
}

function handleAutoresearchRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const allRuns = await prisma.run.findMany({
      orderBy: { created_at: "desc" },
      take: 100,
      include: { steps: true },
    });

    const rawRuns = allRuns.map((run) => {
      const total_steps = run.steps.length;
      const completed_steps = run.steps.filter((s) => s.status === "done").length;
      const failed_steps = run.steps.filter((s) => s.status === "failed").length;
      const running_steps = run.steps.filter((s) => s.status === "running").length;
      const waiting_steps = run.steps.filter((s) => s.status === "waiting").length;

      return {
        id: run.id,
        workflow_id: run.workflow_id,
        task: run.task,
        status: run.status,
        context: run.context,
        created_at: run.created_at,
        updated_at: run.updated_at,
        run_number: run.run_number,
        tokens_spent: run.tokens_spent,
        total_steps,
        completed_steps,
        failed_steps,
        running_steps,
        waiting_steps,
      };
    });

    const filtered = rawRuns.filter((row) => {
      const cwd = resolveRunHarnessCwd({ context: row.context as string | null | undefined });
      if (!cwd) return false;
      try {
        const sessionCwd = findAutoresearchSessionCwd(cwd);
        return !!sessionCwd;
      } catch {
        return false;
      }
    });

    const runs = filtered.map((row) => {
      let no_hurry = false;
      try {
        const ctx = JSON.parse(String(row.context ?? "{}"));
        no_hurry = ctx.no_hurry_save_tokens_mode === "true";
      } catch {
        // malformed context → no_hurry stays false
      }
      return { ...row, no_hurry };
    });

    console.log(`[dashboard] GET /api/autoresearch/runs → ${runs.length} of ${rawRuns.length} total runs have AutoResearch state`);
    jsonResponse(res, { runs });
  })().catch((err) => errorResponse(res, `Failed to list AutoResearch runs: ${(err as Error).message}`));
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const events = getRecentEvents(Math.min(limit, 500));
    jsonResponse(res, { events });
  } catch (err) {
    errorResponse(res, `Failed to get events: ${(err as Error).message}`);
  }
}

function handleLogsTail(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const offsetParam = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const offset = Number.isFinite(offsetParam) ? offsetParam : 0;
    const runId = url.searchParams.get("runId")?.trim();

    const source: EventCursorSource = runId
      ? { kind: "run", runId }
      : { kind: "global" };

    const { events, nextOffset } = readEventsFromCursor(source, offset);
    const lines = formatLogsTailLines(events);

    jsonResponse(res, { lines, nextOffset });
  } catch (err) {
    errorResponse(res, `Failed to get logs-tail events: ${(err as Error).message}`);
  }
}

function handleStats(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();
    const systemTokensSpent = await getSystemTokenSpend();

    let runTokensSpent = 0;
    try {
      const result = await prisma.run.aggregate({
        _sum: { tokens_spent: true },
      });
      runTokensSpent = result._sum.tokens_spent ?? 0;
    } catch {
      // runs table may not exist yet
      runTokensSpent = 0;
    }

    jsonResponse(res, {
      systemTokensSpent,
      totalTokensSpent: systemTokensSpent + runTokensSpent,
    });
  })().catch((err) => errorResponse(res, `Failed to get stats: ${(err as Error).message}`));
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();
    // Quick health check: can we query the DB?
    await prisma.$queryRaw`SELECT 1`;
    jsonResponse(res, {
      status: "ok",
      uptime: process.uptime(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
  })().catch((err) =>
    errorResponse(res, `Health check failed: ${(err as Error).message}`, 503),
  );
}

// ── AutoResearch Session API Handlers ──────────────────────────────

function handleAutoresearchSessions(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const sessions = await getAutoresearchSessions();
    const enriched = sessions.map((s) => {
      const summary = summarizeAutoresearch(s.cwd);
      return {
        id: s.id,
        cwd: s.cwd,
        goal: s.goal,
        metric_name: s.metric_name,
        metric_unit: s.metric_unit,
        direction: s.direction,
        command: s.command,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_seen_at: s.last_seen_at,
        last_run_at: s.last_run_at,
        total_runs: s.total_runs,
        baseline_metric: s.baseline_metric,
        best_metric: s.best_metric,
        best_run: s.best_run,
        files_missing: s.files_missing,
        summary: summary.exists ? summary : undefined,
      };
    });

    console.log(`[dashboard] GET /api/autoresearch/sessions → ${sessions.length} sessions`);
    jsonResponse(res, { sessions: enriched });
  })().catch((err) => errorResponse(res, `Failed to list AutoResearch sessions: ${(err as Error).message}`));
}

function handleAutoresearchSessionById(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
): void {
  (async () => {
    const session = await getAutoresearchSessionById(sessionId);
    if (!session) {
      errorResponse(res, `Session not found: ${sessionId}`, 404);
      return;
    }

    const cwd = session.cwd;
    const summary = summarizeAutoresearch(cwd);
    const entries = summary.exists ? readAutoresearchLog(cwd) : [];
    const results = entries.filter(
      (entry): entry is AutoresearchRunResultEntry => entry.type === "run_result",
    );

    jsonResponse(res, {
      session,
      exists: summary.exists,
      reason: summary.nextPrompt,
      summary,
      experiments: summary.exists ? buildAutoresearchExperiments(entries) : [],
      pendingResults: results.filter(
        (result) => !entries.some((entry) => entry.type === "run" && entry.run === result.run),
      ),
      entries: entries.slice(-100),
    });
  })().catch((err) => errorResponse(res, `Failed to get AutoResearch session: ${(err as Error).message}`));
}

// ── Backfill ────────────────────────────────────────────────────────

export function backfillAutoresearchSessions(): void {
  (async () => {
    const prisma = getPrisma();
    const rows = await prisma.run.findMany({
      select: { context: true },
      orderBy: { created_at: "desc" },
      take: 100,
    });

    const seen = new Set<string>();
    let backfilled = 0;

    for (const row of rows) {
      const cwd = resolveRunHarnessCwd({ context: row.context });
      if (!cwd) continue;
      try {
        const sessionCwd = findAutoresearchSessionCwd(cwd);
        if (!sessionCwd || seen.has(sessionCwd)) continue;
        seen.add(sessionCwd);

        // Only upsert if the cwd isn't already tracked
        const sessionId = fs.existsSync(sessionCwd)
          ? (() => { try { return fs.realpathSync(sessionCwd); } catch { return path.resolve(sessionCwd); } })()
          : path.resolve(sessionCwd);
        const existing = getAutoresearchSessionById(sessionId);
        if (!existing) {
          upsertAutoresearchSession(sessionCwd);
          backfilled++;
        }
      } catch {
        // Skip malformed or inaccessible cwds
      }
    }

    if (backfilled > 0) {
      console.log(`[dashboard] backfill: inserted ${backfilled} missing AutoResearch sessions from recent runs`);
    }
  })().catch((err) => {
    console.error(`[dashboard] backfill error: ${(err as Error).message}`);
  });
}

async function handlePauseRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    // Parse drain query parameter
    const url = new URL(req.url ?? "/", "http://localhost");
    const drain = url.searchParams.get("drain") === "true";

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "running") {
      errorResponse(
        res,
        `Cannot pause run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await pauseRunWithDaemon(runId, drain);

    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }

    if (result.status === 200 || result.status === 202) {
      jsonResponse(res, { paused: true, runId });
      return;
    }

    // Forward daemon error
    errorResponse(
      res,
      (result.body.error as string) ?? "Failed to pause run",
      result.status >= 400 ? result.status : 500,
    );
  } catch (err) {
    errorResponse(res, `Failed to pause run: ${(err as Error).message}`);
  }
}

async function handleResumeRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "paused") {
      errorResponse(
        res,
        `Cannot resume run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await resumeRunWithDaemon(runId);

    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }

    if (result.status === 200 || result.status === 202) {
      jsonResponse(res, { resumed: true, runId });
      return;
    }

    // Forward daemon error
    errorResponse(
      res,
      (result.body.error as string) ?? "Failed to resume run",
      result.status >= 400 ? result.status : 500,
    );
  } catch (err) {
    errorResponse(res, `Failed to resume run: ${(err as Error).message}`);
  }
}

async function handleCancelRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "running" && run.status !== "paused") {
      errorResponse(
        res,
        `Cannot cancel run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await stopWorkflow(runId);

    if (result.ok) {
      jsonResponse(res, { canceled: true, runId });
      return;
    }

    errorResponse(res, "Failed to cancel run", 500);
  } catch (err) {
    errorResponse(res, `Failed to cancel run: ${(err as Error).message}`);
  }
}

async function handleDeleteRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const url = new URL(_req.url ?? "/", "http://localhost");
    const force = url.searchParams.get("force") === "true";

    // Resolve prefix/id to full run ID
    let fullRunId: string;
    try {
      fullRunId = getWorkflowStatus(runId).id;
    } catch {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const result = await deleteWorkflow(fullRunId, { force });
    jsonResponse(res, result);
  } catch (err) {
    const message = (err as Error).message;
    const status = message.includes("Use --force") ? 409 : 500;
    errorResponse(res, message, status);
  }
}

async function handleRelaunchRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, workflow_id: true, task: true, status: true, context: true, notify_url: true },
    });

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "failed" && run.status !== "canceled") {
      errorResponse(
        res,
        `Cannot relaunch run in ${run.status} state. Only failed or canceled runs can be relaunched.`,
        409,
      );
      return;
    }

    // Parse request body for optional task override
    const body = await parseBody(req);
    let taskOverride: string | undefined;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { task?: string };
        taskOverride = parsed.task?.trim() || undefined;
      } catch {
        errorResponse(res, "Invalid JSON body", 400);
        return;
      }
    }

    const taskTitle = taskOverride ?? run.task;

    // Parse original context to extract workspace settings
    let originalContext: Record<string, string> = {};
    try {
      originalContext = JSON.parse(run.context ?? "{}") as Record<string, string>;
    } catch {
      // context may be malformed — proceed with empty context
    }

    const workspaceMode = originalContext.workspace_mode ?? "direct";

    if (workspaceMode === "worktree") {
      const relaunched = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle,
        notifyUrl: run.notify_url ?? undefined,
        worktreeOriginRepository: originalContext.worktree_origin_repository,
        worktreeOriginRef: originalContext.worktree_origin_ref,
      });

      jsonResponse(res, {
        relaunched: true,
        originalRunId: runId,
        runId: relaunched.runId,
        runNumber: relaunched.runNumber,
      });
    } else {
      const relaunched = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle,
        notifyUrl: run.notify_url ?? undefined,
        workingDirectoryForHarness: originalContext.working_directory_for_harness,
      });

      jsonResponse(res, {
        relaunched: true,
        originalRunId: runId,
        runId: relaunched.runId,
        runNumber: relaunched.runNumber,
      });
    }
  } catch (err) {
    errorResponse(res, `Failed to relaunch run: ${(err as Error).message}`);
  }
}

function handleVersion(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const version = getBuildVersion();
    jsonResponse(res, { version });
  } catch (err) {
    errorResponse(res, `Failed to read build version: ${(err as Error).message}`);
  }
}

// ── ML Pipeline API Handlers ──────────────────────────────────────────

function handlePipelineStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();
    const runId = await findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, {
        runId: null,
        status: "idle",
        currentPhase: "idle",
        currentRound: 0,
        maxRounds: 5,
        startedAt: null,
        updatedAt: null,
        phaseStats: {
          dataAnalyst: "idle",
          featureEngineer: "idle",
          modelerClassic: "idle",
          modelerAdvanced: "idle",
          mlCritic: "idle",
        },
        quickStats: { totalExperiments: 0, bestCvMean: null, roundsCompleted: 0, tokensSpent: 0 },
      });
      return;
    }

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true, created_at: true, updated_at: true, tokens_spent: true },
    });

    const stats = await getExperimentStats(runId);

    // Best cvMean from leaderboard
    const bestRow = await prisma.experiment.findFirst({
      where: { run_id: runId, status: { in: ["SUCCESS", "AUDITED"] } },
      orderBy: { val_metric: "desc" },
      select: { val_metric: true },
    });

    // Determine the max round number observed
    const maxRoundRow = await prisma.experiment.aggregate({
      where: { run_id: runId },
      _max: { round_number: true },
    });

    const currentRound = maxRoundRow._max.round_number ?? 0;

    const currentPhase = await getCurrentPhase(runId);

    const phaseStats = {
      dataAnalyst: (await getAgentUnifiedStatus(runId, "data-analyst", currentRound)).status,
      featureEngineer: (await getAgentUnifiedStatus(runId, "feature-engineer", currentRound)).status,
      modelerClassic: (await getAgentUnifiedStatus(runId, "modeler-classic", currentRound)).status,
      modelerAdvanced: (await getAgentUnifiedStatus(runId, "modeler-advanced", currentRound)).status,
      mlCritic: (await getAgentUnifiedStatus(runId, "ml-critic", currentRound)).status,
    };

    jsonResponse(res, {
      runId,
      status: run?.status ?? "idle",
      currentPhase,
      currentRound,
      maxRounds: 5,
      startedAt: run?.created_at ?? null,
      updatedAt: run?.updated_at ?? null,
      phaseStats,
      quickStats: {
        totalExperiments: stats.total,
        bestCvMean: bestRow?.val_metric ?? null,
        roundsCompleted: currentRound,
        tokensSpent: run?.tokens_spent ?? 0,
      },
    });
  })().catch((err) => errorResponse(res, `Failed to get pipeline status: ${(err as Error).message}`));
}

function handleAgents(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const runId = await findActivePipelineRunId();

    const agents = await Promise.all(
      Object.entries(AGENT_INFO_REGISTRY).map(async ([name, info]) => {
        if (!runId) return { ...info, currentStatus: "idle" };
        const unified = await getAgentUnifiedStatus(runId, name, 0);
        return { ...info, currentStatus: unified.status };
      }),
    );

    jsonResponse(res, agents);
  })().catch((err) => errorResponse(res, `Failed to list agents: ${(err as Error).message}`));
}

function handleAgentDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): void {
  (async () => {
    const info = AGENT_INFO_REGISTRY[agentName];
    if (!info) {
      errorResponse(res, `Agent not found: ${agentName}`, 404);
      return;
    }

    const runId = await findActivePipelineRunId();

    const rounds: Array<{ roundNumber: number; status: string; cvMean: number | null; modelType: string | null }> = [];
    let totalTrials = 0;
    let lastError: string | null = null;

    if (runId) {
      const roundSummaries = await getAgentRoundSummaries(runId, agentName);
      totalTrials = roundSummaries.length;
      rounds.push(...roundSummaries);

      const unified = await getAgentUnifiedStatus(runId, agentName, 0);
      lastError = unified.errorMessage;
    }

    // Determine current status using the unified helper
    let currentStatus: string = "idle";
    if (runId) {
      currentStatus = (await getAgentUnifiedStatus(runId, agentName, 0)).status;
    }

    const result = {
      agent: info,
      currentStatus,
      totalTrials,
      lastOutput: null, // populated when agent produces output
      lastError,
      rounds,
    };

    jsonResponse(res, result);
  })().catch((err) => errorResponse(res, `Failed to get agent detail: ${(err as Error).message}`));
}

function handleAgentLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): void {
  (async () => {
    const prisma = getPrisma();

    const info = AGENT_INFO_REGISTRY[agentName];
    if (!info) {
      errorResponse(res, `Agent not found: ${agentName}`, 404);
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

    const runId = await findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, { agentName, entries: [], total: 0, offset, limit });
      return;
    }

    // Read experiments for this agent as log entries
    const total = await prisma.experiment.count({
      where: { run_id: runId, agent_name: agentName },
    });

    const rows = await prisma.experiment.findMany({
      where: { run_id: runId, agent_name: agentName },
      orderBy: { experiment_id: "desc" },
      skip: offset,
      take: limit,
      select: { experiment_id: true, round_number: true, status: true, val_metric: true, error_message: true, created_at: true },
    });

    const entries = rows.flatMap((row) => {
      const logs: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }> = [];
      const ts = row.created_at.toISOString();
      if (row.status === "SUCCESS" || row.status === "AUDITED") {
        logs.push({ timestamp: ts, level: "info", message: `[Round ${row.round_number}] Trial completed — val_metric: ${row.val_metric.toFixed(4)}, status: ${row.status}` });
      } else if (row.status === "FAILED" || row.status === "OVERFITTED") {
        logs.push({ timestamp: ts, level: "error", message: `[Round ${row.round_number}] Trial failed — ${row.error_message ?? "Unknown error"}` });
      } else {
        logs.push({ timestamp: ts, level: "info", message: `[Round ${row.round_number}] Trial running — status: ${row.status}` });
      }
      return logs;
    });

    jsonResponse(res, {
      agentName,
      entries,
      total,
      offset,
      limit,
    });
  })().catch((err) => errorResponse(res, `Failed to get agent logs: ${(err as Error).message}`));
}

function handleLeaderboard(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const url = new URL(req.url ?? "/", "http://localhost");
    const agentName = url.searchParams.get("agentName")?.trim();
    const roundStr = url.searchParams.get("roundNumber");
    const statusFilter = url.searchParams.get("status")?.trim();
    const sortBy = url.searchParams.get("sortBy") ?? "cvMean";
    const sortDir = url.searchParams.get("sortDir") ?? "desc";

    const runId = await findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, { entries: [], total: 0, bestCvMean: null, filters: {} });
      return;
    }

    // Build where clause
    const whereClause: Record<string, unknown> = { run_id: runId };
    if (agentName) whereClause.agent_name = agentName;
    if (roundStr) whereClause.round_number = Number(roundStr);
    if (statusFilter) whereClause.status = statusFilter;

    // Map sortBy field
    const sortOrderBy: Record<string, string> = {};
    if (sortBy === "trainMean") {
      sortOrderBy.train_metric = sortDir;
    } else if (sortBy === "roundNumber") {
      sortOrderBy.round_number = sortDir;
    } else {
      // cvMean is default, and trainValGap requires calculation
      sortOrderBy.val_metric = sortDir;
    }

    const total = await prisma.experiment.count({ where: whereClause });

    const rows = await prisma.experiment.findMany({
      where: whereClause,
      orderBy: sortOrderBy,
      take: 100,
    });

    const bestRow = await prisma.experiment.findFirst({
      where: { run_id: runId, status: { in: ["SUCCESS", "AUDITED"] } },
      orderBy: { val_metric: "desc" },
      select: { val_metric: true },
    });

    // Handle trainValGap sorting in JS if needed
    let entries = rows.map(mapExperimentRow);
    if (sortBy === "trainValGap") {
      entries.sort((a, b) => {
        const gapA = a.trainValGap;
        const gapB = b.trainValGap;
        return sortDir === "asc" ? gapA - gapB : gapB - gapA;
      });
    }

    jsonResponse(res, {
      entries,
      total,
      bestCvMean: bestRow?.val_metric ?? null,
      filters: { agentName: agentName || undefined, roundNumber: roundStr ? Number(roundStr) : undefined, status: statusFilter || undefined },
    });
  })().catch((err) => errorResponse(res, `Failed to get leaderboard: ${(err as Error).message}`));
}

function safeParseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Maps a raw `experiments` row to the LeaderboardEntry shape returned by
 * GET /api/leaderboard, /api/leaderboard/:id, and /api/leaderboard/compare.
 * Fields that the schema does not yet persist (feature importances, timings)
 * surface as `null` until ingestion captures them — the API contract is stable.
 */
function mapExperimentRow(r: Record<string, unknown>): {
  id: string;
  runId: string;
  roundNumber: number;
  agentName: string;
  modelId: string;
  modelType: string;
  status: string;
  cvMean: number;
  cvStd: number;
  trainMean: number;
  trainValGap: number;
  hyperparameters: Record<string, unknown>;
  featureImportancesTop10: Array<[string, number]> | null;
  trainTimeSeconds: number | null;
  inferenceTimeMsPer1k: number | null;
  createdAt: string;
  promotedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
} {
  return {
    id: String(r.experiment_id),
    runId: r.run_id as string,
    roundNumber: Number(r.round_number),
    agentName: r.agent_name as string,
    modelId: `model_${r.experiment_id}`,
    modelType: r.model_type as string,
    status: r.status as string,
    cvMean: Number(r.val_metric),
    cvStd: 0,
    trainMean: Number(r.train_metric),
    trainValGap: Number(r.train_metric) - Number(r.val_metric),
    hyperparameters: safeParseJson(r.hyperparameters as string),
    featureImportancesTop10: null,
    trainTimeSeconds: null,
    inferenceTimeMsPer1k: null,
    createdAt: r.created_at as string,
    promotedAt: (r.promoted_at as string | null) ?? null,
    rejectedAt: (r.rejected_at as string | null) ?? null,
    rejectReason: (r.reject_reason as string | null) ?? null,
  };
}

function handleLeaderboardEntry(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): void {
  (async () => {
    const prisma = getPrisma();

    const experimentId = Number(id);
    if (!Number.isFinite(experimentId)) {
      errorResponse(res, `Invalid experiment id: ${id}`, 400);
      return;
    }

    const row = await prisma.experiment.findUnique({
      where: { experiment_id: experimentId },
    });

    if (!row) {
      errorResponse(res, `Experiment not found: ${id}`, 404);
      return;
    }

    jsonResponse(res, mapExperimentRow(row as Record<string, unknown>));
  })().catch((err) => errorResponse(res, `Failed to get leaderboard entry: ${(err as Error).message}`));
}

function handleLeaderboardCompare(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const url = new URL(req.url ?? "/", "http://localhost");
    const ids = url.searchParams.getAll("id");

    if (ids.length < 2) {
      errorResponse(res, "At least 2 experiment IDs required", 400);
      return;
    }

    const experimentIds = ids.map(Number);
    const rows = await prisma.experiment.findMany({
      where: { experiment_id: { in: experimentIds } },
    });

    const entries = rows.map((r) => mapExperimentRow(r as Record<string, unknown>));

    jsonResponse(res, { entries });
  })().catch((err) => errorResponse(res, `Failed to compare leaderboard entries: ${(err as Error).message}`));
}

function handleLeaderboardAgentHistory(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentName = url.searchParams.get("agent")?.trim();
    if (!agentName) {
      errorResponse(res, "Missing required query parameter: agent", 400);
      return;
    }

    const failed = await getFailedConfigsForAgent(agentName, 5);
    const succeeded = await getSucceededConfigsForAgent(agentName, 3);

    jsonResponse(res, {
      agent: agentName,
      failed_count: failed.length,
      succeeded_count: succeeded.length,
      failed,
      succeeded,
    });
  })().catch((err) => errorResponse(res, `Failed to get agent history: ${(err as Error).message}`));
}

function handleLeaderboardCurrentBest(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let runId = url.searchParams.get("runId")?.trim() ?? null;
    if (!runId) {
      runId = await findActivePipelineRunId();
    }

    if (!runId) {
      errorResponse(res, "Missing required query parameter: runId (no active pipeline)", 400);
      return;
    }

    const row = await getCurrentBestForRun(runId);

    if (!row) {
      jsonResponse(res, { experiment: null });
      return;
    }

    jsonResponse(res, {
      experiment: {
        experiment_id: row.experiment_id,
        model_type: row.model_type,
        cv_mean: row.val_metric,
        agent_name: row.agent_name,
      },
    });
  })().catch((err) => errorResponse(res, `Failed to get current best: ${(err as Error).message}`));
}

function handleRounds(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const url = new URL(req.url ?? "/", "http://localhost");
    let runId = url.searchParams.get("runId")?.trim() ?? null;
    if (!runId) {
      runId = await findActivePipelineRunId();
    }

    if (!runId) {
      jsonResponse(res, []);
      return;
    }

    const roundRows = await prisma.experiment.groupBy({
      by: ["round_number"],
      where: { run_id: runId },
      _min: { created_at: true },
      _max: { created_at: true },
      orderBy: { round_number: "asc" },
    });

    const rounds = await Promise.all(
      roundRows.map(async (r) => {
        const stats = await prisma.experiment.aggregate({
          where: { run_id: runId, round_number: r.round_number },
          _count: true,
        });

        const successCount = await prisma.experiment.count({
          where: { run_id: runId, round_number: r.round_number, status: { in: ["SUCCESS", "AUDITED"] } },
        });

        const rejectedCount = await prisma.experiment.count({
          where: { run_id: runId, round_number: r.round_number, status: { in: ["FAILED", "OVERFITTED"] } },
        });

        return {
          runId,
          roundNumber: r.round_number,
          status: stats._count > 0 ? "completed" : "pending",
          experimentsRegistered: successCount,
          experimentsRejected: rejectedCount,
          startedAt: r._min.created_at?.toISOString(),
          completedAt: r._max.created_at?.toISOString(),
        };
      }),
    );

    jsonResponse(res, rounds);
  })().catch((err) => errorResponse(res, `Failed to list rounds: ${(err as Error).message}`));
}

function handleCrossFindings(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const url = new URL(req.url ?? "/", "http://localhost");
    let runId = url.searchParams.get("runId")?.trim() ?? null;
    if (!runId) {
      runId = await findActivePipelineRunId();
    }

    if (!runId) {
      jsonResponse(res, []);
      return;
    }

    // Cross-findings are experiments where both modelers ran and produced results
    const rows = await prisma.experiment.findMany({
      where: {
        run_id: runId,
        agent_name: { in: ["modeler-classic", "modeler-advanced"] },
        status: { in: ["SUCCESS", "AUDITED"] },
      },
      orderBy: [{ round_number: "asc" }, { agent_name: "asc" }],
      select: { experiment_id: true, round_number: true, agent_name: true, model_type: true, val_metric: true, created_at: true },
    });

    // Group by round to find cross-findings
    const byRound = new Map<number, typeof rows>();
    for (const row of rows) {
      const list = byRound.get(row.round_number) ?? [];
      list.push(row);
      byRound.set(row.round_number, list);
    }

    const findings: Array<{ id: string; runId: string; roundNumber: number; fromAgent: string; toAgent: string; content: string; createdAt: string }> = [];
    for (const [round, entries] of byRound) {
      if (entries.length >= 2) {
        const classic = entries.find((e) => e.agent_name === "modeler-classic");
        const advanced = entries.find((e) => e.agent_name === "modeler-advanced");
        if (classic && advanced) {
          const diff = Math.abs(classic.val_metric - advanced.val_metric);
          findings.push({
            id: `cross_${round}`,
            runId,
            roundNumber: round,
            fromAgent: "modeler-classic",
            toAgent: "modeler-advanced",
            content: `Round ${round}: Classic (${classic.model_type}) cvMean=${classic.val_metric.toFixed(4)} vs Advanced (${advanced.model_type}) cvMean=${advanced.val_metric.toFixed(4)} (diff=${diff.toFixed(4)})`,
            createdAt: advanced.created_at.toISOString(),
          });
        }
      }
    }

    jsonResponse(res, findings);
  })().catch((err) => errorResponse(res, `Failed to get cross-findings: ${(err as Error).message}`));
}

// ── Front-specs handlers: promote/reject, approvals, checklist, trace ─

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const raw = await parseBody(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// NOTE: manual promote/reject endpoints removed; audit is now fully automated
// by the critic-processor that parses the ml-critic step output.

function parseSpecId(specId: string): { runId: string; phase: string } | null {
  const idx = specId.indexOf(":");
  if (idx <= 0 || idx === specId.length - 1) return null;
  return { runId: specId.slice(0, idx), phase: specId.slice(idx + 1) };
}

function rowToSpecApproval(row: Record<string, unknown>): {
  id: string;
  runId: string;
  phase: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  updatedAt: string;
} {
  return {
    id: row.spec_id as string,
    runId: row.run_id as string,
    phase: row.phase as string,
    status: row.status as "pending" | "approved" | "rejected",
    reason: (row.reason as string | null) ?? undefined,
    approvedBy: (row.approved_by as string | null) ?? undefined,
    approvedAt: (row.approved_at as string | null) ?? undefined,
    rejectedAt: (row.rejected_at as string | null) ?? undefined,
    rejectedBy: (row.rejected_by as string | null) ?? undefined,
    updatedAt: row.updated_at as string,
  };
}

async function handleSpecApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  specId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const parts = parseSpecId(specId);
    if (!parts) {
      errorResponse(res, `Invalid spec id (expected "<runId>:<phase>"): ${specId}`, 400);
      return;
    }
    const body = await readJsonBody<{ approvedBy?: string }>(req);
    const approvedBy = body?.approvedBy?.trim() ?? null;
    const now = new Date();

    const row = await prisma.specApproval.upsert({
      where: { spec_id: specId },
      create: {
        spec_id: specId,
        run_id: parts.runId,
        phase: parts.phase,
        status: "approved",
        approved_by: approvedBy,
        approved_at: now,
        rejected_at: null,
        rejected_by: null,
        reason: null,
        updated_at: now,
      },
      update: {
        status: "approved",
        approved_by: approvedBy,
        approved_at: now,
        rejected_at: null,
        rejected_by: null,
        reason: null,
        updated_at: now,
      },
    });

    jsonResponse(res, rowToSpecApproval(row as Record<string, unknown>));
  } catch (err) {
    errorResponse(res, `Failed to approve spec: ${(err as Error).message}`);
  }
}

async function handleSpecReject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  specId: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const parts = parseSpecId(specId);
    if (!parts) {
      errorResponse(res, `Invalid spec id (expected "<runId>:<phase>"): ${specId}`, 400);
      return;
    }
    const body = await readJsonBody<{ reason?: string; rejectedBy?: string }>(req);
    const reason = body?.reason?.trim() ?? null;
    const rejectedBy = body?.rejectedBy?.trim() ?? null;
    const now = new Date();

    const row = await prisma.specApproval.upsert({
      where: { spec_id: specId },
      create: {
        spec_id: specId,
        run_id: parts.runId,
        phase: parts.phase,
        status: "rejected",
        reason,
        rejected_by: rejectedBy,
        rejected_at: now,
        approved_by: null,
        approved_at: null,
        updated_at: now,
      },
      update: {
        status: "rejected",
        reason,
        rejected_by: rejectedBy,
        rejected_at: now,
        approved_by: null,
        approved_at: null,
        updated_at: now,
      },
    });

    jsonResponse(res, rowToSpecApproval(row as Record<string, unknown>));
  } catch (err) {
    errorResponse(res, `Failed to reject spec: ${(err as Error).message}`);
  }
}

function handleChecklistGet(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  phase: string,
): void {
  (async () => {
    const prisma = getPrisma();

    const row = await prisma.checklistState.findUnique({
      where: { run_id_phase: { run_id: runId, phase } },
      select: { items_json: true, updated_at: true },
    });

    if (!row) {
      jsonResponse(res, { runId, phase, items: [], updatedAt: new Date().toISOString() });
      return;
    }

    let items: unknown = [];
    try {
      items = JSON.parse(row.items_json);
    } catch {
      items = [];
    }
    jsonResponse(res, { runId, phase, items, updatedAt: row.updated_at.toISOString() });
  })().catch((err) => errorResponse(res, `Failed to read checklist: ${(err as Error).message}`));
}

async function handleChecklistPut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  phase: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const body = await readJsonBody<{ items?: unknown }>(req);
    const items = Array.isArray(body?.items) ? body!.items : [];
    const json = JSON.stringify(items);
    const now = new Date();

    const row = await prisma.checklistState.upsert({
      where: { run_id_phase: { run_id: runId, phase } },
      create: {
        run_id: runId,
        phase,
        items_json: json,
        updated_at: now,
      },
      update: {
        items_json: json,
        updated_at: now,
      },
      select: { updated_at: true },
    });

    jsonResponse(res, { runId, phase, items, updatedAt: row.updated_at.toISOString() });
  } catch (err) {
    errorResponse(res, `Failed to update checklist: ${(err as Error).message}`);
  }
}

function handleTrace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
  roundNumber: number,
): void {
  (async () => {
    const prisma = getPrisma();

    const url = new URL(req.url ?? "/", "http://localhost");
    let runId = url.searchParams.get("runId")?.trim() ?? null;
    if (!runId) {
      runId = await findActivePipelineRunId();
    }
    if (!runId) {
      jsonResponse(res, []);
      return;
    }

    // Derive trace entries from experiments table for this agent + round.
    // Each experiment row becomes one TraceEntry; failures escalate to 'error',
    // OVERFITTED to 'warn', others 'info'.
    const rows = await prisma.experiment.findMany({
      where: { run_id: runId, agent_name: agentName, round_number: roundNumber },
      orderBy: [{ created_at: "asc" }, { experiment_id: "asc" }],
      select: { experiment_id: true, model_type: true, status: true, error_message: true, created_at: true },
    });

    const entries = rows.map((r) => {
      let level: "info" | "warn" | "error" = "info";
      if (r.status === "FAILED") level = "error";
      else if (r.status === "OVERFITTED") level = "warn";
      return {
        timestamp: r.created_at.toISOString(),
        event: `${r.status} · ${r.model_type}`,
        detail: r.error_message ?? undefined,
        level,
      };
    });

    jsonResponse(res, entries);
  })().catch((err) => errorResponse(res, `Failed to read trace: ${(err as Error).message}`));
}

const PIPELINE_PHASE_LABELS: Array<{ id: string; label: string }> = [
  { id: "data_analysis", label: "EDA" },
  { id: "feature_engineering", label: "Feat" },
  { id: "modeling", label: "Model" },
  { id: "audit", label: "Audit" },
  { id: "complete", label: "Done" },
];

function derivePhases(currentPhase: string): Array<{
  id: string;
  label: string;
  status: "done" | "running" | "pending" | "failed";
  elapsedMs: number;
  estimatedMs: number;
}> {
  const currentIdx = PIPELINE_PHASE_LABELS.findIndex((p) => p.id === currentPhase);
  return PIPELINE_PHASE_LABELS.map((p, i) => {
    let status: "done" | "running" | "pending" | "failed" = "pending";
    if (currentIdx < 0) status = "pending";
    else if (i < currentIdx) status = "done";
    else if (i === currentIdx) status = "running";
    return { id: p.id, label: p.label, status, elapsedMs: 0, estimatedMs: 0 };
  });
}

async function derivePendingDecisions(runId: string): Promise<Array<{
  id: string;
  type: "spec_approval" | "model_rejected" | "model_promoted" | "overfitting_warning";
  title: string;
  description: string;
  actions: Array<{ id: string; label: string; primary?: boolean }>;
  createdAt: string;
}>> {
  const prisma = getPrisma();
  const decisions: Array<{
    id: string;
    type: "spec_approval" | "model_rejected" | "model_promoted" | "overfitting_warning";
    title: string;
    description: string;
    actions: Array<{ id: string; label: string; primary?: boolean }>;
    createdAt: string;
  }> = [];

  // Pending spec approvals for this run
  const pendingSpecs = await prisma.specApproval.findMany({
    where: { run_id: runId, status: "pending" },
    select: { spec_id: true, phase: true, updated_at: true },
  });

  for (const s of pendingSpecs) {
    decisions.push({
      id: `spec:${s.spec_id}`,
      type: "spec_approval",
      title: `Spec pending: ${s.phase}`,
      description: "A spec is awaiting your approval before the pipeline continues.",
      actions: [
        { id: "approve", label: "Approve", primary: true },
        { id: "reject", label: "Reject" },
      ],
      createdAt: s.updated_at.toISOString(),
    });
  }

  // NOTE: overfitting warnings removed since reject is now automatic via critic-processor

  return decisions;
}

function handlePendingDecisions(req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let runId = url.searchParams.get("runId")?.trim() ?? null;
    if (!runId) {
      runId = await findActivePipelineRunId();
    }
    if (!runId) {
      jsonResponse(res, []);
      return;
    }
    jsonResponse(res, await derivePendingDecisions(runId));
  })().catch((err) => errorResponse(res, `Failed to derive pending decisions: ${(err as Error).message}`));
}

function handleCommandCenter(_req: http.IncomingMessage, res: http.ServerResponse): void {
  (async () => {
    const prisma = getPrisma();

    const runId = await findActivePipelineRunId();
    if (!runId) {
      jsonResponse(res, {
        run: {
          runId: null,
          status: "idle",
          currentPhase: "idle",
          currentRound: 0,
          maxRounds: 5,
          startedAt: null,
          updatedAt: null,
        },
        phases: derivePhases("idle"),
        pendingDecisions: [],
        bestModel: null,
        bestModelTrend: [],
        agentStrip: Object.values(AGENT_INFO_REGISTRY).map((info) => ({
          name: info.name,
          label: info.label,
          status: "idle",
          bestCvMean: null,
          trials: 0,
        })),
        quickStats: { totalExperiments: 0, bestCvMean: null, roundsCompleted: 0, tokensSpent: 0 },
      });
      return;
    }

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true, created_at: true, updated_at: true, tokens_spent: true },
    });

    const maxRoundRow = await prisma.experiment.aggregate({
      where: { run_id: runId },
      _max: { round_number: true },
    });
    const currentRound = maxRoundRow._max.round_number ?? 0;

    const agentRows = await prisma.experiment.findMany({
      where: { run_id: runId, round_number: currentRound },
      distinct: ["agent_name"],
      select: { agent_name: true },
    });
    const agentNames = new Set(agentRows.map((a) => a.agent_name));

    // Fallback: derive phase from step statuses when no experiments yet
    const stepRows = await prisma.step.findMany({
      where: { run_id: runId },
      select: { step_id: true, status: true },
    });
    const stepStatus: Record<string, string> = {};
    for (const s of stepRows) stepStatus[s.step_id] = s.status;

    const currentPhase = await getCurrentPhase(runId);

    const stats = await getExperimentStats(runId);
    const bestRow = await prisma.experiment.findFirst({
      where: { run_id: runId, status: { in: ["SUCCESS", "AUDITED"] } },
      orderBy: { val_metric: "desc" },
    });
    const bestModel = bestRow ? mapExperimentRow(bestRow as Record<string, unknown>) : null;

    const trendRows = await prisma.experiment.findMany({
      where: { run_id: runId, status: { in: ["SUCCESS", "AUDITED"] } },
      orderBy: { created_at: "asc" },
      take: 50,
      select: { val_metric: true },
    });
    const bestModelTrend = trendRows.map((r) => r.val_metric);

    const agentStrip = await Promise.all(
      Object.values(AGENT_INFO_REGISTRY).map(async (info) => {
        const unified = await getAgentUnifiedStatus(runId, info.name, currentRound);
        const trialsCount = await prisma.experiment.count({
          where: { run_id: runId, agent_name: info.name },
        });
        return {
          name: info.name,
          label: info.label,
          status: unified.status as "idle" | "running" | "completed" | "failed" | "timed_out",
          bestCvMean: unified.valMetric,
          trials: trialsCount,
        };
      }),
    );

    jsonResponse(res, {
      run: {
        runId,
        status: run?.status ?? "idle",
        currentPhase,
        currentRound,
        maxRounds: 5,
        startedAt: run?.created_at ?? null,
        updatedAt: run?.updated_at ?? null,
      },
      phases: derivePhases(currentPhase),
      pendingDecisions: await derivePendingDecisions(runId),
      bestModel,
      bestModelTrend,
      agentStrip,
      quickStats: {
        totalExperiments: stats.total,
        bestCvMean: bestModel?.cvMean ?? null,
        roundsCompleted: currentRound,
        tokensSpent: run?.tokens_spent ?? 0,
      },
    });
  })().catch((err) => errorResponse(res, `Failed to build command-center snapshot: ${(err as Error).message}`));
}

async function handlePipelinePause(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const runId = await findActivePipelineRunId();
    if (!runId) {
      errorResponse(res, "No active pipeline run", 404);
      return;
    }
    const result = await pauseRunWithDaemon(runId, false);
    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }
    jsonResponse(res, { paused: true, runId });
  } catch (err) {
    errorResponse(res, `Failed to pause pipeline: ${(err as Error).message}`);
  }
}

async function handlePipelineResume(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const runId = await findActivePipelineRunId();
    if (!runId) {
      errorResponse(res, "No active pipeline run", 404);
      return;
    }
    const result = await resumeRunWithDaemon(runId);
    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }
    jsonResponse(res, { resumed: true, runId });
  } catch (err) {
    errorResponse(res, `Failed to resume pipeline: ${(err as Error).message}`);
  }
}

async function handlePipelineCancel(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const runId = await findActivePipelineRunId();
    if (!runId) {
      errorResponse(res, "No active pipeline run", 404);
      return;
    }
    const result = await stopWorkflow(runId);
    if (result.ok) {
      jsonResponse(res, { canceled: true, runId });
      return;
    }
    errorResponse(res, "Failed to cancel pipeline", 500);
  } catch (err) {
    errorResponse(res, `Failed to cancel pipeline: ${(err as Error).message}`);
  }
}

// ── React SPA serving ──────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStaticFile(res: http.ServerResponse, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for any unmatched paths
    try {
      const indexHtml = fs.readFileSync(path.join(DASHBOARD_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
    } catch {
      errorResponse(res, "Dashboard not built. Run npm run build:dashboard first.", 503);
    }
  }
}

// ── Router ───────────────────────────────────────────────────────────

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Parse URL path (strip query string)
  const pathname = url.split("?")[0];

  // React SPA default
  if (method === "GET" && pathname === "/") {
    serveStaticFile(res, path.join(DASHBOARD_DIST, "index.html"));
    return;
  }

  // GET /runs/:id/kanban -> redirect to new kanban
  const kanbanHtmlMatch = pathname.match(/^\/runs\/([a-zA-Z0-9_-]+)\/kanban$/);
  if (method === "GET" && kanbanHtmlMatch) {
    res.writeHead(302, { Location: "/kanban" });
    res.end();
    return;
  }

  // GET /api/runs/:id/kanban/card-detail (registered before /api/runs/:id/kanban and /api/runs/:id)
  const cardDetailMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/kanban\/card-detail$/);
  if (method === "GET" && cardDetailMatch) {
    handleRunKanbanCardDetail(req, res, cardDetailMatch[1]);
    return;
  }

  // GET /api/runs/:id/kanban (registered before /api/runs/:id below)
  const kanbanApiMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/kanban$/);
  if (method === "GET" && kanbanApiMatch) {
    handleRunKanban(req, res, kanbanApiMatch[1]);
    return;
  }

  // GET /api/runs/:id/autoresearch (registered before /api/runs/:id below)
  const autoresearchApiMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/autoresearch$/);
  if (method === "GET" && autoresearchApiMatch) {
    handleRunAutoresearch(req, res, autoresearchApiMatch[1]);
    return;
  }

  // GET /api/stats
  if (method === "GET" && pathname === "/api/stats") {
    handleStats(req, res);
    return;
  }

  // GET /api/health
  if (method === "GET" && pathname === "/api/health") {
    handleHealth(req, res);
    return;
  }

  // GET /api/autoresearch/sessions/:id (registered before /api/autoresearch/sessions to avoid prefix conflict)
  const sessionIdMatch = pathname.match(/^\/api\/autoresearch\/sessions\/([a-zA-Z0-9_\/.%~-]+)$/);
  if (method === "GET" && sessionIdMatch) {
    handleAutoresearchSessionById(req, res, decodeURIComponent(sessionIdMatch[1]));
    return;
  }

  // GET /api/autoresearch/sessions (registered before /api/autoresearch/runs)
  if (method === "GET" && pathname === "/api/autoresearch/sessions") {
    handleAutoresearchSessions(req, res);
    return;
  }

  // GET /api/autoresearch/runs (registered before /api/runs to avoid route conflict)
  if (method === "GET" && pathname === "/api/autoresearch/runs") {
    handleAutoresearchRuns(req, res);
    return;
  }

  // GET /api/runs
  if (method === "GET" && pathname === "/api/runs") {
    handleListRuns(req, res);
    return;
  }

  // GET /api/runs/:id
  const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
  if (method === "GET" && runMatch) {
    handleRunDetail(req, res, runMatch[1]);
    return;
  }

  // GET /api/events
  if (method === "GET" && pathname === "/api/events") {
    handleEvents(req, res);
    return;
  }

  // GET /api/logs-tail
  if (method === "GET" && pathname === "/api/logs-tail") {
    handleLogsTail(req, res);
    return;
  }

  // GET /api/version (registered before /api/version-status to avoid prefix conflict)
  if (method === "GET" && pathname === "/api/version") {
    handleVersion(req, res);
    return;
  }

  // POST /api/runs/:id/pause
  const pauseMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/pause$/);
  if (method === "POST" && pauseMatch) {
    handlePauseRun(req, res, pauseMatch[1]);
    return;
  }

  // POST /api/runs/:id/resume
  const resumeMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/resume$/);
  if (method === "POST" && resumeMatch) {
    handleResumeRun(req, res, resumeMatch[1]);
    return;
  }

  // POST /api/runs/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    handleCancelRun(req, res, cancelMatch[1]);
    return;
  }

  // DELETE /api/runs/:id (registered before POST /api/runs/:id/* to avoid prefix conflict)
  const deleteMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
  if (method === "DELETE" && deleteMatch) {
    handleDeleteRun(req, res, deleteMatch[1]);
    return;
  }

  // POST /api/runs/:id/relaunch
  const relaunchMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/relaunch$/);
  if (method === "POST" && relaunchMatch) {
    handleRelaunchRun(req, res, relaunchMatch[1]);
    return;
  }

  // ── ML Pipeline API routes ──────────────────────────────────────

  // GET /api/pipeline/status
  if (method === "GET" && pathname === "/api/pipeline/status") {
    handlePipelineStatus(req, res);
    return;
  }

  // GET /api/agents
  if (method === "GET" && pathname === "/api/agents") {
    handleAgents(req, res);
    return;
  }

  // GET /api/agents/:name/logs (before /api/agents/:name)
  const agentLogsMatch = pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/logs$/);
  if (method === "GET" && agentLogsMatch) {
    handleAgentLogs(req, res, agentLogsMatch[1]);
    return;
  }

  // GET /api/agents/:name
  const agentDetailMatch = pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/);
  if (method === "GET" && agentDetailMatch) {
    handleAgentDetail(req, res, agentDetailMatch[1]);
    return;
  }

  // GET /api/leaderboard/agent-history
  if (method === "GET" && pathname === "/api/leaderboard/agent-history") {
    handleLeaderboardAgentHistory(req, res);
    return;
  }

  // GET /api/leaderboard/current-best
  if (method === "GET" && pathname === "/api/leaderboard/current-best") {
    handleLeaderboardCurrentBest(req, res);
    return;
  }

  // GET /api/leaderboard/compare (before /api/leaderboard/:id)
  if (method === "GET" && pathname === "/api/leaderboard/compare") {
    handleLeaderboardCompare(req, res);
    return;
  }

  // GET /api/leaderboard/:id
  const leaderboardEntryMatch = pathname.match(/^\/api\/leaderboard\/([0-9]+)$/);
  if (method === "GET" && leaderboardEntryMatch) {
    handleLeaderboardEntry(req, res, leaderboardEntryMatch[1]);
    return;
  }

  // GET /api/leaderboard
  if (method === "GET" && pathname === "/api/leaderboard") {
    handleLeaderboard(req, res);
    return;
  }

  // GET /api/rounds
  if (method === "GET" && pathname === "/api/rounds") {
    handleRounds(req, res);
    return;
  }

  // GET /api/cross-findings
  if (method === "GET" && pathname === "/api/cross-findings") {
    handleCrossFindings(req, res);
    return;
  }

  // POST /api/pipeline/pause
  if (method === "POST" && pathname === "/api/pipeline/pause") {
    handlePipelinePause(req, res);
    return;
  }

  // POST /api/pipeline/resume
  if (method === "POST" && pathname === "/api/pipeline/resume") {
    handlePipelineResume(req, res);
    return;
  }

  // POST /api/pipeline/cancel
  if (method === "POST" && pathname === "/api/pipeline/cancel") {
    handlePipelineCancel(req, res);
    return;
  }

  // ── front-specs routes ──────────────────────────────────────────

  // PATCH /api/specs/:specId/approve
  const specApproveMatch = pathname.match(/^\/api\/specs\/([^/]+)\/approve$/);
  if (method === "PATCH" && specApproveMatch) {
    handleSpecApprove(req, res, decodeURIComponent(specApproveMatch[1]));
    return;
  }

  // PATCH /api/specs/:specId/reject
  const specRejectMatch = pathname.match(/^\/api\/specs\/([^/]+)\/reject$/);
  if (method === "PATCH" && specRejectMatch) {
    handleSpecReject(req, res, decodeURIComponent(specRejectMatch[1]));
    return;
  }

  // GET /api/checklist/:runId/:phase
  const checklistGetMatch = pathname.match(/^\/api\/checklist\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && checklistGetMatch) {
    handleChecklistGet(
      req,
      res,
      decodeURIComponent(checklistGetMatch[1]),
      decodeURIComponent(checklistGetMatch[2]),
    );
    return;
  }

  // PUT /api/checklist/:runId/:phase
  if (method === "PUT" && checklistGetMatch) {
    handleChecklistPut(
      req,
      res,
      decodeURIComponent(checklistGetMatch[1]),
      decodeURIComponent(checklistGetMatch[2]),
    );
    return;
  }

  // GET /api/trace/:agentName/:roundNumber
  const traceMatch = pathname.match(/^\/api\/trace\/([^/]+)\/([0-9]+)$/);
  if (method === "GET" && traceMatch) {
    handleTrace(req, res, decodeURIComponent(traceMatch[1]), Number(traceMatch[2]));
    return;
  }

  // GET /api/decisions/pending
  if (method === "GET" && pathname === "/api/decisions/pending") {
    handlePendingDecisions(req, res);
    return;
  }

  // GET /api/command-center
  if (method === "GET" && pathname === "/api/command-center") {
    handleCommandCenter(req, res);
    return;
  }

  // Also serve /assets/ from dashboard dist (Vite output)
  if (pathname.startsWith("/assets/")) {
    serveStaticFile(res, path.join(DASHBOARD_DIST, pathname));
    return;
  }

  // ━━ React SPA catch-all for non-API routes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (method === "GET" && !pathname.startsWith("/api/")) {
    serveStaticFile(res, path.join(DASHBOARD_DIST, "index.html"));
    return;
  }

  // 404
  errorResponse(res, `Not found: ${method} ${pathname}`, 404);
}

// ── Create Server ────────────────────────────────────────────────────

export interface DashboardServerOptions {
  onError?: (err: NodeJS.ErrnoException) => void;
}

export function createDashboardServer(port: number, options: DashboardServerOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      console.error("Unhandled dashboard error:", err);
      if (!res.headersSent) {
        errorResponse(res, "Internal server error", 500);
      }
    }
  });

  server.listen(port, () => {
    console.log(`Formiga dashboard listening on http://localhost:${port}`);
    // Backfill AutoResearch sessions from recent workflow runs
    backfillAutoresearchSessions();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Is another daemon running?`);
    } else {
      console.error("Dashboard server error:", err);
    }

    if (options.onError) {
      options.onError(err);
      return;
    }

    process.exit(1);
  });

  return server;
}
