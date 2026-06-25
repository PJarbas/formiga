// ══════════════════════════════════════════════════════════════════════
// queries.ts — Named, typed query helpers for the experiments table
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";
import type { ExperimentRow } from "./repository.js";

/** All experiments for a run, newest first. */
export function getExperimentsForRun(db: DatabaseSync, runId: string): ExperimentRow[] {
  return db
    .prepare("SELECT * FROM experiments WHERE run_id = ? ORDER BY created_at DESC")
    .all(runId) as unknown as ExperimentRow[];
}

/** Count experiments grouped by status for a run. */
export function getExperimentStats(
  db: DatabaseSync,
  runId: string,
): { total: number; validated: number; rejected: number; pending: number } {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('SUCCESS','AUDITED') THEN 1 ELSE 0 END) AS validated,
        SUM(CASE WHEN status IN ('FAILED','OVERFITTED') THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
       FROM experiments WHERE run_id = ?`,
    )
    .get(runId) as Record<string, number> | undefined;

  return {
    total: row?.total ?? 0,
    validated: row?.validated ?? 0,
    rejected: row?.rejected ?? 0,
    pending: row?.pending ?? 0,
  };
}

/** Best N experiments by val_metric for a run. */
export function getBestExperiments(db: DatabaseSync, runId: string, limit = 10): ExperimentRow[] {
  return db
    .prepare(
      `SELECT * FROM experiments
       WHERE run_id = ? AND status IN ('SUCCESS','AUDITED')
       ORDER BY val_metric DESC LIMIT ?`,
    )
    .all(runId, limit) as unknown as ExperimentRow[];
}

/** Count of rejected experiments for a given agent across all runs. */
export function getRejectedCount(db: DatabaseSync, agentName: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM experiments WHERE agent_name = ? AND status IN ('FAILED','OVERFITTED')")
    .get(agentName) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
