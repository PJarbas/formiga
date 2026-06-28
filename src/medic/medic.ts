/**
 * Medic — the formiga health watchdog.
 *
 * Runs periodic health checks on workflow runs, detects stuck/stalled/dead state,
 * and takes corrective action where safe. Logs all findings to the medic_checks table.
 */
import { getPrisma } from "../db.js";
import { emitEvent } from "../installer/events.js";
import { teardownWorkflowCronsIfIdle } from "../installer/agent-scheduler.js";
import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface MedicFinding {
  severity: "info" | "warning" | "critical";
  message: string;
  action: "none" | "reset_step" | "fail_run" | "teardown_crons";
  runId?: string;
  stepId?: string;
  workflowId?: string;
  remediated?: boolean;
}

// ── Types imported from checks ──
import { checkStuckRuns } from "./checks.js";

// ── Sync Checks ─────────────────────────────────────────────────────

const STUCK_THRESHOLD_MINUTES = 30;
const ZOMBIE_THRESHOLD_MINUTES = 60;

function minutesSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 60000);
}

async function runSyncChecks(): Promise<MedicFinding[]> {
  const findings: MedicFinding[] = [];
  const prisma = getPrisma();

  // Find steps that have been "running" for too long
  const stuckSteps = await prisma.step.findMany({
    where: {
      status: "running",
      run: { status: "running" },
    },
    include: { run: true },
  });

  for (const step of stuckSteps) {
    const idleMinutes = minutesSince(step.updated_at);
    if (idleMinutes <= STUCK_THRESHOLD_MINUTES) continue;

    findings.push({
      severity: "warning",
      message: `Step ${step.step_id} stuck running for ${idleMinutes}m (agent ${step.agent_id}, run ${step.run_id.slice(0, 8)})`,
      action: "reset_step",
      runId: step.run_id,
      stepId: step.id,
      workflowId: step.run.workflow_id,
    });
  }

  // Find zombie runs: all steps done/failed but run still "running"
  const zombieRows = await prisma.run.findMany({
    where: { status: "running" },
    include: { steps: { select: { status: true } } },
  });

  for (const run of zombieRows) {
    const idleMinutes = minutesSince(run.updated_at);
    if (idleMinutes <= ZOMBIE_THRESHOLD_MINUTES) continue;

    const hasPendingOrRunning = run.steps.some(
      (s) => s.status === "pending" || s.status === "running",
    );
    if (!hasPendingOrRunning) {
      findings.push({
        severity: "critical",
        message: `Run ${run.id.slice(0, 8)} is zombie — idle for ${idleMinutes}m with all steps terminal`,
        action: "fail_run",
        runId: run.id,
        workflowId: run.workflow_id,
      });
    }
  }

  return findings;
}

// ── Remediation ─────────────────────────────────────────────────────

async function remediate(finding: MedicFinding): Promise<boolean> {
  const prisma = getPrisma();

  switch (finding.action) {
    case "reset_step": {
      if (!finding.stepId) return false;
      const step = await prisma.step.findUnique({
        where: { id: finding.stepId },
        select: { abandoned_count: true },
      });
      if (!step) return false;

      const newCount = (step.abandoned_count ?? 0) + 1;
      const now = new Date();
      if (newCount >= 5) {
        await prisma.step.update({
          where: { id: finding.stepId },
          data: {
            status: "failed",
            output: "Medic: abandoned too many times",
            abandoned_count: newCount,
            updated_at: now,
          },
        });
        if (finding.runId) {
          await prisma.run.update({
            where: { id: finding.runId },
            data: { status: "failed", updated_at: now },
          });
          emitEvent({
            ts: now.toISOString(),
            event: "run.failed",
            runId: finding.runId,
            detail: "Medic: step abandoned too many times",
          });
        }
        return true;
      }

      await prisma.step.update({
        where: { id: finding.stepId },
        data: {
          status: "pending",
          abandoned_count: newCount,
          updated_at: now,
        },
      });
      if (finding.runId) {
        emitEvent({
          ts: now.toISOString(),
          event: "step.timeout",
          runId: finding.runId,
          stepId: finding.stepId,
          detail: `Medic: reset stuck step (abandon ${newCount}/5)`,
        });
      }
      return true;
    }

    case "fail_run": {
      if (!finding.runId) return false;
      const run = await prisma.run.findUnique({
        where: { id: finding.runId },
        select: { status: true, workflow_id: true },
      });
      if (!run || run.status !== "running") return false;

      const now = new Date();
      await prisma.run.update({
        where: { id: finding.runId },
        data: { status: "failed", updated_at: now },
      });
      await prisma.step.updateMany({
        where: {
          run_id: finding.runId,
          status: { in: ["waiting", "pending", "running"] },
        },
        data: { status: "failed", output: "Medic: run marked as dead", updated_at: now },
      });
      emitEvent({
        ts: now.toISOString(),
        event: "run.failed",
        runId: finding.runId,
        workflowId: run.workflow_id,
        detail: "Medic: zombie run — all steps terminal but run still marked running",
      });
      try { await teardownWorkflowCronsIfIdle(run.workflow_id); } catch {}
      return true;
    }

    case "teardown_crons": {
      const match = finding.message.match(/workflow "([^"]+)"/);
      if (!match) return false;
      try {
        await teardownWorkflowCronsIfIdle(match[1]);
        return true;
      } catch {
        return false;
      }
    }

    case "none":
    default:
      return false;
  }
}

