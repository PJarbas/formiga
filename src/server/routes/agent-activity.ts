// ══════════════════════════════════════════════════════════════════════
// agent-activity.ts — API routes for agent events and artifacts
// ══════════════════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from "node:http";
import { getPrisma } from "../../db.js";
import { logger } from "../../lib/logger.js";
import type {
  AgentEventRow,
  AgentEventsResponse,
  AgentArtifactRow,
  AgentArtifactsResponse,
} from "../../shared/dashboard-types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const maxSize = 500 * 1024; // 500KB limit

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.destroy();
        reject(new Error("Request body too large (max 500KB)"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}

// ── Event Recording ─────────────────────────────────────────────────────

export interface RecordEventInput {
  runId: string;
  stepId: string;
  agentId: string;
  eventType: "tool_call" | "thinking" | "step_event" | "artifact" | "error";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolStatus?: "running" | "completed" | "failed";
  durationMs?: number;
  thinking?: string;
  stepEvent?: "claimed" | "completed" | "failed" | "retrying";
}

export async function recordAgentEvent(input: RecordEventInput): Promise<number> {
  const prisma = getPrisma();
  const event = await prisma.agentEvent.create({
    data: {
      run_id: input.runId,
      step_id: input.stepId,
      agent_id: input.agentId,
      event_type: input.eventType,
      tool_name: input.toolName,
      tool_args: input.toolArgs ? JSON.stringify(input.toolArgs) : null,
      tool_result: input.toolResult,
      tool_status: input.toolStatus,
      duration_ms: input.durationMs,
      thinking: input.thinking,
      step_event: input.stepEvent,
    },
  });
  return event.id;
}

// ── Artifact Recording ──────────────────────────────────────────────────

export interface RecordArtifactInput {
  runId: string;
  stepId: string;
  agentId: string;
  artifactKey: string;
  artifactPath?: string;
  content: Record<string, unknown>;
  contentType?: string;
  sizeBytes?: number;
  checksum?: string;
}

export async function recordAgentArtifact(input: RecordArtifactInput): Promise<number> {
  const prisma = getPrisma();
  const now = new Date();

  // Upsert: update if exists, create if not
  const existing = await prisma.agentArtifact.findUnique({
    where: {
      run_id_artifact_key: {
        run_id: input.runId,
        artifact_key: input.artifactKey,
      },
    },
  });

  if (existing) {
    const updated = await prisma.agentArtifact.update({
      where: { id: existing.id },
      data: {
        content: JSON.stringify(input.content),
        content_type: input.contentType ?? "json",
        artifact_path: input.artifactPath,
        size_bytes: input.sizeBytes,
        checksum: input.checksum,
        updated_at: now,
      },
    });
    return updated.id;
  }

  const created = await prisma.agentArtifact.create({
    data: {
      run_id: input.runId,
      step_id: input.stepId,
      agent_id: input.agentId,
      artifact_key: input.artifactKey,
      artifact_path: input.artifactPath,
      content: JSON.stringify(input.content),
      content_type: input.contentType ?? "json",
      size_bytes: input.sizeBytes,
      checksum: input.checksum,
    },
  });
  return created.id;
}

// ── Route Handlers ──────────────────────────────────────────────────────

/**
 * GET /api/runs/:runId/events
 * Query params:
 *   - since: ISO timestamp, return events after this time
 *   - stepId: filter by step
 *   - limit: max events (default 100)
 */
export async function handleGetEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const query = parseQuery(req.url ?? "");
    const since = query.since ? new Date(query.since) : undefined;
    const stepId = query.stepId;
    const limit = Math.min(parseInt(query.limit ?? "100", 10), 500);

    const prisma = getPrisma();

    const where: Record<string, unknown> = { run_id: runId };
    if (since) where.created_at = { gt: since };
    if (stepId) where.step_id = stepId;

    const events = await prisma.agentEvent.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const rows: AgentEventRow[] = events.slice(0, limit).map((e) => ({
      id: e.id,
      runId: e.run_id,
      stepId: e.step_id,
      agentId: e.agent_id,
      eventType: e.event_type as AgentEventRow["eventType"],
      toolName: e.tool_name ?? undefined,
      toolArgs: e.tool_args ? JSON.parse(e.tool_args) : undefined,
      toolResult: e.tool_result ?? undefined,
      toolStatus: e.tool_status as AgentEventRow["toolStatus"],
      durationMs: e.duration_ms ?? undefined,
      thinking: e.thinking ?? undefined,
      stepEvent: e.step_event as AgentEventRow["stepEvent"],
      createdAt: (e.created_at ?? new Date()).toISOString(),
    }));

    const response: AgentEventsResponse = {
      events: rows,
      total: rows.length,
      hasMore,
    };

    sendJson(res, response);
  } catch (err) {
    logger.error("Failed to get agent events", { runId, error: String(err) });
    sendError(res, "Failed to get events", 500);
  }
}

/**
 * GET /api/runs/:runId/artifacts
 * Query params:
 *   - key: filter by artifact key
 */
