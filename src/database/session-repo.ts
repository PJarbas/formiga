import fs from "node:fs";
import path from "node:path";

import { getDb } from "./connection.js";

interface AutoresearchSessionConfigRaw {
  goal?: string;
  metricName?: string;
  metricUnit?: string;
  direction?: string;
  command?: string;
}

interface AutoresearchLogRunEntry {
  type: string;
  run: number;
  status: string;
  metric: number | null;
}

export interface AutoresearchSessionRow {
  id: string;
  cwd: string;
  goal: string | null;
  metric_name: string | null;
  metric_unit: string | null;
  direction: string | null;
  command: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_run_at: string | null;
  total_runs: number;
  baseline_metric: number | null;
  best_metric: number | null;
  best_run: number | null;
  files_missing: number;
}

function readSessionConfigFromFiles(cwd: string): { config: AutoresearchSessionConfigRaw; missing: boolean } {
  const configPath = path.join(cwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) {
    return { config: {}, missing: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AutoresearchSessionConfigRaw;
    return { config: raw, missing: false };
  } catch {
    return { config: {}, missing: true };
  }
}

function readLogFromFiles(cwd: string): AutoresearchLogRunEntry[] {
  const logPath = path.join(cwd, "autoresearch.jsonl");
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as AutoresearchLogRunEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AutoresearchLogRunEntry => entry !== null && entry.type === "run");
  } catch {
    return [];
  }
}

// Module-level cache to avoid repeated fs.realpathSync() calls for the
// same cwd. Invalidate on filesystem changes by capping at 1024 entries.
const _resolvedCwdCache = new Map<string, string>();
const _RESOLVED_CWD_MAX = 1024;

function resolveSessionCwd(cwd: string): string {
  const absolute = path.resolve(cwd);
  const cached = _resolvedCwdCache.get(absolute);
  if (cached) return cached;

  let result: string;
  try {
    result = fs.realpathSync(absolute);
  } catch {
    let current = absolute;
    const missingParts: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        result = absolute;
        break;
      }
      missingParts.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = fs.realpathSync(current);
        result = path.join(realParent, ...missingParts);
        break;
      } catch {
        // Continue walking up until an existing parent can be canonicalized.
      }
    }
  }

  // Evict oldest entry if at capacity
  if (_resolvedCwdCache.size >= _RESOLVED_CWD_MAX) {
    const firstKey = _resolvedCwdCache.keys().next().value;
    if (firstKey !== undefined) _resolvedCwdCache.delete(firstKey);
  }
  _resolvedCwdCache.set(absolute, result);
  return result;
}

export function upsertAutoresearchSession(cwd: string): AutoresearchSessionRow | null {
  const db = getDb();
  const resolvedCwd = resolveSessionCwd(cwd);
  const id = resolvedCwd;

  const { config, missing } = readSessionConfigFromFiles(resolvedCwd);
  const now = new Date().toISOString();

  let filesMissing = missing ? 1 : 0;
  if (!filesMissing) {
    // Check if log file exists (not strictly required but useful for completeness)
    const logPath = path.join(resolvedCwd, "autoresearch.jsonl");
    if (!fs.existsSync(logPath)) filesMissing = 1;
  }

  const goal = config.goal ?? null;
  const metricName = config.metricName ?? null;
  const metricUnit = config.metricUnit ?? null;
  const direction = config.direction ?? null;
  const command = config.command ?? null;

  // Read log entries to compute stats
  const runs = readLogFromFiles(resolvedCwd);
  const keptRuns = runs.filter((r) => r.status === "baseline" || r.status === "keep");
  const totalRuns = runs.length;

  // Find baseline metric (first entry with status "baseline")
  const baselineEntry = runs.find((r) => r.status === "baseline" && r.metric !== null);
  const baselineMetric = baselineEntry?.metric ?? null;

  // Find best metric among kept runs
  let bestMetric: number | null = null;
  let bestRun: number | null = null;
  for (const r of keptRuns) {
    if (r.metric === null) continue;
    if (bestMetric === null) {
      bestMetric = r.metric;
      bestRun = r.run;
    } else if (direction === "higher") {
      if (r.metric > bestMetric) { bestMetric = r.metric; bestRun = r.run; }
    } else {
      if (r.metric < bestMetric) { bestMetric = r.metric; bestRun = r.run; }
    }
  }

  // Determine last_run_at from the highest run number
  const latestRun = runs.reduce<AutoresearchLogRunEntry | null>((latest, r) => {
    if (!latest || r.run > latest.run) return r;
    return latest;
  }, null);
  const lastRunAt = latestRun ? now : null; // We use 'now' as last_seen; last_run_at is approximate

  db.prepare(`
    INSERT OR REPLACE INTO autoresearch_sessions
      (id, cwd, goal, metric_name, metric_unit, direction, command,
       created_at, updated_at, last_seen_at, last_run_at,
       total_runs, baseline_metric, best_metric, best_run, files_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, resolvedCwd, goal, metricName, metricUnit, direction, command,
    now, now, now, lastRunAt,
    totalRuns, baselineMetric, bestMetric, bestRun, filesMissing,
  );

  return {
    id,
    cwd: resolvedCwd,
    goal,
    metric_name: metricName,
    metric_unit: metricUnit,
    direction,
    command,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    last_run_at: lastRunAt,
    total_runs: totalRuns,
    baseline_metric: baselineMetric,
    best_metric: bestMetric,
    best_run: bestRun,
    files_missing: filesMissing,
  };
}

export function getAutoresearchSessions(opts?: { includeMissing?: boolean }): AutoresearchSessionRow[] {
  const db = getDb();
  const includeMissing = opts?.includeMissing ?? false;
  const rows = includeMissing
    ? db.prepare("SELECT * FROM autoresearch_sessions ORDER BY updated_at DESC").all()
    : db.prepare("SELECT * FROM autoresearch_sessions WHERE files_missing = 0 ORDER BY updated_at DESC").all();
  return rows as unknown as AutoresearchSessionRow[];
}

export function getAutoresearchSessionById(id: string): AutoresearchSessionRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM autoresearch_sessions WHERE id = ?").get(id) as unknown as AutoresearchSessionRow | undefined;
}

export function deleteAutoresearchSession(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM autoresearch_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}
