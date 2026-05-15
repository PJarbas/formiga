import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureMedicTables, getMedicStatus, runMedicCheck } from "../../dist/medic/medic.js";
import { checkDatabaseIntegrity } from "../../dist/medic/checks.js";

describe("medic", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-medic-"));
    dbPath = path.join(tempDir, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    // medic checks uses os.homedir() to find cron-jobs.json
    process.env.HOME = tempDir;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        input_template TEXT NOT NULL,
        expects TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        output TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 4,
        type TEXT NOT NULL DEFAULT 'single',
        loop_config TEXT,
        current_story_id TEXT,
        abandoned_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("ensureMedicTables", () => {
    it("creates medic_checks table", () => {
      ensureMedicTables();

      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='medic_checks'"
      ).get() as { name: string } | undefined;

      assert.ok(row);
      assert.equal(row!.name, "medic_checks");
    });

    it("is idempotent — can be called multiple times", () => {
      ensureMedicTables();
      assert.doesNotThrow(() => ensureMedicTables());
    });
  });

  describe("checkDatabaseIntegrity", () => {
    it("returns ok for a healthy database", () => {
      const result = checkDatabaseIntegrity();
      assert.equal(result.ok, true);
      assert.equal(result.message, "ok");
    });
  });

  describe("getMedicStatus", () => {
    it("returns installed: true after tables are created", () => {
      ensureMedicTables();
      const status = getMedicStatus();
      assert.equal(status.installed, true);
      assert.equal(status.lastCheck, null);
      assert.equal(status.recentChecks, 0);
    });
  });

  describe("runMedicCheck", () => {
    it("runs without errors on clean DB", async () => {
      ensureMedicTables();
      const result = await runMedicCheck();
      assert.equal(result.issuesFound, 0);
      assert.equal(result.actionsTaken, 0);
      assert.ok(result.summary.includes("All clear"));
    });
  });
});
