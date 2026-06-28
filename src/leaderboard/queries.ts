// ══════════════════════════════════════════════════════════════════════
// queries.ts — Named, typed query helpers for the experiments table
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../database/prisma.js";
import type { ExperimentRow } from "./repository.js";

/** All experiments for a run, newest first. */
export async function getExperimentsForRun(runId: string): Promise<ExperimentRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: { run_id: runId },
    orderBy: { created_at: "desc" },
  });
  return rows.map(toExperimentRow);
}

/** Count experiments grouped by status for a run. */
export async function getExperimentStats(
  runId: string,
): Promise<{ total: number; validated: number; rejected: number; pending: number }> {
  const prisma = getPrisma();
  const [totalResult, validatedResult, rejectedResult, pendingResult] = await Promise.all([
    prisma.experiment.count({ where: { run_id: runId } }),
    prisma.experiment.count({
      where: { run_id: runId, status: { in: ["SUCCESS", "AUDITED"] } },
    }),
    prisma.experiment.count({
      where: { run_id: runId, status: { in: ["FAILED", "OVERFITTED"] } },
    }),
    prisma.experiment.count({
      where: { run_id: runId, status: "PENDING" },
    }),
  ]);
  return {
    total: totalResult,
    validated: validatedResult,
    rejected: rejectedResult,
    pending: pendingResult,
  };
}

/** Best N experiments by val_metric for a run. */
export async function getBestExperiments(
  runId: string,
  limit = 10,
): Promise<ExperimentRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: {
      run_id: runId,
      status: { in: ["SUCCESS", "AUDITED"] },
    },
    orderBy: { val_metric: "desc" },
    take: limit,
  });
  return rows.map(toExperimentRow);
}

/** Count of rejected experiments for a given agent across all runs. */
export async function getRejectedCount(agentName: string): Promise<number> {
  const prisma = getPrisma();
  return prisma.experiment.count({
    where: {
      agent_name: agentName,
      status: { in: ["FAILED", "OVERFITTED"] },
    },
  });
}

/** Best experiment (by val_metric) for a single run. */
export async function getCurrentBestForRun(
  runId: string,
): Promise<ExperimentRow | undefined> {
  const prisma = getPrisma();
  const row = await prisma.experiment.findFirst({
    where: {
      run_id: runId,
      status: { in: ["SUCCESS", "AUDITED"] },
    },
    orderBy: { val_metric: "desc" },
  });
  return row ? toExperimentRow(row) : undefined;
}

/** Failed / OVERFITTED configs for a given agent across ALL runs.
 *  Agent name is matched with LIKE '%_<agentName>' so the scoped
 *  workflow prefix (e.g. ml-pipeline_modeler-classic) still hits. */
export async function getFailedConfigsForAgent(
  agentName: string,
  limit = 5,
): Promise<
  Array<{
    model_type: string;
    hyperparameters: Record<string, unknown>;
    reject_reason: string | null;
  }>
> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: {
      agent_name: { endsWith: `_${agentName}` },
      status: { in: ["FAILED", "OVERFITTED"] },
    },
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      model_type: true,
      hyperparameters: true,
      reject_reason: true,
      error_message: true,
    },
  });
  return rows.map((r) => ({
    model_type: r.model_type,
    hyperparameters: safeJsonParse(r.hyperparameters),
    reject_reason: r.reject_reason ?? r.error_message,
  }));
}

/** Top succeeded configs for a given agent across ALL runs. */
export async function getSucceededConfigsForAgent(
  agentName: string,
  limit = 3,
): Promise<
  Array<{
    model_type: string;
    hyperparameters: Record<string, unknown>;
    val_metric: number;
  }>
> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: {
      agent_name: { endsWith: `_${agentName}` },
      status: { in: ["SUCCESS", "AUDITED"] },
    },
    orderBy: { val_metric: "desc" },
    take: limit,
    select: {
      model_type: true,
      hyperparameters: true,
      val_metric: true,
    },
  });
  return rows.map((r) => ({
    model_type: r.model_type,
    hyperparameters: safeJsonParse(r.hyperparameters),
    val_metric: r.val_metric,
  }));
}

/** Best experiments that share a dataset signature, across runs. */
export async function getBestExperimentsBySignature(
  signature: string,
  limit = 5,
): Promise<ExperimentRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.experiment.findMany({
    where: {
      dataset_signature: signature,
      status: { in: ["SUCCESS", "AUDITED"] },
    },
    orderBy: { val_metric: "desc" },
    take: limit,
  });
  return rows.map(toExperimentRow);
}

/** Upsert a dataset signature record. */
export async function upsertDatasetSignature(
  signature: string,
  columnHash: string,
  rowBucket: string,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.datasetSignature.upsert({
    where: { signature },
    create: { signature, column_hash: columnHash, row_bucket: rowBucket },
    update: { column_hash: columnHash, row_bucket: rowBucket },
  });
}

// ── Dataset Signature Computation ─────────────────────────────────────────────────

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
  const totalRows = lines.length - 1;
  const rb = rowBucket(totalRows);
  const signature = `${columnHash}_${rb}`;
  return { signature, columnHash, rowBucket: rb };
}

// ── Serialization helpers ──────────────────────────────────────────────────────────────

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toExperimentRow(model: {
  experiment_id: number;
  run_id: string;
  round_number: number;
  agent_name: string;
  model_type: string;
  hyperparameters: string;
  train_metric: number;
  val_metric: number;
  test_metric: number | null;
  metric_name: string;
  artifact_path: string;
  status: string;
  error_message: string | null;
  dataset_signature: string | null;
  created_at: Date;
}): ExperimentRow {
  return {
    experiment_id: model.experiment_id,
    run_id: model.run_id,
    round_number: model.round_number,
    agent_name: model.agent_name,
    model_type: model.model_type,
    hyperparameters: safeJsonParse(model.hyperparameters),
    train_metric: model.train_metric,
    val_metric: model.val_metric,
    test_metric: model.test_metric,
    metric_name: model.metric_name,
    artifact_path: model.artifact_path,
    status: model.status as ExperimentRow["status"],
    error_message: model.error_message,
    dataset_signature: model.dataset_signature,
    created_at: model.created_at.toISOString(),
  };
}
