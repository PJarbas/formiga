/**
 * Integration tests for RF-2 complete (issue #74): the scheduler claims the
 * step and injects stepId/input into the prompt, so the agent never runs
 * `step claim` via the CLI.
 *
 * Validates the claimStep → buildPollingPrompt(work) contract end-to-end:
 * a pending step is claimed, the resolved input is injected, and the
 * generated prompt contains the stepId + input but no `step claim`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetPrisma } from "../dist/db.js";
import { migrate } from "../dist/database/migrations.js";
import { claimStep } from "../dist/installer/step-ops.js";
import { buildPollingPrompt } from "../dist/installer/scheduler/prompts.js";

// ── Environment isolation ──
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-inject-claim-"));
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

describe("RF-2 complete: claim injected into prompt", () => {
  let runId: string;
  let stepPkId: string; // UUID PK (what claimStep returns as stepId)
  const agentId = "ml-autoresearch_feature-engineer";

  before(() => {
    const db = getDb();
    migrate(db);
    resetPrisma();

    runId = crypto.randomUUID();
    stepPkId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'ml-autoresearch', 'inject claim', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // A pending features step claimable by the feature-engineer.
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'features', ?, 0, 'Build features for {{dataset_path}}', 'STATUS: done',
        'pending', 0, 2, 'single', ?, ?)`
    ).run(stepPkId, runId, agentId, now, now);

    // Context the template resolver needs (dataset_path variable).
    db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(
      JSON.stringify({ dataset_path: "data/classification.csv" }),
      runId,
    );
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id = ?").run(stepPkId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  });

  it("claimStep returns the stepId + resolved input for a pending step", async () => {
    const claim = await claimStep(agentId, runId);
    assert.equal(claim.found, true, "should find and claim the pending step");
    assert.equal(claim.stepId, stepPkId, "should return the step PK as stepId");
    assert.ok(claim.resolvedInput, "should resolve the input template");
    assert.ok(
      claim.resolvedInput!.includes("data/classification.csv"),
      "resolved input should substitute the dataset_path variable",
    );

    // Step should now be running (claimed).
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepPkId) as { status: string };
    assert.equal(step.status, "running", "claimStep should move step to running");
  });

  it("buildPollingPrompt(work) injects the claimed stepId + input, no step claim", async () => {
    const claim = await claimStep(agentId, runId); // already claimed → not found
    // Use the first claim's result (simulate the scheduler path):
    const work = { stepId: stepPkId, input: "Build features for data/classification.csv" };
    const prompt = await buildPollingPrompt("ml-autoresearch", agentId, runId, "", work);

    assert.ok(prompt.includes(stepPkId), "prompt should inject the claimed stepId");
    assert.ok(prompt.includes("Build features for data/classification.csv"), "prompt should inject the input");
    assert.ok(!prompt.includes('step claim "'), "prompt should NOT contain the claim command (scheduler pre-claimed)");
    assert.ok(prompt.includes("step complete"), "prompt should still instruct step complete");
    assert.ok(prompt.includes("step fail"), "prompt should still instruct step fail");
  });

  it("claimStep on an already-claimed step returns not found (race safety)", async () => {
    // The step is running (claimed above). A second claim must not find it.
    const claim = await claimStep(agentId, runId);
    assert.equal(claim.found, false, "should not re-claim a running step");
  });

  it("buildPollingPrompt without work falls back to CLI claim instruction", async () => {
    const prompt = await buildPollingPrompt("ml-autoresearch", agentId, runId, "");
    assert.ok(prompt.includes("step claim"), "fallback prompt should instruct step claim");
    assert.ok(prompt.includes("HEARTBEAT_OK"), "fallback prompt should keep HEARTBEAT_OK escape");
  });
});
