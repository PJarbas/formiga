/**
 * Regression tests for RF-3 (spec §1.4 / §5.2) — orphaned running steps
 * whose owning process (claim_pid) is dead.
 *
 * Run 367d0f4e stuck forever because a feature-engineer claimed the
 * `features` step then died in a heartbeat loop; the step stayed
 * "running" with a dead claim_pid and no existing recovery caught it
 * (stale-pending needs claim_pid NULL; run-timeout needs claim_pid NULL;
 * cleanupAbandonedSteps used a ~20-65min threshold and never probed
 * liveness, and heartbeats kept runs.updated_at fresh).
 *
 * These tests validate findOrphanedRunningSteps + remediateOrphanedStep:
 *   1. running step with a DEAD claim_pid (past threshold) → detected + reset to pending
 *   2. running step with a LIVE claim_pid → NOT detected
 *   3. running step with dead pid but fresh claim_updated_at (< threshold) → NOT detected
 *   4. after MAX_ABANDON_RESETS orphan recoveries → step fails + run fails
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  findOrphanedRunningSteps,
  remediateOrphanedStep,
} from "../dist/installer/step-ops.js";
import { getDb, resetPrisma } from "../dist/db.js";
import { getRunEvents } from "../dist/installer/events.js";
// migrate() creates the schema via DDL (CREATE TABLE IF NOT EXISTS). The
// Prisma singleton does not auto-run migrations on a fresh tmpdir DB, so
// we apply the DDL explicitly to guarantee tables exist.
import { migrate } from "../dist/database/migrations.js";

// ── Environment isolation (same pattern as orphaned-step-recovery.test.ts) ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-orphan-running-"));
process.env.FORMIGA_STATE_DIR = _testIsolationDir;
process.env.FORMIGA_DB_PATH = path.join(_testIsolationDir, "formiga.db");
// Use a short threshold so tests don't have to wait 90s. The freshness
// filter still applies — we back-date claim_updated_at explicitly.
process.env.FORMIGA_ORPHAN_RUNNING_THRESHOLD_S = "1";

process.on("exit", () => {
  if (_savedStateDir === undefined) delete process.env.FORMIGA_STATE_DIR;
  else process.env.FORMIGA_STATE_DIR = _savedStateDir;
  if (_savedDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
  else process.env.FORMIGA_DB_PATH = _savedDbPath;
  try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const TEST_AGENT = "test-orphan-running-agent";

/** Spawn a long-lived child just to obtain a real, live PID, then kill it
 *  and wait for it to be reaped (exit event) so process.kill(pid,0) reports
 *  it as dead. Without waiting, a SIGKILL'd-but-unreaped zombie still answers
 *  signal 0 on macOS. */
async function obtainDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid!;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  return pid;
}

/** Spawn a long-lived child and keep it alive (returns pid + a kill fn). */
function obtainLivePid(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
    stdio: "ignore",
  });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

