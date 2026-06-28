// ══════════════════════════════════════════════════════════════════════
// session-repo.ts — AutoResearch session registry
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { getPrisma } from "./prisma.js";

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

function toAutoresearchRow(model: {
  id: string;
  cwd: string;
  goal: string | null;
  metric_name: string | null;
  metric_unit: string | null;
  direction: string | null;
  command: string | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date;
  last_run_at: Date | null;
  total_runs: number;
  baseline_metric: number | null;
  best_metric: number | null;
  best_run: number | null;
  files_missing: number;
}): AutoresearchSessionRow {
  return {
    id: model.id,
    cwd: model.cwd,
    goal: model.goal,
    metric_name: model.metric_name,
    metric_unit: model.metric_unit,
    direction: model.direction,
    command: model.command,
    created_at: model.created_at.toISOString(),
    updated_at: model.updated_at.toISOString(),
    last_seen_at: model.last_seen_at.toISOString(),
    last_run_at: model.last_run_at?.toISOString() ?? null,
    total_runs: model.total_runs,
    baseline_metric: model.baseline_metric,
    best_metric: model.best_metric,
    best_run: model.best_run,
    files_missing: model.files_missing,
  };
}

export async function upsertAutoresearchSession(
  cwd: string,
): Promise<AutoresearchSessionRow | null> {
  const prisma = getPrisma();
  const resolvedCwd = resolveSessionCwd(cwd);
  const id = resolvedCwd;

  const { config, missing } = readSessionConfigFromFiles(resolvedCwd);
  const now = new Date();

  let filesMissing = missing ? 1 : 0;
  if (!filesMissing) {
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

  const baselineEntry = runs.find((r) => r.status === "baseline" && r.metric !== null);
  const baselineMetric = baselineEntry?.metric ?? null;

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

  const latestRun = runs.reduce<AutoresearchLogRunEntry | null>((latest, r) => {
    if (!latest || r.run > latest.run) return r;
    return latest;
  }, null);
  const lastRunAt = latestRun ? now : null;

  const upserted = await prisma.autoresearchSession.upsert({
    where: { id },
    create: {
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
    },
    update: {
      cwd: resolvedCwd,
      goal,
      metric_name: metricName,
      metric_unit: metricUnit,
      direction,
      command,
      updated_at: now,
      last_seen_at: now,
      last_run_at: lastRunAt,
      total_runs: totalRuns,
      baseline_metric: baselineMetric,
      best_metric: bestMetric,
      best_run: bestRun,
      files_missing: filesMissing,
    },
  });

  return toAutoresearchRow(upserted);
}

export async function getAutoresearchSessions(
  opts?: { includeMissing?: boolean },
): Promise<AutoresearchSessionRow[]> {
  const prisma = getPrisma();
  const includeMissing = opts?.includeMissing ?? false;
  const where = includeMissing
    ? {}
    : { files_missing: 0 };
  const rows = await prisma.autoresearchSession.findMany({
    where,
    orderBy: { updated_at: "desc" },
  });
  return rows.map(toAutoresearchRow);
}

export async function getAutoresearchSessionById(
  id: string,
): Promise<AutoresearchSessionRow | undefined> {
  const prisma = getPrisma();
  const row = await prisma.autoresearchSession.findUnique({
    where: { id },
  });
  return row ? toAutoresearchRow(row) : undefined;
}

export async function deleteAutoresearchSession(id: string): Promise<boolean> {
  const prisma = getPrisma();
  try {
    await prisma.autoresearchSession.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
