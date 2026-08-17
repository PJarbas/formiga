// ══════════════════════════════════════════════════════════════════════
// complete-artifacts.test.ts — autoRegisterArtifacts backfill semantics
// ══════════════════════════════════════════════════════════════════════
//
// autoRegisterArtifacts() is the best-effort backfill that registers an
// agent's on-disk workspace artifacts into agent_artifacts after step
// completion. These tests pin down the two behaviors that were broken for
// arena runs:
//   1. Agent ids arrive workflow-prefixed ("ml-autoresearch_data-analyst")
//      and must be normalized before the per-agent file map is consulted.
//   2. Artifacts must be stored under the canonical bare key the frontend
//      expects ("eda_report"), never "<agentId>/<fileName>".

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../../dist/db.js";
import { autoRegisterArtifacts } from "../../../dist/installer/steps/complete.js";

describe("autoRegisterArtifacts", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-complete-artifacts-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    origStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
    // First getDb() call migrates the schema (agent_artifacts, steps, runs).
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
    db.exec("DELETE FROM agent_artifacts");
    db.exec("DELETE FROM steps");
    db.exec("DELETE FROM runs");
  });

  function seedRun(runId: string, workflowId: string): void {
    getDb()
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
         VALUES (?, ?, 'test', 'running', '{}', datetime('now'), datetime('now'))`,
      )
      .run(runId, workflowId);
  }

  function seedStep(stepRowId: string, runId: string, agentId: string): void {
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                            status, retry_count, max_retries, type, created_at, updated_at)
         VALUES (?, ?, 'eda', ?, 0, '', '', 'running', 0, 4, 'single', datetime('now'), datetime('now'))`,
      )
      .run(stepRowId, runId, agentId);
  }

  function listArtifacts(runId: string): Array<{ artifact_key: string; agent_id: string; content: string }> {
    return getDb()
      .prepare(
        "SELECT artifact_key, agent_id, content FROM agent_artifacts WHERE run_id = ? ORDER BY artifact_key",
      )
      .all(runId) as Array<{ artifact_key: string; agent_id: string; content: string }>;
  }

  function makeWorkspace(runId: string, files: Record<string, string>): string {
    const workspace = path.join(tempHome, "ws", runId);
    const artifactsDir = path.join(workspace, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(artifactsDir, name), content);
    }
    return workspace;
  }

  it("registers on-disk artifacts under canonical bare keys for a prefixed arena agent id", async () => {
    const runId = "run-artifacts-1";
    const stepRowId = "step-artifacts-1";
    const workspace = makeWorkspace(runId, {
      "eda_report.json": JSON.stringify({ title: "EDA", n_rows: 120 }),
      "eda_config.json": JSON.stringify({ seed: 42 }),
    });

    seedRun(runId, "ml-autoresearch");
    seedStep(stepRowId, runId, "ml-autoresearch_data-analyst");

    await autoRegisterArtifacts(runId, stepRowId, "ml-autoresearch_data-analyst", { workspace });

    const rows = listArtifacts(runId);
    assert.deepEqual(
      rows.map((r) => r.artifact_key),
      ["eda_config", "eda_report"],
    );
    for (const row of rows) {
      assert.ok(!row.artifact_key.includes("/"), `artifact key must be bare, got: ${row.artifact_key}`);
      assert.equal(row.agent_id, "ml-autoresearch_data-analyst");
    }
    const report = rows.find((r) => r.artifact_key === "eda_report");
    assert.deepEqual(JSON.parse(report!.content), { title: "EDA", n_rows: 120 });
  });

  it("registers nothing when the agent has no known artifact files", async () => {
    const runId = "run-artifacts-2";
    const stepRowId = "step-artifacts-2";
    // Files on disk, but the reporter agent is not in AGENT_ARTIFACT_FILES.
    const workspace = makeWorkspace(runId, {
      "eda_report.json": JSON.stringify({ title: "EDA" }),
    });

    seedRun(runId, "ml-autoresearch");
    seedStep(stepRowId, runId, "ml-autoresearch_reporter");

    await autoRegisterArtifacts(runId, stepRowId, "ml-autoresearch_reporter", { workspace });

    assert.equal(listArtifacts(runId).length, 0);
  });

  it("skips missing files but registers the ones present", async () => {
    const runId = "run-artifacts-3";
    const stepRowId = "step-artifacts-3";
    // Only eda_report.json exists; eda_config.json is absent.
    const workspace = makeWorkspace(runId, {
      "eda_report.json": JSON.stringify({ title: "EDA" }),
    });

    seedRun(runId, "ml-autoresearch");
    seedStep(stepRowId, runId, "ml-autoresearch_data-analyst");

    await autoRegisterArtifacts(runId, stepRowId, "ml-autoresearch_data-analyst", { workspace });

    assert.deepEqual(
      listArtifacts(runId).map((r) => r.artifact_key),
      ["eda_report"],
    );
  });

  it("falls back to the raw agent id when the workflow prefix does not match", async () => {
    const runId = "run-artifacts-4";
    const stepRowId = "step-artifacts-4";
    const workspace = makeWorkspace(runId, {
      "eda_report.json": JSON.stringify({ title: "EDA" }),
    });

    // A different workflow that does not prefix the stored agent id: the
    // normalizer must leave the raw (unprefixed) id intact for the map lookup.
    seedRun(runId, "other-wf");
    seedStep(stepRowId, runId, "data-analyst");

    await autoRegisterArtifacts(runId, stepRowId, "data-analyst", { workspace });

    assert.deepEqual(
      listArtifacts(runId).map((r) => r.artifact_key),
      ["eda_report"],
    );
  });
});
