import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePiStateDir } from "./paths.js";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface FormigaEvent {
  ts: string;
  event: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  storyId?: string;
  storyTitle?: string;
  agentId?: string;
  detail?: string;
  tokenDelta?: number;
  tokensSpent?: number;
}

export type EventCursorSource =
  | { kind: "global" }
  | { kind: "run"; runId: string };

export interface EventCursorReadResult {
  events: FormigaEvent[];
  nextOffset: number;
}

// ── Paths ────────────────────────────────────────────────────────────

function getEventsDir(): string {
  return path.join(resolvePiStateDir(), "events");
}

function getEventsFile(runId: string): string {
  return path.join(getEventsDir(), `${runId}.jsonl`);
}

function getGlobalEventsFile(): string {
  return path.join(getEventsDir(), "all.jsonl");
}

function getEventsFileForSource(source: EventCursorSource): string {
  if (source.kind === "global") return getGlobalEventsFile();
  return getEventsFile(source.runId);
}

// ── Event Emission ───────────────────────────────────────────────────

/**
 * Ledgers are rotated by size once they exceed this threshold so that a
 * single file never grows unbounded (the reads above only ever touch one
 * bounded file + its backup).
 */
const MAX_LEDGER_BYTES = 10 * 1024 * 1024; // 10MB
/** Keep one rotated backup (all.jsonl + all.jsonl.1); older ones are removed. */
const MAX_LEDGER_BACKUPS = 1;
/** Tail window read by getRecentEvents — always covers the recent N lines. */
const MAX_RECENT_READ_BYTES = 512 * 1024; // 512KB

/**
 * Rotate a ledger file in place once it exceeds MAX_LEDGER_BYTES: rename it
 * to `<file>.1`, removing any older backup first. Best-effort — a failure
 * must never lose the already-appended line, so it is only logged.
 */
function rotateLedgerFileIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= MAX_LEDGER_BYTES) return;
    const backup = `${file}.1`;
    if (fs.existsSync(backup)) fs.rmSync(backup);
    fs.renameSync(file, backup);
    logger.info("Rotated events ledger", {
      file: path.basename(file),
      sizeBytes: stat.size,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return; // file disappeared between append and rotation
    logger.warn("Failed to rotate events ledger", {
      file: path.basename(file),
      error: String(err),
    });
  }
}

/**
 * Emit a Formiga event.
 *
 * Writes:
 * 1. To the run-specific JSONL file (~/.formiga/events/<runId>.jsonl)
 * 2. To the global JSONL file (~/.formiga/events/all.jsonl)
 * 3. Fires a webhook if a notify URL is configured for the run (fire-and-forget)
 */
export function emitEvent(evt: FormigaEvent): void {
  const line = JSON.stringify(evt) + "\n";

  // Ensure events directory exists
  const eventsDir = getEventsDir();
  fs.mkdirSync(eventsDir, { recursive: true });

  // Write to run-specific events file
  const runFile = getEventsFile(evt.runId);
  try {
    fs.appendFileSync(runFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write run event", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  }
  rotateLedgerFileIfNeeded(runFile);

  // Write to global events file
  const globalFile = getGlobalEventsFile();
  try {
    fs.appendFileSync(globalFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write global event", {
      event: evt.event,
      error: String(err),
    });
  }
  rotateLedgerFileIfNeeded(globalFile);

  // Fire-and-forget webhook if applicable
  fireWebhook(evt).catch((err) => {
    logger.warn("Webhook delivery failed", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  });
}

// ── Event Reading ────────────────────────────────────────────────────

/**
 * Read events appended after a byte offset from either:
 * - ~/.formiga/events/all.jsonl (global)
 * - ~/.formiga/events/<runId>.jsonl (per-run)
 *
 * Async (fs.promises) so hot request paths never block the event loop on the
 * (up to 10MB, size-rotated) ledger. Only the bytes after `offset` are read,
 * and only complete newline-terminated records are returned along with the
 * next cursor offset. Malformed JSON lines are skipped safely.
 */
export async function readEventsFromCursor(source: EventCursorSource, offset = 0): Promise<EventCursorReadResult> {
  const eventsFile = getEventsFileForSource(source);
  const safeOffset = Math.max(0, Math.floor(offset));

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(eventsFile, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { events: [], nextOffset: 0 };

    logger.warn("Failed to read event cursor source", {
      source: source.kind,
      runId: source.kind === "run" ? source.runId : undefined,
      error: String(err),
    });
    return { events: [], nextOffset: safeOffset };
  }

  try {
    // Opening a directory succeeds on some platforms; the read then throws
    // (EISDIR). Any post-open failure is non-fatal — behave like the old
    // readFileSync fallback (empty result, offset unchanged).
    let stat: fs.Stats;
    try {
      stat = await fh.stat();
    } catch (err) {
      logger.warn("Failed to stat event cursor source", {
        source: source.kind,
        runId: source.kind === "run" ? source.runId : undefined,
        error: String(err),
      });
      return { events: [], nextOffset: safeOffset };
    }

    // Ledger rotated or truncated below the cursor? Start over from the top.
    const startOffset = safeOffset > stat.size ? 0 : safeOffset;
    const bytesToRead = stat.size - startOffset;
    const buf = Buffer.alloc(bytesToRead);
    try {
      if (bytesToRead > 0) await fh.read(buf, 0, bytesToRead, startOffset);
    } catch (err) {
      logger.warn("Failed to read event cursor source", {
        source: source.kind,
        runId: source.kind === "run" ? source.runId : undefined,
        error: String(err),
      });
      return { events: [], nextOffset: safeOffset };
    }

    let cursor = startOffset;
    const events: FormigaEvent[] = [];

    while (cursor < startOffset + buf.length) {
      const rel = buf.indexOf(0x0a, cursor - startOffset);
      if (rel === -1) break; // trailing partial line
      const newlineIndex = startOffset + rel;

      const lineBuffer = buf.subarray(cursor - startOffset, rel);
      cursor = newlineIndex + 1;

      if (lineBuffer.length === 0) continue;

      const line = lineBuffer.toString("utf-8").replace(/\r$/, "");
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          events.push(parsed as FormigaEvent);
        }
      } catch {
        // Ignore malformed JSONL rows so later valid events still stream.
      }
    }

    return { events, nextOffset: cursor };
  } finally {
    await fh.close();
  }
}

