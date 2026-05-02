/**
 * Tamandua Dashboard HTTP Server
 *
 * Creates an HTTP server that serves the dashboard UI and API endpoints.
 *
 * Routes:
 *   GET /             -> index.html (dashboard UI)
 *   GET /api/runs     -> list all workflow runs
 *   GET /api/runs/:id -> detail for a specific run
 *   GET /api/events   -> recent events (global)
 *   GET /api/logs-tail -> logs-tail formatted event lines (cursor based)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { getMcpStatus } from "./daemonctl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");

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

// ── API Handlers ─────────────────────────────────────────────────────

function handleListRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();

    const runs = db.prepare(`
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
    `).all();

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

    jsonResponse(res, { run, steps, events });
  } catch (err) {
    errorResponse(res, `Failed to get run detail: ${(err as Error).message}`);
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

function handleMcpStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const status = getMcpStatus();
    jsonResponse(res, {
      running: status.running,
      port: status.port,
      path: status.endpoint,
    });
  } catch (err) {
    errorResponse(res, `Failed to get MCP status: ${(err as Error).message}`);
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
<head><meta charset="UTF-8"><title>Tamandua Dashboard</title></head>
<body><h1>Tamandua Dashboard</h1><p>Dashboard HTML not found. Rebuild tamandua or check dist/server/index.html.</p></body>
</html>`, 200);
    }
    return;
  }

  // GET /api/health
  if (method === "GET" && pathname === "/api/health") {
    handleHealth(req, res);
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

  // GET /api/mcp-status
  if (method === "GET" && pathname === "/api/mcp-status") {
    handleMcpStatus(req, res);
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
    console.log(`Tamandua dashboard listening on http://localhost:${port}`);
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
