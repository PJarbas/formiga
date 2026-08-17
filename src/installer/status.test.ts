import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";

// Canonical created_at/updated_at are NOT NULL without a SQL default, so the
// tests bind explicit ISO timestamps (as Prisma does). The old hand-rolled
// tables had DEFAULT (datetime('now')) — and node:sqlite miscounts
// `datetime('now')` function literals in VALUES, so we avoid them here.
const NOW = new Date().toISOString();

// ── Tests ──

describe("stopWorkflow", () => {
  let tempRoot: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let db: DatabaseSync;

  beforeEach(async () => {
    originalDbPath = process.env.FORMIGA_DB_PATH;
    originalHome = process.env.HOME;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-stopwf-"));
    const dbPath = path.join(tempRoot, ".formiga", "formiga.db");
    process.env.FORMIGA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    // Build the canonical schema. The hand-rolled runs/steps/stories/
    // run_worktrees tables lagged the canonical schema (missing
    // max_duration_minutes, last_progress_at, …), which made
    // prisma.run.update() throw "column max_duration_minutes does not
    // exist". migrate() is idempotent and creates every table the status
    // paths touch.
    const { migrate } = await import("../../dist/database/migrations.js");
    migrate(db);

    // Force Prisma to re-bind to the new temp DB
    const { resetPrisma } = await import("../../dist/db.js");
    await resetPrisma();
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

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("run-cancel", "wf", "test task", "running", NOW, NOW);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "run-cancel", "implement", "dev", 0, "", "", "waiting", NOW, NOW);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s2", "run-cancel", "test", "qa", 1, "", "", "running", NOW, NOW);

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
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("run-done", "wf", "test", "completed", NOW, NOW);
    await assert.rejects(() => stopWorkflow("run-done"), /already completed/i);
  });

  it("deletes a terminal workflow and its associated records", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("run-delete", "wf", "test", "completed", NOW, NOW);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s-delete", "run-delete", "implement", "dev", 0, "", "", "done", NOW, NOW);
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-delete", "run-delete", 0, "story-1", "Delete run", "done", NOW, NOW);
    db.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("run-delete", tempRoot, path.join(tempRoot, ".git"), path.join(tempRoot, "worktree"), "removed", NOW);

    const result = await deleteWorkflow("run-delete");

    assert.deepEqual(result, { ok: true, runId: "run-delete", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM stories WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_worktrees WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
  });

  it("requires force before deleting active workflows", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("run-active", "wf", "test", "running", NOW, NOW);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s-active", "run-active", "implement", "dev", 0, "", "", "running", NOW, NOW);

    await assert.rejects(() => deleteWorkflow("run-active"), /Use --force/);
    assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get("run-active") as { status: string }).status, "running");

    const result = await deleteWorkflow("run-active", { force: true });

    assert.deepEqual(result, { ok: true, runId: "run-active", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-active") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-active") as { count: number }).count, 0);
  });
});
