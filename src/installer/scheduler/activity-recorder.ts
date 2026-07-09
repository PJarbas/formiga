// ══════════════════════════════════════════════════════════════════════
// activity-recorder.ts — Record agent tool calls to database in real-time
// ══════════════════════════════════════════════════════════════════════
//
// Extends the streaming metadata extraction to also record tool calls
// to the database for real-time activity visualization in the dashboard.
//
// Called during pi output streaming to capture:
//   - Tool calls (Read, Write, Bash, etc.)
//   - Thinking blocks
//   - Step events (claimed, completed, failed)
// ══════════════════════════════════════════════════════════════════════

import { logger } from "../../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ActivityContext {
  runId: string;
  stepId: string;
  agentId: string;
}

export interface ToolCallEvent {
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  result?: string;
  durationMs?: number;
}

// Track in-flight tool calls by ID
const inFlightToolCalls = new Map<string, { startTime: number; tool: string; args: Record<string, unknown> }>();

// ── Activity Recording ─────────────────────────────────────────────────

/**
 * Process a JSON line from pi output and record relevant events.
 * Called for each line during streaming.
 */
export async function processActivityLine(
  line: string,
  context: ActivityContext | null,
): Promise<void> {
  if (!context) return;
  if (!line.startsWith("{")) return;

  try {
    const event = JSON.parse(line);
    await handlePiEvent(event, context);
  } catch {
    // Not valid JSON or parsing error — skip silently
  }
}

async function handlePiEvent(
  event: Record<string, unknown>,
  context: ActivityContext,
): Promise<void> {
  const eventType = event.type as string | undefined;
  if (!eventType) return;

  // Tool call start
  if (eventType === "toolcall_start" || eventType === "tool_use") {
    await handleToolCallStart(event, context);
    return;
  }

  // Tool call result
  if (eventType === "toolcall_result" || eventType === "tool_result") {
    await handleToolCallResult(event, context);
    return;
  }

  // Thinking block
  if (eventType === "thinking" || (eventType === "message_update" && hasThinking(event))) {
    await handleThinking(event, context);
    return;
  }
}

function hasThinking(event: Record<string, unknown>): boolean {
  const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistantEvent) return false;
  const delta = assistantEvent.delta as Record<string, unknown> | undefined;
  if (!delta) return false;
  return delta.type === "thinking" || assistantEvent.type === "thinking";
}

async function handleToolCallStart(
  event: Record<string, unknown>,
  context: ActivityContext,
): Promise<void> {
  const toolCall = extractToolCall(event);
  if (!toolCall) return;

  // Track this tool call as in-flight
  inFlightToolCalls.set(toolCall.id, {
    startTime: Date.now(),
    tool: toolCall.name,
    args: toolCall.args,
  });

  // Record to database
  try {
    const { recordAgentEvent } = await import("../../server/routes/agent-activity.js");
    await recordAgentEvent({
      runId: context.runId,
      stepId: context.stepId,
      agentId: context.agentId,
      eventType: "tool_call",
      toolName: toolCall.name,
      toolArgs: toolCall.args,
      toolStatus: "running",
    });
  } catch (err) {
    logger.warn("Failed to record tool call start", {
      error: String(err),
      tool: toolCall.name,
    });
  }
}

async function handleToolCallResult(
  event: Record<string, unknown>,
  context: ActivityContext,
): Promise<void> {
  const toolCallId = (event.tool_call_id ?? event.id) as string | undefined;
  const isError = event.is_error === true || event.error === true;
  const result = extractResultPreview(event);

  // Find the matching in-flight call
  const inFlight = toolCallId ? inFlightToolCalls.get(toolCallId) : null;
  const durationMs = inFlight ? Date.now() - inFlight.startTime : undefined;

  if (toolCallId) {
    inFlightToolCalls.delete(toolCallId);
  }

  // Record to database
  try {
    const { recordAgentEvent } = await import("../../server/routes/agent-activity.js");
    await recordAgentEvent({
      runId: context.runId,
      stepId: context.stepId,
      agentId: context.agentId,
      eventType: "tool_call",
      toolName: inFlight?.tool,
      toolArgs: inFlight?.args,
      toolResult: result,
      toolStatus: isError ? "failed" : "completed",
      durationMs,
    });
  } catch (err) {
    logger.warn("Failed to record tool call result", { error: String(err) });
  }
}