export async function handleGetArtifacts(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const query = parseQuery(req.url ?? "");
    const key = query.key;

    const prisma = getPrisma();

    const where: Record<string, unknown> = { run_id: runId };
    if (key) where.artifact_key = key;

    const artifacts = await prisma.agentArtifact.findMany({
      where,
      orderBy: { created_at: "desc" },
    });

    const rows: AgentArtifactRow[] = artifacts.map((a) => ({
      id: a.id,
      runId: a.run_id,
      stepId: a.step_id,
      agentId: a.agent_id,
      artifactKey: a.artifact_key,
      artifactPath: a.artifact_path ?? undefined,
      content: JSON.parse(a.content),
      contentType: a.content_type ?? "json",
      sizeBytes: a.size_bytes ?? undefined,
      checksum: a.checksum ?? undefined,
      createdAt: (a.created_at ?? new Date()).toISOString(),
      updatedAt: (a.updated_at ?? new Date()).toISOString(),
    }));

    const response: AgentArtifactsResponse = { artifacts: rows };
    sendJson(res, response);
  } catch (err) {
    logger.error("Failed to get agent artifacts", { runId, error: String(err) });
    sendError(res, "Failed to get artifacts", 500);
  }
}

/**
 * GET /api/runs/:runId/artifacts/:key
 */
export async function handleGetArtifactByKey(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  key: string,
): Promise<void> {
  try {
    const prisma = getPrisma();

    const artifact = await prisma.agentArtifact.findUnique({
      where: {
        run_id_artifact_key: {
          run_id: runId,
          artifact_key: key,
        },
      },
    });

    if (!artifact) {
      sendError(res, `Artifact not found: ${key}`, 404);
      return;
    }

    const row: AgentArtifactRow = {
      id: artifact.id,
      runId: artifact.run_id,
      stepId: artifact.step_id,
      agentId: artifact.agent_id,
      artifactKey: artifact.artifact_key,
      artifactPath: artifact.artifact_path ?? undefined,
      content: JSON.parse(artifact.content),
      contentType: artifact.content_type ?? "json",
      sizeBytes: artifact.size_bytes ?? undefined,
      checksum: artifact.checksum ?? undefined,
      createdAt: (artifact.created_at ?? new Date()).toISOString(),
      updatedAt: (artifact.updated_at ?? new Date()).toISOString(),
    };

    sendJson(res, row);
  } catch (err) {
    logger.error("Failed to get artifact", { runId, key, error: String(err) });
    sendError(res, "Failed to get artifact", 500);
  }
}

/**
 * POST /api/runs/:runId/agent-artifacts/:key
 * Save or update an agent artifact (used by agents via curl)
 */
export async function handleSaveArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  artifactKey: string,
): Promise<void> {
  try {
    // Validate artifact key format (security: prevent injection)
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(artifactKey)) {
      sendError(res, "Invalid artifact key format. Use lowercase letters, numbers, underscores. Start with letter, 2-31 chars.", 400);
      return;
    }

    const body = await parseBody(req);
    if (!body) {
      sendError(res, "Request body is required", 400);
      return;
    }

    let parsed: { stepId?: string; agentId?: string; content?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, "Invalid JSON body", 400);
      return;
    }

    const { stepId, agentId, content } = parsed;

    // Validate content is an object
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      sendError(res, "Content must be a JSON object", 400);
      return;
    }

    // Size check (already handled by parseBody, but double-check stringified)
    const contentStr = JSON.stringify(content);
    if (contentStr.length > 500 * 1024) {
      sendError(res, "Content too large (max 500KB)", 400);
      return;
    }

    const id = await recordAgentArtifact({
      runId,
      stepId: stepId || "unknown",
      agentId: agentId || "unknown",
      artifactKey,
      content: content as Record<string, unknown>,
      contentType: "json",
      sizeBytes: contentStr.length,
    });

    logger.info("Agent artifact saved", { runId, artifactKey, agentId, sizeBytes: contentStr.length });

    sendJson(res, { id, artifactKey, created: true }, 201);
  } catch (err) {
    logger.error("Failed to save artifact", { runId, artifactKey, error: String(err) });
    sendError(res, "Failed to save artifact", 500);
  }
}

/**
 * GET /api/runs/:runId/steps/:stepId/events (SSE stream)
 * Server-Sent Events for real-time activity
 */
export async function handleEventStream(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  stepId: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  let lastEventId = 0;
  let isRunning = true;

  const sendEvent = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const poll = async () => {
    if (!isRunning) return;

    try {
      const prisma = getPrisma();

      // Check if step is still running
      const step = await prisma.step.findFirst({
        where: { run_id: runId, step_id: stepId },
        select: { status: true },
      });

      if (!step || !["running", "pending"].includes(step.status)) {
        sendEvent({ type: "stream_end", status: step?.status ?? "unknown" });
        res.end();
        isRunning = false;
        return;
      }

      // Get new events since last poll
      const events = await prisma.agentEvent.findMany({
        where: {
          run_id: runId,
          step_id: stepId,
          id: { gt: lastEventId },
        },
        orderBy: { id: "asc" },
        take: 50,
      });

      for (const e of events) {
        lastEventId = e.id;
        sendEvent({
          type: "event",
          event: {
            id: e.id,
            eventType: e.event_type,
            toolName: e.tool_name,
            toolArgs: e.tool_args ? JSON.parse(e.tool_args) : undefined,
            toolResult: e.tool_result,
            toolStatus: e.tool_status,
            durationMs: e.duration_ms,
            thinking: e.thinking,
            stepEvent: e.step_event,
            createdAt: (e.created_at ?? new Date()).toISOString(),
          },
        });
      }

      // Poll again in 1 second
      setTimeout(poll, 1000);
    } catch (err) {
      logger.error("SSE poll error", { runId, stepId, error: String(err) });
      sendEvent({ type: "error", message: String(err) });
      res.end();
      isRunning = false;
    }
  };

  // Start polling
  poll();

  // Handle client disconnect
  res.on("close", () => {
    isRunning = false;
  });
}
