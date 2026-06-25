// ══════════════════════════════════════════════════════════════════════
// ingest.test.ts — Tests for ingestStepOutput (KEY:value → leaderboard)
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../dist/db.js";
import { ingestStepOutput } from "../../dist/leaderboard/ingest.js";

describe("ingestStepOutput", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-ingest-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    // Force migration + leaderboard schema creation on the temp DB.
    getDb();
  });

  after(() => {
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origDbPath) process.env.FORMIGA_DB_PATH = origDbPath;
    else delete process.env.FORMIGA_DB_PATH;
    rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Wipe experiments between tests so each is independent.
    getDb().exec("DELETE FROM experiments");
  });

  describe("agent gating", () => {
    it("skips non-leaderboard agents (e.g. data-analyst)", () => {
      const result = ingestStepOutput({
        agentId: "data-analyst",
        runId: "run-1",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          artifact_path: "/tmp/m.pkl",
        },
      });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "non-leaderboard agent");
    });

    it("skips ml-critic (audit, not modeling)", () => {
      const result = ingestStepOutput({
        agentId: "ml-pipeline_ml-critic",
        runId: "run-1",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          artifact_path: "/tmp/m.pkl",
        },
      });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "non-leaderboard agent");
    });

    it("accepts bare leaderboard agent id (modeler-classic)", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-1",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          artifact_path: "/tmp/m.pkl",
        },
      });
      assert.ok(result.experimentId !== null && result.experimentId > 0);
    });

    it("accepts suffix-scoped agent id (ml-pipeline_modeler-advanced)", () => {
      const result = ingestStepOutput({
        agentId: "ml-pipeline_modeler-advanced",
        runId: "run-1",
        parsedKv: {
          model_type: "MLP",
          cv_mean: "0.87",
          train_mean: "0.92",
          artifact_path: "/tmp/m.pt",
        },
      });
      assert.ok(result.experimentId !== null && result.experimentId > 0);
    });

    it("accepts feature-engineer for baseline submissions", () => {
      const result = ingestStepOutput({
        agentId: "feature-engineer",
        runId: "run-1",
        parsedKv: {
          model_type: "LogisticRegression",
          cv_mean: "0.70",
          train_mean: "0.72",
          artifact_path: "/tmp/baseline.json",
        },
      });
      assert.ok(result.experimentId !== null && result.experimentId > 0);
    });
  });

  describe("required field validation", () => {
    const base = {
      agentId: "modeler-classic",
      runId: "run-x",
      parsedKv: {
        model_type: "XGB",
        cv_mean: "0.9",
        train_mean: "0.95",
        artifact_path: "/tmp/m.pkl",
      },
    };

    it("rejects missing MODEL_TYPE", () => {
      const kv = { ...base.parsedKv };
      delete (kv as Record<string, string>)["model_type"];
      const result = ingestStepOutput({ ...base, parsedKv: kv });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing MODEL_TYPE");
    });

    it("rejects missing CV_MEAN", () => {
      const kv = { ...base.parsedKv };
      delete (kv as Record<string, string>)["cv_mean"];
      const result = ingestStepOutput({ ...base, parsedKv: kv });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing or non-numeric CV_MEAN");
    });

    it("rejects non-numeric CV_MEAN", () => {
      const result = ingestStepOutput({
        ...base,
        parsedKv: { ...base.parsedKv, cv_mean: "not-a-number" },
      });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing or non-numeric CV_MEAN");
    });

    it("rejects missing TRAIN_MEAN", () => {
      const kv = { ...base.parsedKv };
      delete (kv as Record<string, string>)["train_mean"];
      const result = ingestStepOutput({ ...base, parsedKv: kv });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing or non-numeric TRAIN_MEAN");
    });

    it("rejects non-numeric TRAIN_MEAN", () => {
      const result = ingestStepOutput({
        ...base,
        parsedKv: { ...base.parsedKv, train_mean: "NaN?" },
      });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing or non-numeric TRAIN_MEAN");
    });

    it("rejects missing ARTIFACT_PATH", () => {
      const kv = { ...base.parsedKv };
      delete (kv as Record<string, string>)["artifact_path"];
      const result = ingestStepOutput({ ...base, parsedKv: kv });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing ARTIFACT_PATH");
    });

    it("rejects empty ARTIFACT_PATH", () => {
      const result = ingestStepOutput({
        ...base,
        parsedKv: { ...base.parsedKv, artifact_path: "" },
      });
      assert.equal(result.experimentId, null);
      assert.equal(result.reason, "missing ARTIFACT_PATH");
    });
  });

  describe("successful registration", () => {
    it("registers an experiment and returns its ID", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-ok",
        roundNumber: 2,
        parsedKv: {
          model_type: "LightGBM",
          cv_mean: "0.88",
          train_mean: "0.91",
          hyperparameters: JSON.stringify({ lr: 0.05, depth: 7 }),
          artifact_path: "/tmp/lgbm.pkl",
          metric_name: "rmse",
        },
      });
      assert.ok(result.experimentId !== null);
      assert.ok(result.experimentId > 0);
      assert.equal(result.reason, undefined);

      const row = getDb()
        .prepare("SELECT * FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as Record<string, unknown>;
      assert.equal(row.run_id, "run-ok");
      assert.equal(row.round_number, 2);
      assert.equal(row.agent_name, "modeler-classic");
      assert.equal(row.model_type, "LightGBM");
      assert.equal(row.val_metric, 0.88);
      assert.equal(row.train_metric, 0.91);
      assert.equal(row.metric_name, "rmse");
      assert.equal(row.artifact_path, "/tmp/lgbm.pkl");
      assert.equal(row.status, "PENDING");
      const hp = JSON.parse(row.hyperparameters as string) as Record<string, unknown>;
      assert.deepEqual(hp, { lr: 0.05, depth: 7 });
    });

    it("defaults roundNumber to 1 when not provided", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-default-round",
        parsedKv: {
          model_type: "RF",
          cv_mean: "0.80",
          train_mean: "0.82",
          artifact_path: "/tmp/rf.pkl",
        },
      });
      assert.ok(result.experimentId !== null);
      const row = getDb()
        .prepare("SELECT round_number FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { round_number: number };
      assert.equal(row.round_number, 1);
    });

    it("defaults metric_name to 'cv_mean' when not provided", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-default-metric",
        parsedKv: {
          model_type: "RF",
          cv_mean: "0.80",
          train_mean: "0.82",
          artifact_path: "/tmp/rf.pkl",
        },
      });
      const row = getDb()
        .prepare("SELECT metric_name FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { metric_name: string };
      assert.equal(row.metric_name, "cv_mean");
    });
  });

  describe("hyperparameters parsing", () => {
    it("parses valid JSON object", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-hp-json",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          hyperparameters: '{"alpha": 0.1, "tree_method": "hist"}',
          artifact_path: "/tmp/x.pkl",
        },
      });
      const row = getDb()
        .prepare("SELECT hyperparameters FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { hyperparameters: string };
      assert.deepEqual(JSON.parse(row.hyperparameters), {
        alpha: 0.1,
        tree_method: "hist",
      });
    });

    it("falls back to {raw: ...} for non-JSON hyperparameters", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-hp-raw",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          hyperparameters: "lr=0.01;depth=6", // not JSON
          artifact_path: "/tmp/x.pkl",
        },
      });
      const row = getDb()
        .prepare("SELECT hyperparameters FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { hyperparameters: string };
      assert.deepEqual(JSON.parse(row.hyperparameters), {
        raw: "lr=0.01;depth=6",
      });
    });

    it("falls back to {raw: ...} for JSON arrays (not objects)", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-hp-array",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          hyperparameters: "[1, 2, 3]",
          artifact_path: "/tmp/x.pkl",
        },
      });
      const row = getDb()
        .prepare("SELECT hyperparameters FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { hyperparameters: string };
      assert.deepEqual(JSON.parse(row.hyperparameters), {
        raw: "[1, 2, 3]",
      });
    });

    it("defaults hyperparameters to {} when absent", () => {
      const result = ingestStepOutput({
        agentId: "modeler-classic",
        runId: "run-hp-none",
        parsedKv: {
          model_type: "XGB",
          cv_mean: "0.9",
          train_mean: "0.95",
          artifact_path: "/tmp/x.pkl",
        },
      });
      const row = getDb()
        .prepare("SELECT hyperparameters FROM experiments WHERE experiment_id = ?")
        .get(result.experimentId) as { hyperparameters: string };
      assert.deepEqual(JSON.parse(row.hyperparameters), {});
    });
  });
});
