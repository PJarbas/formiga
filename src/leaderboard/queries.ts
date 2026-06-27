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

/** Best experiment (by val_metric) for a single run. */
export function getCurrentBestForRun(
  db: DatabaseSync,
  runId: string,
): ExperimentRow | undefined {
  const row = db
    .prepare(
      `SELECT * FROM experiments
       WHERE run_id = ? AND status IN ('SUCCESS','AUDITED')
       ORDER BY val_metric DESC LIMIT 1`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row ? deserializeExperimentRow(row) : undefined;
}

/** Failed / OVERFITTED configs for a given agent across ALL runs.
 *  Agent name is matched with LIKE '%_<agentName>' so the scoped
 *  workflow prefix (e.g. ml-pipeline_modeler-classic) still hits. */
export function getFailedConfigsForAgent(
  db: DatabaseSync,
  agentName: string,
  limit = 5,
): Array<{
  model_type: string;
  hyperparameters: Record<string, unknown>;
  reject_reason: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT model_type, hyperparameters, COALESCE(NULLIF(reject_reason,''), error_message) AS reject_reason
       FROM experiments
       WHERE agent_name LIKE '%_' || ? AND status IN ('FAILED','OVERFITTED')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentName, limit) as Array<{
      model_type: string;
      hyperparameters: string;
      reject_reason: string | null;
    }>;
  return rows.map((r) => ({
    model_type: r.model_type,
    hyperparameters: safeJsonParse(r.hyperparameters),
    reject_reason: r.reject_reason,
  }));
}

/** Top succeeded configs for a given agent across ALL runs. */
export function getSucceededConfigsForAgent(
  db: DatabaseSync,
  agentName: string,
  limit = 3,
): Array<{
  model_type: string;
  hyperparameters: Record<string, unknown>;
  val_metric: number;
}> {
  const rows = db
    .prepare(
      `SELECT model_type, hyperparameters, val_metric
       FROM experiments
       WHERE agent_name LIKE '%_' || ? AND status IN ('SUCCESS','AUDITED')
       ORDER BY val_metric DESC LIMIT ?`,
    )
    .all(agentName, limit) as Array<{
      model_type: string;
      hyperparameters: string;
      val_metric: number;
    }>;
  return rows.map((r) => ({
    model_type: r.model_type,
    hyperparameters: safeJsonParse(r.hyperparameters),
    val_metric: r.val_metric,
  }));
}

/** Best experiments that share a dataset signature, across runs. */
export function getBestExperimentsBySignature(
  db: DatabaseSync,
  signature: string,
  limit = 5,
): ExperimentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM experiments
       WHERE dataset_signature = ? AND status IN ('SUCCESS','AUDITED')
       ORDER BY val_metric DESC LIMIT ?`,
    )
    .all(signature, limit) as Array<Record<string, unknown>>;
  return rows.map(deserializeExperimentRow);
}

/** Upsert a dataset signature record. */
export function upsertDatasetSignature(
  db: DatabaseSync,
  signature: string,
  columnHash: string,
  rowBucket: string,
): void {
  db.prepare(
    `INSERT INTO dataset_signatures (signature, column_hash, row_bucket)
     VALUES (?, ?, ?)
     ON CONFLICT(signature) DO UPDATE SET column_hash=excluded.column_hash, row_bucket=excluded.row_bucket`,
  ).run(signature, columnHash, rowBucket);
}

// ── Dataset Signature Computation ──

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function rowBucket(count: number): string {
  if (count < 1000) return "<1K";
  if (count < 10000) return "1K-10K";
  if (count < 100000) return "10K-100K";
  if (count < 1000000) return "100K-1M";
  return ">1M";
}

/** Build a deterministic signature from a CSV file:
 *  - read header, sort column names, md5 hash → column_hash
 *  - count total rows (header excluded), bucket → row_bucket
 *  - final signature = column_hash + "_" + row_bucket
 */
export async function computeDatasetSignature(datasetPath: string): Promise<{
  signature: string;
  columnHash: string;
  rowBucket: string;
}> {
  const raw = await readFile(datasetPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim()) {
    throw new Error(`Dataset has no header: ${datasetPath}`);
  }
  const header = lines[0].trim();
  const columns = header.split(",").map((c) => c.trim()).sort();
  const columnHash = createHash("md5").update(columns.join(",")).digest("hex");
  const totalRows = lines.length - 1; // exclude header line
  const rb = rowBucket(totalRows);
  const signature = `${columnHash}_${rb}`;
  return { signature, columnHash, rowBucket: rb };
}

// ── Rehydration helper (mirrors repository mapping) ──

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deserializeExperimentRow(raw: Record<string, unknown>): ExperimentRow {
  return {
    experiment_id: Number(raw.experiment_id),
    run_id: raw.run_id as string,
    round_number: Number(raw.round_number),
    agent_name: raw.agent_name as string,
    model_type: raw.model_type as string,
    hyperparameters: safeJsonParse(raw.hyperparameters as string),
    train_metric: Number(raw.train_metric),
    val_metric: Number(raw.val_metric),
    test_metric: raw.test_metric != null ? Number(raw.test_metric) : null,
    metric_name: raw.metric_name as string,
    artifact_path: raw.artifact_path as string,
    status: raw.status as ExperimentRow["status"],
    error_message: raw.error_message != null ? (raw.error_message as string) : null,
    dataset_signature: raw.dataset_signature != null ? (raw.dataset_signature as string) : null,
    created_at: raw.created_at as string,
  };
}