// ── Main Check Runner ───────────────────────────────────────────────

export interface MedicCheckResult {
  id: string;
  checkedAt: string;
  issuesFound: number;
  actionsTaken: number;
  summary: string;
  findings: MedicFinding[];
}

export async function runMedicCheck(): Promise<MedicCheckResult> {
  const findings: MedicFinding[] = await runSyncChecks();

  // Remediate
  let actionsTaken = 0;
  for (const finding of findings) {
    if (finding.action !== "none") {
      const success = await remediate(finding);
      if (success) {
        finding.remediated = true;
        actionsTaken++;
      }
    }
  }

  // Build summary
  const parts: string[] = [];
  if (findings.length === 0) {
    parts.push("All clear — no issues found");
  } else {
    const critical = findings.filter((f) => f.severity === "critical").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    if (critical > 0) parts.push(`${critical} critical`);
    if (warnings > 0) parts.push(`${warnings} warning(s)`);
    if (actionsTaken > 0) parts.push(`${actionsTaken} auto-fixed`);
  }
  const summary = parts.join(", ");

  // Log to DB
  const checkId = crypto.randomUUID();
  const checkedAt = new Date();
  const prisma = getPrisma();
  await prisma.medicCheck.create({
    data: {
      id: checkId,
      checked_at: checkedAt,
      issues_found: findings.length,
      actions_taken: actionsTaken,
      summary,
      details: JSON.stringify(findings),
    },
  });

  // Prune old checks (keep last 500)
  const toDelete = await prisma.medicCheck.findMany({
    orderBy: { checked_at: "desc" },
    skip: 500,
    select: { id: true },
  });
  if (toDelete.length > 0) {
    await prisma.medicCheck.deleteMany({
      where: { id: { in: toDelete.map((d) => d.id) } },
    });
  }

  return {
    id: checkId,
    checkedAt: checkedAt.toISOString(),
    issuesFound: findings.length,
    actionsTaken,
    summary,
    findings,
  };
}

// ── Query Helpers ───────────────────────────────────────────────────

export interface MedicStatus {
  installed: boolean;
  lastCheck: { checkedAt: string; summary: string; issuesFound: number; actionsTaken: number } | null;
  recentChecks: number;
  recentIssues: number;
  recentActions: number;
}

export async function getMedicStatus(): Promise<MedicStatus> {
  try {
    const prisma = getPrisma();

    const last = await prisma.medicCheck.findFirst({
      orderBy: { checked_at: "desc" },
      select: { checked_at: true, summary: true, issues_found: true, actions_taken: true },
    });

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stats = await prisma.medicCheck.aggregate({
      _count: { id: true },
      _sum: { issues_found: true, actions_taken: true },
      where: { checked_at: { gt: twentyFourHoursAgo } },
    });

    return {
      installed: true,
      lastCheck: last ? {
        checkedAt: last.checked_at.toISOString(),
        summary: last.summary ?? "",
        issuesFound: last.issues_found,
        actionsTaken: last.actions_taken,
      } : null,
      recentChecks: stats._count.id,
      recentIssues: stats._sum.issues_found ?? 0,
      recentActions: stats._sum.actions_taken ?? 0,
    };
  } catch {
    return { installed: false, lastCheck: null, recentChecks: 0, recentIssues: 0, recentActions: 0 };
  }
}

export async function getRecentMedicChecks(limit = 20): Promise<Array<{
  id: string;
  checkedAt: string;
  issuesFound: number;
  actionsTaken: number;
  summary: string;
  details: MedicFinding[];
}>> {
  try {
    const prisma = getPrisma();
    const rows = await prisma.medicCheck.findMany({
      orderBy: { checked_at: "desc" },
      take: limit,
    });

    return rows.map((r) => ({
      id: r.id,
      checkedAt: r.checked_at.toISOString(),
      issuesFound: r.issues_found,
      actionsTaken: r.actions_taken,
      summary: r.summary ?? "",
      details: JSON.parse(r.details ?? "[]"),
    }));
  } catch {
    return [];
  }
}