function ts(): string {
  return new Date().toISOString();
}
function pastTs(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

describe("orphan-running recovery (RF-3)", () => {
  let deadRunId: string;
  let deadStepId: string;
  let deadPid: number;
  let liveRunId: string;
  let liveStepId: string;
  let livePidHandle: { pid: number; kill: () => void };
  let freshRunId: string;
  let freshStepId: string;
  let freshPid: number;
  let exhaustedRunId: string;
  let exhaustedStepId: string;
  let exhaustedPid: number;

  before(async () => {
    const db = getDb();
    // Ensure schema exists in the isolated tmpdir DB (DDL is idempotent).
    migrate(db);
    // Force Prisma to re-bind to the isolated DB path (singleton may have
    // been created by another test/module with a different path).
    resetPrisma();
    deadPid = await obtainDeadPid();
    livePidHandle = obtainLivePid();
    freshPid = await obtainDeadPid();
    exhaustedPid = await obtainDeadPid();

    deadRunId = crypto.randomUUID();
    liveRunId = crypto.randomUUID();
    freshRunId = crypto.randomUUID();
    exhaustedRunId = crypto.randomUUID();
    deadStepId = crypto.randomUUID();
    liveStepId = crypto.randomUUID();
    freshStepId = crypto.randomUUID();
    exhaustedStepId = crypto.randomUUID();

    // Dead-PID step: running, claim_updated_at back-dated past threshold → should be reclaimed
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'dead pid', 'running', '{}', ?, ?)"
    ).run(deadRunId, ts(), ts());
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, abandoned_count, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'dead-step', ?, 0, '', '', 'running', 0, 2, 'single', 0, ?, ?, ?, ?)`
    ).run(deadStepId, deadRunId, TEST_AGENT, deadPid, pastTs(30), ts(), pastTs(30));

    // Live-PID step: running with a live claim → should NOT be reclaimed
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'live pid', 'running', '{}', ?, ?)"
    ).run(liveRunId, ts(), ts());
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, abandoned_count, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'live-step', ?, 0, '', '', 'running', 0, 2, 'single', 0, ?, ?, ?, ?)`
    ).run(liveStepId, liveRunId, TEST_AGENT, livePidHandle.pid, pastTs(30), ts(), pastTs(30));

    // Fresh step: dead PID but claim_updated_at is recent (< 1s threshold) → should NOT be reclaimed
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'fresh claim', 'running', '{}', ?, ?)"
    ).run(freshRunId, ts(), ts());
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, abandoned_count, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'fresh-step', ?, 0, '', '', 'running', 0, 2, 'single', 0, ?, ?, ?, ?)`
    ).run(freshStepId, freshRunId, TEST_AGENT, freshPid, ts(), ts(), ts());

    // Exhausted step: dead PID, abandoned_count already at MAX_ABANDON_RESETS (5) → should FAIL
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'exhausted', 'running', '{}', ?, ?)"
    ).run(exhaustedRunId, ts(), ts());
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, abandoned_count, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'exhausted-step', ?, 0, '', '', 'running', 0, 2, 'single', 4, ?, ?, ?, ?)`
    ).run(exhaustedStepId, exhaustedRunId, TEST_AGENT, exhaustedPid, pastTs(30), ts(), pastTs(30));
  });

  after(() => {
    livePidHandle.kill();
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id IN (?, ?, ?, ?)").run(deadStepId, liveStepId, freshStepId, exhaustedStepId);
    db.prepare("DELETE FROM runs WHERE id IN (?, ?, ?, ?)").run(deadRunId, liveRunId, freshRunId, exhaustedRunId);
  });

  it("finds the dead-pid orphan but not the live-pid or fresh-claim steps", async () => {
    const orphans = await findOrphanedRunningSteps();
    const ids = orphans.map((o) => o.id);
    assert.ok(ids.includes(deadStepId), "dead-pid step should be detected");
    assert.ok(!ids.includes(liveStepId), "live-pid step should NOT be detected");
    assert.ok(!ids.includes(freshStepId), "fresh-claim step should NOT be detected (under threshold)");
    assert.ok(ids.includes(exhaustedStepId), "exhausted dead-pid step should be detected");
  });

  it("resets a dead-pid orphan to pending, clears claim_pid, bumps abandoned_count, emits event", async () => {
    const runId = await remediateOrphanedStep({
      id: deadStepId,
      step_id: "dead-step",
      run_id: deadRunId,
      agent_id: TEST_AGENT,
      claim_pid: deadPid,
      claim_updated_at: new Date(pastTs(30)),
    });
    assert.equal(runId, deadRunId, "should return runId to re-nudge");

    const db = getDb();
    const step = db.prepare(
      "SELECT status, claim_pid, abandoned_count FROM steps WHERE id = ?"
    ).get(deadStepId) as { status: string; claim_pid: number | null; abandoned_count: number };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.claim_pid, null, "claim_pid should be cleared");
    assert.equal(step.abandoned_count, 1, "abandoned_count should bump to 1");

    const events = getRunEvents(deadRunId);
    assert.ok(
      events.some((e) => e.event === "step.orphan_reclaimed"),
      "should emit step.orphan_reclaimed event",
    );
  });

  it("fails the step and run when abandon retries are exhausted", async () => {
    const runId = await remediateOrphanedStep({
      id: exhaustedStepId,
      step_id: "exhausted-step",
      run_id: exhaustedRunId,
      agent_id: TEST_AGENT,
      claim_pid: exhaustedPid,
      claim_updated_at: new Date(pastTs(30)),
    });
    assert.equal(runId, null, "should NOT return a runId (run is terminal)");

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(exhaustedStepId) as { status: string };
    assert.equal(step.status, "failed", "step should be failed");
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(exhaustedRunId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });
});
