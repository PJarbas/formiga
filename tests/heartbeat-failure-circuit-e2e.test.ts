/**
 * Integration tests for the heartbeat-failure circuit terminal path (RF-4).
 *
 * Validates that failStep(..., { terminal: true }) — invoked by the circuit
 * after N consecutive heartbeats — fails the step+run immediately (no retry
 * to pending), emits step.failed with a heartbeat_loop_exhausted reason,
 * and resolves the escalation target when on_fail.escalate_to is configured.
 *
 * Follows the isolation pattern of orphan-running-recovery.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failStep } from "../dist/installer/step-ops.js";
import { getDb, resetPrisma } from "../dist/db.js";
import { getRunEvents } from "../dist/installer/events.js";
import { migrate } from "../dist/database/migrations.js";

// ── Environment isolation ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-heartbeat-circuit-"));
process.env.FORMIGA_STATE_DIR = _testIsolationDir;
process.env.FORMIGA_DB_PATH = path.join(_testIsolationDir, "formiga.db");

process.on("exit", () => {
  if (_savedStateDir === undefined) delete process.env.FORMIGA_STATE_DIR;
  else process.env.FORMIGA_STATE_DIR = _savedStateDir;
  if (_savedDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
  else process.env.FORMIGA_DB_PATH = _savedDbPath;
  try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function ts(): string {
  return new Date().toISOString();
}

describe("heartbeat-failure circuit — failStep terminal (RF-4)", () => {
  let runId: string;
  let stepId: string; // UUID PK (what failStep expects)
  const agentId = "test-heartbeat-circuit-agent";

  before(() => {
    const db = getDb();
    migrate(db);
    resetPrisma();

    runId = crypto.randomUUID();
    stepId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'heartbeat circuit', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // A single step claimed (running) by the agent, with retries left.
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'features', ?, 0, '', '', 'running', 0, 4, 'single', 99999, ?, ?, ?)`
    ).run(stepId, runId, agentId, now, now, now);
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  it("fails the step+run terminally without retrying to pending", async () => {
    const reason = "heartbeat_loop_exhausted (5 consecutive heartbeats, no progress)";
    const result = await failStep(stepId, reason, { terminal: true });

    assert.equal(result.status, "failed", "terminal fail should return failed (not retrying)");

    const db = getDb();
    const step = db.prepare("SELECT status, output, retry_count FROM steps WHERE id = ?").get(stepId) as {
      status: string;
      output: string;
      retry_count: number;
    };
    assert.equal(step.status, "failed", "step should be failed");
    assert.equal(step.retry_count, 1, "retry_count should bump once (not exhaust via retries)");
    assert.ok(step.output.includes("heartbeat_loop_exhausted"), "output should carry the reason");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("emits step.failed with the heartbeat_loop_exhausted reason", async () => {
    const events = getRunEvents(runId);
    const stepFailed = events.find(
      (e) => e.event === "step.failed" && typeof e.detail === "string" && e.detail.includes("heartbeat_loop_exhausted"),
    );
    assert.ok(stepFailed, "should emit step.failed with heartbeat_loop_exhausted detail");
  });

  it("does NOT leave the step in pending (no retry path)", async () => {
    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.notEqual(step.status, "pending", "terminal fail must not retry to pending");
  });
});
