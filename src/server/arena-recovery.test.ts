// ══════════════════════════════════════════════════════════════════════
// arena-recovery.test.ts — Reconciler arena stuck-step decision tree
// ══════════════════════════════════════════════════════════════════════
//
// The reconciler's arena liveness detector was extracted to
// src/server/arena-recovery.ts so its decision tree is unit-testable:
//
//   1. Session still heartbeating → skip, whatever the step says. A slow-but-
//      healthy arena (hours of rounds) is never touched. The default silence
//      window is 30 minutes, so a 20-minute-old session must still be "fresh".
//   2. Session "running" but silent past the threshold → re-admit:
//        - no checkpoint (crash before round 1 finished) → the restart makes
//          no forward progress, so it is capped at step.max_retries; exhausted
//          → fail fast instead of re-admitting forever (B1)
//        - checkpoint present → resume, uncapped (no retry consumed)
//   3. No running session at all → genuine hang → mark the step+run failed.
//
// These tests drive the tree against a real temp SQLite DB with a fake
// relauncher, so no arena engine is ever launched.
// ══════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { getDb, getPrisma, resetPrisma } from "../db.js";
import { handleStuckArenaSteps } from "./arena-recovery.js";

describe("handleStuckArenaSteps — arena stuck detection & re-admission", () => {
  let tempHome: string;
  const orig: Record<string, string | undefined> = {};

  // Temp DB for the whole file: no test may touch the real ~/.formiga DB.
  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-arena-recovery-"));
    orig.HOME = process.env.HOME;
    orig.FORMIGA_DB_PATH = process.env.FORMIGA_DB_PATH;
    orig.FORMIGA_STATE_DIR = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
    // First getDb() call migrates the schema (src/database/legacy-compat.ts);
    // Prisma shares the same SQLite file.
    getDb();
  });

  after(async () => {
    await resetPrisma();
    for (const [key, value] of Object.entries(orig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM steps");
    db.exec("DELETE FROM arena_sessions");
    db.exec("DELETE FROM runs");
  });

  function insertRun(runId: string, status = "running"): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
         VALUES (?, 'ml-autoresearch', 'test', ?, '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId, status);
  }

  /** A stale, unclaimed, running arena step for runId (default 60min old). */
  function insertArenaStep(
    runId: string,
    opts: { retryCount?: number; maxRetries?: number; staleMinutes?: number } = {},
  ): void {
    const { retryCount = 0, maxRetries = 4, staleMinutes = 60 } = opts;
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, created_at, updated_at)
         VALUES (?, ?, 'arena', 'ml-autoresearch_feature-engineer', 2, '', '', 'running',
                 ?, ?, 'single', datetime('now', ?), datetime('now', ?))`,
      )
      .run(
        `step-arena-${runId}`,
        runId,
        retryCount,
        maxRetries,
        `-${staleMinutes} minutes`,
        `-${staleMinutes} minutes`,
      );
  }

  function insertSession(
    runId: string,
    opts: { stateJson?: string | null; updatedMinutesAgo?: number; status?: string } = {},
  ): void {
    const { stateJson = null, updatedMinutesAgo = 60, status = "running" } = opts;
    getDb()
      .prepare(
        `INSERT INTO arena_sessions (id, run_id, metric_name, metric_direction, benchmark_script, status, state_json, created_at, updated_at)
         VALUES (?, ?, 'f1', 'higher', 'benchmark.py', ?, ?, datetime('now', ?), datetime('now', ?))`,
      )
      .run(
        `session-${runId}`,
        runId,
        status,
        stateJson,
        `-${updatedMinutesAgo} minutes`,
        `-${updatedMinutesAgo} minutes`,
      );
  }

  function readStep(runId: string): { status: string; retry_count: number; output: string | null } {
    return getDb()
      .prepare("SELECT status, retry_count, output FROM steps WHERE id = ?")
      .get(`step-arena-${runId}`) as { status: string; retry_count: number; output: string | null };
  }

  function readRun(runId: string): { status: string } {
    return getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  }

  it("re-admits a no-checkpoint session within retry budget (retry 0→1, step/run stay running)", async () => {
    const runId = "run-nocp-budget";
    insertRun(runId);
    insertArenaStep(runId, { retryCount: 0, maxRetries: 4 });
    insertSession(runId, { stateJson: null }); // stale 60min, no checkpoint

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    assert.deepEqual(relaunched, [{ runId, stepId: `step-arena-${runId}` }], "must re-launch the arena");
    const step = readStep(runId);
    assert.equal(step.status, "running", "re-admission must not fail the step");
    assert.equal(step.retry_count, 1, "a no-checkpoint restart must consume one retry");
    assert.equal(readRun(runId).status, "running", "run must stay running");
  });

  it("fails fast when a no-checkpoint session exhausts the re-admission budget (no relaunch)", async () => {
    const runId = "run-nocp-exhausted";
    insertRun(runId);
    insertArenaStep(runId, { retryCount: 4, maxRetries: 4 });
    insertSession(runId, { stateJson: null });

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    assert.deepEqual(relaunched, [], "must NOT relaunch once the budget is exhausted");
    const step = readStep(runId);
    assert.equal(step.status, "failed", "exhausted no-checkpoint step must fail");
    assert.match(step.output ?? "", /retries exhausted/);
    assert.equal(readRun(runId).status, "failed", "run must fail with the step");
  });

  it("skips a session still heartbeating (and validates the 30-minute default)", async () => {
    const runId = "run-fresh";
    insertRun(runId);
    insertArenaStep(runId, { retryCount: 2, maxRetries: 4 }); // step stale 60min
    insertSession(runId, { stateJson: null, updatedMinutesAgo: 20 }); // session fresh 20min ago

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    // The old default was 10 minutes, so a 20-minute-old session used to be
    // "stuck". With the raised 30-minute default it must still be considered
    // alive and the step must be left completely untouched.
    assert.deepEqual(relaunched, [], "a heartbeating session must never be touched");
    const step = readStep(runId);
    assert.equal(step.status, "running");
    assert.equal(step.retry_count, 2, "retry_count must be untouched");
    assert.equal(readRun(runId).status, "running");
  });

  it("re-admits a checkpointed session without consuming the retry budget", async () => {
    const runId = "run-cp";
    insertRun(runId);
    insertArenaStep(runId, { retryCount: 1, maxRetries: 4 });
    insertSession(runId, { stateJson: "{}" }); // resumable

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    assert.deepEqual(relaunched, [{ runId, stepId: `step-arena-${runId}` }], "must re-launch the arena");
    const step = readStep(runId);
    assert.equal(step.status, "running");
    assert.equal(step.retry_count, 1, "a checkpointed re-admission must not consume retries");
    assert.equal(readRun(runId).status, "running");
  });

  it("marks failed a stuck step whose session is gone (nothing to resume)", async () => {
    const runId = "run-no-session";
    insertRun(runId);
    insertArenaStep(runId, { retryCount: 0, maxRetries: 4 });
    // No arena_sessions row at all.

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    assert.deepEqual(relaunched, [], "no session → nothing to relaunch");
    assert.equal(readStep(runId).status, "failed");
    assert.equal(readRun(runId).status, "failed");
  });

  it("ignores steps that are claimed or whose run already failed (query filter)", async () => {
    const runIdClaimed = "run-claimed";
    insertRun(runIdClaimed);
    insertArenaStep(runIdClaimed, { retryCount: 0, maxRetries: 4 });
    getDb().prepare("UPDATE steps SET claim_pid = 12345 WHERE id = ?").run(`step-arena-${runIdClaimed}`);

    const runIdFailed = "run-failed";
    insertRun(runIdFailed, "failed");
    insertArenaStep(runIdFailed, { retryCount: 0, maxRetries: 4 });
    insertSession(runIdFailed, { stateJson: null });

    const relaunched: Array<{ runId: string; stepId: string }> = [];
    await handleStuckArenaSteps(getPrisma(), {
      relaunch: (rid, sid) => { relaunched.push({ runId: rid, stepId: sid }); },
    });

    assert.deepEqual(relaunched, [], "claimed/failed-run steps are outside the detector's scope");
    assert.equal(readStep(runIdClaimed).status, "running");
    assert.equal(readStep(runIdFailed).status, "running");
  });
});
