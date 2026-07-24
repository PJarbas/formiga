/**
 * Integration tests for agent log retention (RF-6, issue #78).
 *
 * round_summary events are unredacted and can echo dataset values (privacy,
 * Q3). pruneAgentEvents bounds exposure: deletes agent_events older than
 * FORMIGA_AGENT_LOG_RETENTION_DAYS (default 7). Safe for active runs —
 * their events are recent.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetPrisma, getPrisma } from "../dist/db.js";
import { migrate } from "../dist/database/migrations.js";
import { pruneAgentEvents } from "../dist/medic/medic.js";

// ── Environment isolation ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-agent-log-retention-"));
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

describe("agent log retention (RF-6)", () => {
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
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'ml-autoresearch', 'retention test', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'features', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepId, runId, agentId, now, now);
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM agent_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  afterEach(() => {
    delete process.env.FORMIGA_AGENT_LOG_RETENTION_DAYS;
  });

  async function insertEvent(createdAt: Date): Promise<void> {
    await getPrisma().agentEvent.create({
      data: {
        run_id: runId,
        step_id: stepId,
        agent_id: agentId,
        event_type: "round_summary",
        tool_result: `outcome=work_done (created ${createdAt.toISOString()})`,
        created_at: createdAt,
      },
    });
  }

  it("deletes events older than the retention window (1 day)", async () => {
    process.env.FORMIGA_AGENT_LOG_RETENTION_DAYS = "1";
    // 3 days ago → should be pruned
    await insertEvent(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    // 1 hour ago → should remain
    await insertEvent(new Date(Date.now() - 1 * 60 * 60 * 1000));

    const before = await getPrisma().agentEvent.count({ where: { run_id: runId } });
    assert.equal(before, 2);

    const deleted = await pruneAgentEvents();
    assert.equal(deleted, 1, "one old event should be pruned");

    const after = await getPrisma().agentEvent.count({ where: { run_id: runId } });
    assert.equal(after, 1, "recent event should remain");
  });

  it("defaults to 7 days when env is unset", async () => {
    delete process.env.FORMIGA_AGENT_LOG_RETENTION_DAYS;
    // 2 days ago → within default 7-day window, should remain
    await insertEvent(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    // 10 days ago → past 7-day default, should be pruned
    await insertEvent(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));

    const deleted = await pruneAgentEvents();
    assert.equal(deleted, 1, "only the 10-day-old event should be pruned with default 7d");
  });

  it("falls back to 7 days on invalid env value", async () => {
    process.env.FORMIGA_AGENT_LOG_RETENTION_DAYS = "not-a-number";
    await insertEvent(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const deleted = await pruneAgentEvents();
    assert.equal(deleted, 1, "invalid env should fall back to 7 days");
  });

  it("never throws (best-effort) and returns 0 when nothing to prune", async () => {
    process.env.FORMIGA_AGENT_LOG_RETENTION_DAYS = "1";
    // Clear old events first
    await pruneAgentEvents();
    const deleted = await pruneAgentEvents();
    assert.equal(deleted, 0);
  });
});
