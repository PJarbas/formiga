// ══════════════════════════════════════════════════════════════════════
// polling-round-marker.test.ts — AL-2/AL-1: paused/draining_pause rounds
// must clear the in-flight marker so the job isn't stuck forever, and the
// draining branch must drive finalizeDrainingPause on the heartbeat path.
// ══════════════════════════════════════════════════════════════════════
//
// executePollingRound marks a job in-flight at entry (tryMarkJobInFlight).
// The paused and draining_pause branches return early, BEFORE the big
// try/finally that clears the marker — so without an explicit delete the
// job stays in-flight and every later tick is skipped forever (AL-2).
// Additionally, the draining_pause branch must call finalizeDrainingPause
// so a drain whose in-flight work has finished actually lands on paused
// even when no step-completion event fires (AL-1).

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../../dist/db.js";
import { executePollingRound } from "../../../dist/installer/scheduler/polling-round.js";
import { inFlightJobs, inFlightChildren } from "../../../dist/installer/scheduler/shared.js";
import type { WorkflowAgent, WorkflowSpec } from "../../../dist/installer/types.js";

describe("executePollingRound paused/draining marker cleanup (AL-2/AL-1)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-round-marker-test-"));
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
    db.exec("DELETE FROM job_registry");
    for (const id of [...inFlightJobs]) inFlightJobs.delete(id);
    for (const id of [...inFlightChildren.keys()]) inFlightChildren.delete(id);
  });

  function insertRun(runId: string, status: string, schedulingStatus?: string): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, scheduling_status, context, created_at, updated_at)
         VALUES (?, 'ml-pipeline', 'test', ?, ?, '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId, status, schedulingStatus ?? null);
  }

  function insertPendingStep(runId: string, agentId: string): void {
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, created_at, updated_at)
         VALUES (?, ?, 'plan', ?, 0, '', '', 'pending', 0, 3, 'single', datetime('now'), datetime('now'))`,
      )
      .run(`step-${runId}-${agentId}`, runId, agentId);
  }

  const agent: WorkflowAgent = { id: "developer", workspace: { baseDir: "/tmp", files: {} } };
  const workflow: WorkflowSpec = { id: "ml-pipeline", agents: [agent], steps: [] };

  function job(runId: string): { id: string; runId: string; agentId: string; workflowId: string; intervalMinutes: number; workingDirectoryForHarness: string } {
    return {
      id: `formiga-ml-pipeline-${runId}-developer`,
      runId,
      agentId: "developer",
      workflowId: "ml-pipeline",
      intervalMinutes: 5,
      workingDirectoryForHarness: tempHome,
    };
  }

  it("clears the in-flight marker for a paused run (AL-2)", async () => {
    const runId = "run-paused-marker";
    insertRun(runId, "paused");
    insertPendingStep(runId, "developer");
    const j = job(runId);

    await executePollingRound(j, agent, workflow);

    assert.equal(inFlightJobs.has(j.id), false, "paused round must not leave the job in-flight");
    assert.equal(inFlightChildren.has(j.id), false, "paused round must not leave a child marker");
  });

  it("clears the in-flight marker and finalizes drain for a draining_pause run (AL-2/AL-1)", async () => {
    const runId = "run-drain-marker";
    // Draining run with a pending step but NO running steps — the drain's
    // in-flight work has finished, so the heartbeat path must finalize it
    // to paused (AL-1) and clear the marker (AL-2).
    insertRun(runId, "running", "draining_pause");
    insertPendingStep(runId, "developer");
    const j = job(runId);

    await executePollingRound(j, agent, workflow);

    assert.equal(inFlightJobs.has(j.id), false, "draining round must not leave the job in-flight");
    assert.equal(inFlightChildren.has(j.id), false, "draining round must not leave a child marker");

    const run = getDb().prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
      status: string;
      scheduling_status: string | null;
    };
    assert.equal(run.status, "paused", "drain with no in-flight work must finalize to paused");
    assert.equal(run.scheduling_status, "paused");
  });

  it("leaves a draining_pause run draining when in-flight work remains (AL-1 safety)", async () => {
    const runId = "run-drain-busy";
    insertRun(runId, "running", "draining_pause");
    insertPendingStep(runId, "developer");
    // A still-running step (in-flight work) must keep the run draining.
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, created_at, updated_at)
         VALUES (?, ?, 'build', ?, 1, '', '', 'running', 0, 3, 'single', datetime('now'), datetime('now'))`,
      )
      .run(`step-run-${runId}-build`, runId, "developer");
    const j = job(runId);

    await executePollingRound(j, agent, workflow);

    assert.equal(inFlightJobs.has(j.id), false, "draining round must still clear the marker");
    const run = getDb().prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as {
      status: string;
      scheduling_status: string | null;
    };
    assert.equal(run.status, "running", "in-flight work must keep the run draining");
    assert.equal(run.scheduling_status, "draining_pause");
  });
});
