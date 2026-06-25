// ══════════════════════════════════════════════════════════════════════
// claim-parallel.test.ts — claimStep semantics around parallel_group
// ══════════════════════════════════════════════════════════════════════
//
// These tests exercise the prev-step filter inside claimStep() (claim.ts),
// specifically the parallel_group exception that lets sibling steps in the
// same group be claimed concurrently. They also verify that the step that
// comes AFTER the group remains blocked until every group sibling is done.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../../dist/db.js";
import { claimStep } from "../../../dist/installer/steps/claim.js";

describe("claimStep parallel_group semantics", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-claim-parallel-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    origStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
    // First getDb() call migrates the schema (creates steps table with
    // parallel_group column, runs table, etc.).
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

  function insertRun(runId: string): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
         VALUES (?, 'ml-pipeline', 'test', 'running', '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId);
  }

  function insertStep(args: {
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    stepIndex: number;
    status: string;
    parallelGroup?: string | null;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, parallel_group, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', '', ?, 0, 3, 'single', ?, datetime('now'), datetime('now'))`,
      )
      .run(
        args.id,
        args.runId,
        args.stepId,
        args.agentId,
        args.stepIndex,
        args.status,
        args.parallelGroup ?? null,
      );
  }

  it("claims two sibling steps in same parallel_group concurrently", () => {
    insertRun("r1");
    insertStep({ id: "s1", runId: "r1", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r1",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "pending",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r1",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "pending",
      parallelGroup: "modelers",
    });

    // First sibling — preceded only by a done step → claimable.
    const r2 = claimStep("modeler-classic", "r1");
    assert.equal(r2.found, true);
    assert.equal(r2.stepId, "s2");

    // Second sibling — s2 is now 'running' and would normally block s3 because
    // s2.step_index < s3.step_index and s2.status NOT IN ('done','skipped').
    // The parallel_group exception in the prev-step filter must skip s2.
    const r3 = claimStep("modeler-advanced", "r1");
    assert.equal(r3.found, true);
    assert.equal(r3.stepId, "s3");
  });

  it("blocks post-group step while any group sibling is still running", () => {
    insertRun("r2");
    insertStep({ id: "s1", runId: "r2", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r2",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "running",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r2",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "pending",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s4",
      runId: "r2",
      stepId: "audit",
      agentId: "ml-critic",
      stepIndex: 3,
      status: "pending",
      // parallel_group: null (post-group step)
    });

    // s4 must wait because the parallel_group exception only applies when
    // BOTH prev.parallel_group and s.parallel_group are non-null AND equal.
    // s4.parallel_group is NULL, so siblings still count as upstream blockers.
    const r = claimStep("ml-critic", "r2");
    assert.equal(r.found, false);
  });

  it("blocks post-group step when only one group member is done", () => {
    insertRun("r3");
    insertStep({ id: "s1", runId: "r3", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r3",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "done",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r3",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "running",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s4",
      runId: "r3",
      stepId: "audit",
      agentId: "ml-critic",
      stepIndex: 3,
      status: "pending",
    });

    const r = claimStep("ml-critic", "r3");
    assert.equal(r.found, false);
  });

  it("allows post-group step once every group member is done", () => {
    insertRun("r4");
    insertStep({ id: "s1", runId: "r4", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r4",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "done",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r4",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "done",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s4",
      runId: "r4",
      stepId: "audit",
      agentId: "ml-critic",
      stepIndex: 3,
      status: "pending",
    });

    const r = claimStep("ml-critic", "r4");
    assert.equal(r.found, true);
    assert.equal(r.stepId, "s4");
  });

  it("group siblings stay blocked when a pre-group (non-group) step is still pending", () => {
    insertRun("r5");
    insertStep({ id: "s1", runId: "r5", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "pending" });
    insertStep({
      id: "s2",
      runId: "r5",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "pending",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r5",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "pending",
      parallelGroup: "modelers",
    });

    // The parallel_group exception ONLY suppresses siblings in the same
    // group — the eda step (parallel_group=NULL) is a real blocker.
    assert.equal(claimStep("modeler-classic", "r5").found, false);
    assert.equal(claimStep("modeler-advanced", "r5").found, false);
  });

  it("treats different parallel_groups as non-siblings (still block each other)", () => {
    insertRun("r6");
    insertStep({ id: "s1", runId: "r6", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r6",
      stepId: "a",
      agentId: "agent-a",
      stepIndex: 1,
      status: "pending",
      parallelGroup: "g1",
    });
    insertStep({
      id: "s3",
      runId: "r6",
      stepId: "b",
      agentId: "agent-b",
      stepIndex: 2,
      status: "pending",
      parallelGroup: "g2",
    });

    // s2 is claimable — only the done eda step precedes it.
    const r2 = claimStep("agent-a", "r6");
    assert.equal(r2.found, true);
    assert.equal(r2.stepId, "s2");

    // s3 must NOT skip s2: their parallel_groups differ, so the exception
    // does not apply. s2 is now running → s3 is blocked.
    const r3 = claimStep("agent-b", "r6");
    assert.equal(r3.found, false);
  });

  it("ignores parallel_group when run is not 'running'", () => {
    insertRun("r7");
    getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = 'r7'").run();
    insertStep({ id: "s1", runId: "r7", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r7",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "pending",
      parallelGroup: "modelers",
    });

    // run.status='paused' blocks any claim regardless of parallel_group.
    const r = claimStep("modeler-classic", "r7");
    assert.equal(r.found, false);
  });

  it("only matches the requested agent within a parallel_group", () => {
    insertRun("r8");
    insertStep({ id: "s1", runId: "r8", stepId: "eda", agentId: "data-analyst", stepIndex: 0, status: "done" });
    insertStep({
      id: "s2",
      runId: "r8",
      stepId: "model-classic",
      agentId: "modeler-classic",
      stepIndex: 1,
      status: "pending",
      parallelGroup: "modelers",
    });
    insertStep({
      id: "s3",
      runId: "r8",
      stepId: "model-advanced",
      agentId: "modeler-advanced",
      stepIndex: 2,
      status: "pending",
      parallelGroup: "modelers",
    });

    // Asking for modeler-classic must not claim modeler-advanced's step
    // even though both are in the same parallel_group.
    const r = claimStep("modeler-classic", "r8");
    assert.equal(r.found, true);
    assert.equal(r.stepId, "s2");

    const stillPending = getDb()
      .prepare("SELECT status FROM steps WHERE id = 's3'")
      .get() as { status: string };
    assert.equal(stillPending.status, "pending");
  });
});
