// ══════════════════════════════════════════════════════════════════════
// repository.test.ts — Tests for LeaderboardRepository CRUD + queries
//
// Migrated to the Prisma-based repository: async API, temp DB via
// FORMIGA_DB_PATH, raw-SQL assertions through getDb() (shares the same
// SQLite file as Prisma in WAL mode).
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../dist/db.js";
import { migrate } from "../../dist/database/migrations.js";
import { resetPrisma } from "../../dist/database/index.js";
import { LeaderboardRepositoryImpl, type NewExperiment } from "../../dist/leaderboard/repository.js";
import { getExperimentStats, getRejectedCount, getBestExperiments } from "../../dist/leaderboard/queries.js";

const sampleEntry: NewExperiment = {
  run_id: "run-001",
  round_number: 1,
  agent_name: "modeler-classic",
  model_type: "XGBoost",
  hyperparameters: { lr: 0.01, max_depth: 6 },
  train_metric: 0.95,
  val_metric: 0.85,
  metric_name: "accuracy",
  artifact_path: "/tmp/model.pkl",
};

describe("LeaderboardRepositoryImpl", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let repo: LeaderboardRepositoryImpl;

  before(async () => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-repo-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = tempHome;
    const dbPath = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_DB_PATH = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    await resetPrisma();
    migrate(getDb());
    repo = new LeaderboardRepositoryImpl();
  });

  after(async () => {
    await resetPrisma();
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origDbPath) process.env.FORMIGA_DB_PATH = origDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("register", () => {
    it("inserts an experiment and returns its ID", async () => {
      const id = await repo.register(sampleEntry);
      assert.ok(id > 0);
    });

    it("defaults status to PENDING", async () => {
      const id = await repo.register({ ...sampleEntry, run_id: "run-002" });
      const rows = getDb()
        .prepare("SELECT status FROM experiments WHERE experiment_id = ?")
        .get(id) as { status: string };
      assert.equal(rows.status, "PENDING");
    });
  });

  describe("getBestByMetric", () => {
    it("returns top experiments ordered by val_metric desc", async () => {
      await repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.80, model_type: "RF" });
      const id2 = await repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.90, model_type: "XGB" });
      await repo.updateTestMetric(id2, 0.88, "AUDITED");
      await repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.70, model_type: "SVM" });
      const results = await repo.getBestByMetric("run-best", 2);
      assert.equal(results.length, 1); // only the AUDITED one
      assert.equal(results[0].val_metric, 0.90);
    });

    it("filters out non-success/non-audited rows", async () => {
      await repo.register({ ...sampleEntry, run_id: "run-best2", val_metric: 0.80, model_type: "RF" });
      const id2 = await repo.register({ ...sampleEntry, run_id: "run-best2", val_metric: 0.90, model_type: "XGB" });
      await repo.updateTestMetric(id2, 0.88, "AUDITED");
      const results = await repo.getBestByMetric("run-best2", 10);
      const allValid = results.every((r) => r.status === "SUCCESS" || r.status === "AUDITED");
      assert.equal(allValid, true);
    });
  });

  describe("getByRound", () => {
    it("returns only experiments for given round", async () => {
      await repo.register({ ...sampleEntry, run_id: "run-round", round_number: 1 });
      await repo.register({ ...sampleEntry, run_id: "run-round", round_number: 1, model_type: "RF" });
      await repo.register({ ...sampleEntry, run_id: "run-round", round_number: 2, model_type: "SVM" });
      const round1 = await repo.getByRound("run-round", 1);
      assert.equal(round1.length, 2);
      const round2 = await repo.getByRound("run-round", 2);
      assert.equal(round2.length, 1);
    });
  });

  describe("getByAgent", () => {
    it("filters by agent name and run", async () => {
      await repo.register({ ...sampleEntry, run_id: "run-agent", agent_name: "feature-engineer" });
      await repo.register({ ...sampleEntry, run_id: "run-agent", agent_name: "modeler-classic" });
      const results = await repo.getByAgent("feature-engineer", "run-agent");
      assert.equal(results.length, 1);
      assert.equal(results[0].agent_name, "feature-engineer");
    });
  });

  describe("getValidated", () => {
    it("returns only validated experiments", async () => {
      const id = await repo.register({ ...sampleEntry, run_id: "run-validated", val_metric: 0.92 });
      await repo.updateTestMetric(id, 0.90, "AUDITED");
      const results = await repo.getValidated("run-validated");
      assert.ok(results.length > 0);
    });
  });

  describe("getFailedConfigs", () => {
    it("returns only failed/overfitted experiments", async () => {
      await repo.register({ ...sampleEntry, run_id: "run-failed", agent_name: "bad-agent" });
      const id = await repo.register({ ...sampleEntry, run_id: "run-failed", agent_name: "bad-agent", model_type: "NN" });
      await repo.reject(id, "overfit detected");
      const results = await repo.getFailedConfigs("bad-agent");
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "FAILED");
    });
  });

  describe("updateTestMetric", () => {
    it("updates test metric and status", async () => {
      const id = await repo.register({ ...sampleEntry, run_id: "run-update" });
      await repo.updateTestMetric(id, 0.88, "AUDITED");
      const row = getDb()
        .prepare("SELECT test_metric, status FROM experiments WHERE experiment_id = ?")
        .get(id) as Record<string, unknown>;
      assert.equal(row.test_metric, 0.88);
      assert.equal(row.status, "AUDITED");
    });
  });

  describe("reject", () => {
    it("sets status to FAILED with error message", async () => {
      const id = await repo.register({ ...sampleEntry, run_id: "run-reject" });
      await repo.reject(id, "data leakage detected");
      const row = getDb()
        .prepare("SELECT status, error_message FROM experiments WHERE experiment_id = ?")
        .get(id) as Record<string, unknown>;
      assert.equal(row.status, "FAILED");
      assert.equal(row.error_message, "data leakage detected");
    });
  });

  // ── queries (shares the same DB; seeded here so they run in the same
  //    connection/singleton context as the repository tests above). ──
  describe("getExperimentStats", () => {
    it("returns correct counts", async () => {
      // Seed a fresh run for stats: PENDING, AUDITED, FAILED.
      // Use a distinct agent so getRejectedCount below is unambiguous.
      await repo.register({ ...sampleEntry, run_id: "run-stats", agent_name: "stats-agent", val_metric: 0.85 });
      const id2 = await repo.register({ ...sampleEntry, run_id: "run-stats", agent_name: "stats-agent", val_metric: 0.92, model_type: "RF" });
      await repo.updateTestMetric(id2, 0.90, "AUDITED");
      const id3 = await repo.register({ ...sampleEntry, run_id: "run-stats", agent_name: "stats-agent", val_metric: 0.70, model_type: "SVM" });
      await repo.reject(id3, "low performance");

      const stats = await getExperimentStats("run-stats");
      assert.equal(stats.total, 3);
      assert.equal(stats.validated, 1); // only the AUDITED one (id2)
      assert.equal(stats.rejected, 1);  // FAILED (id3)
      assert.equal(stats.pending, 1);   // PENDING (id1)
    });
  });

  describe("getBestExperiments", () => {
    it("returns top N by val_metric", async () => {
      const best = await getBestExperiments("run-stats", 1);
      assert.equal(best.length, 1);
      assert.equal(best[0].val_metric, 0.92);
    });
  });

  describe("getRejectedCount", () => {
    it("returns count of rejected experiments for agent", async () => {
      // stats-agent has exactly one rejected experiment (id3 above).
      const count = await getRejectedCount("stats-agent");
      assert.equal(count, 1);
    });

    it("returns 0 for agent with no rejections", async () => {
      const count = await getRejectedCount("nonexistent");
      assert.equal(count, 0);
    });
  });
});
