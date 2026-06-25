// ══════════════════════════════════════════════════════════════════════
// ml-pipeline-workflow.test.ts — End-to-end Branch 7 wiring
// ══════════════════════════════════════════════════════════════════════
//
// This test exercises the complete wiring described in the Branch 7 plan:
//
//   workflows/ml-pipeline/workflow.yml  →  loadWorkflowSpec
//                                       →  steps inserted with parallel_group
//   claimStep                           →  honors parallel_group (siblings claim concurrently,
//                                          post-group step blocked until all siblings done)
//   completeStep                        →  parses KEY:value protocol, merges context,
//                                          invokes ingestStepOutput → leaderboard
//
// We bypass the daemon control plane: rather than calling runWorkflow()
// (which spins up the daemon for registration), we drive claim/complete
// directly against rows we insert into the DB. This mirrors the same SQL
// shape as run.ts:253-285.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up env BEFORE imports execute so getDb() resolves to the temp DB.
const _savedHome = process.env.HOME;
const _savedDbPath = process.env.FORMIGA_DB_PATH;
const _savedStateDir = process.env.FORMIGA_STATE_DIR;
const _tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-ml-pipeline-e2e-"));
process.env.HOME = _tempHome;
process.env.FORMIGA_STATE_DIR = path.join(_tempHome, ".formiga");
process.env.FORMIGA_DB_PATH = path.join(_tempHome, ".formiga", "formiga.db");

