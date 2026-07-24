/**
 * Integration tests for agent log round-summary (RF-6, issue #78).
 *
 * The pi-output file is ephemeral (deleted after the agent finishes), so
 * a DS cannot review an agent's reasoning after the run. recordRoundSummary
 * persists the outcome + final assistant text (truncated) as an agent_event
 * so it survives. Honors suppressRecording (heartbeat backoff).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetPrisma, getPrisma } from "../dist/db.js";
import { migrate } from "../dist/database/migrations.js";
import { recordRoundSummary, type ActivityContext } from "../dist/installer/scheduler/activity-recorder.js";

// ── Environment isolation ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-agent-log-summary-"));
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

describe("agent log round-summary (RF-6)", () => {
  let runId: string;
  let stepId: string;
  let ctx: ActivityContext;
  const agentId = "ml-autoresearch_feature-engineer";

  before(() => {
    const db = getDb();
    migrate(db);
    resetPrisma();

    runId = crypto.randomUUID();
    stepId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'ml-autoresearch', 'summary test', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'features', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepId, runId, agentId, now, now);

    ctx = { runId, stepId, agentId };
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM agent_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  it("persists a round_summary event with outcome + assistant text", async () => {
    await recordRoundSummary(ctx, {
      outcome: "work_done",
      assistantTextTail: "I built features.parquet and split.pkl with StandardScaler.",
      assistantTextTruncated: false,
      tokenUsage: 1234,
      outputPreview: "STATUS: done...",
    });

    const events = await getPrisma().agentEvent.findMany({
      where: { run_id: runId, event_type: "round_summary" },
    });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.agent_id, agentId);
    assert.equal(e.step_id, stepId);
    assert.ok(e.tool_result?.includes("outcome=work_done"), "tool_result should carry outcome");
    assert.ok(e.tool_result?.includes("tokens=1234"), "tool_result should carry token usage");
    assert.ok(e.thinking?.includes("StandardScaler"), "thinking should carry assistant text");
  });

  it("does NOT persist when suppressRecording is set (heartbeat backoff)", async () => {
    const before = await getPrisma().agentEvent.count({ where: { run_id: runId, event_type: "round_summary" } });
    await recordRoundSummary({ ...ctx, suppressRecording: true }, {
      outcome: "heartbeat",
      assistantTextTail: "should not be persisted",
      assistantTextTruncated: false,
    });
    const after = await getPrisma().agentEvent.count({ where: { run_id: runId, event_type: "round_summary" } });
    assert.equal(after, before, "no new event should be recorded when suppressed");
  });

  it("records heartbeat outcome without assistant text", async () => {
    await recordRoundSummary(ctx, {
      outcome: "heartbeat",
      assistantTextTail: "",
      assistantTextTruncated: true,
    });
    const events = await getPrisma().agentEvent.findMany({
      where: { run_id: runId, event_type: "round_summary", tool_result: { contains: "outcome=heartbeat" } },
    });
    assert.ok(events.length >= 1);
    const last = events[events.length - 1];
    assert.ok(last.tool_result?.includes("text_truncated=true"), "should flag truncated text");
  });
});
