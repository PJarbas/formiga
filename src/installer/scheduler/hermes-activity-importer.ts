// ══════════════════════════════════════════════════════════════════════
// hermes-activity-importer.ts — Import Hermes session events to Formiga
// ══════════════════════════════════════════════════════════════════════
//
// After Hermes completes, reads the session from ~/.hermes/state.db
// and imports tool calls, reasoning, and results into the Formiga
// agent_events table for dashboard visualization.
//
// Unlike Pi (real-time JSON streaming), Hermes events are imported
// post-execution from its SQLite database.
// ══════════════════════════════════════════════════════════════════════

import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { logger } from "../../lib/logger.js";
import type { ActivityContext } from "./activity-recorder.js";

// ── Hermes Types ──────────────────────────────────────────────────────

interface HermesToolCall {
  id: string;
  call_id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface HermesMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null; // JSON array of HermesToolCall
  tool_name: string | null;
  timestamp: number;
  reasoning: string | null;
  reasoning_content: string | null;
}

interface HermesSession {
  id: string;
  source: string;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
}

// ── Import Logic ──────────────────────────────────────────────────────

/**
 * Import a Hermes session's events into Formiga's agent_events table.
 * Called after runHermes completes successfully.
 */
export async function importHermesSession(
  sessionId: string,
  context: ActivityContext,
): Promise<{ imported: number; errors: number }> {
  const hermesDbPath = path.join(os.homedir(), ".hermes", "state.db");

  let db: Database.Database;
  try {
    db = new Database(hermesDbPath, { readonly: true });
  } catch (err) {
    logger.warn("Failed to open Hermes state.db", {
      path: hermesDbPath,
      error: String(err),
    });
    return { imported: 0, errors: 1 };
  }

  try {
    // Verify session exists
    const session = db.prepare<[string], HermesSession>(`
      SELECT id, source, tool_call_count, input_tokens, output_tokens
      FROM sessions WHERE id = ?
    `).get(sessionId);

    if (!session) {
      logger.warn("Hermes session not found", { sessionId });
      return { imported: 0, errors: 1 };
    }

    // Get all messages for this session
    const messages = db.prepare<[string], HermesMessage>(`
      SELECT id, session_id, role, content, tool_call_id, tool_calls,
             tool_name, timestamp, reasoning, reasoning_content
      FROM messages
      WHERE session_id = ? AND active = 1
      ORDER BY timestamp ASC
    `).all(sessionId);

    logger.info("Importing Hermes session", {
      sessionId,
      messageCount: messages.length,
      toolCallCount: session.tool_call_count,
      runId: context.runId,
      stepId: context.stepId,
    });

    // Import events
    const { recordAgentEvent } = await import("../../server/routes/agent-activity.js");

    let imported = 0;
    let errors = 0;

    // Track in-flight tool calls to match with results
    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown>; startTime: number }>();

    for (const msg of messages) {
      try {
        // Assistant message with tool calls
        if (msg.role === "assistant" && msg.tool_calls) {
          const toolCalls = JSON.parse(msg.tool_calls) as HermesToolCall[];

          for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = { raw: tc.function.arguments };
            }

            // Track this tool call
            pendingToolCalls.set(tc.id, {
              name: tc.function.name,
              args,
              startTime: msg.timestamp,
            });

            // Record tool call start
            await recordAgentEvent({
              runId: context.runId,
              stepId: context.stepId,
              agentId: context.agentId,
              eventType: "tool_call",
              toolName: tc.function.name,
              toolArgs: args,
              toolStatus: "running",
            });
            imported++;
          }

          // Record reasoning if present
          const reasoning = msg.reasoning || msg.reasoning_content;
          if (reasoning && reasoning.length >= 20) {
            await recordAgentEvent({
              runId: context.runId,
              stepId: context.stepId,
              agentId: context.agentId,
              eventType: "thinking",
              thinking: reasoning.slice(0, 500),
            });
            imported++;
          }
        }

        // Tool result message
        if (msg.role === "tool" && msg.tool_call_id) {
          const pending = pendingToolCalls.get(msg.tool_call_id);
          const durationMs = pending ? Math.round((msg.timestamp - pending.startTime) * 1000) : undefined;

          // Parse result to check for errors
          let isError = false;
          let resultPreview = "";
          if (msg.content) {
            try {
              const parsed = JSON.parse(msg.content);
              isError = parsed.error !== undefined && parsed.error !== null;
              resultPreview = msg.content.slice(0, 200);
            } catch {
              resultPreview = msg.content.slice(0, 200);
            }
          }

          await recordAgentEvent({
            runId: context.runId,
            stepId: context.stepId,
            agentId: context.agentId,
            eventType: "tool_call",
            toolName: pending?.name ?? msg.tool_name ?? "unknown",
            toolArgs: pending?.args,
            toolResult: resultPreview,
            toolStatus: isError ? "failed" : "completed",
            durationMs,
          });
          imported++;

          // Remove from pending
          pendingToolCalls.delete(msg.tool_call_id);
        }
      } catch (err) {
        logger.warn("Failed to import Hermes message", {
          messageId: msg.id,
          role: msg.role,
          error: String(err),
        });
        errors++;
      }
    }

    logger.info("Hermes session import complete", {
      sessionId,
      imported,
      errors,
      runId: context.runId,
    });

    return { imported, errors };
  } finally {
    db.close();
  }
}

/**
 * Extract session ID from Hermes stdout.
 * Hermes appends "session_id: <id>" at the end of output.
 */
export function extractHermesSessionId(stdout: string): string | null {
  const match = stdout.match(/^session_id:\s*(\S+)/m);
  return match?.[1] ?? null;
}