process.on("exit", () => {
  if (_savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = _savedHome;
  if (_savedDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
  else process.env.FORMIGA_DB_PATH = _savedDbPath;
  if (_savedStateDir === undefined) delete process.env.FORMIGA_STATE_DIR;
  else process.env.FORMIGA_STATE_DIR = _savedStateDir;
  try { fs.rmSync(_tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

import { getDb } from "../dist/db.js";
import { claimStep, completeStep } from "../dist/installer/step-ops.js";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";

const WORKFLOW_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "workflows",
  "ml-pipeline",
);

const RUN_ID = "ml-pipeline-e2e-run";

// Canonical KEY:value output for the EDA step (data-analyst, non-leaderboard).
const EDA_OUTPUT = [
  "REPORT_PATH: reports/01_eda.md",
  "FIGURES_COUNT: 7",
  "KEY_FINDINGS: target slightly right-skewed; no missing in numerics",
  "STATUS: done",
].join("\n");

// Canonical KEY:value output for the feature-engineer step.
// This agent IS in the leaderboard suffix list, so it MUST register a
// baseline experiment row.
const FEATURES_OUTPUT = [
  "REPORT_PATH: reports/02_features.md",
  "BASELINE_CV_MEAN: 0.71",
  "BASELINE_CV_STD: 0.03",
  "BASELINE_JSON_PATH: artifacts/baseline.json",
  "FEATURES_SHAPE: 100x12",
  "MODEL_TYPE: baseline-logreg",
  "CV_MEAN: 0.71",
  "TRAIN_MEAN: 0.73",
  'HYPERPARAMETERS: {"C": 1.0}',
  "ARTIFACT_PATH: artifacts/baseline.pkl",
  "STATUS: done",
].join("\n");

const CLASSIC_OUTPUT = [
  "REPORT_PATH: reports/03_classic.md",
  "MODELS_TRAINED: 4",
  "BEST_MODEL_ID: classic_lgbm_v2",
  "MODEL_TYPE: lightgbm",
  "CV_MEAN: 0.88",
  "TRAIN_MEAN: 0.91",
  'HYPERPARAMETERS: {"learning_rate": 0.05, "num_leaves": 31, "max_depth": 6}',
  "ARTIFACT_PATH: artifacts/classic_lgbm_v2.pkl",
  "TOTAL_TIME_SECONDS: 124",
  "STATUS: done",
].join("\n");

const ADVANCED_OUTPUT = [
  "REPORT_PATH: reports/04_advanced.md",
  "MODELS_TRAINED: 3",
  "BEST_MODEL_ID: advanced_mlp_v1",
  "MODEL_TYPE: mlp",
  "CV_MEAN: 0.85",
  "TRAIN_MEAN: 0.93",
  'HYPERPARAMETERS: {"layers": [256, 128, 64], "dropout": 0.3, "lr": 0.001}',
  "ARTIFACT_PATH: artifacts/advanced_mlp_v1.pt",
  "GPU_USED: false",
  "TOTAL_TIME_SECONDS: 342",
  "STATUS: done",
].join("\n");

const AUDIT_OUTPUT = [
  "REPORT_PATH: reports/05_audit.md",
  "TOTAL_SUBMITTED: 3",
  "VALIDATED: 2",
  "REJECTED: 1",
  "FINAL_LEADERBOARD: lightgbm > mlp > baseline-logreg",
  "STATUS: done",
].join("\n");

function insertRun(): void {
  // Initial context carries dataset_path and target_column (mimicking what
  // `formiga workflow run ml-pipeline 'dataset_path=… target_column=…'` would
  // do when the task string is parsed into key=value pairs).
  const context = JSON.stringify({
    dataset_path: "/tmp/toy/train.csv",
    target_column: "price",
    workspace: "/tmp/toy/workspace",
    run_id: RUN_ID,
  });
  getDb()
    .prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'ml-pipeline', ?, 'running', ?, datetime('now'), datetime('now'))`,
    )
    .run(RUN_ID, "dataset_path=/tmp/toy/train.csv target_column=price", context);
}

function insertStep(args: {
  id: string;
  stepId: string;
  agentId: string; // scoped agent_id (workflow_id_agent_id)
  stepIndex: number;
  inputTemplate: string;
  expects: string;
  status: "waiting" | "pending" | "running" | "done";
  parallelGroup?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO steps (
         id, run_id, step_id, agent_id, step_index,
         input_template, expects, status, retry_count, max_retries,
         type, parallel_group, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 2, 'single', ?, datetime('now'), datetime('now'))`,
    )
    .run(
      args.id,
      RUN_ID,
      args.stepId,
      args.agentId,
      args.stepIndex,
      args.inputTemplate,
      args.expects,
      args.status,
      args.parallelGroup ?? null,
    );
}

describe("ml-pipeline workflow E2E", () => {
  before(() => {
    // Force schema migration on the temp DB.
    getDb();
  });

  after(() => {
    // beforeEach in nested describes wipes between tests; nothing to do here.
  });

  describe("workflow.yml structure", () => {
    it("loads workflows/ml-pipeline/workflow.yml with 5 steps and modelers in parallel_group", async () => {
      const spec = await loadWorkflowSpec(WORKFLOW_DIR);

      assert.equal(spec.id, "ml-pipeline");
      assert.equal(spec.agents.length, 5);
      assert.equal(spec.steps.length, 5);

      const stepIds = spec.steps.map((s: { id: string }) => s.id);
      assert.deepEqual(stepIds, [
        "eda",
        "features",
        "model-classic",
        "model-advanced",
        "audit",
      ]);

      const classicStep = spec.steps[2] as { parallel_group?: string };
      const advancedStep = spec.steps[3] as { parallel_group?: string };
      assert.equal(classicStep.parallel_group, "modelers");
      assert.equal(advancedStep.parallel_group, "modelers");

      const edaStep = spec.steps[0] as { parallel_group?: string };
      const auditStep = spec.steps[4] as { parallel_group?: string };
      assert.equal(edaStep.parallel_group, undefined);
      assert.equal(auditStep.parallel_group, undefined);
    });
  });

  describe("full pipeline drive: claim → complete → leaderboard ingest", () => {
    before(() => {
      // Wipe any prior state from sibling describes.
      const db = getDb();
      db.exec("DELETE FROM experiments");
      db.exec("DELETE FROM steps");
      db.exec("DELETE FROM runs");

      // Insert the run and the 5 steps. Step 0 (eda) is 'pending' so the
      // scheduler can claim it; the rest are 'waiting' until advancePipeline
      // promotes them. This mirrors what run.ts does (advancePipeline call
      // after the INSERTs).
      insertRun();
      insertStep({
        id: "step-eda",
        stepId: "eda",
        agentId: "ml-pipeline_data-analyst",
        stepIndex: 0,
        inputTemplate: "EDA prompt",
        expects: "STATUS: done",
        status: "pending",
      });
      insertStep({
        id: "step-features",
        stepId: "features",
        agentId: "ml-pipeline_feature-engineer",
        stepIndex: 1,
        inputTemplate: "Features prompt",
        expects: "STATUS: done",
        status: "waiting",
      });
      insertStep({
        id: "step-classic",
        stepId: "model-classic",
        agentId: "ml-pipeline_modeler-classic",
        stepIndex: 2,
        inputTemplate: "Classic prompt",
        expects: "STATUS: done",
        status: "waiting",
        parallelGroup: "modelers",
      });
      insertStep({
        id: "step-advanced",
        stepId: "model-advanced",
        agentId: "ml-pipeline_modeler-advanced",
        stepIndex: 3,
        inputTemplate: "Advanced prompt",
        expects: "STATUS: done",
        status: "waiting",
        parallelGroup: "modelers",
      });
      insertStep({
        id: "step-audit",
        stepId: "audit",
        agentId: "ml-pipeline_ml-critic",
        stepIndex: 4,
        inputTemplate: "Audit prompt",
        expects: "STATUS: done",
        status: "waiting",
      });
    });

    it("claims and completes the eda step (non-leaderboard agent → no experiment)", () => {
      const claim = claimStep("ml-pipeline_data-analyst", RUN_ID);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, "step-eda");

      const result = completeStep("step-eda", EDA_OUTPUT);
      assert.equal(result.status, "advanced");

      // No leaderboard row from data-analyst (non-leaderboard agent).
      const cnt = getDb()
        .prepare("SELECT COUNT(*) AS c FROM experiments WHERE run_id = ?")
        .get(RUN_ID) as { c: number };
      assert.equal(cnt.c, 0);
    });

    it("claims and completes the features step (feature-engineer is in leaderboard suffix → 1 experiment)", () => {
      const claim = claimStep("ml-pipeline_feature-engineer", RUN_ID);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, "step-features");

      const result = completeStep("step-features", FEATURES_OUTPUT);
      assert.equal(result.status, "advanced");

      const rows = getDb()
        .prepare(
          "SELECT agent_name, model_type, val_metric, train_metric, artifact_path FROM experiments WHERE run_id = ?",
        )
        .all(RUN_ID) as Array<{
          agent_name: string;
          model_type: string;
          val_metric: number;
          train_metric: number;
          artifact_path: string;
        }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agent_name, "ml-pipeline_feature-engineer");
      assert.equal(rows[0].model_type, "baseline-logreg");
      assert.equal(rows[0].val_metric, 0.71);
      assert.equal(rows[0].train_metric, 0.73);
      assert.equal(rows[0].artifact_path, "artifacts/baseline.pkl");
    });

    it("claims BOTH modeler steps concurrently via the parallel_group exception", () => {
      // After features completed, advancePipeline promoted both modeler steps
      // (step_index 2 and 3) from 'waiting' to 'pending' because of how
      // advancePipeline walks waiting steps — but importantly, even if only
      // step 2 was promoted, the parallel_group exception in claim.ts must
      // let step 3 be claimed while step 2 is still running.
      // Verify both are claimable right after step 1 completed.
      const classicClaim = claimStep("ml-pipeline_modeler-classic", RUN_ID);
      assert.equal(classicClaim.found, true);
      assert.equal(classicClaim.stepId, "step-classic");

      // step-classic is now 'running'. Without parallel_group, this would
      // block step-advanced. With it, step-advanced is claimable.
      const advancedClaim = claimStep("ml-pipeline_modeler-advanced", RUN_ID);
      assert.equal(advancedClaim.found, true);
      assert.equal(advancedClaim.stepId, "step-advanced");
    });

    it("blocks the audit step while either modeler sibling is still running", () => {
      // Both modelers are 'running' now. The post-group step (audit) must
      // wait, because its parallel_group is NULL → the exception does not
      // apply, and the prev-step filter sees running siblings as upstream
      // blockers.
      const auditClaim = claimStep("ml-pipeline_ml-critic", RUN_ID);
      assert.equal(auditClaim.found, false);
    });

    it("registers a leaderboard experiment for each modeler upon completion", () => {
      const classicResult = completeStep("step-classic", CLASSIC_OUTPUT);
      assert.equal(classicResult.status, "advanced");

      // Audit still blocked — advanced sibling still running.
      const intermediateAudit = claimStep("ml-pipeline_ml-critic", RUN_ID);
      assert.equal(intermediateAudit.found, false);

      const advancedResult = completeStep("step-advanced", ADVANCED_OUTPUT);
      assert.equal(advancedResult.status, "advanced");

      const rows = getDb()
        .prepare(
          "SELECT agent_name, model_type, val_metric FROM experiments WHERE run_id = ? ORDER BY experiment_id",
        )
        .all(RUN_ID) as Array<{
          agent_name: string;
          model_type: string;
          val_metric: number;
        }>;
      // baseline (features) + classic + advanced = 3 rows
      assert.equal(rows.length, 3);
      assert.equal(rows[1].agent_name, "ml-pipeline_modeler-classic");
      assert.equal(rows[1].model_type, "lightgbm");
      assert.equal(rows[1].val_metric, 0.88);
      assert.equal(rows[2].agent_name, "ml-pipeline_modeler-advanced");
      assert.equal(rows[2].model_type, "mlp");
      assert.equal(rows[2].val_metric, 0.85);
    });

    it("unblocks the audit step once every modeler sibling is done", () => {
      const auditClaim = claimStep("ml-pipeline_ml-critic", RUN_ID);
      assert.equal(auditClaim.found, true);
      assert.equal(auditClaim.stepId, "step-audit");
    });

    it("completes the audit step (ml-critic is non-leaderboard → no new experiments) and marks the run complete", () => {
      const result = completeStep("step-audit", AUDIT_OUTPUT);
      // advancePipeline reports runCompleted=true when no more steps remain.
      assert.equal(result.status, "completed");

      // Experiments table unchanged: ml-critic is not in the leaderboard
      // suffix list, so the ingest hook no-ops.
      const cnt = getDb()
        .prepare("SELECT COUNT(*) AS c FROM experiments WHERE run_id = ?")
        .get(RUN_ID) as { c: number };
      assert.equal(cnt.c, 3);

      const run = getDb()
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(RUN_ID) as { status: string };
      assert.equal(run.status, "completed");

      // And the context carries the merged KEY:value snapshots from earlier
      // steps (e.g. baseline_cv_mean from features step lowercased).
      const ctxRow = getDb()
        .prepare("SELECT context FROM runs WHERE id = ?")
        .get(RUN_ID) as { context: string };
      const ctx = JSON.parse(ctxRow.context) as Record<string, string>;
      assert.equal(ctx["baseline_cv_mean"], "0.71");
      assert.equal(ctx["model_type"], "mlp"); // most recent modeler win
    });
  });
});
