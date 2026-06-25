/**
 * Formiga Dashboard HTTP Server
 *
 * Creates an HTTP server that serves the dashboard UI and API endpoints.
 *
 * Routes:
 *   GET /                        -> index.html (dashboard UI)
 *   GET /runs/:id/kanban         -> kanban.html (per-run swim-lane view)
 *   GET /api/autoresearch/runs   -> list workflow runs with AutoResearch state
 *   GET /api/runs                -> list all workflow runs
 *   GET /api/runs/:id            -> detail for a specific run
 *   GET /api/runs/:id/autoresearch -> AutoResearch progress for a run's harness cwd
 *   GET /api/runs/:id/kanban     -> lane-grouped snapshot for the kanban view
 *   GET /api/events              -> recent events (global)
 *   DELETE /api/runs/:id         -> permanently delete a run and all associated data
 *   GET /api/logs-tail           -> logs-tail formatted event lines (cursor based)
 *   GET /ml/*                     -> React ML dashboard SPA
 *   GET /api/pipeline/status      -> active ML pipeline status
 *   GET /api/agents               -> list 5 ML agents
 *   GET /api/agents/:name         -> agent detail
 *   GET /api/agents/:name/logs    -> paginated agent logs
 *   GET /api/leaderboard          -> top models sorted by cvMean
 *   GET /api/leaderboard/:id      -> single experiment detail
 *   GET /api/leaderboard/compare  -> compare experiments
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
import { getDb, getSystemTokenSpend, getAutoresearchSessions, getAutoresearchSessionById, upsertAutoresearchSession } from "../db.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { buildKanbanSnapshot, buildKanbanCardDetail } from "./kanban-data.js";
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
import { getExperimentStats } from "../leaderboard/queries.js";
import { AGENT_INFO_REGISTRY } from "../shared/dashboard-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");
const KANBAN_HTML = path.join(__dirname, "kanban.html");
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
  try {
    const db = getDb();

    const rawRuns = db.prepare(`
      SELECT
        r.id,
        r.workflow_id,
        r.task,
        r.status,
        r.context,
        r.created_at,
        r.updated_at,
        r.run_number,
        r.tokens_spent,
        COUNT(s.id) AS total_steps,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS completed_steps,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed_steps,
        SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running_steps,
        SUM(CASE WHEN s.status = 'waiting' THEN 1 ELSE 0 END) AS waiting_steps
      FROM runs r
      LEFT JOIN steps s ON s.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>;

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
  } catch (err) {
    errorResponse(res, `Failed to list runs: ${(err as Error).message}`);
  }
}

function handleRunDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const db = getDb();

    const run = db.prepare(`
      SELECT id, workflow_id, task, status, context, created_at, updated_at, run_number, tokens_spent
      FROM runs WHERE id = ?
    `).get(runId);

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const steps = db.prepare(`
      SELECT id, step_id, agent_id, step_index, status, output,
             retry_count, max_retries, type, created_at, updated_at
      FROM steps WHERE run_id = ?
      ORDER BY step_index ASC
    `).all(runId);

    const events = getRunEvents(runId);

    // Derive failure_reason from existing data (no new DB column)
    let failure_reason: string | null = null;
    const runStatus = (run as { status: string }).status;
    if (runStatus === "failed") {
      const failedStep = (steps as Array<{ status: string; output?: string | null }>).find(
        (s) => s.status === "failed",
      );
      failure_reason = failedStep?.output || "Run failed";
    } else if (runStatus === "canceled") {
      failure_reason = "Canceled";
    }

    // Enrich with worktree information
    let worktree: unknown = null;
    try {
      const ctx = JSON.parse((run as { context?: string }).context ?? "{}") as Record<string, string>;
      if (ctx.workspace_mode === "worktree") {
        worktree = db
          .prepare(
            "SELECT worktree_path, worktree_origin_repository, worktree_origin_ref, worktree_origin_sha, status AS wt_status, cleanup_policy FROM run_worktrees WHERE run_id = ?",
          )
          .get(runId) ?? null;
      }
    } catch {
      // context may be malformed
    }

    jsonResponse(res, { run, steps, events, worktree, failure_reason, prompt: (run as { task: string }).task });
  } catch (err) {
    errorResponse(res, `Failed to get run detail: ${(err as Error).message}`);
  }
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

    const db = getDb();
    const events = getRunEvents(runId);
    const detail = buildKanbanCardDetail(db, runId, cardId, events);

    if (!detail) {
      errorResponse(res, `Card not found: ${cardId} in run ${runId}`, 404);
      return;
    }

    jsonResponse(res, detail);
  } catch (err) {
    errorResponse(res, `Failed to build card detail: ${(err as Error).message}`);
  }
}

function handleRunKanban(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const snapshot = buildKanbanSnapshot(getDb(), runId);
    if (!snapshot) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }
    jsonResponse(res, snapshot);
  } catch (err) {
    errorResponse(res, `Failed to build kanban snapshot: ${(err as Error).message}`);
  }
}

function handleRunAutoresearch(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const db = getDb();
    const run = db.prepare(`
      SELECT id, workflow_id, task, status, context, created_at, updated_at
      FROM runs WHERE id = ?
    `).get(runId) as
      | { id: string; workflow_id: string; task: string; status: string; context?: string | null; created_at: string; updated_at: string }
      | undefined;

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
  } catch (err) {
    errorResponse(res, `Failed to get AutoResearch progress: ${(err as Error).message}`);
  }
}

function handleAutoresearchRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();

    const rawRuns = db.prepare(`
      SELECT
        r.id,
        r.workflow_id,
        r.task,
        r.status,
        r.context,
        r.created_at,
        r.updated_at,
        r.run_number,
        r.tokens_spent,
        COUNT(s.id) AS total_steps,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS completed_steps,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed_steps,
        SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running_steps,
        SUM(CASE WHEN s.status = 'waiting' THEN 1 ELSE 0 END) AS waiting_steps
      FROM runs r
      LEFT JOIN steps s ON s.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>;

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
  } catch (err) {
    errorResponse(res, `Failed to list AutoResearch runs: ${(err as Error).message}`);
  }
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
  try {
    const db = getDb();
    const systemTokensSpent = getSystemTokenSpend();

    let runTokensSpent = 0;
    try {
      const row = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get() as { total: number } | undefined;
      runTokensSpent = row?.total ?? 0;
    } catch {
      // runs table may not exist yet
      runTokensSpent = 0;
    }

    jsonResponse(res, {
      systemTokensSpent,
      totalTokensSpent: systemTokensSpent + runTokensSpent,
    });
  } catch (err) {
    errorResponse(res, `Failed to get stats: ${(err as Error).message}`);
  }
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();
    // Quick health check: can we query the DB?
    db.prepare("SELECT 1").get();
    jsonResponse(res, {
      status: "ok",
      uptime: process.uptime(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    errorResponse(res, `Health check failed: ${(err as Error).message}`, 503);
  }
}

// ── AutoResearch Session API Handlers ──────────────────────────────

function handleAutoresearchSessions(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const sessions = getAutoresearchSessions();
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
  } catch (err) {
    errorResponse(res, `Failed to list AutoResearch sessions: ${(err as Error).message}`);
  }
}

function handleAutoresearchSessionById(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
): void {
  try {
    const session = getAutoresearchSessionById(sessionId);
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
  } catch (err) {
    errorResponse(res, `Failed to get AutoResearch session: ${(err as Error).message}`);
  }
}

// ── Backfill ────────────────────────────────────────────────────────

export function backfillAutoresearchSessions(): void {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT context FROM runs
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as Array<{ context: string }>;

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
  } catch (err) {
    console.error(`[dashboard] backfill error: ${(err as Error).message}`);
  }
}

async function handlePauseRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();

    // Parse drain query parameter
    const url = new URL(req.url ?? "/", "http://localhost");
    const drain = url.searchParams.get("drain") === "true";

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

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
    const db = getDb();

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

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
    const db = getDb();

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

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
    const db = getDb();

    const run = db.prepare(
      "SELECT id, workflow_id, task, status, context, notify_url FROM runs WHERE id = ?",
    ).get(runId) as
      | { id: string; workflow_id: string; task: string; status: string; context: string; notify_url: string | null }
      | undefined;

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
      originalContext = JSON.parse(run.context) as Record<string, string>;
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

function findActivePipelineRunId(): string | null {
  try {
    const db = getDb();
    // Look for a run that has experiments and is still running/paused
    const row = db.prepare(`
      SELECT DISTINCT e.run_id
      FROM experiments e
      JOIN runs r ON r.id = e.run_id
      WHERE r.status IN ('running', 'paused')
      ORDER BY e.created_at DESC LIMIT 1
    `).get() as { run_id: string } | undefined;
    return row?.run_id ?? null;
  } catch {
    return null;
  }
}

function handlePipelineStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();
    const runId = findActivePipelineRunId();

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

    const run = db.prepare(
      "SELECT id, status, created_at, updated_at, tokens_spent FROM runs WHERE id = ?",
    ).get(runId) as { id: string; status: string; created_at: string; updated_at: string; tokens_spent: number } | undefined;

    const stats = getExperimentStats(db, runId);

    // Best cvMean from leaderboard
    const bestRow = db.prepare(
      "SELECT val_metric FROM experiments WHERE run_id = ? AND status IN ('SUCCESS','AUDITED') ORDER BY val_metric DESC LIMIT 1",
    ).get(runId) as { val_metric: number } | undefined;

    // Determine the max round number observed
    const maxRoundRow = db.prepare(
      "SELECT MAX(round_number) AS max_round FROM experiments WHERE run_id = ?",
    ).get(runId) as { max_round: number } | undefined;

    const currentRound = maxRoundRow?.max_round ?? 0;

    // Determine current phase based on the experiments we have
    const agentPhases = db.prepare(`
      SELECT DISTINCT agent_name FROM experiments WHERE run_id = ? AND round_number = ?
    `).all(runId, currentRound) as Array<{ agent_name: string }>;

    const agentNames = new Set(agentPhases.map((a) => a.agent_name));
    let currentPhase = "idle";
    if (agentNames.has("ml-critic")) currentPhase = "audit";
    else if (agentNames.has("modeler-classic") || agentNames.has("modeler-advanced")) currentPhase = "modeling";
    else if (agentNames.has("feature-engineer")) currentPhase = "feature_engineering";
    else if (agentNames.has("data-analyst")) currentPhase = "data_analysis";
    else if (agentNames.size > 0) currentPhase = "complete";

    // Agent statuses for this round
    function agentInRound(name: string): string {
      const row = db.prepare(
        "SELECT status FROM experiments WHERE run_id = ? AND round_number = ? AND agent_name = ? ORDER BY experiment_id DESC LIMIT 1",
      ).get(runId, currentRound, name) as { status: string } | undefined;
      if (!row) return "idle";
      const s = row.status;
      if (s === "SUCCESS" || s === "AUDITED") return "completed";
      if (s === "FAILED" || s === "OVERFITTED") return "failed";
      if (s === "PENDING") return "running";
      return "idle";
    }

    jsonResponse(res, {
      runId,
      status: run?.status ?? "idle",
      currentPhase,
      currentRound,
      maxRounds: 5,
      startedAt: run?.created_at ?? null,
      updatedAt: run?.updated_at ?? null,
      phaseStats: {
        dataAnalyst: agentInRound("data-analyst"),
        featureEngineer: agentInRound("feature-engineer"),
        modelerClassic: agentInRound("modeler-classic"),
        modelerAdvanced: agentInRound("modeler-advanced"),
        mlCritic: agentInRound("ml-critic"),
      },
      quickStats: {
        totalExperiments: stats.total,
        bestCvMean: bestRow?.val_metric ?? null,
        roundsCompleted: currentRound,
        tokensSpent: run?.tokens_spent ?? 0,
      },
    });
  } catch (err) {
    errorResponse(res, `Failed to get pipeline status: ${(err as Error).message}`);
  }
}

function handleAgents(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();
    const runId = findActivePipelineRunId();

    const agents = Object.entries(AGENT_INFO_REGISTRY).map(([name, info]) => {
      let currentStatus = "idle";
      if (runId) {
        const row = db.prepare(
          "SELECT status FROM experiments WHERE run_id = ? AND agent_name = ? ORDER BY experiment_id DESC LIMIT 1",
        ).get(runId, name) as { status: string } | undefined;
        if (row) {
          const s = row.status;
          if (s === "SUCCESS" || s === "AUDITED") currentStatus = "completed";
          else if (s === "FAILED" || s === "OVERFITTED") currentStatus = "failed";
          else if (s === "PENDING") currentStatus = "running";
        }
      }
      return { ...info, currentStatus };
    });

    jsonResponse(res, agents);
  } catch (err) {
    errorResponse(res, `Failed to list agents: ${(err as Error).message}`);
  }
}

function handleAgentDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): void {
  try {
    const info = AGENT_INFO_REGISTRY[agentName];
    if (!info) {
      errorResponse(res, `Agent not found: ${agentName}`, 404);
      return;
    }

    const db = getDb();
    const runId = findActivePipelineRunId();

    const rounds: Array<{ roundNumber: number; status: string; cvMean: number | null; modelType: string | null }> = [];
    let totalTrials = 0;
    let lastError: string | null = null;

    if (runId) {
      const rows = db.prepare(`
        SELECT round_number, status, val_metric, model_type, error_message
        FROM experiments WHERE run_id = ? AND agent_name = ?
        ORDER BY round_number ASC
      `).all(runId, agentName) as Array<{
        round_number: number; status: string; val_metric: number;
        model_type: string; error_message: string | null;
      }>;

      totalTrials = rows.length;

      for (const row of rows) {
        rounds.push({
          roundNumber: row.round_number,
          status: row.status,
          cvMean: row.val_metric,
          modelType: row.model_type,
        });
      }

      const errRow = db.prepare(
        "SELECT error_message FROM experiments WHERE run_id = ? AND agent_name = ? AND error_message IS NOT NULL ORDER BY experiment_id DESC LIMIT 1",
      ).get(runId, agentName) as { error_message: string } | undefined;
      lastError = errRow?.error_message ?? null;
    }

    // Determine current status
    let currentStatus = "idle";
    if (rounds.length > 0) {
      const last = rounds[rounds.length - 1];
      if (last.status === "SUCCESS" || last.status === "AUDITED") currentStatus = "completed";
      else if (last.status === "FAILED" || last.status === "OVERFITTED") currentStatus = "failed";
      else if (last.status === "PENDING") currentStatus = "running";
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
  } catch (err) {
    errorResponse(res, `Failed to get agent detail: ${(err as Error).message}`);
  }
}

function handleAgentLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): void {
  try {
    const info = AGENT_INFO_REGISTRY[agentName];
    if (!info) {
      errorResponse(res, `Agent not found: ${agentName}`, 404);
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

    const db = getDb();
    const runId = findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, { agentName, entries: [], total: 0, offset, limit });
      return;
    }

    // Read experiments for this agent as log entries
    const countRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM experiments WHERE run_id = ? AND agent_name = ?",
    ).get(runId, agentName) as { cnt: number };

    const rows = db.prepare(`
      SELECT experiment_id, round_number, status, val_metric, error_message, created_at
      FROM experiments WHERE run_id = ? AND agent_name = ?
      ORDER BY experiment_id DESC LIMIT ? OFFSET ?
    `).all(runId, agentName, limit, offset) as Array<{
      experiment_id: number; round_number: number; status: string;
      val_metric: number; error_message: string | null; created_at: string;
    }>;

    const entries = rows.flatMap((row) => {
      const logs: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }> = [];
      const ts = row.created_at;
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
      total: countRow.cnt,
      offset,
      limit,
    });
  } catch (err) {
    errorResponse(res, `Failed to get agent logs: ${(err as Error).message}`);
  }
}

function handleLeaderboard(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentName = url.searchParams.get("agentName")?.trim();
    const roundStr = url.searchParams.get("roundNumber");
    const statusFilter = url.searchParams.get("status")?.trim();
    const sortBy = url.searchParams.get("sortBy") ?? "cvMean";
    const sortDir = url.searchParams.get("sortDir") ?? "desc";

    const db = getDb();
    const runId = findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, { entries: [], total: 0, bestCvMean: null, filters: {} });
      return;
    }

    let where = "WHERE run_id = ?";
    const params: (string | number)[] = [runId];

    if (agentName) {
      where += " AND agent_name = ?";
      params.push(agentName);
    }
    if (roundStr) {
      where += " AND round_number = ?";
      params.push(Number(roundStr));
    }
    if (statusFilter) {
      where += " AND status = ?";
      params.push(statusFilter);
    }

    // Map sortBy field
    const sortCol = sortBy === "trainMean" ? "train_metric" :
                    sortBy === "trainValGap" ? "(train_metric - val_metric)" :
                    sortBy === "roundNumber" ? "round_number" :
                    "val_metric";
    const dir = sortDir === "asc" ? "ASC" : "DESC";

    const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM experiments ${where}`).get(...params) as { cnt: number };

    const rows = db.prepare(`
      SELECT * FROM experiments ${where} ORDER BY ${sortCol} ${dir} LIMIT 100
    `).all(...params) as Array<Record<string, unknown>>;

    const bestRow = db.prepare(
      "SELECT val_metric FROM experiments WHERE run_id = ? AND status IN ('SUCCESS','AUDITED') ORDER BY val_metric DESC LIMIT 1",
    ).get(runId) as { val_metric: number } | undefined;

    const entries = rows.map((r) => ({
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
    }));

    jsonResponse(res, {
      entries,
      total: countRow.cnt,
      bestCvMean: bestRow?.val_metric ?? null,
      filters: { agentName: agentName || undefined, roundNumber: roundStr ? Number(roundStr) : undefined, status: statusFilter || undefined },
    });
  } catch (err) {
    errorResponse(res, `Failed to get leaderboard: ${(err as Error).message}`);
  }
}

function safeParseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function handleLeaderboardEntry(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): void {
  try {
    const db = getDb();
    const experimentId = Number(id);
    if (!Number.isFinite(experimentId)) {
      errorResponse(res, `Invalid experiment id: ${id}`, 400);
      return;
    }

    const row = db.prepare("SELECT * FROM experiments WHERE experiment_id = ?").get(experimentId) as Record<string, unknown> | undefined;
    if (!row) {
      errorResponse(res, `Experiment not found: ${id}`, 404);
      return;
    }

    jsonResponse(res, {
      id: String(row.experiment_id),
      runId: row.run_id,
      roundNumber: Number(row.round_number),
      agentName: row.agent_name,
      modelId: `model_${row.experiment_id}`,
      modelType: row.model_type,
      status: row.status,
      cvMean: Number(row.val_metric),
      cvStd: 0,
      trainMean: Number(row.train_metric),
      trainValGap: Number(row.train_metric) - Number(row.val_metric),
      hyperparameters: safeParseJson(row.hyperparameters as string),
      featureImportancesTop10: null,
      trainTimeSeconds: null,
      inferenceTimeMsPer1k: null,
      createdAt: row.created_at,
    });
  } catch (err) {
    errorResponse(res, `Failed to get leaderboard entry: ${(err as Error).message}`);
  }
}

function handleLeaderboardCompare(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ids = url.searchParams.getAll("id");

    if (ids.length < 2) {
      errorResponse(res, "At least 2 experiment IDs required", 400);
      return;
    }

    const db = getDb();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT * FROM experiments WHERE experiment_id IN (${placeholders})`,
    ).all(...ids.map(Number)) as Array<Record<string, unknown>>;

    const entries = rows.map((r) => ({
      id: String(r.experiment_id),
      modelType: r.model_type as string,
      agentName: r.agent_name as string,
      cvMean: Number(r.val_metric),
      trainMean: Number(r.train_metric),
      trainValGap: Number(r.train_metric) - Number(r.val_metric),
      roundNumber: Number(r.round_number),
      status: r.status as string,
    }));

    jsonResponse(res, { entries });
  } catch (err) {
    errorResponse(res, `Failed to compare leaderboard entries: ${(err as Error).message}`);
  }
}

function handleRounds(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const runId = url.searchParams.get("runId")?.trim() ?? findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, []);
      return;
    }

    const db = getDb();
    const roundRows = db.prepare(`
      SELECT DISTINCT round_number, MIN(created_at) AS started_at, MAX(created_at) AS completed_at
      FROM experiments WHERE run_id = ?
      GROUP BY round_number ORDER BY round_number ASC
    `).all(runId) as Array<{ round_number: number; started_at: string; completed_at: string }>;

    const rounds = roundRows.map((r) => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status IN ('SUCCESS','AUDITED') THEN 1 ELSE 0 END) AS registered,
          SUM(CASE WHEN status IN ('FAILED','OVERFITTED') THEN 1 ELSE 0 END) AS rejected
        FROM experiments WHERE run_id = ? AND round_number = ?
      `).get(runId, r.round_number) as { total: number; registered: number; rejected: number };

      return {
        runId,
        roundNumber: r.round_number,
        status: stats.total > 0 ? "completed" : "pending",
        experimentsRegistered: stats.registered,
        experimentsRejected: stats.rejected,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      };
    });

    jsonResponse(res, rounds);
  } catch (err) {
    errorResponse(res, `Failed to list rounds: ${(err as Error).message}`);
  }
}

function handleCrossFindings(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const runId = url.searchParams.get("runId")?.trim() ?? findActivePipelineRunId();

    if (!runId) {
      jsonResponse(res, []);
      return;
    }

    const db = getDb();
    // Cross-findings are experiments where both modelers ran and produced results
    const rows = db.prepare(`
      SELECT e.experiment_id, e.round_number, e.agent_name, e.model_type, e.val_metric, e.created_at
      FROM experiments e
      WHERE e.run_id = ? AND e.agent_name IN ('modeler-classic', 'modeler-advanced')
        AND e.status IN ('SUCCESS','AUDITED')
      ORDER BY e.round_number ASC, e.agent_name ASC
    `).all(runId) as Array<{
      experiment_id: number; round_number: number; agent_name: string;
      model_type: string; val_metric: number; created_at: string;
    }>;

    // Group by round to find cross-findings
    const byRound = new Map<number, Array<typeof rows[number]>>();
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
          const diff = Math.abs(Number(classic.val_metric) - Number(advanced.val_metric));
          findings.push({
            id: `cross_${round}`,
            runId,
            roundNumber: round,
            fromAgent: "modeler-classic",
            toAgent: "modeler-advanced",
            content: `Round ${round}: Classic (${classic.model_type}) cvMean=${Number(classic.val_metric).toFixed(4)} vs Advanced (${advanced.model_type}) cvMean=${Number(advanced.val_metric).toFixed(4)} (diff=${diff.toFixed(4)})`,
            createdAt: advanced.created_at,
          });
        }
      }
    }

    jsonResponse(res, findings);
  } catch (err) {
    errorResponse(res, `Failed to get cross-findings: ${(err as Error).message}`);
  }
}

async function handlePipelinePause(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const runId = findActivePipelineRunId();
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
    const runId = findActivePipelineRunId();
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
    const runId = findActivePipelineRunId();
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Parse URL path (strip query string)
  const pathname = url.split("?")[0];

  // GET /
  if (method === "GET" && pathname === "/") {
    try {
      const html = fs.readFileSync(INDEX_HTML, "utf-8");
      htmlResponse(res, html);
    } catch {
      htmlResponse(res, `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Formiga Dashboard</title></head>
<body><h1>Formiga Dashboard</h1><p>Dashboard HTML not found. Rebuild formiga or check dist/server/index.html.</p></body>
</html>`, 200);
    }
    return;
  }

  // GET /runs/:id/kanban
  const kanbanHtmlMatch = pathname.match(/^\/runs\/([a-zA-Z0-9_-]+)\/kanban$/);
  if (method === "GET" && kanbanHtmlMatch) {
    try {
      const html = fs.readFileSync(KANBAN_HTML, "utf-8");
      htmlResponse(res, html);
    } catch {
      htmlResponse(res, `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Formiga Kanban</title></head>
<body><h1>Formiga Kanban</h1><p>Kanban HTML not found. Rebuild formiga or check dist/server/kanban.html.</p></body>
</html>`, 200);
    }
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

  // ── React SPA: /ml and /ml/* ────────────────────────────────────
  if (pathname === "/ml" || pathname.startsWith("/ml/")) {
    const spaPath = pathname === "/ml"
      ? path.join(DASHBOARD_DIST, "index.html")
      : path.join(DASHBOARD_DIST, pathname.slice(4)); // remove "/ml/" prefix
    serveStaticFile(res, spaPath);
    return;
  }

  // Also serve /assets/ from dashboard dist (Vite output)
  if (pathname.startsWith("/assets/")) {
    serveStaticFile(res, path.join(DASHBOARD_DIST, pathname));
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