/**
 * Read up to `limit` events from the tail of a single ledger file, without
 * loading the whole file. Returns [] when the file is missing or unreadable.
 * The chunk may start mid-line; the partial first line fails JSON.parse and
 * is filtered out below.
 */
async function readEventTail(file: string, limit: number): Promise<FormigaEvent[]> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn("Failed to read events file tail", {
        file: path.basename(file),
        error: String(err),
      });
    }
    return [];
  }

  try {
    // A directory opens fine but then stat/read throw (EISDIR) — treat any
    // post-open failure as "no events" instead of crashing the caller.
    let stat: fs.Stats;
    try {
      stat = await fh.stat();
    } catch {
      return [];
    }
    if (stat.size === 0) return [];

    const readBytes = Math.min(stat.size, MAX_RECENT_READ_BYTES);
    const buf = Buffer.alloc(readBytes);
    try {
      await fh.read(buf, 0, readBytes, stat.size - readBytes);
    } catch {
      return [];
    }

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line) as FormigaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is FormigaEvent => e !== null);
  } finally {
    await fh.close();
  }
}

/**
 * Read the most recent N events from the global events file.
 *
 * Async, and only the tail of each file is read. The ledger is size-rotated
 * at 10MB into `all.jsonl.1`, so the rotated backup's tail is also consulted
 * (older first) so the "recent events" view stays populated across a
 * rotation instead of going briefly empty.
 */
export async function getRecentEvents(limit = 50): Promise<FormigaEvent[]> {
  const globalFile = getGlobalEventsFile();
  const [active, backup] = await Promise.all([
    readEventTail(globalFile, limit),
    readEventTail(`${globalFile}.1`, limit),
  ]);
  return [...backup, ...active].slice(-limit);
}

/**
 * Read all events for a specific run.
 */
export function getRunEvents(runId: string): FormigaEvent[] {
  const runFile = getEventsFile(runId);
  try {
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as FormigaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is FormigaEvent => e !== null);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read run events", { runId, error: String(err) });
    return [];
  }
}

/**
 * Get the path to the events directory.
 */
export function getEventsPath(): string {
  return getEventsDir();
}

// ── Webhook Support ──────────────────────────────────────────────────

/**
 * Fire-and-forget POST to the webhook URL configured for a run.
 * Looks up the notify_url from the runs table.
 * Does not throw — webhook failures are logged and swallowed.
 */
async function fireWebhook(evt: FormigaEvent): Promise<void> {
  // Only notify on significant events to avoid flooding
  const significantEvents = new Set([
    "run.started",
    "run.completed",
    "run.failed",
    "step.failed",
    "step.worker_lost",
    "pipeline.advanced",
  ]);

  if (!significantEvents.has(evt.event)) return;

  let notifyUrl: string | undefined;

  // Try to look up notify_url from the DB
  try {
    const { getPrisma } = await import("../db.js");
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: evt.runId },
      select: { notify_url: true },
    });
    notifyUrl = run?.notify_url ?? undefined;
  } catch {
    // DB might not be available — skip webhook
    return;
  }

  if (!notifyUrl) return;

  const payload = JSON.stringify(evt);

  // Use global fetch (Node 18+)
  const controller = new AbortController();
  // B-5: the timeout must be cleared even when fetch throws, otherwise the
  // 10s timer keeps the event loop alive (and may fire after the request
  // already settled, aborting a reused AbortSignal).
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    // Fire-and-forget: log and move on
    logger.warn("Webhook POST failed", {
      url: notifyUrl,
      event: evt.event,
      runId: evt.runId,
      error: String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}
