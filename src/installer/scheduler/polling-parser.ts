// ══════════════════════════════════════════════════════════════════════
// polling-parser.ts — Pure parsers for harness polling-round output
// ══════════════════════════════════════════════════════════════════════
//
// Splits a polling round's raw stdout into structured signals:
//   - `classifyPollingRoundOutcome` reduces the output to one of:
//       heartbeat | work_done | work_failed | empty_output | other_output
//   - `summarizePollingRoundOutput` adds a bounded preview + line count.
//   - `parsePollingRoundMetadata` extracts assistantOutput, tokenUsage,
//      runId, stepId from pi's JSON-mode `message_end` events (and
//      falls back to regex-scraping when JSON metadata is absent).
//   - `extractTokenUsage` normalizes the usage object shape.
//
// All functions are pure: no DB, no fs, no logger calls — safe to unit-test.
// ══════════════════════════════════════════════════════════════════════

import { buildBoundedPreview, type BoundedPreviewMetadata } from "./shared.js";

const MAX_POLLING_OUTPUT_PREVIEW = 240;

export type PollingRoundOutcome =
  | "heartbeat"
  | "work_done"
  | "work_failed"
  | "empty_output"
  | "other_output";

export interface PollingRoundOutputSummary extends BoundedPreviewMetadata {
  outcome: PollingRoundOutcome;
  lines: number;
}

/** @internal exported for regression tests */
export function classifyPollingRoundOutcome(output: string): PollingRoundOutcome {
  if (output.length === 0) return "empty_output";
  if (/\bHEARTBEAT_OK\b/.test(output)) return "heartbeat";
  if (/STATUS:\s*(fail|failed|error)/i.test(output)) return "work_failed";
  if (/STATUS:\s*done/i.test(output)) return "work_done";
  return "other_output";
}

export function summarizePollingRoundOutput(output: string): PollingRoundOutputSummary {
  const normalized = output.trim();
  const bounded = buildBoundedPreview(normalized, MAX_POLLING_OUTPUT_PREVIEW);

  return {
    ...bounded,
    outcome: classifyPollingRoundOutcome(normalized),
    lines: normalized ? normalized.split(/\r?\n/).length : 0,
  };
}

const UUID_CAPTURE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const RUN_ID_FIELD_REGEX = new RegExp(`["']?run(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");
const STEP_ID_FIELD_REGEX = new RegExp(`["']?step(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");

export interface PollingRoundMetadata {
  assistantOutput: string;
  tokenUsage: number | null;
  runId: string | null;
  stepId: string | null;
  jsonMetadataDetected: boolean;
}

interface PollingIdentifierHints {
  runId: string | null;
  stepId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTokenUsage(value: number): number {
  return Math.max(0, Math.round(value));
}

function firstNumeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseNumeric(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractTokenUsage(usageLike: unknown): number | null {
  const usage = asRecord(usageLike);
  if (!usage) return null;

  const directTotal = firstNumeric(usage, ["totalTokens", "total_tokens", "total"]);
  if (directTotal !== null) return normalizeTokenUsage(directTotal);

  const parts: Array<number | null> = [
    firstNumeric(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
    firstNumeric(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
    firstNumeric(usage, ["cacheRead", "cache_read", "cache_read_tokens"]),
    firstNumeric(usage, ["cacheWrite", "cache_write", "cache_write_tokens"]),
  ];

  if (!parts.some((value) => value !== null)) return null;

  const total = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return normalizeTokenUsage(total);
}

function collectTextFragments(value: unknown, sink: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.trim().length > 0) sink.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, sink, depth + 1);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const nested of Object.values(record)) {
    collectTextFragments(nested, sink, depth + 1);
  }
}

function extractAssistantText(messageLike: unknown): string {
  const message = asRecord(messageLike);
  if (!message) return "";

  const content = message.content;
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const textSegments: string[] = [];
  for (const item of content) {
    const contentRecord = asRecord(item);
    if (!contentRecord) continue;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      textSegments.push(contentRecord.text);
    }
  }

  return textSegments.join("\n");
}

function extractIdentifierHints(text: string): PollingIdentifierHints {
  const runMatch = text.match(RUN_ID_FIELD_REGEX);
  const stepMatch = text.match(STEP_ID_FIELD_REGEX);

  return {
    runId: runMatch?.[1] ?? null,
    stepId: stepMatch?.[1] ?? null,
  };
}

export function parsePollingRoundMetadata(output: string): PollingRoundMetadata {
  const normalized = output.trim();
  if (normalized.length === 0) {
    return {
      assistantOutput: "",
      tokenUsage: null,
      runId: null,
      stepId: null,
      jsonMetadataDetected: false,
    };
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (record) events.push(record);
    } catch {
      // best-effort parsing; ignore malformed/non-JSON lines
    }
  }

  if (events.length === 0) {
    const hints = extractIdentifierHints(normalized);
    return {
      assistantOutput: normalized,
      tokenUsage: null,
      runId: hints.runId,
      stepId: hints.stepId,
      jsonMetadataDetected: false,
    };
  }

  let assistantOutput = "";
  let tokenUsage: number | null = null;
  const toolTextFragments: string[] = [];

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role === "assistant") {
        const assistantText = extractAssistantText(message).trim();
        if (assistantText.length > 0) assistantOutput = assistantText;

        const extractedUsage = extractTokenUsage(message.usage);
        if (extractedUsage !== null) tokenUsage = extractedUsage;
      }
    }

    if (type.startsWith("tool_execution")) {
      collectTextFragments(event, toolTextFragments);
    }
  }

  if (!assistantOutput) {
    assistantOutput = normalized;
  }

  const hintsFromToolData = extractIdentifierHints(toolTextFragments.join("\n"));
  const fallbackHints = extractIdentifierHints(`${assistantOutput}\n${normalized}`);

  return {
    assistantOutput,
    tokenUsage,
    runId: hintsFromToolData.runId ?? fallbackHints.runId,
    stepId: hintsFromToolData.stepId ?? fallbackHints.stepId,
    jsonMetadataDetected: true,
  };
}
