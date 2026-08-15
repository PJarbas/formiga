// ══════════════════════════════════════════════════════════════════════
// cron-manager-nudge.test.ts — M-1: nudge must not double-launch a job
// that a concurrent timer tick put in-flight while the nudge was awaiting.
// ══════════════════════════════════════════════════════════════════════
//
// nudgeScheduledRuns checks `inFlightJobs.has(jobId)` BEFORE several awaits
// (loadSpec, agent lookup). If a timer tick finishes a round and re-marks the
// job in-flight during those awaits, the nudge must re-check the marker
// immediately before the fire-and-forget launch and skip (M-1). This test
// simulates that race via the `loadWorkflowSpec` override: it marks the job
// in-flight mid-await, then asserts the nudge reports skipped_in_flight
// instead of launching a duplicate round.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../../dist/db.js";
import { nudgeScheduledRuns } from "../../../dist/installer/scheduler/cron-manager.js";
import { jobMetadata, inFlightJobs } from "../../../dist/installer/scheduler/shared.js";
import type { WorkflowSpec } from "../../../dist/installer/types.js";

describe("nudgeScheduledRuns in-flight re-check (M-1)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-nudge-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    origStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
    // First getDb() call migrates the schema.
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
    for (const id of [...jobMetadata.keys()]) jobMetadata.delete(id);
  });

  function insertRun(runId: string): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
         VALUES (?, 'ml-pipeline', 'test', 'running', '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId);
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

  const workflowSpec: WorkflowSpec = {
    id: "ml-pipeline",
    name: "ML Pipeline",
    agents: [{ id: "developer", workspace: { baseDir: "/tmp", files: {} } }],
    steps: [],
  };

  it("skips a job that became in-flight during the nudge's awaits (M-1)", async () => {
    const runId = "run-m1";
    const jobId = `formiga-ml-pipeline-${runId}-developer`;
    insertRun(runId);
    insertPendingStep(runId, "developer");
    // Register the job's metadata so nudgeScheduledRuns picks it up.
    jobMetadata.set(jobId, {
      id: jobId,
      workflowId: "ml-pipeline",
      runId,
      agentId: "developer",
      intervalMinutes: 5,
      createdAt: new Date().toISOString(),
    });

    // Simulate the race: while nudge awaits loadWorkflowSpec, a concurrent
    // timer tick completes a round and re-marks the job in-flight. Without
    // the M-1 re-check the nudge would launch a duplicate polling round.
    const loadWorkflowSpec = async (): Promise<WorkflowSpec> => {
      inFlightJobs.add(jobId);
      return workflowSpec;
    };

    const result = await nudgeScheduledRuns([runId], { loadWorkflowSpec });

    assert.equal(result.launched, 0, "must not launch a job that is in-flight");
    assert.equal(result.skippedInFlight, 1, "must count the job as skipped-in-flight");
    const job = result.jobs.find((j) => j.runId === runId && j.agentId === "developer");
    assert.equal(job?.status, "skipped_in_flight");
  });
});
