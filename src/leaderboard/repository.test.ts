// ══════════════════════════════════════════════════════════════════════
// repository.test.ts — Tests for LeaderboardRepository CRUD + queries
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initLeaderboardSchema } from "./schema.js";
import { LeaderboardRepositoryImpl, type NewExperiment } from "./repository.js";
import { getExperimentStats, getRejectedCount, getBestExperiments } from "./queries.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  initLeaderboardSchema(db);
  return db;
}

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
  let db: DatabaseSync;
  let repo: LeaderboardRepositoryImpl;

  before(() => {
    db = createTestDb();
    repo = new LeaderboardRepositoryImpl(db);
  });

  after(() => {
    db.close();
  });

  describe("register", () => {
    it("inserts an experiment and returns its ID", () => {
      const id = repo.register(sampleEntry);
      assert.ok(id > 0);
    });

    it("defaults status to PENDING", () => {
      const id = repo.register({ ...sampleEntry, run_id: "run-002" });
      const rows = db.prepare("SELECT status FROM experiments WHERE experiment_id = ?").get(id) as { status: string };
      assert.equal(rows.status, "PENDING");
    });
  });

  describe("getBestByMetric", () => {
    before(() => {
      repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.80, model_type: "RF" });
      const id2 = repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.90, model_type: "XGB" });
      repo.updateTestMetric(id2, 0.88, "AUDITED");
      repo.register({ ...sampleEntry, run_id: "run-best", val_metric: 0.70, model_type: "SVM" });
    });

    it("returns top experiments ordered by val_metric desc", () => {
      const results = repo.getBestByMetric("run-best", 2);
      assert.equal(results.length, 1); // only the AUDITED one
      assert.equal(results[0].val_metric, 0.90);
    });

    it("filters out non-success/non-audited rows", () => {
      const results = repo.getBestByMetric("run-best", 10);
      const allValid = results.every((r) => r.status === "SUCCESS" || r.status === "AUDITED");
      assert.equal(allValid, true);
    });
  });

  describe("getByRound", () => {
    before(() => {
      repo.register({ ...sampleEntry, run_id: "run-round", round_number: 1 });
      repo.register({ ...sampleEntry, run_id: "run-round", round_number: 1, model_type: "RF" });
      repo.register({ ...sampleEntry, run_id: "run-round", round_number: 2, model_type: "SVM" });
    });

    it("returns only experiments for given round", () => {
      const round1 = repo.getByRound("run-round", 1);
      assert.equal(round1.length, 2);
      const round2 = repo.getByRound("run-round", 2);
      assert.equal(round2.length, 1);
    });
  });

  describe("getByAgent", () => {
    it("filters by agent name and run", () => {
      repo.register({ ...sampleEntry, run_id: "run-agent", agent_name: "feature-engineer" });
      repo.register({ ...sampleEntry, run_id: "run-agent", agent_name: "modeler-classic" });
      const results = repo.getByAgent("feature-engineer", "run-agent");
      assert.equal(results.length, 1);
      assert.equal(results[0].agent_name, "feature-engineer");
    });
  });

  describe("getValidated", () => {
    it("returns only validated experiments", () => {
      const id = repo.register({ ...sampleEntry, run_id: "run-validated", val_metric: 0.92 });
      repo.updateTestMetric(id, 0.90, "AUDITED");
      const results = repo.getValidated("run-validated");
      assert.ok(results.length > 0);
    });
  });

  describe("getFailedConfigs", () => {
    it("returns only failed/overfitted experiments", () => {
      repo.register({ ...sampleEntry, run_id: "run-failed", agent_name: "bad-agent" });
      const id = repo.register({ ...sampleEntry, run_id: "run-failed", agent_name: "bad-agent", model_type: "NN" });
      repo.reject(id, "overfit detected");
      const results = repo.getFailedConfigs("bad-agent");
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "FAILED");
    });
  });

  describe("updateTestMetric", () => {
    it("updates test metric and status", () => {
      const id = repo.register({ ...sampleEntry, run_id: "run-update" });
      repo.updateTestMetric(id, 0.88, "AUDITED");
      const row = db.prepare("SELECT test_metric, status FROM experiments WHERE experiment_id = ?").get(id) as Record<string, unknown>;
      assert.equal(row.test_metric, 0.88);
      assert.equal(row.status, "AUDITED");
    });
  });

  describe("reject", () => {
    it("sets status to FAILED with error message", () => {
      const id = repo.register({ ...sampleEntry, run_id: "run-reject" });
      repo.reject(id, "data leakage detected");
      const row = db.prepare("SELECT status, error_message FROM experiments WHERE experiment_id = ?").get(id) as Record<string, unknown>;
      assert.equal(row.status, "FAILED");
      assert.equal(row.error_message, "data leakage detected");
    });
  });
});

describe("queries", () => {
  let db: DatabaseSync;
  let repo: LeaderboardRepositoryImpl;

  before(() => {
    db = createTestDb();
    repo = new LeaderboardRepositoryImpl(db);
    // Add mix of experiments for stats
    repo.register({ ...sampleEntry, run_id: "run-stats", val_metric: 0.85 });
    const id2 = repo.register({ ...sampleEntry, run_id: "run-stats", val_metric: 0.92, model_type: "RF" });
    repo.updateTestMetric(id2, 0.90, "AUDITED");
    const id3 = repo.register({ ...sampleEntry, run_id: "run-stats", val_metric: 0.70, model_type: "SVM" });
    repo.reject(id3, "low performance");
    // PENDING: only the first one (not yet updated/rejected)
  });

  after(() => {
    db.close();
  });

  describe("getExperimentStats", () => {
    it("returns correct counts", () => {
      const stats = getExperimentStats(db, "run-stats");
      assert.equal(stats.total, 3);
      assert.equal(stats.validated, 1); // only the AUDITED one (id2)
      assert.equal(stats.rejected, 1);  // FAILED (id3)
      assert.equal(stats.pending, 1);   // PENDING (id1)
    });
  });

  describe("getBestExperiments", () => {
    it("returns top N by val_metric", () => {
      const best = getBestExperiments(db, "run-stats", 1);
      assert.equal(best.length, 1);
      assert.equal(best[0].val_metric, 0.92);
    });
  });

  describe("getRejectedCount", () => {
    it("returns count of rejected experiments for agent", () => {
      const count = getRejectedCount(db, "modeler-classic");
      assert.equal(count, 1);
    });

    it("returns 0 for agent with no rejections", () => {
      const count = getRejectedCount(db, "nonexistent");
      assert.equal(count, 0);
    });
  });
});
