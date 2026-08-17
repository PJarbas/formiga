// ══════════════════════════════════════════════════════════════════════
// arena-repository.test.ts — state_json checkpoint persistence (AL-4)
//
// Uses the same temp-DB pattern as leaderboard/repository.test.ts:
// FORMIGA_DB_PATH → tmpdir, resetPrisma(), migrate(getDb()), then asserts
// through both Prisma (repository API) and raw SQLite (getDb).
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../dist/db.js";
import { migrate } from "../../dist/database/migrations.js";
import { resetPrisma } from "../../dist/database/index.js";
import { ArenaRepositoryImpl } from "../../dist/arena/arena-repository.js";
import type { ArenaConfig } from "../../dist/arena/arena-types.js";

function makeRunRow(runId: string): void {
  getDb()
    .prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .run(runId, "ml-autoresearch", "Arena test", "running", "{}");
}

function makeConfig(runId: string): ArenaConfig {
  return {
    runId,
    workspacePath: "/tmp",
    metricName: "f1",
    metricDirection: "higher",
    maxRounds: 5,
    maxNoImprove: 3,
    commitOnKeep: false,
    revertOnDiscard: false,
    agents: [{ id: "modeler-classic", agentPersona: "modeler_classic", timeout: 300_000, strategyHint: "hint", modelType: "lightgbm" }],
  };
}

describe("ArenaRepositoryImpl — state_json checkpoint (AL-4)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let repo: ArenaRepositoryImpl;

  before(async () => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-arena-repo-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = tempHome;
    const dbPath = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_DB_PATH = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    await resetPrisma();
    migrate(getDb());
    repo = new ArenaRepositoryImpl();
  });

  after(async () => {
    await resetPrisma();
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origDbPath) process.env.FORMIGA_DB_PATH = origDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("exposes the state_json column after migrate()", () => {
    const cols = getDb().prepare("PRAGMA table_info(arena_sessions)").all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "state_json"), "arena_sessions should have a state_json column");
  });

  it("round-trips a checkpoint through saveCheckpoint → getByRunId", async () => {
    makeRunRow("arena-run-001");
    const session = await repo.createFromConfig("arena-run-001", makeConfig("arena-run-001"));
    assert.equal(session.status, "running");
    assert.equal(session.currentRound, 0);
    assert.equal(session.stateJson, null);

    const checkpoint = JSON.stringify({
      version: 1,
      allResults: [{ agentId: "modeler-classic", metric: 0.8, decision: "keep" }],
      consecutiveNoImprove: 1,
    });
    await repo.saveCheckpoint(session.id, checkpoint);

    const loaded = await repo.getByRunId("arena-run-001");
    assert.ok(loaded);
    assert.equal(loaded.stateJson, checkpoint);

    const loadedById = await repo.getById(session.id);
    assert.equal(loadedById!.stateJson, checkpoint);
  });

  it("updateRound advances round counters without clobbering state_json", async () => {
    makeRunRow("arena-run-002");
    const session = await repo.createFromConfig("arena-run-002", makeConfig("arena-run-002"));
    await repo.saveCheckpoint(session.id, "{}");
    await repo.updateRound(session.id, 2, 0.9, "modeler-classic", null, 1);

    const loaded = await repo.getByRunId("arena-run-002");
    assert.equal(loaded!.stateJson, "{}");
    assert.equal(loaded!.currentRound, 2);
    assert.equal(loaded!.bestMetric, 0.9);
    assert.equal(loaded!.consecutiveNoImprove, 1);
  });
});
