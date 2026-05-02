import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".tamandua");
const LOG_FILE = path.join(LOG_DIR, "tamandua.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function ensureDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded(): void {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE + ".1";
      try { fs.unlinkSync(rotated); } catch {}
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {}
}

export type LogLevel = "info" | "warn" | "error";

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function writeLine(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  ensureDir();
  rotateIfNeeded();
  const ts = formatTimestamp();
  const extraStr = extra ? " " + JSON.stringify(extra) : "";
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${extraStr}\n`;
  fs.appendFileSync(LOG_FILE, line, "utf-8");
}

export const logger = {
  info(message: string, extra?: Record<string, unknown>) {
    writeLine("info", message, extra);
  },
  warn(message: string, extra?: Record<string, unknown>) {
    writeLine("warn", message, extra);
  },
  error(message: string, extra?: Record<string, unknown>) {
    writeLine("error", message, extra);
  },
  debug(message: string, extra?: Record<string, unknown>) {
    writeLine("info", message, extra);  // debug = info for compatibility
  },
};

export const log = (
  level: string,
  message: string,
  extra?: Record<string, unknown>,
): void => {
  writeLine(level as LogLevel, message, extra);
};

export function formatEntry(entry: {
  timestamp: string;
  level: string;
  message: string;
  runId?: string;
}): string {
  const runPart = entry.runId ? `[${entry.runId.slice(0, 8)}] ` : "";
  return `[${entry.timestamp.replace("T", " ").slice(0, 19)}] [${entry.level.toUpperCase()}] ${runPart}${entry.message}`;
}

export async function readRecentLogs(lines = 50): Promise<string[]> {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const all = content.trim().split("\n").filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function getLogPath(): string {
  return LOG_FILE;
}
