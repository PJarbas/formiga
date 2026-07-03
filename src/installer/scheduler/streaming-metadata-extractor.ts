// ══════════════════════════════════════════════════════════════════════
// streaming-metadata-extractor.ts — Extract pi output metadata during streaming
// ══════════════════════════════════════════════════════════════════════
//
// Processes pi stdout line-by-line as it arrives, extracting:
//   - STATUS markers (done/failed/error)
//   - Token usage from message_end JSON events
//   - Run/step IDs from metadata
//   - Bounded assistant text tail (for completeStep fallback)
//
// Memory guarantee: O(maxAssistantBytes) regardless of pi output size.
// No .join() on unbounded arrays — toString() checks total size first.
// ══════════════════════════════════════════════════════════════════════

import { extractTokenUsage } from "./polling-parser.js";

// ── Public types ──────────────────────────────────────────────────────

export interface ExtractedMetadata {
  /** Detected STATUS marker: "done" | "failed" | "error" | null */
  statusMarker: string | null;
  /** Token usage from message_end event */
  tokenUsage: number | null;
  /** Run/step IDs from metadata */
  runId: string | null;
  stepId: string | null;
  /** Whether JSON metadata was detected at all */
  jsonMetadataDetected: boolean;
  /** Bounded assistant text tail (for completeStep fallback) */
  assistantTextTail: string;
  /** Whether assistantTextTail was truncated */
  assistantTextTruncated: boolean;
  /** Total bytes ingested (for metrics) */
  totalBytesIngested: number;
  /** Total lines ingested */
  totalLines: number;
  /** Lines dropped from the assistant text buffer */
  linesDropped: number;
}

// ── Internal helpers ──────────────────────────────────────────────────

const UUID_CAPTURE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const RUN_ID_REGEX = new RegExp(`["']?run(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");
const STEP_ID_REGEX = new RegExp(`["']?step(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Extract assistant text from a message_end event's message.content */
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

// ── StreamingMetadataExtractor ─────────────────────────────────────────

/**
 * Process pi stdout line-by-line as it arrives, extracting metadata
 * in real-time. Bounded memory: only retains a configurable tail of
 * assistant text, never the full output.
 */
export class StreamingMetadataExtractor {
  private readonly maxAssistantBytes: number;

  private statusMarker: string | null = null;
  private tokenUsage: number | null = null;
  private assistantBuffer: string[] = [];
  private assistantBytes = 0;
  private totalBytes = 0;
  private totalLines = 0;
  private linesDropped = 0;
  private jsonDetected = false;
  private runId: string | null = null;
  private stepId: string | null = null;

  constructor(maxAssistantBytes = 256 * 1024) {
    this.maxAssistantBytes = maxAssistantBytes;
  }

  /** Process a single line from pi stdout. O(1) per line. */
  processLine(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
    this.totalBytes += lineBytes;
    this.totalLines++;

    // 1. Check for STATUS marker (highest priority — single line)
    const statusMatch = line.match(/^STATUS:\s*(\S+)/i);
    if (statusMatch) {
      this.statusMarker = statusMatch[1].toLowerCase();
    }

    // 2. Check for JSON event (message_end, etc.)
    let wasMessageEnd = false;
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const record = asRecord(parsed);
        if (record) {
          this.jsonDetected = true;

          // Extract run/step IDs from any JSON event
          const runMatch = JSON.stringify(record).match(RUN_ID_REGEX);
          if (runMatch) this.runId = runMatch[1];
          const stepMatch = JSON.stringify(record).match(STEP_ID_REGEX);
          if (stepMatch) this.stepId = stepMatch[1];

          // Extract token usage + assistant text from message_end
          if (record.type === "message_end") {
            wasMessageEnd = true;
            const message = asRecord(record.message);
            if (message?.role === "assistant") {
              const text = extractAssistantText(message).trim();
              if (text.length > 0) {
                // Replace assistant buffer — message_end is authoritative
                this.assistantBuffer = [text];
                this.assistantBytes = Buffer.byteLength(text, "utf-8") + 1;
              }

              const usage = extractTokenUsage(message.usage);
              if (usage !== null) this.tokenUsage = usage;
            }
          }
        }
      } catch {
        // best-effort: ignore malformed JSON lines
      }
    }

    // 3. Buffer line into assistant text tail (FIFO eviction)
    //    Skip message_end lines — the authoritative assistantText was
    //    already extracted above, so we don't need the raw JSON in the buffer.
    if (!wasMessageEnd) {
      this.assistantBuffer.push(line);
      this.assistantBytes += lineBytes;

      while (this.assistantBytes > this.maxAssistantBytes && this.assistantBuffer.length > 1) {
        const dropped = this.assistantBuffer.shift()!;
        this.assistantBytes -= Buffer.byteLength(dropped, "utf-8") + 1;
        this.linesDropped++;
      }
    }
  }

  /** Return extracted metadata. Call once after all lines are processed. */
  getMetadata(): ExtractedMetadata {
    const V8_MAX_STRING_LENGTH = 512 * 1024 * 1024;
    let assistantTextTail: string;
    let assistantTextTruncated = this.linesDropped > 0;

    // Safe toString: check estimated size before .join()
    const estimatedSize = this.assistantBuffer.reduce(
      (sum, c) => sum + c.length + 1, 0,
    );
    if (estimatedSize <= V8_MAX_STRING_LENGTH) {
      assistantTextTail = this.assistantBuffer.join("\n");
    } else {
      // Incremental build with truncation guard
      let result = "";
      for (let i = 0; i < this.assistantBuffer.length; i++) {
        const next = this.assistantBuffer[i];
        if (result.length + next.length + 1 > V8_MAX_STRING_LENGTH) {
          result += "\n[… output truncated: exceeded V8 string limit]";
          assistantTextTruncated = true;
          break;
        }
        result += (result ? "\n" : "") + next;
      }
      assistantTextTail = result;
    }

    return {
      statusMarker: this.statusMarker,
      tokenUsage: this.tokenUsage,
      runId: this.runId,
      stepId: this.stepId,
      jsonMetadataDetected: this.jsonDetected,
      assistantTextTail,
      assistantTextTruncated,
      totalBytesIngested: this.totalBytes,
      totalLines: this.totalLines,
      linesDropped: this.linesDropped,
    };
  }
}