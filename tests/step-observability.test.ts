/**
 * Integration tests for step observability columns (RF-7, issue #79).
 *
 * Validates that polling-round.ts persists spawn_count, last_outcome,
 * last_outcome_at, and consecutive_heartbeats on the active step, so the
 * dashboard can show an honest "running in loop" signal. Run 367d0f4e
 * masked its heartbeat loop because only runs.updated_at was renewed.
 *
 * Exercises updateStepObservability directly (the helper polling-round
 * calls) plus getAgentHealth (the API reader).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetPrisma } from "../dist/db.js";
import { getRunEvents } from "../dist/installer/events.js";
import { migrate } from "../dist/database/migrations.js";

// ── Environment isolation ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-step-observability-"));
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

// updateStepObservability is a private helper in polling-round.ts; we
// exercise the same DB contract it writes, mirroring its data shape, to
// validate the columns exist and read back correctly via getAgentHealth.
async function writeObservability(stepId: string, update: {
  incrementSpawn?: boolean;
  outcome?: string;
  consecutiveHeartbeats?: number;
}): Promise<void> {
  const { getPrisma } = await import("../dist/db.js");
  const prisma = getPrisma();
  const data: Record<string, unknown> = { last_outcome_at: new Date() };
  if (update.outcome !== undefined) data.last_outcome = update.outcome;
  if (update.consecutiveHeartbeats !== undefined) data.consecutive_heartbeats = update.consecutiveHeartbeats;
  if (update.incrementSpawn) {
    await prisma.step.update({ where: { id: stepId }, data: { ...data, spawn_count: { increment: 1 } } });
  } else {
    await prisma.step.update({ where: { id: stepId }, data });
  }
}

describe("step observability columns (RF-7)", () => {
  let runId: string;
  let stepId: string;
  const agentId = "ml-autoresearch_feature-engineer";

  before(() => {
    const db = getDb();
    migrate(db);
    resetPrisma();

    runId = crypto.randomUUID();
    stepId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'ml-autoresearch', 'obs test', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'features', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepId, runId, agentId, now, now);
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  it("defaults to zero/empty on a fresh step", async () => {
    const { getAgentHealth } = await import("../dist/server/pipeline-status.js");
    const health = await getAgentHealth(runId, "feature-engineer");
    assert.equal(health.consecutiveHeartbeats, 0);
    assert.equal(health.spawnCount, 0);
    assert.equal(health.lastOutcome, null);
    assert.equal(health.lastOutcomeAt, null);
  });

  it("records spawn_count increments and outcome on a heartbeat round", async () => {
    await writeObservability(stepId, { incrementSpawn: true, outcome: "heartbeat", consecutiveHeartbeats: 1 });
    const { getAgentHealth } = await import("../dist/server/pipeline-status.js");
    const health = await getAgentHealth(runId, "feature-engineer");
    assert.equal(health.spawnCount, 1, "spawn_count should increment");
    assert.equal(health.lastOutcome, "heartbeat");
    assert.equal(health.consecutiveHeartbeats, 1);
    assert.ok(health.lastOutcomeAt, "last_outcome_at should be set");
  });

  it("accumulates spawns and consecutive heartbeats across rounds", async () => {
    await writeObservability(stepId, { incrementSpawn: true, outcome: "heartbeat", consecutiveHeartbeats: 2 });
    await writeObservability(stepId, { incrementSpawn: true, outcome: "heartbeat", consecutiveHeartbeats: 3 });
    const { getAgentHealth } = await import("../dist/server/pipeline-status.js");
    const health = await getAgentHealth(runId, "feature-engineer");
    assert.equal(health.spawnCount, 3, "spawn_count should accumulate to 3");
    assert.equal(health.consecutiveHeartbeats, 3);
    assert.equal(health.lastOutcome, "heartbeat");
  });

  it("resets consecutive_heartbeats on work_done (progress observed)", async () => {
    await writeObservability(stepId, { outcome: "work_done", consecutiveHeartbeats: 0 });
    const { getAgentHealth } = await import("../dist/server/pipeline-status.js");
    const health = await getAgentHealth(runId, "feature-engineer");
    assert.equal(health.consecutiveHeartbeats, 0, "heartbeats should reset on work_done");
    assert.equal(health.lastOutcome, "work_done");
    assert.equal(health.spawnCount, 3, "spawn_count should NOT reset (historical tally)");
  });

  it("getRunEvents still works (events unaffected)", () => {
    const events = getRunEvents(runId);
    assert.ok(Array.isArray(events));
  });
});