async function handleThinking(
  event: Record<string, unknown>,
  context: ActivityContext,
): Promise<void> {
  const thinking = extractThinking(event);
  if (!thinking || thinking.length < 20) return; // Skip very short thinking

  // Record to database (throttled — only record substantial thinking)
  try {
    const { recordAgentEvent } = await import("../../server/routes/agent-activity.js");
    await recordAgentEvent({
      runId: context.runId,
      stepId: context.stepId,
      agentId: context.agentId,
      eventType: "thinking",
      thinking: thinking.slice(0, 500), // Truncate for storage
    });
  } catch (err) {
    logger.warn("Failed to record thinking", { error: String(err) });
  }
}

// ── Step Event Recording ───────────────────────────────────────────────

export async function recordStepEvent(
  context: ActivityContext,
  stepEvent: "claimed" | "completed" | "failed" | "retrying",
): Promise<void> {
  try {
    const { recordAgentEvent } = await import("../../server/routes/agent-activity.js");
    await recordAgentEvent({
      runId: context.runId,
      stepId: context.stepId,
      agentId: context.agentId,
      eventType: "step_event",
      stepEvent,
    });
  } catch (err) {
    logger.warn("Failed to record step event", {
      error: String(err),
      stepEvent,
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function extractToolCall(event: Record<string, unknown>): ToolCallInfo | null {
  // Handle various pi JSON formats

  // Format 1: toolcall_start with toolCall field
  const toolCall = event.toolCall as Record<string, unknown> | undefined;
  if (toolCall) {
    return {
      id: (toolCall.id as string) ?? "",
      name: (toolCall.name as string) ?? "unknown",
      args: parseArgs(toolCall.arguments as string | Record<string, unknown>),
    };
  }

  // Format 2: message_update with toolCall in content
  const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (assistantEvent?.type === "toolcall_delta") {
    const partial = assistantEvent.partial as Record<string, unknown> | undefined;
    if (partial?.content && Array.isArray(partial.content)) {
      for (const item of partial.content) {
        const contentItem = item as Record<string, unknown>;
        if (contentItem.type === "toolCall") {
          return {
            id: (contentItem.id as string) ?? "",
            name: (contentItem.name as string) ?? "unknown",
            args: parseArgs(contentItem.arguments as string | Record<string, unknown>),
          };
        }
      }
    }
  }

  // Format 3: Direct tool_use event
  if (event.type === "tool_use") {
    return {
      id: (event.id as string) ?? "",
      name: (event.name as string) ?? "unknown",
      args: parseArgs(event.input as string | Record<string, unknown>),
    };
  }

  return null;
}

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return args;
}

function extractResultPreview(event: Record<string, unknown>): string {
  const content = event.content as string | undefined;
  if (content) {
    return content.slice(0, 200);
  }

  const result = event.result as string | undefined;
  if (result) {
    return result.slice(0, 200);
  }

  return "";
}

function extractThinking(event: Record<string, unknown>): string | null {
  // Direct thinking event
  if (event.thinking) {
    return event.thinking as string;
  }

  // message_update with thinking in content
  const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (assistantEvent) {
    const partial = assistantEvent.partial as Record<string, unknown> | undefined;
    if (partial?.content && Array.isArray(partial.content)) {
      for (const item of partial.content) {
        const contentItem = item as Record<string, unknown>;
        if (contentItem.type === "thinking" && contentItem.thinking) {
          return contentItem.thinking as string;
        }
      }
    }
  }

  return null;
}

// ── Cleanup ────────────────────────────────────────────────────────────

export function clearInFlightToolCalls(): void {
  inFlightToolCalls.clear();
}
