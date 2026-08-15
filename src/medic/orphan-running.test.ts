// ══════════════════════════════════════════════════════════════════════
// orphan-running.test.ts — AL-1: findOrphanedRunningSteps must never
// reclaim a step whose run is being paused (draining_pause), otherwise the
// reclaim re-activates a run the user asked to pause.
// ══════════════════════════════════════════════════════════════════════
//
// The query filters `run.status === "running"` AND (AL-1)
// `run.scheduling_status !== "draining_pause"`. A step whose claim_pid is
// dead in a draining run must NOT be reported as orphaned; the same step in
// a normally-running run must still be reported (control).

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { getDb } from "../../dist/db.js";
import { findOrphanedRunningSteps } from "../../dist/medic/orphan-running.js";

describe("findOrphanedRunningSteps draining_pause exclusion (AL-1)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-orphan-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    origStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
    getDb();
  });

  after(() => {
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origDbPath) process.env.FORMIGA_DB_PATH = origDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    if (origStateDir) process.env.FORMIGA_STATE_DIR = origStateDir;
    else delete process.env.FORMIGA_STATE_DIR;
    rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM steps");
    db.exec("DELETE FROM runs");
  });

  function insertRun(runId: string, status: string, schedulingStatus?: string): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, scheduling_status, context, created_at, updated_at)
         VALUES (?, 'ml-pipeline', 'test', ?, ?, '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId, status, schedulingStatus ?? null);
  }

  function insertRunningStep(runId: string, agentId: string, deadPid: number): void {
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, claim_pid, claim_updated_at,
                            created_at, updated_at)
         VALUES (?, ?, 'plan', ?, 0, '', '', 'running', 0, 3, 'single', ?, datetime('now', '-10 minutes'),
                 datetime('now'), datetime('now'))`,
      )
      .run(`step-${runId}-${agentId}`, runId, agentId, deadPid);
  }

  /** Spawn a child that exits immediately and capture its (now-dead) pid. */
  function deadPid(): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      child.on("exit", () => resolve(child.pid as number));
    });
  }

  it("does not reclaim a step from a draining_pause run (AL-1)", async () => {
    const pid = await deadPid();
    insertRun("run-draining", "running", "draining_pause");
    insertRunningStep("run-draining", "developer", pid);

    const orphans = await findOrphanedRunningSteps();
    assert.equal(orphans.length, 0, "draining_pause run's dead step must not be reclaimed");
  });

  it("does not reclaim a step from a paused run (status filter)", async () => {
    const pid = await deadPid();
    insertRun("run-paused", "paused", "paused");
    insertRunningStep("run-paused", "developer", pid);

    const orphans = await findOrphanedRunningSteps();
    assert.equal(orphans.length, 0, "paused run's dead step must not be reclaimed");
  });

  it("still reclaims a dead step from a normally-running run (control)", async () => {
    const pid = await deadPid();
    insertRun("run-normal", "running", null);
    insertRunningStep("run-normal", "developer", pid);

    const orphans = await findOrphanedRunningSteps();
    assert.equal(orphans.length, 1, "normal running run's dead step must still be reclaimed");
    assert.equal(orphans[0]!.run_id, "run-normal");
  });
});
