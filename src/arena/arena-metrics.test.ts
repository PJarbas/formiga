// ══════════════════════════════════════════════════════════════════════
// arena-metrics.test.ts — Tests for A4: strict `_results.json` validation and
// the load-with-reason helper (no more silent `{}` on missing files).
// ══════════════════════════════════════════════════════════════════════

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRichMetrics, tryLoadRichMetrics } from "./arena-engine.js";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-metrics-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write an agent's _results.json into `<ws>/artifacts/models/`. */
function writeResults(ws: string, agentId: string, round: number, json: unknown): string {
  const dir = path.join(ws, "artifacts", "models");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentId}_round${round}_results.json`);
  fs.writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
  return file;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── validateRichMetrics ─────────────────────────────────────────────────

function classificationPayload(): Record<string, unknown> {
  return {
    fold_scores: [0.80, 0.82, 0.81],
    train_score: 0.85,
    roc_auc: 0.82,
    f1_score: 0.80,
    precision: 0.78,
    recall: 0.77,
    log_loss: 0.45,
  };
}

function regressionPayload(): Record<string, unknown> {
  return {
    folds: [0.41, 0.42, 0.40],
    train_score: 0.39,
    rmse: 0.42,
    mae: 0.33,
    r2_score: 0.91,
  };
}

describe("validateRichMetrics — classification", () => {
  it("accepts a fully valid classification payload", () => {
    assert.equal(validateRichMetrics(classificationPayload(), "classification"), null);
  });

  it("accepts an explicit null log_loss (number not required)", () => {
    const p = classificationPayload();
    p.log_loss = null;
    assert.equal(validateRichMetrics(p, "classification"), null);
  });

  it("rejects when a required classification metric is missing", () => {
    const p = classificationPayload();
    delete p.roc_auc;
    const err = validateRichMetrics(p, "classification");
    assert.ok(err);
    assert.match(err!, /\[metrics_invalid\]/);
    assert.match(err!, /roc_auc/);
  });

  it("rejects when log_loss is absent entirely", () => {
    const p = classificationPayload();
    delete p.log_loss;
    const err = validateRichMetrics(p, "classification");
    assert.ok(err);
    assert.match(err!, /log_loss/);
  });
});

describe("validateRichMetrics — regression", () => {
  it("accepts a fully valid regression payload (legacy `folds` alias)", () => {
    assert.equal(validateRichMetrics(regressionPayload(), "regression"), null);
  });

  it("rejects when a required regression metric is missing", () => {
    const p = regressionPayload();
    delete p.rmse;
    const err = validateRichMetrics(p, "regression");
    assert.ok(err);
    assert.match(err!, /\[metrics_invalid\]/);
    assert.match(err!, /rmse/);
  });
});

describe("validateRichMetrics — structural contract", () => {
  it("rejects fewer than 2 valid folds", () => {
    const p = classificationPayload();
    p.fold_scores = [0.8];
    assert.match(validateRichMetrics(p, "classification")!, /\[metrics_invalid\]/);

    const q = classificationPayload();
    q.fold_scores = [];
    assert.match(validateRichMetrics(q, "classification")!, /fold_scores/);
  });

  it("rejects a missing train_score", () => {
    const p = classificationPayload();
    delete p.train_score;
    assert.match(validateRichMetrics(p, "classification")!, /train_score/);
  });

  it("accepts numeric strings for metrics and folds", () => {
    const p = classificationPayload();
    p.fold_scores = ["0.80", "0.82", "0.81"];
    p.roc_auc = "0.82";
    p.train_score = "0.85";
    assert.equal(validateRichMetrics(p, "classification"), null);
  });

  it("filters out non-finite fold entries but keeps the valid ones", () => {
    const p = classificationPayload();
    p.fold_scores = [0.8, NaN, "0.9", Infinity, 0.85];
    // 3 valid folds survive → passes.
    assert.equal(validateRichMetrics(p, "classification"), null);
  });
});

// ── tryLoadRichMetrics ──────────────────────────────────────────────────

describe("tryLoadRichMetrics", () => {
  it("returns [metrics_missing] when the file does not exist", () => {
    const ws = makeWorkspace();
    const r = tryLoadRichMetrics(ws, "modeler-classic", 1, "classification");
    assert.ok(r.error);
    assert.match(r.error!, /\[metrics_missing\]/);
    assert.deepEqual(r.rich, {});
  });

  it("returns [metrics_invalid] for a corrupt _results.json", () => {
    const ws = makeWorkspace();
    writeResults(ws, "modeler-classic", 1, "{ not valid json");
    const r = tryLoadRichMetrics(ws, "modeler-classic", 1, "classification");
    assert.ok(r.error);
    assert.match(r.error!, /\[metrics_invalid\]/);
    assert.match(r.error!, /corrompido/);
  });

  it("extracts the rich contract from a valid _results.json", () => {
    const ws = makeWorkspace();
    writeResults(ws, "modeler-classic", 1, {
      model: "lightgbm",
      best_params: { lr: 0.01, depth: 6 },
      ...classificationPayload(),
      feature_importances: [0.3, 0.2, 0.1],
      oof_path: "artifacts/oof.npy",
      prod_path: "artifacts/prod.npy",
      n_unique_probs: 482,
      ece_calibrated: 0.02,
      notes: "bom",
    });
    const r = tryLoadRichMetrics(ws, "modeler-classic", 1, "classification");
    assert.equal(r.error, null);
    assert.equal(r.rich.modelAlgorithm, "lightgbm");
    assert.deepEqual(r.rich.hyperparameters, { lr: 0.01, depth: 6 });
    assert.deepEqual(r.rich.foldScores, [0.80, 0.82, 0.81]);
    assert.equal(r.rich.trainScore, 0.85);
    assert.equal(r.rich.metricBag.f1_score, 0.80);
    assert.equal(r.rich.metricBag.roc_auc, 0.82);
    assert.deepEqual(r.rich.featureImportances, [0.3, 0.2, 0.1]);
    assert.equal(r.rich.oofArtifactKey, "artifacts/oof.npy");
    assert.equal(r.rich.oofUniqueProbs, 482);
    assert.equal(r.rich.notes, "bom");
  });

  it("reports a validation error but still returns the parsed rich object", () => {
    const ws = makeWorkspace();
    writeResults(ws, "modeler-classic", 1, {
      fold_scores: [0.8, 0.82, 0.81],
      train_score: 0.85,
      // missing roc_auc/f1/precision/recall → classification invalid
    });
    const r = tryLoadRichMetrics(ws, "modeler-classic", 1, "classification");
    assert.ok(r.error);
    assert.match(r.error!, /\[metrics_invalid\]/);
    assert.equal(r.rich.foldScores?.length, 3);
  });
});
