import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";

// ── Tests ──

describe("stopWorkflow", () => {
  let tempRoot: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let db: DatabaseSync;

  beforeEach(() => {
    originalDbPath = process.env.FORMIGA_DB_PATH;
    originalHome = process.env.HOME;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-stopwf-"));
    const dbPath = path.join(tempRoot, ".formiga", "formiga.db");
    process.env.FORMIGA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT,
      error TEXT
    )`);
  });

  afterEach(() => {
    if (originalDbPath) process.env.FORMIGA_DB_PATH = originalDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("cancels a running workflow", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-cancel", "wf", "test task", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s1", "run-cancel", "implement", "dev", 0, "waiting");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s2", "run-cancel", "test", "qa", 1, "running");

    const result = await stopWorkflow("run-cancel");
    assert.equal(result.ok, true);
    assert.equal(result.runId, "run-cancel");

    // Run should be canceled
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-cancel") as { status: string };
    assert.equal(run.status, "canceled");

    // Steps should be canceled
    const steps = db.prepare("SELECT status FROM steps WHERE run_id = ?").all("run-cancel") as Array<{ status: string }>;
    for (const s of steps) {
      assert.equal(s.status, "canceled");
    }
  });

  it("throws when run not found", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");
    await assert.rejects(() => stopWorkflow("nonexistent"), /Run not found/i);
  });

  it("throws when run is already terminal (completed)", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-done", "wf", "test", "completed");
    await assert.rejects(() => stopWorkflow("run-done"), /already completed/i);
  });

  it("deletes a terminal workflow and its associated records", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-delete", "wf", "test", "completed");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s-delete", "run-delete", "implement", "dev", 0, "done");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, status) VALUES (?, ?, ?, ?, ?, ?)").run("story-delete", "run-delete", 0, "story-1", "Delete run", "done");
    db.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("run-delete", tempRoot, path.join(tempRoot, ".git"), path.join(tempRoot, "worktree"), "removed");

    const result = await deleteWorkflow("run-delete");

    assert.deepEqual(result, { ok: true, runId: "run-delete", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM stories WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_worktrees WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
  });

  it("requires force before deleting active workflows", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-active", "wf", "test", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s-active", "run-active", "implement", "dev", 0, "running");

    await assert.rejects(() => deleteWorkflow("run-active"), /Use --force/);
    assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get("run-active") as { status: string }).status, "running");

    const result = await deleteWorkflow("run-active", { force: true });

    assert.deepEqual(result, { ok: true, runId: "run-active", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-active") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-active") as { count: number }).count, 0);
  });
});
