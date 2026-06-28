import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseLogsSelector, lookupRunIdByNumber } from "../../dist/cli/logs-selector.js";

describe("parseLogsSelector", () => {
  it("returns default global recent selector when no arg is provided", () => {
    assert.deepEqual(parseLogsSelector(), { kind: "global-recent", limit: 50 });
  });

  it("parses a numeric arg as global limit", () => {
    assert.deepEqual(parseLogsSelector("25"), { kind: "global-limit", limit: 25 });
  });

  it("parses #<run-number> as run-number selector", () => {
    assert.deepEqual(parseLogsSelector("#42"), { kind: "run-number", runNumber: 42, raw: "#42" });
  });

  it("parses non-numeric values as run-id selectors", () => {
    assert.deepEqual(parseLogsSelector("run-abc"), { kind: "run-id", runId: "run-abc" });
  });
});

describe("lookupRunIdByNumber", () => {
  let tempRoot: string;
  let originalDbPath: string | undefined;
  let db: DatabaseSync;

  beforeEach(async () => {
    originalDbPath = process.env.FORMIGA_DB_PATH;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-logs-"));
    const dbPath = path.join(tempRoot, ".formiga", "formiga.db");
    process.env.FORMIGA_DB_PATH = dbPath;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const { getPrisma, resetPrisma } = await import("../../dist/db.js");
    await resetPrisma();
  });

  afterEach(() => {
    if (originalDbPath) process.env.FORMIGA_DB_PATH = originalDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    try { db.close(); } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("queries runs by run_number", async () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, run_number, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("run-id-123", 7, "test", "completed", now, now);

    const runId = await lookupRunIdByNumber(7);
    assert.equal(runId, "run-id-123");
  });

  it("returns undefined when no matching run_number exists", async () => {
    const runId = await lookupRunIdByNumber(999);
    assert.equal(runId, undefined);
  });
});
