// ══════════════════════════════════════════════════════════════════════
// job-registry-db.ts — Thin write-through layer for job_registry persistence
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../../db.js";
import type { CronJobInfo } from "./shared.js";

export type JobRegistryStatus = "active" | "paused" | "completed" | "failed" | "inactive";

interface UpsertJobParams {
  id: string;
  workflowId: string;
  runId: string;
  agentId: string;
  status?: JobRegistryStatus;
  harnessType?: string | null;
  pid?: number | null;
  pgid?: number | null;
  intervalMinutes?: number;
  metadata?: string | null;
}

export async function upsertJobRegistry(params: UpsertJobParams): Promise<void> {
  const prisma = getPrisma();
  await prisma.jobRegistry.upsert({
    where: { id: params.id },
    create: {
      id: params.id,
      workflow_id: params.workflowId,
      run_id: params.runId,
      agent_id: params.agentId,
      status: params.status ?? "active",
      harness_type: params.harnessType ?? null,
      pid: params.pid ?? null,
      pgid: params.pgid ?? null,
      interval_minutes: params.intervalMinutes ?? 5,
      metadata: params.metadata ?? null,
    },
    update: {
      status: params.status ?? "active",
      harness_type: params.harnessType ?? undefined,
      pid: params.pid ?? undefined,
      pgid: params.pgid ?? undefined,
      interval_minutes: params.intervalMinutes ?? undefined,
      metadata: params.metadata ?? undefined,
      updated_at: new Date(),
    },
  });
}

export async function updateJobStatus(
  id: string,
  status: JobRegistryStatus,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.jobRegistry.updateMany({
    where: { id },
    data: { status, updated_at: new Date() },
  });
}

export async function updateJobPid(
  id: string,
  pid: number | null,
  pgid: number | null,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.jobRegistry.updateMany({
    where: { id },
    data: { pid, pgid, updated_at: new Date() },
  });
}

export async function softDeleteJobsByRun(runId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.jobRegistry.updateMany({
    where: { run_id: runId, status: { not: "inactive" } },
    data: { status: "inactive", updated_at: new Date() },
  });
}

export async function deleteJob(id: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.jobRegistry.deleteMany({ where: { id } });
}

/** Rehydrate active jobs from the DB at daemon startup or reconciler tick.
 *  Only loads jobs whose run is currently running to avoid stale entries. */
export async function loadActiveJobsFromRegistry(): Promise<ActiveJobRow[]> {
  const prisma = getPrisma();
  const rows = await prisma.jobRegistry.findMany({
    where: {
      status: { in: ["active", "paused"] },
    },
    orderBy: { updated_at: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    workflowId: r.workflow_id,
    runId: r.run_id,
    agentId: r.agent_id,
    status: r.status as JobRegistryStatus,
    harnessType: r.harness_type,
    pid: r.pid,
    pgid: r.pgid,
    intervalMinutes: r.interval_minutes,
    metadata: r.metadata,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));
}

export interface ActiveJobRow {
  id: string;
  workflowId: string;
  runId: string;
  agentId: string;
  status: JobRegistryStatus;
  harnessType: string | null;
  pid: number | null;
  pgid: number | null;
  intervalMinutes: number;
  metadata: string | null;
  startedAt: string;
  updatedAt: string;
}

/** Filter out jobs whose run is no longer running. */
export async function findStaleJobIds(activeRows: ActiveJobRow[]): Promise<string[]> {
  const prisma = getPrisma();
  const runIds = [...new Set(activeRows.map((r) => r.runId))];
  const runningRuns = await prisma.run.findMany({
    where: { id: { in: runIds }, status: "running" },
    select: { id: true },
  });
  const runningSet = new Set(runningRuns.map((r) => r.id));
  return activeRows.filter((r) => !runningSet.has(r.runId)).map((r) => r.id);
}
